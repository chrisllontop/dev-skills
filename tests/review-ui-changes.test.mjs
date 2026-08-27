import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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

  const staleReadyResponse = await fetch(new URL(`/api/ready${urlA.search}`, urlA.origin), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ batchId: "batch-a", surfaceId: "home", revision: 1, ready: true }),
  });
  assert.equal(staleReadyResponse.status, 409);

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
  assert.equal(restarted.protocolVersion, 2);
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
