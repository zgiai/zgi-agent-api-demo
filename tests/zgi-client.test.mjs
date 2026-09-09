import assert from "node:assert/strict";
import test from "node:test";

import {
  AgentApiError,
  normalizeAgentApiBaseUrl,
  zgiJson,
} from "../src/lib/zgi-client.ts";
import {
  getAgentEventDefinition,
  PUBLIC_AGENT_EVENT_NAMES,
} from "../src/lib/agent-event-catalog.ts";

test("normalizes browser-configured Agent API base URLs", () => {
  assert.equal(normalizeAgentApiBaseUrl(" http://localhost:2870/api/v1/// "), "http://localhost:2870/api/v1");
  assert.throws(() => normalizeAgentApiBaseUrl("localhost:2870/api/v1"), AgentApiError);
  assert.throws(() => normalizeAgentApiBaseUrl("file:///tmp/api/v1"), AgentApiError);
  assert.throws(() => normalizeAgentApiBaseUrl("https://example.com/api/v1?key=secret"), AgentApiError);
});

test("sends browser connection credentials and external user directly upstream", async () => {
  const originalFetch = globalThis.fetch;
  let captured;
  globalThis.fetch = async (input, init) => {
    captured = { input, init };
    return new Response(JSON.stringify({ code: "0", message: "ok", data: { name: "Agent" } }), {
      headers: { "Content-Type": "application/json" },
    });
  };

  try {
    const result = await zgiJson(
      { baseUrl: "http://localhost:2870/api/v1/", apiKey: "zgi_test_key" },
      "/agents/config",
      "demo-user",
    );
    assert.deepEqual(result, { name: "Agent" });
    assert.equal(captured.input, "http://localhost:2870/api/v1/agents/config");
    const headers = new Headers(captured.init.headers);
    assert.equal(headers.get("Authorization"), "Bearer zgi_test_key");
    assert.equal(headers.get("X-External-User-ID"), "demo-user");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("accepts numeric envelope codes and reports non-zero codes", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ code: 4101, message: "invalid key", data: null }));
  try {
    await assert.rejects(
      () => zgiJson({ baseUrl: "https://example.com/api/v1", apiKey: "bad" }, "agents/config", "demo-user"),
      (error) => error instanceof AgentApiError && error.code === 4101 && error.message === "invalid key",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("catalogs every currently public Agent SSE event and safely describes unknown events", () => {
  assert.equal(PUBLIC_AGENT_EVENT_NAMES.length, 48);
  for (const name of ["message_start", "agent_intermediate_answer", "skill_artifact_created", "memory_clear", "approval_requested", "iteration_failed", "loop_failed", "text_replace"]) {
    assert.ok(PUBLIC_AGENT_EVENT_NAMES.includes(name), `missing ${name}`);
    assert.notEqual(getAgentEventDefinition(name).category, "unknown");
  }
  assert.equal(PUBLIC_AGENT_EVENT_NAMES.includes("client_action"), false);
  assert.equal(getAgentEventDefinition("future_event").category, "unknown");
});
