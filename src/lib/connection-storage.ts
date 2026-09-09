import type { AgentApiConnection } from "./zgi-client.ts";

const CONNECTION_STORAGE_KEY = "zgi-agent-api-demo.connection.v1";
const LEGACY_BASE_STORAGE_KEY = "zgi-demo-api-base-url";
const LEGACY_API_KEY_STORAGE_KEY = "zgi-demo-api-key";

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface StoredConnection extends AgentApiConnection {
  version: 1;
}

export function loadOrMigrateConnection(
  localStorage: StorageLike,
  sessionStorage: StorageLike,
  fallbackBaseUrl: string,
): AgentApiConnection | null {
  try {
    const current = parseStoredConnection(localStorage.getItem(CONNECTION_STORAGE_KEY));
    if (current) {
      removeLegacyConnection(localStorage, sessionStorage);
      return current;
    }

    const baseUrl = localStorage.getItem(LEGACY_BASE_STORAGE_KEY)?.trim() || fallbackBaseUrl;
    const apiKey = localStorage.getItem(LEGACY_API_KEY_STORAGE_KEY)?.trim()
      || sessionStorage.getItem(LEGACY_API_KEY_STORAGE_KEY)?.trim()
      || "";
    if (!apiKey) return null;

    const migrated = { baseUrl, apiKey };
    if (saveConnection(localStorage, migrated)) {
      removeLegacyConnection(localStorage, sessionStorage);
    }
    return migrated;
  } catch {
    return null;
  }
}

export function loadStoredBaseUrl(localStorage: StorageLike, fallbackBaseUrl: string): string {
  try {
    return parseStoredConnection(localStorage.getItem(CONNECTION_STORAGE_KEY))?.baseUrl
      || localStorage.getItem(LEGACY_BASE_STORAGE_KEY)?.trim()
      || fallbackBaseUrl;
  } catch {
    return fallbackBaseUrl;
  }
}

export function saveConnection(
  localStorage: StorageLike,
  connection: AgentApiConnection,
  sessionStorage?: StorageLike,
): boolean {
  try {
    const value: StoredConnection = {
      version: 1,
      baseUrl: connection.baseUrl.trim(),
      apiKey: connection.apiKey.trim(),
    };
    localStorage.setItem(CONNECTION_STORAGE_KEY, JSON.stringify(value));
    localStorage.removeItem(LEGACY_BASE_STORAGE_KEY);
    localStorage.removeItem(LEGACY_API_KEY_STORAGE_KEY);
  } catch {
    return false;
  }
  if (sessionStorage) {
    try {
      sessionStorage.removeItem(LEGACY_API_KEY_STORAGE_KEY);
    } catch {
      // Persistent storage succeeded; legacy session cleanup is best effort.
    }
  }
  return true;
}

export function clearStoredConnection(
  localStorage: StorageLike,
  sessionStorage?: StorageLike,
): void {
  try {
    localStorage.removeItem(CONNECTION_STORAGE_KEY);
    localStorage.removeItem(LEGACY_BASE_STORAGE_KEY);
    localStorage.removeItem(LEGACY_API_KEY_STORAGE_KEY);
  } catch {
    // The active in-memory connection can still be cleared when storage is blocked.
  }
  if (sessionStorage) {
    try {
      sessionStorage.removeItem(LEGACY_API_KEY_STORAGE_KEY);
    } catch {
      // Ignore legacy cleanup failures.
    }
  }
}

function parseStoredConnection(raw: string | null): AgentApiConnection | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<StoredConnection>;
    if (value.version !== 1 || typeof value.baseUrl !== "string" || typeof value.apiKey !== "string") {
      return null;
    }
    const baseUrl = value.baseUrl.trim();
    const apiKey = value.apiKey.trim();
    return baseUrl && apiKey ? { baseUrl, apiKey } : null;
  } catch {
    return null;
  }
}

function removeLegacyConnection(localStorage: StorageLike, sessionStorage: StorageLike): void {
  try {
    localStorage.removeItem(LEGACY_BASE_STORAGE_KEY);
    localStorage.removeItem(LEGACY_API_KEY_STORAGE_KEY);
  } catch {
    // The versioned value remains usable even if legacy cleanup is blocked.
  }
  try {
    sessionStorage.removeItem(LEGACY_API_KEY_STORAGE_KEY);
  } catch {
    // Legacy session cleanup is best effort.
  }
}
