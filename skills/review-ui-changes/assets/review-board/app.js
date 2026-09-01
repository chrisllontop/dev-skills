const batchNavigation = document.querySelector("#batches");
const content = document.querySelector("#content");
const summary = document.querySelector("#summary");
const emptyTemplate = document.querySelector("#empty-template");

const query = new URLSearchParams(window.location.search);
const reviewId = query.get("review");
const accessToken = query.get("token");
let state = null;
let stateSignature = null;
let loadingPromise = null;
let selectedBatchId = query.get("batch");
let showApproved = query.get("approved") === "1";

const iconPaths = {
  check: [["path", { d: "m5 12 4 4L19 6" }]],
  checkCircle: [
    ["path", { d: "M22 11.08V12a10 10 0 1 1-5.93-9.14" }],
    ["path", { d: "m9 11 3 3L22 4" }],
  ],
  chevronDown: [["path", { d: "m6 9 6 6 6-6" }]],
  chevronUp: [["path", { d: "m18 15-6-6-6 6" }]],
  externalLink: [
    ["path", { d: "M15 3h6v6" }],
    ["path", { d: "m10 14 11-11" }],
    ["path", { d: "M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" }],
  ],
  eye: [
    ["path", { d: "M2.06 12.35a1 1 0 0 1 0-.7C3.79 7.6 7.73 5 12 5c4.27 0 8.21 2.6 9.94 6.65a1 1 0 0 1 0 .7C20.21 16.4 16.27 19 12 19c-4.27 0-8.21-2.6-9.94-6.65" }],
    ["circle", { cx: "12", cy: "12", r: "3" }],
  ],
  eyeOff: [
    ["path", { d: "m2 2 20 20" }],
    ["path", { d: "M6.71 6.71C4.93 7.9 3.46 9.6 2.46 11.73a.7.7 0 0 0 0 .54C4.24 16.07 7.84 18.5 12 18.5c1.28 0 2.51-.23 3.64-.65" }],
    ["path", { d: "M10.73 5.58A10.8 10.8 0 0 1 12 5.5c4.16 0 7.76 2.43 9.54 6.23a.7.7 0 0 1 0 .54 12 12 0 0 1-2.04 3.05" }],
  ],
  message: [
    ["path", { d: "M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z" }],
  ],
  rotate: [
    ["path", { d: "M3 12a9 9 0 1 0 3-6.7L3 8" }],
    ["path", { d: "M3 3v5h5" }],
  ],
  send: [
    ["path", { d: "m22 2-7 20-4-9-9-4Z" }],
    ["path", { d: "M22 2 11 13" }],
  ],
};

function icon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("icon");
  for (const [tag, attributes] of iconPaths[name]) {
    const child = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [attribute, value] of Object.entries(attributes)) child.setAttribute(attribute, value);
    svg.append(child);
  }
  return svg;
}

function element(tag, attributes = {}, children = []) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (name === "className") node.className = value;
    else if (name === "text") node.textContent = value;
    else if (name.startsWith("on")) node.addEventListener(name.slice(2).toLowerCase(), value);
    else node.setAttribute(name, value);
  }
  for (const child of children) node.append(child);
  return node;
}

function button(attributes, children) {
  return element("button", { type: "button", ...attributes }, children);
}

