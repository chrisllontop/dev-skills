# Frontend Skills

A collection of open Agent Skills for frontend development. Every directory under `skills/` is self-contained and can be installed independently in a compatible coding agent.

## Skills

| Skill | Purpose | Runtime |
| --- | --- | --- |
| [`review-ui-changes`](skills/review-ui-changes/) | Review before-and-after UI screenshots asynchronously on a local board. | Node.js 20+, local browser and screenshot tooling |

## Install

List or select skills from this repository with the open skills CLI:

```bash
npx skills add chrisllontop/frontend-skills
```

Install a specific skill:

```bash
npx skills add chrisllontop/frontend-skills --skill review-ui-changes
```

Add `-g` for a user-level installation, or use `-a codex`, `-a claude-code`, `-a cursor`, or another supported agent selector.

In Codex, the built-in installer can install the skill directory directly:

```text
$skill-installer install https://github.com/chrisllontop/frontend-skills/tree/main/skills/review-ui-changes
```

## `review-ui-changes`

The coding agent captures screenshots with the browser tooling it already has, publishes before-and-after pairs to a local board, and ends its turn. You review the images asynchronously, mark surfaces ready, or leave comments. On the next turn, the agent reads only unresolved feedback, makes corrections, republishes, and marks handled comments addressed.

The board and its state stay on your machine. A single loopback service is shared by local agents, while random workspace IDs, review IDs, and access tokens keep reviews separate. There is no hosted service, account, telemetry, screenshot capture, or runtime npm dependency.

### Requirements

- Node.js 20 or newer.
- A local coding agent with browser or screenshot tooling, such as Playwright.
- The application running locally in a state the agent can navigate.

The skill does not install or configure screenshot tooling.

### Use

Ask your agent to use the skill while making a UI change:

```text
Use the review-ui-changes skill for this work. Capture every empty state before
changing it, make the requested corrections, and publish the review when done.
```

The agent returns a token-bearing loopback URL such as `http://127.0.0.1:53184/?review=…&token=…&batch=empty-states`. Keep the complete URL private. Marking a surface Ready hides it from the default view; use **Show approved** to inspect or reopen approved surfaces.

The board does not push events into the agent's active turn. After leaving feedback, return to the chat and send a short signal:

```text
I left feedback on the visual review.
```

The agent reads open, revision-bound comments from the current workspace. You do not need to paste the review URL, comment text, or a session code.

### Persistence and isolation

The first `before` image for each surface remains immutable. Republishing `after` increments the surface revision, resets Ready, and keeps comments attached to the revision the reviewer actually saw. An `expectedRevision` field prevents concurrent agents from overwriting a newer image.

The agent creates source screenshots and the manifest in a temporary directory outside the repository, publishes copies, and removes those temporary files after publication. Persisted state and copied screenshots live in the user's local application-data directory:

- macOS: `~/Library/Application Support/review-ui-changes/`
- Linux: `$XDG_STATE_HOME/review-ui-changes/` or `~/.local/state/review-ui-changes/`

Conductor workspaces are resolved using `CONDUCTOR_WORKSPACE_ID`; other local environments use the canonical project path. Agent sessions are deliberately not identities, so a later agent can continue the same review.

The shared server chooses an available port automatically and stops after four hours without requests by default. Persisted reviews remain available after it stops.

### Manual commands

```bash
node skills/review-ui-changes/scripts/review.mjs publish /path/to/manifest.json
node skills/review-ui-changes/scripts/review.mjs feedback
node skills/review-ui-changes/scripts/review.mjs address --comment <comment-id>
node skills/review-ui-changes/scripts/review.mjs status
node skills/review-ui-changes/scripts/review.mjs stop
```

`stop` closes the shared service for every currently open local review but does not delete state or images. A later `publish` or `start` launches it again. After `start`, `status` prints fresh token-bearing URLs for persisted reviews in the current workspace.

The first publication uses this manifest shape:

```json
{
  "id": "empty-states",
  "title": "Empty states",
  "surfaces": [
    {
      "id": "courses-empty",
      "title": "Courses / empty",
      "before": "/path/to/courses-before.png",
      "after": "/path/to/courses-after.png"
    }
  ]
}
```

On a later revision, omit `before` and include the current revision:

```json
{
  "id": "empty-states",
  "title": "Empty states",
  "surfaces": [
    {
      "id": "courses-empty",
      "title": "Courses / empty",
      "after": "/path/to/courses-after-r2.png",
      "expectedRevision": 1
    }
  ]
}
```

### Scope

`review-ui-changes` supports human judgment of static screenshots. It does not capture images, run in CI, maintain cross-session regression baselines, or cover hover, focus, open dropdowns, transitions, and other interactive states. It complements accessibility, interaction, and visual-regression testing.

## Repository conventions

```text
skills/
└── <skill-name>/
    ├── SKILL.md              # Required
    ├── agents/openai.yaml    # Optional OpenAI metadata
    ├── scripts/              # Optional deterministic tooling
    ├── references/           # Optional on-demand documentation
    └── assets/               # Optional templates and runtime assets
```

For every new skill:

1. Use a unique lowercase kebab-case folder and matching `name` in `SKILL.md`.
2. Keep the folder independently installable; do not import runtime files from another skill or the repository root.
3. Put host-neutral instructions in `SKILL.md` and host-specific metadata in optional host directories.
4. Add the skill to the catalog and add focused tests under `tests/` when it contains executable behavior.
5. Validate the skill with `skills-ref` and run its focused tests.

## Development

```bash
skills-ref validate skills/review-ui-changes
npm test
```

Install `skills-ref` from the [Agent Skills reference repository](https://github.com/agentskills/agentskills/tree/main/skills-ref). Validate each directory under `skills/` individually. `npm test` discovers every `tests/*.test.mjs` file and verifies executable behavior separately from the skill format.

## License

MIT
