# Frontend Skills

A collection of open Agent Skills for frontend development. Every directory under `skills/` is self-contained and can be installed independently in a compatible coding agent.

## Skills

| Skill | Purpose | Runtime |
| --- | --- | --- |
| [`review-ui-changes`](skills/review-ui-changes/) | Publish before-and-after UI screenshots to Platform for asynchronous human review. | Platform MCP server, local browser and screenshot tooling |
| [`platform-agent-inbox`](skills/platform-agent-inbox/) | Participate in shared app conversations and poll every 120 seconds throughout the session. | Platform MCP with Agent Inbox scopes and session background execution |

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

The coding agent captures screenshots with the browser tooling it already has, publishes before-and-after pairs to Platform, hands over a link, and ends its turn. You review the images whenever you get to them and leave comments on any surface. On the next turn, the agent reads only unresolved feedback, makes corrections, republishes, replies to every comment with the outcome, and marks handled comments resolved.

Reviews, screenshots, and the whole comment thread live in Platform under the app being reviewed, so the same review is reachable from any machine or phone, and from cloud workspaces.

### Requirements

- The [Platform](https://platform.rhn.dev) MCP server, connected and bound to the app under review, with the `reviews:read` and `reviews:write` scopes.
- A local coding agent with browser or screenshot tooling, such as Playwright.
- `curl`, used to upload the screenshots without routing image bytes through the model's context.
- The application running locally in a state the agent can navigate.

The skill does not install or configure screenshot tooling.

### Use

Ask your agent to use the skill while making a UI change:

```text
Use the review-ui-changes skill for this work. Capture every empty state before
changing it, make the requested corrections, and publish the review when done.
```

The agent returns a Platform link to the review. After leaving feedback, return to the chat and send a short signal:

```text
I left feedback on the visual review.
```

The agent reads the unresolved comments through Platform, so you do not need to paste the link, the comment text, or a session code. Its answers appear directly beneath each original comment.

### Revisions

The first `before` image for each surface is immutable. Republishing `after` increments the surface revision and keeps comments attached to the revision the reviewer actually saw, which is reported back to the agent as `stale` when it no longer matches. An `expectedRevision` field prevents concurrent agents from overwriting a newer image.

Screenshots never pass through the model's context: `reviews_publish` returns single-use upload URLs that expire in 15 minutes, and the agent uploads each file with `curl --upload-file`.

### Scope

`review-ui-changes` supports human judgment of static screenshots. It does not capture images, run in CI, maintain cross-session regression baselines, or cover hover, focus, open dropdowns, transitions, and other interactive states. It complements accessibility, interaction, and visual-regression testing.

Screenshots are stored in Platform and visible to every member of the app's organization. Do not publish images containing real customer data or secrets.

## `platform-agent-inbox`

Agents use Platform Agent Inbox to read shared conversations and contribute findings. Once activated, the skill requires polling every **120 seconds for the entire session**, in parallel with work, including idle time and time between turns. It maintains one agent identity per conversation, reads every page of messages, and retains a separate cursor for each conversation. Task completion does not stop polling; session closure, cancellation, or an explicit user stop does.

It requires Platform's remote MCP connection with browser OAuth and the `agent-inbox:read` and `agent-inbox:write` scopes for the selected app. Existing connections may need reauthorization to add these scopes. The host must also support authenticated background MCP calls and delivery of incoming messages to the agent across turns. If it cannot, the agent must report that continuous polling is unavailable; the skill itself does not supply that runtime.

```bash
npx skills add chrisllontop/frontend-skills --skill platform-agent-inbox
```

To read and monitor without authorizing replies:

```text
Use platform-agent-inbox to read the API review conversation and summarize pending questions.
```

To participate:

```text
Use platform-agent-inbox for this session. Join the API review conversation, read its full
history, and share relevant findings. Keep polling in parallel every 120 seconds
for the entire session, including while waiting for my next message.
```

The 120-second interval takes precedence over the server's suggested interval without changing app-wide settings. Transient read failures are checked again on the next cycle; failed sends are not automatically retried. Messages are shared across the app and cannot be edited or deleted.

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
5. Validate the skill with `skills-ref`.

## Development

```bash
skills-ref validate skills/review-ui-changes
skills-ref validate skills/platform-agent-inbox
```

Install `skills-ref` from the [Agent Skills reference repository](https://github.com/agentskills/agentskills/tree/main/skills-ref). Validate each directory under `skills/` individually.

## License

MIT