async function request(path, options) {
  const requestUrl = new URL(path, window.location.origin);
  if (reviewId) requestUrl.searchParams.set("review", reviewId);
  if (accessToken) requestUrl.searchParams.set("token", accessToken);
  const response = await fetch(requestUrl, {
    ...options,
    headers: { "content-type": "application/json", ...(options?.headers ?? {}) },
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error ?? "Request failed");
  return payload;
}

function isApproved(surface) {
  return surface.readyRevision === surface.revision;
}

function commentsFor(batchId, surfaceId) {
  return state.comments.filter((comment) => comment.batchId === batchId && comment.surfaceId === surfaceId);
}

function renderComment(comment, currentRevision) {
  const stale = comment.revision !== currentRevision;
  const details = [comment.status === "open" ? "Open" : "Addressed", `Revision ${comment.revision}`];
  if (stale) details.push("Older image");
  const replies = comment.replies ?? [];
  return element("article", { className: `comment ${comment.status}` }, [
    element("div", { className: "comment-content" }, [
      element("div", { className: "comment-meta", text: details.join(" · ") }),
      element("p", { text: comment.body }),
    ]),
    ...(replies.length
      ? [element(
          "div",
          { className: "agent-replies", "aria-label": "Agent responses" },
          replies.map((reply) => element("div", { className: "agent-reply" }, [
            element("div", {
              className: "agent-reply-meta",
              text: `Agent response · ${new Date(reply.createdAt).toLocaleString()}`,
            }),
            element("p", { text: reply.body }),
          ])),
        )]
      : []),
  ]);
}

function renderShot(label, source, alt, emphasized = false) {
  return element("section", { className: `shot ${emphasized ? "is-after" : ""}` }, [
    element("div", { className: "shot-header" }, [
      element("span", { className: "shot-label", text: label }),
      element("span", { className: "shot-open" }, [
        element("span", { text: "Open image" }),
        icon("externalLink"),
      ]),
    ]),
    element("a", { className: "shot-link", href: source, target: "_blank", rel: "noreferrer" }, [
      element("img", { src: source, alt, loading: "lazy" }),
    ]),
  ]);
}

function renderSurface(batch, surface) {
  const comments = commentsFor(batch.id, surface.id);
  const approved = isApproved(surface);
  const action = button(
    {
      className: approved ? "button button-ghost" : "button button-primary",
      "aria-pressed": String(approved),
      onclick: async () => {
        action.disabled = true;
        try {
          await request("/api/ready", {
            method: "POST",
            body: JSON.stringify({
              batchId: batch.id,
              surfaceId: surface.id,
              revision: surface.revision,
              ready: !approved,
            }),
          });
          showApproved = false;
          const url = new URL(window.location.href);
          url.searchParams.delete("approved");
          window.history.replaceState({}, "", url);
          await load();
        } catch (error) {
          window.alert(error.message);
          await load();
        } finally {
          action.disabled = false;
        }
      },
    },
    [icon(approved ? "rotate" : "check"), element("span", { text: approved ? "Reopen" : "Mark ready" })],
  );

  const form = element("form", { className: "comment-form" });
  const textarea = element("textarea", {
    id: `comment-${batch.id}-${surface.id}`,
    name: "comment",
    required: "",
    maxlength: "4000",
    placeholder: "Describe the visual change you want…",
  });
  form.append(
    element("div", { className: "form-heading" }, [
      element("div", {}, [
        element("label", { for: textarea.id, text: "Leave feedback" }),
        element("p", { text: `Attached to revision ${surface.revision}` }),
      ]),
      icon("message"),
    ]),
    textarea,
    element("div", { className: "form-footer" }, [
      element("span", { text: "The agent reads this on your next message." }),
      element("button", { type: "submit", className: "button button-secondary" }, [
        icon("send"),
        element("span", { text: "Send feedback" }),
      ]),
    ]),
  );
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const submit = form.querySelector("button");
    submit.disabled = true;
    try {
      await request("/api/comments", {
        method: "POST",
        body: JSON.stringify({
          batchId: batch.id,
          surfaceId: surface.id,
          revision: surface.revision,
          body: textarea.value,
        }),
      });
      await load();
    } catch (error) {
      window.alert(error.message);
      submit.disabled = false;
    }
  });

  const commentList = element(
    "div",
    { className: `comment-list ${comments.length ? "" : "is-empty"}` },
    comments.length
      ? comments.map((comment) => renderComment(comment, surface.revision))
      : [icon("message"), element("p", { text: "No feedback on this surface yet." })],
  );

  return element("article", { className: `surface ${approved ? "is-approved" : ""}` }, [
    element("header", { className: "surface-header" }, [
      element("div", { className: "surface-title" }, [
        element("div", { className: "surface-title-row" }, [
          element("h3", { text: surface.title }),
          element("span", { className: "badge", text: `R${surface.revision}` }),
          ...(approved ? [element("span", { className: "badge badge-success", text: "Approved" })] : []),
        ]),
        element("p", { text: approved ? "Approved for this revision" : "Compare both states, then approve or leave feedback" }),
      ]),
      action,
    ]),
    element("div", { className: "comparison" }, [
      renderShot("Before", surface.before, `${surface.title}, before`),
      renderShot("After", surface.after, `${surface.title}, after revision ${surface.revision}`, true),
    ]),
    element("footer", { className: "feedback" }, [commentList, form]),
  ]);
}

function setView({ batchId = selectedBatchId, approved = showApproved } = {}) {
  selectedBatchId = batchId;
  showApproved = approved;
  const url = new URL(window.location.href);
  url.searchParams.set("batch", batchId);
  if (approved) url.searchParams.set("approved", "1");
  else url.searchParams.delete("approved");
  window.history.replaceState({}, "", url);
  render();
}

