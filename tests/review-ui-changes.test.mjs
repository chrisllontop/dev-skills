import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const reviewScript = resolve("skills/review-ui-changes/scripts/review.mjs");
const temporaryDirectory = await mkdtemp(join(tmpdir(), "review-ui-smoke-"));
const dataDirectory = join(temporaryDirectory, "data");

function environment(workspaceId) {
  return {
    ...process.env,
    REVIEW_UI_DATA_DIR: dataDirectory,
    CONDUCTOR_IS_LOCAL: "1",
    CONDUCTOR_WORKSPACE_ID: workspaceId,
    CONDUCTOR_WORKSPACE_NAME: workspaceId,
  };
}

function environmentWithDefaultStorage(workspaceId) {
  const result = environment(workspaceId);
  delete result.REVIEW_UI_DATA_DIR;
  result.PATH = "";
  return result;
}

async function run(workspaceId, argumentsList, { reject = false } = {}) {
  try {
    const result = await execFileAsync(process.execPath, [reviewScript, ...argumentsList], {
      env: environment(workspaceId),
      maxBuffer: 1024 * 1024,
    });
    if (reject) throw new Error(`Expected command to fail: ${argumentsList.join(" ")}`);
    return JSON.parse(result.stdout);
  } catch (error) {
    if (!reject) throw error;
    return error;
  }
}

async function runWithInput(workspaceId, argumentsList, input) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [reviewScript, ...argumentsList], {
      env: environment(workspaceId),
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", rejectRun);
    child.once("close", (code) => {
      const stdoutText = Buffer.concat(stdout).toString("utf8");
      const stderrText = Buffer.concat(stderr).toString("utf8");
      if (code === 0) resolveRun(JSON.parse(stdoutText));
      else rejectRun(new Error(`Command failed (${code}): ${stderrText}`));
    });
    child.stdin.end(input);
  });
}

async function createFixture(workspaceId, batchId) {
  const projectRoot = join(temporaryDirectory, workspaceId);
  const sourceDirectory = join(temporaryDirectory, `${workspaceId}-source`);
  await Promise.all([mkdir(projectRoot), mkdir(sourceDirectory)]);
  const before = join(sourceDirectory, "before.png");
  const after = join(sourceDirectory, "after.png");
  await Promise.all([writeFile(before, "before"), writeFile(after, "after")]);
  const manifest = join(sourceDirectory, "manifest.json");
  await writeFile(manifest, JSON.stringify({
    id: batchId,
    title: `Batch ${batchId}`,
    surfaces: [{ id: "home", title: "Home", before, after }],
  }));
  return { projectRoot, sourceDirectory, manifest };
}

