---
name: review-ui-changes
description: Publish and iterate on asynchronous local visual reviews from before-and-after screenshots. Use when making or auditing UI changes across one or more static surfaces and a human needs to review images, mark surfaces ready, leave revision-bound comments, receive agent replies, or send unresolved visual feedback back to the coding agent. Requires a separate browser or screenshot capability and a running app; does not test interactions or visual regressions.
---

# Review UI Changes

Use the bundled script and board to move visual review state out of the chat. Capture screenshots with the browser tooling already available in the environment; this skill does not capture them. The script starts one repository-local review service that workspaces of the same repository reuse and isolates each review with a random ID and access token.

## Locate the script

Resolve `scripts/review.mjs` relative to this `SKILL.md` and use its absolute path as `<review-script>`. Run it from the project root so the script can resolve the current workspace identity. In Conductor it uses `CONDUCTOR_WORKSPACE_ID`; elsewhere it persists an identity for the canonical project path.

Require Node.js 20 or newer:

```bash
node --version
node <review-script> --help
```

If the project does not already have a `.git` entry, explain that repository-local persistence is unavailable and stop. Never run or initialize Git for this skill. If Node or screenshot tooling is unavailable, explain the missing prerequisite and stop. Do not substitute imagined screenshots. Do not publish from a Conductor cloud workspace because its loopback URL is not reachable from the reviewer's Mac.

## Publish a review

1. Choose stable, lowercase IDs for the batch and each surface.
2. Before editing the UI, navigate to every requested static surface and capture its original screenshot with the available screenshot tooling.
3. Make the requested changes.
4. Capture the same surfaces again at matching routes, viewport sizes, data, and scroll positions.
5. Pass a manifest to the publish command on stdin. Use the screenshot paths returned by the capture tooling; the skill does not require a particular source directory:

```bash
node <review-script> publish - <<'JSON'
{
  "id": "empty-states",
  "title": "Empty states",
  "surfaces": [
    {
      "id": "courses-empty",
      "title": "Courses / empty",
      "before": "/absolute/path/courses-before.png",
      "after": "/absolute/path/courses-after.png"
    }
  ]
}
JSON
```

The command copies the images into the repository's local Git metadata before it returns, starts or reuses the shared board, and prints JSON containing `workspaceId`, `reviewId`, and a token-bearing `url`. After successful publication, remove source screenshots only when you created them solely for this review and know they are safe to delete. Give the complete URL to the user, summarize the included surfaces, and end the turn. Never poll or wait for review completion. Treat the URL as private local data because its token grants access to that review.

The first published `before` image for a surface is immutable. Republishing the same batch and surface ID increments its revision, replaces only `after`, and resets that surface's Ready state. Omit `before` on later revisions:

```json
{
  "id": "empty-states",
  "title": "Empty states",
  "surfaces": [
    {
      "id": "courses-empty",
      "title": "Courses / empty",
      "after": "/absolute/path/courses-after-r2.png",
      "expectedRevision": 1
    }
  ]
}
```

For every existing surface, set `expectedRevision` to the current revision returned by `publish` or `feedback`. A conflicting publication fails instead of overwriting another agent's revision.

Ready surfaces are hidden from the board's default view. The reviewer can use **Show approved** to inspect or reopen them. Approval, comments, and agent replies are persisted under the repository's common Git directory and associated with the current workspace; the reviewer does not need to send a URL or session identifier back to the agent. Replies appear beneath their original comment and the board checks for them automatically while it is open.

On later revisions, include only surfaces whose `after` image actually changed. Unchanged Ready surfaces must be omitted from the manifest so they keep their approved revision and remain hidden. A previously Ready surface should reappear only when its image changed and therefore needs fresh approval.

## Act on feedback

When the user says feedback is ready, read open comments once:

```bash
node <review-script> feedback
```

The JSON output includes the comment ID, the revision the reviewer saw, the current revision, `stale`, and any replies already sent for that comment. Handle only returned open comments.

For each actionable comment:

1. Inspect the referenced surface and revision.
2. Apply the correction.
3. Capture a new `after` screenshot under the same conditions.
4. Republish only the changed surface under the same batch and surface ID, without a new `before`, and set `expectedRevision` to `currentRevision`. Do not include unchanged Ready surfaces.
5. Only after successful publication, reply to the original comment with a concise, concrete summary of what changed and the new revision. Use `--body -` for a multiline reply:

```bash
node <review-script> reply --comment <comment-id> --body - <<'REPLY'
Updated the spacing and republished this surface as revision 2.
REPLY
```

6. After the reply succeeds, mark the handled comment addressed:

```bash
node <review-script> address --comment <comment-id>
```

Every handled comment must receive its own reply; `address` rejects comments that do not have one. If no visual change is needed, reply with the reason or answer before addressing it. If feedback is ambiguous, needs a reviewer decision, or cannot be acted on, reply with the specific question or blocker and leave the comment open. If a comment is stale, verify whether it still applies to the current image before editing and explain the outcome in its reply. Never silently address feedback.

## Maintain scope

- Use the board only for static visual judgment.
- Do not claim coverage of hover, focus, open menus, transitions, drag states, or other interactions.
- Do not treat the original image as a persistent regression baseline across unrelated batches.
- Do not replace existing accessibility, interaction, or automated visual-regression checks.
- Keep screenshots and review state local. The shared server binds to `127.0.0.1`, chooses an available port automatically, and requires the review token for API and media requests.
- The durable copies and review database live under `.git/review-ui-changes/` in the repository's common Git directory. They are shared by linked worktrees but never enter the tracked working tree.
- Let the shared server survive the agent turn so asynchronous review remains available. It stops after four hours without requests by default and restarts on the next publication.

Use `node <review-script> status`, `start`, or `stop` only when lifecycle diagnostics are needed. `stop` affects the shared server and therefore every open local review, but does not delete persisted reviews.