function renderSummary(pending, approved, openComments) {
  summary.replaceChildren(
    element("span", { className: "summary-item" }, [
      element("strong", { text: String(pending) }),
      element("span", { text: pending === 1 ? "pending" : "pending" }),
    ]),
    element("span", { className: "summary-divider", "aria-hidden": "true" }),
    element("span", { className: "summary-item" }, [
      element("strong", { text: String(approved) }),
      element("span", { text: "approved" }),
    ]),
    element("span", { className: "summary-divider", "aria-hidden": "true" }),
    element("span", { className: "summary-item" }, [
      element("strong", { text: String(openComments) }),
      element("span", { text: openComments === 1 ? "open comment" : "open comments" }),
    ]),
  );
}

function render() {
  batchNavigation.replaceChildren();
  content.replaceChildren();

  if (!state.batches.length) {
    summary.textContent = "No surfaces";
    content.append(emptyTemplate.content.cloneNode(true));
    return;
  }

  const selected = state.batches.find((batch) => batch.id === selectedBatchId) ?? state.batches[0];
  selectedBatchId = selected.id;
  for (const batch of state.batches) {
    const approvedCount = batch.surfaces.filter(isApproved).length;
    batchNavigation.append(
      button(
        {
          className: "batch-tab",
          "aria-current": String(batch.id === selected.id),
          onclick: () => setView({ batchId: batch.id, approved: false }),
        },
        [
          element("span", { text: batch.title }),
          element("span", { className: "batch-count", text: `${batch.surfaces.length - approvedCount}` }),
        ],
      ),
    );
  }

  const openComments = state.comments.filter(
    (comment) => comment.batchId === selected.id && comment.status === "open",
  ).length;
  const approved = selected.surfaces.filter(isApproved);
  const pending = selected.surfaces.filter((surface) => !isApproved(surface));
  const visible = showApproved ? selected.surfaces : pending;
  renderSummary(pending.length, approved.length, openComments);

  const approvedToggle = approved.length
    ? button(
        {
          className: "approved-toggle",
          "aria-expanded": String(showApproved),
          onclick: () => setView({ approved: !showApproved }),
        },
        [
          icon(showApproved ? "eyeOff" : "eye"),
          element("span", { text: showApproved ? "Hide approved" : `Show approved (${approved.length})` }),
          icon(showApproved ? "chevronUp" : "chevronDown"),
        ],
      )
    : null;

  content.append(
    element("div", { className: "batch-heading" }, [
      element("div", {}, [
        element("h2", { text: selected.title }),
        element("p", {
          className: "muted",
          text: `${pending.length} awaiting review · Updated ${new Date(selected.updatedAt).toLocaleString()}`,
        }),
      ]),
      ...(approvedToggle ? [approvedToggle] : []),
    ]),
  );

  if (visible.length) {
    content.append(
      element(
        "div",
        { className: "surface-list" },
        visible.map((surface) => renderSurface(selected, surface)),
      ),
    );
  } else {
    content.append(
      element("div", { className: "complete-state" }, [
        element("div", { className: "complete-icon" }, [icon("checkCircle")]),
        element("p", { className: "eyebrow", text: "Review complete" }),
        element("h3", { text: "Everything is approved" }),
        element("p", { className: "muted", text: "There are no surfaces waiting for your review." }),
        ...(approvedToggle ? [approvedToggle.cloneNode(true)] : []),
      ]),
    );
    const clonedToggle = content.querySelector(".complete-state .approved-toggle");
    if (clonedToggle) clonedToggle.addEventListener("click", () => setView({ approved: true }));
  }

  content.append(
    element("aside", { className: "handoff-hint" }, [
      icon("message"),
      element("p", {}, [
        element("strong", { text: "Finished reviewing?" }),
        document.createTextNode(" Return to your agent and say “Feedback is ready.” Agent responses will appear here automatically."),
      ]),
    ]),
  );
}

function hasDraft() {
  return [...document.querySelectorAll("textarea")].some((textarea) => textarea.value.trim());
}

async function load({ silent = false } = {}) {
  if (loadingPromise) return loadingPromise;
  loadingPromise = (async () => {
    try {
      const nextState = await request("/api/state");
      const nextSignature = JSON.stringify(nextState);
      if (nextSignature !== stateSignature) {
        state = nextState;
        stateSignature = nextSignature;
        render();
      }
    } catch (error) {
      if (silent) return;
      summary.textContent = "Unable to load review";
      content.replaceChildren(
        element("div", { className: "empty-state" }, [
          element("h2", { text: "The review could not be loaded" }),
          element("p", { text: error.message }),
        ]),
      );
    } finally {
      loadingPromise = null;
    }
  })();
  return loadingPromise;
}

function refreshIfIdle() {
  if (!document.hidden && !hasDraft()) void load({ silent: true });
}

window.setInterval(refreshIfIdle, 5000);
window.addEventListener("focus", refreshIfIdle);
document.addEventListener("visibilitychange", refreshIfIdle);
void load();