try {
  const [fixtureA, fixtureB] = await Promise.all([
    createFixture("workspace-a", "batch-a"),
    createFixture("workspace-b", "batch-b"),
  ]);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [reviewScript, "status", "--root", fixtureB.projectRoot],
      { env: environmentWithDefaultStorage("workspace-b") },
    ),
    (error) => {
      assert.match(error.stderr, /No \.git entry exists/);
      return true;
    },
  );
  await assert.rejects(stat(join(fixtureB.projectRoot, ".git")), { code: "ENOENT" });
  await mkdir(join(fixtureB.projectRoot, ".git"));
  const directoryOnlyStatus = await execFileAsync(
    process.execPath,
    [reviewScript, "status", "--root", fixtureB.projectRoot],
    { env: environmentWithDefaultStorage("workspace-b") },
  );
  assert.equal(
    JSON.parse(directoryOnlyStatus.stdout).dataDirectory,
    join(await realpath(fixtureB.projectRoot), ".git", "review-ui-changes"),
    "an existing .git directory should be sufficient without running Git",
  );

  await execFileAsync("git", ["init", "--quiet"], { cwd: fixtureA.projectRoot });
  const defaultStorageStatus = await execFileAsync(
    process.execPath,
    [reviewScript, "status", "--root", fixtureA.projectRoot],
    { env: environmentWithDefaultStorage("workspace-a") },
  );
  assert.equal(
    JSON.parse(defaultStorageStatus.stdout).dataDirectory,
    join(await realpath(fixtureA.projectRoot), ".git", "review-ui-changes"),
  );
  await execFileAsync(
    "git",
    [
      "-c",
      "user.name=Review UI Test",
      "-c",
      "user.email=review-ui@example.invalid",
      "commit",
      "--allow-empty",
      "--quiet",
      "-m",
      "Initialize fixture",
    ],
    { cwd: fixtureA.projectRoot },
  );
  const linkedWorktree = join(temporaryDirectory, "workspace-a-linked");
  await execFileAsync(
    "git",
    ["worktree", "add", "--quiet", "--detach", linkedWorktree],
    { cwd: fixtureA.projectRoot },
  );
  const linkedStorageStatus = await execFileAsync(
    process.execPath,
    [reviewScript, "status", "--root", linkedWorktree],
    { env: environmentWithDefaultStorage("workspace-a-linked") },
  );
  assert.equal(
    JSON.parse(linkedStorageStatus.stdout).dataDirectory,
    JSON.parse(defaultStorageStatus.stdout).dataDirectory,
    "linked worktrees should share repository-local review storage",
  );

  const [publishedA, publishedB] = await Promise.all([
    run("workspace-a", ["publish", fixtureA.manifest, "--root", fixtureA.projectRoot]),
    run("workspace-b", ["publish", fixtureB.manifest, "--root", fixtureB.projectRoot]),
  ]);

  const urlA = new URL(publishedA.url);
  const urlB = new URL(publishedB.url);
  assert.equal(urlA.origin, urlB.origin, "workspaces should reuse one local server");
  assert.notEqual(publishedA.workspaceId, publishedB.workspaceId);
  assert.notEqual(publishedA.reviewId, publishedB.reviewId);
  assert.notEqual(urlA.searchParams.get("token"), urlB.searchParams.get("token"));

  const boardResponse = await fetch(urlA);
  assert.equal(boardResponse.status, 200);
  assert.match(await boardResponse.text(), /Review changes/);

  const stateResponse = await fetch(new URL(`/api/state${urlA.search}`, urlA.origin));
  assert.equal(stateResponse.status, 200);
  const state = await stateResponse.json();
  assert.equal(state.schemaVersion, 2);
  assert.equal(state.batches[0].id, "batch-a");
  const mediaResponse = await fetch(new URL(state.batches[0].surfaces[0].before, urlA.origin));
  assert.equal(mediaResponse.status, 200);
  assert.equal(await mediaResponse.text(), "before");

  const invalidTokenUrl = new URL(`/api/state${urlA.search}`, urlA.origin);
  invalidTokenUrl.searchParams.set("token", "wrong");
  assert.equal((await fetch(invalidTokenUrl)).status, 404);

  const commentResponse = await fetch(new URL(`/api/comments${urlA.search}`, urlA.origin), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      batchId: "batch-a",
      surfaceId: "home",
      revision: 1,
      body: "Increase spacing",
    }),
  });
  assert.equal(commentResponse.status, 201);
  const comment = await commentResponse.json();
  const feedback = await run("workspace-a", ["feedback", "--root", fixtureA.projectRoot]);
  assert.equal(feedback[0].id, comment.id);
  assert.equal(feedback[0].currentRevision, 1);
  assert.deepEqual(feedback[0].replies, []);

  const nextAfter = join(fixtureA.sourceDirectory, "after-r2.png");
  await writeFile(nextAfter, "after-r2");
  const staleManifest = join(fixtureA.sourceDirectory, "stale.json");
  await writeFile(staleManifest, JSON.stringify({
    id: "batch-a",
    title: "Batch batch-a",
    surfaces: [{ id: "home", title: "Home", after: nextAfter, expectedRevision: 0 }],
  }));
  const conflict = await run(
    "workspace-a",
    ["publish", staleManifest, "--root", fixtureA.projectRoot],
    { reject: true },
  );
  assert.match(conflict.stderr, /Revision conflict/);

  const nextManifest = join(fixtureA.sourceDirectory, "next.json");
  await writeFile(nextManifest, JSON.stringify({
    id: "batch-a",
    title: "Batch batch-a",
    surfaces: [{ id: "home", title: "Home", after: nextAfter, expectedRevision: 1 }],
  }));
  const revision = await run(
    "workspace-a",
    ["publish", nextManifest, "--root", fixtureA.projectRoot],
  );
  assert.equal(revision.surfaces[0].revision, 2);

  const stdinAfter = join(fixtureA.projectRoot, "after-r3.png");
  await writeFile(stdinAfter, "after-r3");
  const stdinRevision = await runWithInput(
    "workspace-a",
    ["publish", "-", "--root", fixtureA.projectRoot],
    JSON.stringify({
      id: "batch-a",
      title: "Batch batch-a",
      surfaces: [{
        id: "home",
        title: "Home",
        after: "after-r3.png",
        expectedRevision: 2,
      }],
    }),
  );
  assert.equal(stdinRevision.surfaces[0].revision, 3);

  const staleReadyResponse = await fetch(new URL(`/api/ready${urlA.search}`, urlA.origin), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ batchId: "batch-a", surfaceId: "home", revision: 1, ready: true }),
  });
  assert.equal(staleReadyResponse.status, 409);

  const missingReply = await run(
    "workspace-a",
    ["address", "--root", fixtureA.projectRoot, "--comment", comment.id],
    { reject: true },
  );
  assert.match(missingReply.stderr, /requires an agent reply/);

  const replyBody = "Increased spacing and republished this surface as revision 3.";
  const replied = await runWithInput(
    "workspace-a",
    ["reply", "--root", fixtureA.projectRoot, "--comment", comment.id, "--body", "-"],
    replyBody,
  );
  assert.equal(replied.commentId, comment.id);
  assert.equal(replied.reply.author, "agent");
  assert.equal(replied.reply.body, replyBody);

  const feedbackWithReply = await run("workspace-a", ["feedback", "--root", fixtureA.projectRoot]);
  assert.equal(feedbackWithReply[0].replies[0].id, replied.reply.id);
  const stateWithReply = await fetch(
    new URL(`/api/state${urlA.search}`, urlA.origin),
  ).then((response) => response.json());
  assert.equal(stateWithReply.comments[0].replies[0].body, replyBody);

  await run("workspace-a", ["address", "--root", fixtureA.projectRoot, "--comment", comment.id]);
  assert.deepEqual(await run("workspace-a", ["feedback", "--root", fixtureA.projectRoot]), []);

  const database = JSON.parse(await readFile(join(dataDirectory, "database.json"), "utf8"));
  assert.equal(database.schemaVersion, 2);
  assert.equal(database.workspaces.length, 2);
  assert.equal(database.reviews.length, 2);

  await run("workspace-a", ["stop", "--root", fixtureA.projectRoot]);
  const restarted = await run(
    "workspace-a",
    ["start", "--root", fixtureA.projectRoot, "--idle-minutes", "0.005"],
  );
  assert.equal(restarted.protocolVersion, 3);
  await new Promise((resolveWait) => setTimeout(resolveWait, 700));
  assert.equal(
    (await run("workspace-a", ["status", "--root", fixtureA.projectRoot])).running,
    false,
    "idle server should release its port",
  );

  process.stdout.write("review-ui-changes smoke test passed\n");
} finally {
  await run("workspace-a", ["stop", "--root", temporaryDirectory]).catch(() => {});
  await rm(temporaryDirectory, { recursive: true, force: true });
}
