import type { NextRequest } from "next/server";

const DEMO_API_BASE_HEADER = "X-Demo-Agent-API-Base-URL";
const DEMO_USER_HEADER = "X-Demo-External-User-ID";
const UPSTREAM_USER_HEADER = "X-External-User-ID";
const ALLOWED_PATHS = [
  /^agents\/config$/,
  /^agents\/chat$/,
  /^agents\/conversations(?:\/search)?$/,
  /^agents\/conversations\/[^/]+(?:\/messages|\/events|\/stop)?$/,
  /^agents\/conversations\/[^/]+\/messages\/[^/]+\/workflow-continuation$/,
  /^agents\/conversations\/[^/]+\/messages\/[^/]+\/user-input\/[^/]+\/continue$/,
  /^agents\/messages\/[^/]+\/regenerate$/,
  /^agents\/memory(?:\/export)?$/,
  /^agents\/memory\/operations\/[^/]+\/undo$/,
  /^agents\/memory\/[^/]+$/,
  /^files\/upload$/,
];

interface RouteContext {
  params: Promise<{ path: string[] }>;
}

async function proxy(request: NextRequest, context: RouteContext): Promise<Response> {
  if (!isSameOriginBrowserRequest(request)) {
    return jsonError(403, "demo 代理只接受同源页面请求");
  }

  const { path: parts } = await context.params;
  if (!parts?.length || parts.some((part) => !part || part === "." || part === ".." || part.includes("\\"))) {
    return jsonError(400, "无效的 Agent API 路径");
  }

  const decodedPath = parts.join("/");
  if (!ALLOWED_PATHS.some((pattern) => pattern.test(decodedPath))) {
    return jsonError(404, "此路径未在 demo 代理的白名单中");
  }

  const authorization = request.headers.get("authorization")?.trim();
  if (!authorization?.match(/^Bearer\s+\S+$/i)) {
    return jsonError(400, "缺少页面配置的 Agent API Key", "DEMO_NOT_CONFIGURED");
  }

  let baseUrl: string;
  try {
    baseUrl = normalizeBaseUrl(request.headers.get(DEMO_API_BASE_HEADER) || "");
  } catch (error) {
    return jsonError(400, error instanceof Error ? error.message : "无效的 Agent API Base URL");
  }

  const externalUserId = request.headers.get(DEMO_USER_HEADER)?.trim();
  if (decodedPath !== "agents/config" && !externalUserId) {
    return jsonError(400, "缺少外部用户标识");
  }
  if (externalUserId && [...externalUserId].length > 128) {
    return jsonError(400, "外部用户标识不能超过 128 个字符");
  }

  const safePath = parts.map(encodeURIComponent).join("/");
  const upstreamUrl = new URL(`${baseUrl}/${safePath}`);
  request.nextUrl.searchParams.forEach((value, key) => upstreamUrl.searchParams.append(key, value));

  const headers = new Headers({
    Accept: request.headers.get("accept") || "application/json, text/event-stream",
    Authorization: authorization,
  });
  const contentType = request.headers.get("content-type");
  if (contentType) headers.set("Content-Type", contentType);
  if (externalUserId) headers.set(UPSTREAM_USER_HEADER, externalUserId);

  try {
    const hasBody = !["GET", "HEAD"].includes(request.method);
    const body = hasBody ? await request.arrayBuffer() : undefined;
    const upstream = await fetch(upstreamUrl, {
      method: request.method,
      headers,
      body: body && body.byteLength ? body : undefined,
      cache: "no-store",
      signal: request.signal,
    });

    const responseHeaders = new Headers();
    for (const name of [
      "content-type",
      "content-disposition",
      "x-zgi-conversation-id",
      "x-zgi-message-id",
      "deprecation",
      "sunset",
      "link",
    ]) {
      const value = upstream.headers.get(name);
      if (value) responseHeaders.set(name, value);
    }
    responseHeaders.set("Cache-Control", "no-store");

    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "未知网络错误";
    return jsonError(502, `demo 代理无法连接 ZGI Agent API：${message}`, "UPSTREAM_UNAVAILABLE");
  }
}

function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("Base URL 必须是完整的 http:// 或 https:// 地址");
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Base URL 只支持 http:// 或 https://");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("Base URL 不能包含账号、查询参数或锚点");
  }
  return trimmed;
}

function isSameOriginBrowserRequest(request: NextRequest): boolean {
  const fetchSite = request.headers.get("sec-fetch-site");
  const origin = request.headers.get("origin");
  if (origin && origin !== request.nextUrl.origin) return false;
  return !fetchSite || fetchSite === "same-origin" || fetchSite === "none";
}

function jsonError(status: number, message: string, code = "DEMO_PROXY_ERROR"): Response {
  return Response.json({ code, message }, { status });
}

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
