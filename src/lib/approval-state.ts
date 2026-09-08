import type { JsonObject } from "./agent-api-types";

export interface ApprovalState {
  uiAllowed: boolean;
  token: string;
  formId: string;
  title: string;
  content: unknown;
  fields: JsonObject[];
  actions: JsonObject[];
  expiresAt?: string | number;
}

export function isPendingInteractionDisabled(
  streaming: boolean,
  connectionPhase: string,
  continuationInFlight: boolean,
): boolean {
  return continuationInFlight || (streaming && connectionPhase !== "waiting");
}

export function normalizeApprovalState(
  envelope: JsonObject,
  persistedForm?: JsonObject,
): ApprovalState {
  const nestedForm = objectValue(envelope.approval_form);
  const form = persistedForm && Object.keys(persistedForm).length
    ? persistedForm
    : Object.keys(nestedForm).length
      ? nestedForm
      : envelope;

  return {
    uiAllowed: envelope.ui_approval_allowed !== false,
    token: stringValue(envelope.approval_token)
      || stringValue(envelope.token)
      || stringValue(form.token)
      || stringValue(form.approval_token),
    formId: stringValue(envelope.approval_form_id)
      || stringValue(envelope.form_id)
      || stringValue(form.id)
      || stringValue(form.form_id),
    title: stringValue(form.node_title)
      || stringValue(form.title)
      || stringValue(envelope.node_title)
      || stringValue(envelope.title)
      || "需要审批",
    content: form.content ?? envelope.content,
    fields: firstObjectArray(form.fields, envelope.fields),
    actions: firstObjectArray(form.actions, envelope.actions),
    expiresAt: expiryValue(
      form.expiration_at
        ?? form.expires_at
        ?? envelope.expiration_at
        ?? envelope.expires_at,
    ),
  };
}

function objectValue(value: unknown): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : {};
}

function firstObjectArray(...values: unknown[]): JsonObject[] {
  for (const value of values) {
    if (!Array.isArray(value)) continue;
    const items = value.filter((item): item is JsonObject => (
      item !== null && typeof item === "object" && !Array.isArray(item)
    ));
    if (items.length) return items;
  }
  return [];
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function expiryValue(value: unknown): string | number | undefined {
  return typeof value === "string" || typeof value === "number" ? value : undefined;
}
