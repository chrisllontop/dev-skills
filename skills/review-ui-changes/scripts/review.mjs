#!/usr/bin/env node

import { createReadStream, openSync, closeSync } from "node:fs";
import {
  chmod,
  copyFile,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SKILL_DIR = resolve(dirname(SCRIPT_PATH), "..");
const ASSET_DIR = join(SKILL_DIR, "assets", "review-board");
const LOOPBACK = "127.0.0.1";
const PROTOCOL_VERSION = 2;
const DEFAULT_IDLE_MINUTES = 240;

const HELP = `review-ui-changes

Publish local before/after UI reviews and read revision-bound feedback.

Usage:
  node review.mjs publish <manifest.json|-> [--root <project>] [--port <port>]
  node review.mjs feedback [--root <project>] [--batch <batch-id>]
  node review.mjs address --comment <comment-id> [--comment <id> ...]
  node review.mjs start [--port <port>] [--idle-minutes <minutes>]
  node review.mjs stop
  node review.mjs status [--root <project>]

Use - to read the manifest from stdin. The manifest contains id, title, and
surfaces. A new surface requires before and after image paths. A later revision
requires after and expectedRevision. The shared local server chooses an available
port automatically unless --port is set.
`;

function parseArguments(argv) {
  const values = new Map();
  const positional = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }

    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      values.set(token, [...(values.get(token) ?? []), true]);
      continue;
    }

    values.set(token, [...(values.get(token) ?? []), next]);
    index += 1;
  }

  return { positional, values };
}

function option(args, name, fallback) {
  const matches = args.values.get(name);
  return matches?.at(-1) ?? fallback;
}

function options(args, name) {
  return (args.values.get(name) ?? []).filter((value) => value !== true);
}

function assertId(value, label) {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9._-]{0,79}$/.test(value)) {
    throw new Error(`${label} must use 1-80 lowercase letters, numbers, dots, underscores, or hyphens.`);
  }
  return value;
}

function assertText(value, label, max = 200) {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > max) {
    throw new Error(`${label} must be a non-empty string no longer than ${max} characters.`);
  }
  return value.trim();
}

function assertRevision(value, label = "Revision") {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return value;
}

function isInside(parent, child) {
  const pathFromParent = relative(parent, child);
  return pathFromParent === "" || (!pathFromParent.startsWith(`..${sep}`) && pathFromParent !== "..");
}

async function requireDirectory(directory, label) {
  try {
    const directoryInfo = await stat(directory);
    if (!directoryInfo.isDirectory()) throw new Error(`${label} is not a directory: ${directory}`);
    return await realpath(directory);
  } catch (error) {
    if (error.code === "ENOENT") throw new Error(`${label} does not exist: ${directory}`, { cause: error });
    throw error;
  }
}

async function existingGitDirectory(projectRoot) {
  const dotGit = join(projectRoot, ".git");
  let dotGitInfo;
  try {
    dotGitInfo = await stat(dotGit);
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(
        `No .git entry exists in ${projectRoot}. This command does not initialize Git.`,
        { cause: error },
      );
    }
    throw error;
  }

  if (dotGitInfo.isDirectory()) return realpath(dotGit);
  if (!dotGitInfo.isFile()) throw new Error(`The .git entry is not a file or directory: ${dotGit}`);

  const pointer = (await readFile(dotGit, "utf8")).trim().match(/^gitdir:\s*(.+)$/i);
  if (!pointer) throw new Error(`The .git worktree pointer is invalid: ${dotGit}`);
  const worktreeGitDirectory = await requireDirectory(
    resolve(projectRoot, pointer[1]),
    "The .git worktree directory",
  );

  try {
    const commonPointer = (await readFile(join(worktreeGitDirectory, "commondir"), "utf8")).trim();
    if (!commonPointer) throw new Error(`The Git commondir file is empty: ${worktreeGitDirectory}`);
    return requireDirectory(
      resolve(worktreeGitDirectory, commonPointer),
      "The common Git directory",
    );
  } catch (error) {
    if (error.code === "ENOENT") return worktreeGitDirectory;
    throw error;
  }
}

async function defaultDataDirectory(projectRoot) {
  if (process.env.REVIEW_UI_DATA_DIR) return resolve(process.env.REVIEW_UI_DATA_DIR);
  return join(await existingGitDirectory(projectRoot), "review-ui-changes");
}

