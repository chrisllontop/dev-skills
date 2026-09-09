---
name: review-ui-changes
description: Publish before-and-after UI screenshots to Platform for asynchronous human review, then read and answer the reviewer's comments. Use when making or auditing UI changes across one or more static surfaces and a human needs to see images, leave revision-bound feedback, and receive agent replies. Requires the Platform MCP server connected to the app under review, plus a separate browser or screenshot capability; does not capture screenshots, test interactions, or check visual regressions.
---

# Review UI Changes

Move visual review out of the chat: publish screenshots to Platform, hand the reviewer a link, and end the turn. The reviewer comments whenever they get to it, and a later turn reads that feedback, corrects the UI, republishes, and answers each comment in place.

Capture screenshots with the browser tooling already available in the environment. This skill does not capture them.

## Prerequisites

Platform's MCP server must be connected and bound to the app under review, with the `reviews:read` and `reviews:write` scopes. Confirm with `reviews_list`. If the tools are missing, explain that the Platform MCP server is not connected and stop. If screenshot tooling is unavailable, explain the missing prerequisite and stop. Never substitute imagined screenshots.

Screenshots are uploaded from the shell. Never read a PNG into the conversation, and never pass image bytes or base64 to a tool: a single screenshot would consume tens of thousands of tokens.

## Publish a review

1. Choose one short, stable name per surface, such as `Courses / empty`. Reuse the exact name when republishing.
2. Before editing the UI, capture the original screenshot of every requested surface.
3. Make the requested changes.
4. Capture the same surfaces again at matching routes, viewport sizes, data, and scroll positions.
5. Call `reviews_publish` with `title` and one entry per surface, setting `includeBefore: true` on first publication:

```json
{
  "title": "Empty states",
  "surfaces": [{ "name": "Courses / empty", "includeBefore": true }]
}
```

6. Upload every image the response asks for, straight from the shell. Each URL is single-use and expires in 15 minutes:

```bash
curl -sS --upload-file /absolute/path/courses-before.png "<uploads.before>"
curl -sS --upload-file /absolute/path/courses-after.png "<uploads.after>"
```

7. Give the reviewer the `url` from the response, summarize the included surfaces, and end the turn. Never poll or wait for the review to complete.

Keep `reviewId` from the response. A later turn can also recover it with `reviews_list`, which returns the app's reviews with the most recent activity first.

## Republish a surface

Pass the same `reviewId` and the same surface `name`. The first `before` image is immutable; republishing replaces only `after` and increments the surface revision. Set `expectedRevision` to the revision you last saw so a concurrent agent's newer image is never overwritten:

```json
{
  "reviewId": "rev_...",
  "surfaces": [{ "name": "Courses / empty", "expectedRevision": 1 }]
}
```

Include only the surfaces whose `after` image actually changed.

## Act on feedback

When the user says feedback is ready, read the open comments once with `reviews_feedback`. Each entry carries the revision its author saw, the current revision, and `stale`.

For each actionable comment:

1. Inspect the referenced surface and revision.
2. Apply the correction.
3. Capture a new `after` screenshot under the same conditions.
4. Republish only that surface with `expectedRevision` set to `currentRevision`, and upload the new image.
5. Only after the upload succeeds, answer with `reviews_reply`, stating concretely what changed and the new revision.
6. Mark the comment handled with `reviews_resolve`.

`reviews_resolve` refuses a comment that has no reply, so feedback is never closed silently. If no visual change is needed, reply with the reason before resolving. If a comment is ambiguous, needs a reviewer decision, or cannot be acted on, reply with the specific question or blocker and leave it open. If a comment is stale, verify whether it still applies to the current image before editing, and explain the outcome in the reply.

## Maintain scope

- Use reviews only for static visual judgment.
- Do not claim coverage of hover, focus, open menus, transitions, drag states, or other interactions.
- Do not treat an original image as a persistent regression baseline across unrelated reviews.
- Do not replace existing accessibility, interaction, or automated visual-regression checks.
- Screenshots are stored in Platform and are visible to every member of the app's organization. Do not publish screenshots containing real customer data or secrets.
