import type { ApiEnvelope, JsonObject, SseEvent } from "./agent-api-types";

const DEMO_USER_HEADER = "X-Demo-User-ID";

export class AgentApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
  ) {
    super(message);
    this.name = "AgentApiError";
  }
}

export async function zgiFetch(
  path: string,
  externalUserId: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set(DEMO_USER_HEADER, externalUserId);
  if (init.body && !(init.body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  return fetch(`/api/zgi/${path.replace(/^\/+/, "")}`, {
    ...init,
    headers,
    cache: "no-store",
  });
}

export async function zgiJson<T>(
  path: string,
  externalUserId: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await zgiFetch(path, externalUserId, init);
  const raw = await response.text();
  let parsed: unknown;

  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    throw new AgentApiError(raw || `请求失败（HTTP ${response.status}）`, response.status);
  }

  if (!response.ok) {
    const error = isObject(parsed) ? parsed : {};
    throw new AgentApiError(
      typeof error.message === "string" ? error.message : `请求失败（HTTP ${response.status}）`,
      response.status,
      typeof error.code === "string" ? error.code : undefined,
    );
  }

  if (isEnvelope<T>(parsed)) {
    if (parsed.code !== "0") {
      throw new AgentApiError(parsed.message || "Agent API 返回失败", response.status, parsed.code);
    }
    return parsed.data;
  }

  return parsed as T;
}

export async function consumeSse(
  response: Response,
  onEvent: (event: SseEvent) => void | Promise<void>,
): Promise<void> {
  if (!response.ok) {
    const raw = await response.text();
    try {
      const error = JSON.parse(raw) as { message?: string; code?: string };
      throw new AgentApiError(error.message || `请求失败（HTTP ${response.status}）`, response.status, error.code);
    } catch (cause) {
      if (cause instanceof AgentApiError) throw cause;
      throw new AgentApiError(raw || `请求失败（HTTP ${response.status}）`, response.status);
    }
  }
  if (!response.body) throw new AgentApiError("浏览器没有收到 SSE 响应体", response.status);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const dispatch = async (block: string) => {
    let id: string | undefined;
    let nativeEvent = "message";
    const dataLines: string[] = [];

    for (const line of block.split("\n")) {
      if (!line || line.startsWith(":")) continue;
      if (line.startsWith("id:")) id = line.slice(3).trim();
      else if (line.startsWith("event:")) nativeEvent = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
    }

    if (!dataLines.length) return;
    const rawData = dataLines.join("\n");
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawData);
    } catch {
      parsed = { value: rawData };
    }

    const envelope = isObject(parsed) ? parsed : {};
    const event = typeof envelope.event === "string" ? envelope.event : nativeEvent;
    const data = isObject(envelope.data)
      ? envelope.data
      : isObject(parsed)
        ? parsed
        : { value: parsed };
    await onEvent({ id, event, data });
  };

  while (true) {
    const { value, done } = await reader.read();
    buffer = (buffer + decoder.decode(value, { stream: !done })).replace(/\r\n/g, "\n");
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      await dispatch(block);
      boundary = buffer.indexOf("\n\n");
    }
    if (done) break;
  }
  if (buffer.trim()) await dispatch(buffer);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "发生未知错误";
}

export function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

export function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEnvelope<T>(value: unknown): value is ApiEnvelope<T> {
  return isObject(value) && typeof value.code === "string" && "data" in value;
}