async function canonicalProjectRoot(value) {
  const projectRoot = resolve(String(value));
  try {
    return await realpath(projectRoot);
  } catch (error) {
    if (error.code === "ENOENT") throw new Error(`Project root does not exist: ${projectRoot}`);
    throw error;
  }
}

async function contextFrom(args) {
  const projectRoot = await canonicalProjectRoot(option(args, "--root", process.cwd()));
  const explicitDataDirectory = option(args, "--data-dir", option(args, "--state-dir", null));
  const dataDirectory = explicitDataDirectory
    ? resolve(String(explicitDataDirectory))
    : await defaultDataDirectory(projectRoot);
  const conductorWorkspaceId = process.env.CONDUCTOR_WORKSPACE_ID?.trim() || null;
  const workspaceKey = conductorWorkspaceId ? `conductor:${conductorWorkspaceId}` : `path:${projectRoot}`;

  return {
    projectRoot,
    workspaceKey,
    workspaceName: process.env.CONDUCTOR_WORKSPACE_NAME?.trim() || basename(projectRoot),
    conductorWorkspaceId,
    dataDirectory,
    databaseFile: join(dataDirectory, "database.json"),
    databaseLockFile: join(dataDirectory, "database.lock"),
    serverFile: join(dataDirectory, "server.json"),
    serverLockFile: join(dataDirectory, "server.lock"),
    logFile: join(dataDirectory, "server.log"),
    mediaDirectory: join(dataDirectory, "media"),
  };
}

function emptyDatabase() {
  return { schemaVersion: 2, workspaces: [], reviews: [] };
}

async function ensureContext(context) {
  await mkdir(context.mediaDirectory, { recursive: true, mode: 0o700 });
  try {
    await chmod(context.dataDirectory, 0o700);
  } catch (error) {
    if (error.code !== "EPERM") throw error;
  }
}

async function readDatabase(context) {
  try {
    const database = JSON.parse(await readFile(context.databaseFile, "utf8"));
    if (
      database.schemaVersion !== 2
      || !Array.isArray(database.workspaces)
      || !Array.isArray(database.reviews)
    ) {
      throw new Error("Unsupported or invalid local review database.");
    }
    return database;
  } catch (error) {
    if (error.code === "ENOENT") return emptyDatabase();
    throw error;
  }
}

async function writeJsonAtomic(filePath, value) {
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, filePath);
  try {
    await chmod(filePath, 0o600);
  } catch (error) {
    if (error.code !== "EPERM") throw error;
  }
}

function processIsRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

