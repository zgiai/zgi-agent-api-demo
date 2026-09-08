import assert from "node:assert/strict";
import test from "node:test";

import {
  isPendingInteractionDisabled,
  normalizeApprovalState,
} from "../src/lib/approval-state.ts";

test("normalizes the nested approval_requested event emitted by Agent API", () => {
  const state = normalizeApprovalState({
    ui_approval_allowed: true,
    approval_form_id: "form-1",
    approval_token: "top-level-token",
    approval_form: {
      id: "form-1",
      node_title: "发布审批",
      content: "确认发布吗？",
      expiration_at: 1789002351,
      fields: [{ id: "comment", type: "text" }],
      actions: [
        { id: "approve", label: "通过" },
        { id: "reject", label: "驳回" },
      ],
      token: "form-token",
    },
  });

  assert.equal(state.uiAllowed, true);
  assert.equal(state.token, "top-level-token");
  assert.equal(state.formId, "form-1");
  assert.equal(state.title, "发布审批");
  assert.equal(state.fields.length, 1);
  assert.deepEqual(state.actions.map((action) => action.id), ["approve", "reject"]);
  assert.equal(state.expiresAt, 1789002351);
});

test("keeps compatibility with legacy flattened approval events", () => {
  const state = normalizeApprovalState({
    ui_approval_allowed: true,
    token: "legacy-token",
    form_id: "legacy-form",
    title: "旧版审批",
    actions: [{ id: "approve" }],
    expires_at: "2026-09-10T01:05:51Z",
  });

  assert.equal(state.token, "legacy-token");
  assert.equal(state.formId, "legacy-form");
  assert.equal(state.actions.length, 1);
  assert.equal(state.expiresAt, "2026-09-10T01:05:51Z");
});

test("uses the persisted form while honoring continuation permissions", () => {
  const state = normalizeApprovalState(
    { ui_approval_allowed: false, approval_token: "continuation-token" },
    { id: "persisted-form", actions: [{ id: "approve" }] },
  );

  assert.equal(state.uiAllowed, false);
  assert.equal(state.token, "continuation-token");
  assert.equal(state.formId, "persisted-form");
  assert.equal(state.actions.length, 1);
});

test("enables a pending interaction when the message is waiting even if HTTP is still closing", () => {
  assert.equal(isPendingInteractionDisabled(true, "streaming", false), true);
  assert.equal(isPendingInteractionDisabled(true, "waiting", false), false);
  assert.equal(isPendingInteractionDisabled(false, "waiting", true), true);
});
