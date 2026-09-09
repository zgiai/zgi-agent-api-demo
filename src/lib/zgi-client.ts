import type { ApiEnvelope, JsonObject, SseEvent } from "./agent-api-types";

const EXTERNAL_USER_HEADER = "X-External-User-ID";

export interface AgentApiConnection {
  baseUrl: string;
  apiKey: string;
}

export class AgentApiError extends Error {
  public readonly status: number;
  public readonly code?: string | number;

  constructor(
    message: string,
    status: number,
    code?: string | number,
  ) {
    super(message);
    this.name = "AgentApiError";
    this.status = status;
    this.code = code;
  }
}

export async function zgiFetch(
  connection: AgentApiConnection,
  path: string,
  externalUserId: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${connection.apiKey}`);
  headers.set(EXTERNAL_USER_HEADER, externalUserId);
  if (init.body && !(init.body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  try {
    return await fetch(`${normalizeAgentApiBaseUrl(connection.baseUrl)}/${path.replace(/^\/+/, "")}`, {
      ...init,
      headers,
      cache: "no-store",
    });
  } catch (error) {
    if (error instanceof TypeError) {
      throw new AgentApiError(
        "浏览器无法连接 Agent API。请检查 Base URL、网关状态，以及 CORS 是否允许当前页面来源和 Authorization、X-External-User-ID、Content-Type 请求头。",
        0,
      );
    }
    throw error;
  }
}

export async function zgiJson<T>(
  connection: AgentApiConnection,
  path: string,
  externalUserId: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await zgiFetch(connection, path, externalUserId, init);
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
      typeof error.code === "string" || typeof error.code === "number" ? error.code : undefined,
    );
  }

  if (isEnvelope<T>(parsed)) {
    if (String(parsed.code) !== "0") {
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

export function normalizeAgentApiBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new AgentApiError("Base URL 必须是完整的 http:// 或 https:// 地址", 0);
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new AgentApiError("Base URL 只支持 http:// 或 https://", 0);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new AgentApiError("Base URL 不能包含账号、查询参数或锚点", 0);
  }
  return trimmed;
}

function isEnvelope<T>(value: unknown): value is ApiEnvelope<T> {
  return isObject(value)
    && (typeof value.code === "string" || typeof value.code === "number")
    && "data" in value;
}