async function lockIsAbandoned(lockFile, staleAfterMs) {
  try {
    const [contents, lockStat] = await Promise.all([readFile(lockFile, "utf8"), stat(lockFile)]);
    const pid = Number(contents.trim());
    if (Number.isInteger(pid) && pid > 0) return !processIsRunning(pid);
    return Date.now() - lockStat.mtimeMs >= staleAfterMs;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function acquireLock(context, lockFile, label, { waitMs = 10_000, staleAfterMs = 30_000 } = {}) {
  await ensureContext(context);
  const deadline = Date.now() + waitMs;

  while (Date.now() < deadline) {
    try {
      const handle = await open(lockFile, "wx", 0o600);
      await handle.writeFile(`${process.pid}\n`);
      return handle;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (await lockIsAbandoned(lockFile, staleAfterMs)) {
        await rm(lockFile, { force: true });
        continue;
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    }
  }

  throw new Error(`${label} is busy. Try again in a few seconds.`);
}

async function withLock(context, lockFile, label, action, settings) {
  const handle = await acquireLock(context, lockFile, label, settings);
  try {
    return await action();
  } finally {
    await handle.close();
    await rm(lockFile, { force: true });
  }
}

async function mutateDatabase(context, mutation) {
  return withLock(
    context,
    context.databaseLockFile,
    "Local review database",
    async () => {
      const database = await readDatabase(context);
      const result = await mutation(database);
      await writeJsonAtomic(context.databaseFile, database);
      return result;
    },
    { waitMs: 15_000, staleAfterMs: 5 * 60_000 },
  );
}

function workspaceForContext(database, context) {
  return database.workspaces.find((workspace) => workspace.key === context.workspaceKey) ?? null;
}

function ensureWorkspace(database, context) {
  let workspace = workspaceForContext(database, context);
  const now = new Date().toISOString();
  if (!workspace) {
    workspace = {
      id: randomUUID(),
      key: context.workspaceKey,
      name: context.workspaceName,
      projectRoot: context.projectRoot,
      conductorWorkspaceId: context.conductorWorkspaceId,
      createdAt: now,
      updatedAt: now,
    };
    database.workspaces.push(workspace);
  } else {
    workspace.name = context.workspaceName;
    workspace.projectRoot = context.projectRoot;
    workspace.conductorWorkspaceId = context.conductorWorkspaceId;
    workspace.updatedAt = now;
  }
  return workspace;
}

function reviewForBatch(database, workspaceId, batchId) {
  return database.reviews.find(
    (review) => review.workspaceId === workspaceId && review.batch.id === batchId,
  ) ?? null;
}

function tokensEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function imageExtension(filePath) {
  const extension = extname(filePath).toLowerCase();
  const allowed = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".avif"]);
  if (!allowed.has(extension)) throw new Error(`Unsupported screenshot type: ${extension || "none"}.`);
  return extension;
}

async function readManifestFromStdin() {
  const chunks = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    length += chunk.length;
    if (length > 1024 * 1024) throw new Error("Manifest is too large.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function copyScreenshot(sourceValue, manifestDirectory, context, reviewId, surfaceId, name) {
  if (typeof sourceValue !== "string" || sourceValue.length === 0) {
    throw new Error(`Missing screenshot path for ${surfaceId}.`);
  }
  const source = isAbsolute(sourceValue) ? sourceValue : resolve(manifestDirectory, sourceValue);
  const sourceInfo = await stat(source);
  if (!sourceInfo.isFile()) throw new Error(`Screenshot is not a file: ${source}`);

  const extension = imageExtension(source);
  const destinationDirectory = join(context.mediaDirectory, reviewId, surfaceId);
  const filename = `${name}${extension}`;
  await mkdir(destinationDirectory, { recursive: true, mode: 0o700 });
  await copyFile(source, join(destinationDirectory, filename));
  return filename;
}

function validateManifest(manifest) {
  const batchId = assertId(manifest.id, "Batch id");
  const batchTitle = assertText(manifest.title, "Batch title");
  if (!Array.isArray(manifest.surfaces) || manifest.surfaces.length === 0) {
    throw new Error("Manifest surfaces must be a non-empty array.");
  }

  const seen = new Set();
  for (const surface of manifest.surfaces) {
    const surfaceId = assertId(surface.id, "Surface id");
    if (seen.has(surfaceId)) throw new Error(`Duplicate surface id: ${surfaceId}`);
    seen.add(surfaceId);
    assertText(surface.title, `Title for ${surfaceId}`);
    if (!surface.after) throw new Error(`Surface ${surfaceId} requires an after screenshot.`);
    if (
      surface.expectedRevision !== undefined
      && (!Number.isInteger(surface.expectedRevision) || surface.expectedRevision < 0)
    ) {
      throw new Error(`expectedRevision for ${surfaceId} must be a non-negative integer.`);
    }
  }
  return { batchId, batchTitle };
}

async function publish(manifestPathValue, args, context) {
  if (process.env.CONDUCTOR_IS_LOCAL === "0") {
    throw new Error("Local visual review is unavailable in a Conductor cloud workspace.");
  }
  if (!manifestPathValue) throw new Error("publish requires a manifest JSON path or - for stdin.");
  const manifestFromStdin = manifestPathValue === "-";
  const manifestPath = manifestFromStdin ? null : resolve(manifestPathValue);
  const manifestDirectory = manifestFromStdin ? context.projectRoot : dirname(manifestPath);
  const manifestJson = manifestFromStdin
    ? await readManifestFromStdin()
    : await readFile(manifestPath, "utf8");
  const manifest = JSON.parse(manifestJson);
  const { batchId, batchTitle } = validateManifest(manifest);
  const server = await startServer(args, context);

  const published = await mutateDatabase(context, async (database) => {
    const now = new Date().toISOString();
    const workspace = ensureWorkspace(database, context);
    let review = reviewForBatch(database, workspace.id, batchId);
    if (!review) {
      review = {
        id: randomUUID(),
        accessToken: randomBytes(32).toString("base64url"),
        workspaceId: workspace.id,
        createdAt: now,
        updatedAt: now,
        batch: { id: batchId, title: batchTitle, createdAt: now, updatedAt: now, surfaces: [] },
        comments: [],
      };
      database.reviews.push(review);
    }
    review.updatedAt = now;
    review.batch.title = batchTitle;
    review.batch.updatedAt = now;

    const revisions = [];
    for (const input of manifest.surfaces) {
      const surfaceId = input.id;
      const title = assertText(input.title, `Title for ${surfaceId}`);
      let surface = review.batch.surfaces.find((candidate) => candidate.id === surfaceId);

      if (surface) {
        if (input.expectedRevision === undefined) {
          throw new Error(
            `Existing surface ${surfaceId} requires expectedRevision ${surface.revision} to prevent concurrent overwrite.`,
          );
        }
        if (input.expectedRevision !== surface.revision) {
          throw new Error(
            `Revision conflict for ${surfaceId}: expected ${input.expectedRevision}, current ${surface.revision}.`,
          );
        }
      } else if (input.expectedRevision !== undefined && input.expectedRevision !== 0) {
        throw new Error(`New surface ${surfaceId} must omit expectedRevision or use 0.`);
      }

      const revision = surface ? surface.revision + 1 : 1;
      let before = surface?.before;
      if (!surface) {
        if (!input.before) throw new Error(`New surface ${surfaceId} requires a before screenshot.`);
        before = await copyScreenshot(
          input.before,
          manifestDirectory,
          context,
          review.id,
          surfaceId,
          "before",
        );
      }

      const after = await copyScreenshot(
        input.after,
        manifestDirectory,
        context,
        review.id,
        surfaceId,
        `after-r${revision}`,
      );

      if (!surface) {
        surface = { id: surfaceId, title, before, after, revision, readyRevision: null, updatedAt: now };
        review.batch.surfaces.push(surface);
      } else {
        surface.title = title;
        surface.after = after;
        surface.revision = revision;
        surface.readyRevision = null;
        surface.updatedAt = now;
      }
      revisions.push({ id: surfaceId, revision });
    }

    return { reviewId: review.id, accessToken: review.accessToken, revisions };
  });

  const reviewUrl = new URL(server.url);
  reviewUrl.searchParams.set("review", published.reviewId);
  reviewUrl.searchParams.set("token", published.accessToken);
  reviewUrl.searchParams.set("batch", batchId);
  return {
    workspaceId: (await workspaceIdentity(context)),
    reviewId: published.reviewId,
    batch: batchId,
    surfaces: published.revisions,
    url: reviewUrl.toString(),
  };
}

async function workspaceIdentity(context) {
  const database = await readDatabase(context);
  return workspaceForContext(database, context)?.id ?? null;
}

function mediaUrl(review, surfaceId, filename) {
  const query = new URLSearchParams({ token: review.accessToken });
  return `/media/${encodeURIComponent(review.id)}/${encodeURIComponent(surfaceId)}/${encodeURIComponent(filename)}?${query}`;
}

function publicState(review) {
  const batch = {
    ...review.batch,
    surfaces: [...review.batch.surfaces]
      .sort((left, right) => left.title.localeCompare(right.title))
      .map((surface) => ({
        ...surface,
        before: mediaUrl(review, surface.id, surface.before),
        after: mediaUrl(review, surface.id, surface.after),
      })),
  };
  return {
    schemaVersion: 1,
    reviewId: review.id,
    batches: [batch],
    comments: [...review.comments].sort((left, right) => right.createdAt.localeCompare(left.createdAt)),
  };
}

async function feedback(context, batchFilter) {
  const database = await readDatabase(context);
  const workspace = workspaceForContext(database, context);
  if (!workspace) return [];

  return database.reviews
    .filter((review) => review.workspaceId === workspace.id && (!batchFilter || review.batch.id === batchFilter))
    .flatMap((review) => review.comments
      .filter((comment) => comment.status === "open")
      .map((comment) => {
        const surface = review.batch.surfaces.find((candidate) => candidate.id === comment.surfaceId);
        return {
          id: comment.id,
          reviewId: review.id,
          batchId: review.batch.id,
          batchTitle: review.batch.title,
          surfaceId: comment.surfaceId,
          surfaceTitle: surface?.title ?? null,
          revision: comment.revision,
          currentRevision: surface?.revision ?? null,
          stale: surface ? surface.revision !== comment.revision : true,
          body: comment.body,
          createdAt: comment.createdAt,
        };
      }));
}

async function addressComments(context, ids) {
  if (ids.length === 0) throw new Error("address requires at least one --comment <id>.");
  return mutateDatabase(context, (database) => {
    const workspace = workspaceForContext(database, context);
    if (!workspace) throw new Error("No visual reviews exist for this workspace.");
    const addressedAt = new Date().toISOString();
    const addressed = [];

    for (const id of ids) {
      let found = null;
      for (const review of database.reviews.filter((candidate) => candidate.workspaceId === workspace.id)) {
        const comment = review.comments.find((candidate) => candidate.id === id);
        if (comment) {
          found = { review, comment };
          break;
        }
      }
      if (!found) throw new Error(`Unknown comment in this workspace: ${id}`);
      if (found.comment.status === "open") {
        found.comment.status = "addressed";
        found.comment.addressedAt = addressedAt;
        found.review.updatedAt = addressedAt;
      }
      addressed.push(id);
    }
    return addressed;
  });
}

function contentType(filePath) {
  return {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".avif": "image/avif",
  }[extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

function responseHeaders(extra = {}) {
  return {
    "cache-control": "no-store",
    "content-security-policy": "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    ...extra,
  };
}

function sendJson(response, statusCode, value) {
  const body = `${JSON.stringify(value)}\n`;
  response.writeHead(statusCode, responseHeaders({
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  }));
  response.end(body);
}

async function sendFile(response, filePath) {
  try {
    const fileInfo = await stat(filePath);
    if (!fileInfo.isFile()) throw Object.assign(new Error("Not found"), { code: "ENOENT" });
    response.writeHead(200, responseHeaders({ "content-type": contentType(filePath) }));
    createReadStream(filePath).pipe(response);
  } catch (error) {
    if (error.code === "ENOENT") {
      sendJson(response, 404, { error: "Not found" });
      return;
    }
    throw error;
  }
}

async function readJsonBody(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 64 * 1024) throw new Error("Request body is too large.");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function authorizedReview(database, url) {
  const reviewId = url.searchParams.get("review");
  const accessToken = url.searchParams.get("token");
  const review = database.reviews.find((candidate) => candidate.id === reviewId);
  if (!review || !tokensEqual(review.accessToken, accessToken)) {
    throw Object.assign(new Error("Review not found or token is invalid."), { statusCode: 404 });
  }
  return review;
}

async function handleApi(request, response, url, context) {
  if (request.method === "GET" && url.pathname === "/api/health") {
    sendJson(response, 200, { ok: true, pid: process.pid, protocolVersion: PROTOCOL_VERSION });
    return true;
  }

  if (request.method === "GET" && url.pathname === "/api/state") {
    const database = await readDatabase(context);
    sendJson(response, 200, publicState(authorizedReview(database, url)));
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/comments") {
    const input = await readJsonBody(request);
    const body = assertText(input.body, "Comment", 4000);
    const batchId = assertId(input.batchId, "Batch id");
    const surfaceId = assertId(input.surfaceId, "Surface id");
    const revision = assertRevision(input.revision, "Comment revision");
    const comment = await mutateDatabase(context, (database) => {
      const review = authorizedReview(database, url);
      if (review.batch.id !== batchId) throw new Error("Unknown batch.");
      const surface = review.batch.surfaces.find((candidate) => candidate.id === surfaceId);
      if (!surface) throw new Error("Unknown surface.");
      if (revision > surface.revision) throw new Error("Comment revision does not exist.");
      const created = {
        id: randomUUID(),
        batchId,
        surfaceId,
        revision,
        body,
        status: "open",
        createdAt: new Date().toISOString(),
        addressedAt: null,
      };
      review.comments.push(created);
      review.updatedAt = created.createdAt;
      return created;
    });
    sendJson(response, 201, comment);
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/ready") {
    const input = await readJsonBody(request);
    const batchId = assertId(input.batchId, "Batch id");
    const surfaceId = assertId(input.surfaceId, "Surface id");
    const revision = assertRevision(input.revision, "Ready revision");
    const ready = Boolean(input.ready);
    const result = await mutateDatabase(context, (database) => {
      const review = authorizedReview(database, url);
      if (review.batch.id !== batchId) throw new Error("Unknown batch.");
      const surface = review.batch.surfaces.find((candidate) => candidate.id === surfaceId);
      if (!surface) throw new Error("Unknown surface.");
      if (revision !== surface.revision) {
        throw Object.assign(
          new Error(`Revision conflict: reviewed ${revision}, current ${surface.revision}. Reload and review again.`),
          { statusCode: 409 },
        );
      }
      surface.readyRevision = ready ? surface.revision : null;
      review.updatedAt = new Date().toISOString();
      return { batchId, surfaceId, ready, revision: surface.revision };
    });
    sendJson(response, 200, result);
    return true;
  }

  return false;
}

async function requestHandler(request, response, context) {
  try {
    const url = new URL(request.url, `http://${request.headers.host ?? LOOPBACK}`);
    if (url.pathname.startsWith("/api/")) {
      if (!(await handleApi(request, response, url, context))) sendJson(response, 404, { error: "Not found" });
      return;
    }

    if (request.method !== "GET") {
      sendJson(response, 405, { error: "Method not allowed" });
      return;
    }

    if (url.pathname.startsWith("/media/")) {
      const segments = url.pathname.slice("/media/".length).split("/").map(decodeURIComponent);
      if (segments.length !== 3) {
        sendJson(response, 404, { error: "Not found" });
        return;
      }
      const [reviewId, surfaceId, filename] = segments;
      const database = await readDatabase(context);
      const reviewUrl = new URL(url);
      reviewUrl.searchParams.set("review", reviewId);
      const review = authorizedReview(database, reviewUrl);
      const surface = review.batch.surfaces.find((candidate) => candidate.id === surfaceId);
      if (!surface || ![surface.before, surface.after].includes(filename)) {
        sendJson(response, 404, { error: "Not found" });
        return;
      }
      const reviewMediaDirectory = resolve(context.mediaDirectory, review.id);
      const target = resolve(reviewMediaDirectory, surfaceId, filename);
      if (!isInside(reviewMediaDirectory, target)) {
        sendJson(response, 403, { error: "Forbidden" });
        return;
      }
      await sendFile(response, target);
      return;
    }

    const assets = new Map([
      ["/", "index.html"],
      ["/index.html", "index.html"],
      ["/app.js", "app.js"],
      ["/styles.css", "styles.css"],
    ]);
    const asset = assets.get(url.pathname);
    if (!asset) {
      sendJson(response, 404, { error: "Not found" });
      return;
    }
    await sendFile(response, join(ASSET_DIR, asset));
  } catch (error) {
    if (!response.headersSent) sendJson(response, error.statusCode ?? 400, { error: error.message });
    else response.destroy(error);
  }
}

async function readServerInfo(context) {
  try {
    return JSON.parse(await readFile(context.serverFile, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function serverIsHealthy(info) {
  if (!info?.url) return false;
  try {
    const response = await fetch(`${info.url}/api/health`, { signal: AbortSignal.timeout(500) });
    if (!response.ok) return false;
    const health = await response.json();
    return health.ok === true
      && health.pid === info.pid
      && health.protocolVersion === PROTOCOL_VERSION;
  } catch {
    return false;
  }
}

function parsePort(value) {
  const portValue = Number(value);
  if (!Number.isInteger(portValue) || portValue < 0 || portValue > 65535 || (portValue > 0 && portValue < 1024)) {
    throw new Error("Port must be 0 or an integer between 1024 and 65535.");
  }
  return portValue;
}

function parseIdleMinutes(value) {
  const idleMinutes = Number(value);
  if (!Number.isFinite(idleMinutes) || idleMinutes <= 0) {
    throw new Error("Idle minutes must be a positive number.");
  }
  return idleMinutes;
}

async function startServer(args, context) {
  return withLock(context, context.serverLockFile, "Local review server startup", async () => {
    const existing = await readServerInfo(context);
    if (await serverIsHealthy(existing)) return existing;

    await ensureContext(context);
    await rm(context.serverFile, { force: true });
    const portValue = parsePort(option(args, "--port", 0));
    const idleMinutes = parseIdleMinutes(
      option(args, "--idle-minutes", process.env.REVIEW_UI_IDLE_MINUTES ?? DEFAULT_IDLE_MINUTES),
    );
    const logDescriptor = openSync(context.logFile, "a", 0o600);
    const child = spawn(
      process.execPath,
      [
        SCRIPT_PATH,
        "serve",
        "--root",
        context.projectRoot,
        "--data-dir",
        context.dataDirectory,
        "--port",
        String(portValue),
        "--idle-minutes",
        String(idleMinutes),
      ],
      { detached: true, stdio: ["ignore", logDescriptor, logDescriptor] },
    );
    child.unref();
    closeSync(logDescriptor);

    for (let attempt = 0; attempt < 60; attempt += 1) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
      const info = await readServerInfo(context);
      if (await serverIsHealthy(info)) return info;
    }

    throw new Error(`The review server did not start. Inspect ${context.logFile}.`);
  });
}

async function removeOwnServerFile(context) {
  const info = await readServerInfo(context);
  if (info?.pid === process.pid) await rm(context.serverFile, { force: true });
}

async function serve(args, context) {
  const portValue = parsePort(option(args, "--port", 0));
  const idleMinutes = parseIdleMinutes(
    option(args, "--idle-minutes", process.env.REVIEW_UI_IDLE_MINUTES ?? DEFAULT_IDLE_MINUTES),
  );
  const idleMilliseconds = idleMinutes * 60_000;
  await ensureContext(context);

  let idleTimer;
  let shuttingDown = false;
  const server = createServer((request, response) => {
    scheduleIdleShutdown();
    void requestHandler(request, response, context);
  });

  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearTimeout(idleTimer);
    try {
      await removeOwnServerFile(context);
    } finally {
      server.close(() => process.exit(0));
      server.closeIdleConnections?.();
    }
  };

  function scheduleIdleShutdown() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => void shutdown(), idleMilliseconds);
    idleTimer.unref();
  }

  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(portValue, LOOPBACK, resolveListen);
  });

  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not determine the review server port.");
  const info = {
    pid: process.pid,
    port: address.port,
    url: `http://${LOOPBACK}:${address.port}`,
    protocolVersion: PROTOCOL_VERSION,
    idleMinutes,
    startedAt: new Date().toISOString(),
  };
  await writeJsonAtomic(context.serverFile, info);
  scheduleIdleShutdown();

  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
}

async function stopServer(context) {
  const info = await readServerInfo(context);
  if (!info || !(await serverIsHealthy(info))) {
    await rm(context.serverFile, { force: true });
    return { running: false };
  }
  process.kill(info.pid, "SIGTERM");
  for (let attempt = 0; attempt < 50; attempt += 1) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    if (!(await serverIsHealthy(info))) return { running: false };
  }
  throw new Error("The review server did not stop cleanly.");
}

async function status(context) {
  const [info, database] = await Promise.all([readServerInfo(context), readDatabase(context)]);
  const running = await serverIsHealthy(info);
  const workspace = workspaceForContext(database, context);
  const reviews = workspace
    ? database.reviews
      .filter((review) => review.workspaceId === workspace.id)
      .map((review) => {
        let url = null;
        if (running) {
          const reviewUrl = new URL(info.url);
          reviewUrl.searchParams.set("review", review.id);
          reviewUrl.searchParams.set("token", review.accessToken);
          reviewUrl.searchParams.set("batch", review.batch.id);
          url = reviewUrl.toString();
        }
        return {
          reviewId: review.id,
          batch: review.batch.id,
          title: review.batch.title,
          updatedAt: review.updatedAt,
          url,
        };
      })
    : [];
  return {
    running,
    url: running ? info.url : null,
    workspaceId: workspace?.id ?? null,
    reviews,
    dataDirectory: context.dataDirectory,
  };
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === "--help" || command === "-h" || command === "help") {
    process.stdout.write(HELP);
    return;
  }

  const args = parseArguments(rest);
  const context = await contextFrom(args);
  let result;

  if (command === "publish") {
    result = await publish(args.positional[0], args, context);
  } else if (command === "feedback") {
    result = await feedback(context, option(args, "--batch", null));
  } else if (command === "address") {
    result = { addressed: await addressComments(context, options(args, "--comment")) };
  } else if (command === "start") {
    result = await startServer(args, context);
  } else if (command === "serve") {
    await serve(args, context);
    return;
  } else if (command === "stop") {
    result = await stopServer(context);
  } else if (command === "status") {
    result = await status(context);
  } else {
    throw new Error(`Unknown command: ${command}\n\n${HELP}`);
  }

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`review-ui-changes: ${error.message}\n`);
  process.exitCode = 1;
});
