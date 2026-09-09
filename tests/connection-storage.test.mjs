import assert from "node:assert/strict";
import test from "node:test";

import {
  clearStoredConnection,
  loadOrMigrateConnection,
  loadStoredBaseUrl,
  saveConnection,
} from "../src/lib/connection-storage.ts";

class MemoryStorage {
  values = new Map();

  getItem(key) {
    return this.values.get(key) ?? null;
  }

  setItem(key, value) {
    this.values.set(key, value);
  }

  removeItem(key) {
    this.values.delete(key);
  }
}

test("stores Base URL and API key atomically in persistent local storage", () => {
  const local = new MemoryStorage();
  assert.equal(saveConnection(local, { baseUrl: " http://localhost:2870/api/v1 ", apiKey: " zgi_key " }), true);
  assert.deepEqual(
    loadOrMigrateConnection(local, new MemoryStorage(), "http://fallback/api/v1"),
    { baseUrl: "http://localhost:2870/api/v1", apiKey: "zgi_key" },
  );
});

test("migrates legacy local Base URL and session API key", () => {
  const local = new MemoryStorage();
  const session = new MemoryStorage();
  local.setItem("zgi-demo-api-base-url", "http://legacy/api/v1");
  session.setItem("zgi-demo-api-key", "zgi_legacy");

  assert.deepEqual(loadOrMigrateConnection(local, session, "http://fallback/api/v1"), {
    baseUrl: "http://legacy/api/v1",
    apiKey: "zgi_legacy",
  });
  assert.equal(local.getItem("zgi-demo-api-base-url"), null);
  assert.equal(session.getItem("zgi-demo-api-key"), null);
  assert.equal(loadStoredBaseUrl(local, "http://fallback/api/v1"), "http://legacy/api/v1");
});

test("clears current and legacy connection values", () => {
  const local = new MemoryStorage();
  const session = new MemoryStorage();
  saveConnection(local, { baseUrl: "http://localhost/api/v1", apiKey: "zgi_key" });
  local.setItem("zgi-demo-api-base-url", "legacy");
  session.setItem("zgi-demo-api-key", "legacy-key");

  clearStoredConnection(local, session);
  assert.equal(loadOrMigrateConnection(local, session, "http://fallback/api/v1"), null);
  assert.equal(loadStoredBaseUrl(local, "http://fallback/api/v1"), "http://fallback/api/v1");
});

test("keeps the in-memory workflow usable when persistent storage is blocked", () => {
  const blocked = {
    getItem() { throw new Error("blocked"); },
    setItem() { throw new Error("blocked"); },
    removeItem() { throw new Error("blocked"); },
  };
  assert.equal(saveConnection(blocked, { baseUrl: "http://localhost/api/v1", apiKey: "zgi_key" }), false);
  assert.equal(loadOrMigrateConnection(blocked, blocked, "http://fallback/api/v1"), null);
  assert.equal(loadStoredBaseUrl(blocked, "http://fallback/api/v1"), "http://fallback/api/v1");
  assert.doesNotThrow(() => clearStoredConnection(blocked, blocked));
});
