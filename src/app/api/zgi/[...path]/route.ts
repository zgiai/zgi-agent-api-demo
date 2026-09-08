import { NextRequest } from "next/server";

const USER_HEADER = "X-Demo-User-ID";
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
  const { path: parts } = await context.params;
  if (!parts?.length || parts.some((part) => !part || part === "." || part === ".." || part.includes("\\"))) {
    return jsonError(400, "无效的 Agent API 路径");
  }

  const decodedPath = parts.join("/");
  if (!ALLOWED_PATHS.some((pattern) => pattern.test(decodedPath))) {
    return jsonError(404, "此路径未在 demo 代理的白名单中");
  }

  const apiKey = process.env.ZGI_AGENT_API_KEY?.trim();
  if (!apiKey) {
    return jsonError(503, "未配置 ZGI_AGENT_API_KEY，请复制 .env.example 为 .env.local 并填写已发布 Agent 的 API Key", "DEMO_NOT_CONFIGURED");
  }

  const externalUserId = request.headers.get(USER_HEADER)?.trim();
  if (decodedPath !== "agents/config" && !externalUserId) {
    return jsonError(400, "缺少 demo 用户标识");
  }
  if (externalUserId && [...externalUserId].length > 128) {
    return jsonError(400, "demo 用户标识不能超过 128 个字符");
  }

  const baseUrl = (process.env.ZGI_API_BASE_URL || "http://localhost:2879/api/v1").replace(/\/+$/, "");
  const safePath = parts.map(encodeURIComponent).join("/");
  const upstreamUrl = new URL(`${baseUrl}/${safePath}`);
  request.nextUrl.searchParams.forEach((value, key) => upstreamUrl.searchParams.append(key, value));

  const headers = new Headers({
    Accept: request.headers.get("accept") || "application/json, text/event-stream",
    Authorization: `Bearer ${apiKey}`,
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
    return jsonError(502, `无法连接 ZGI Agent API：${message}`, "UPSTREAM_UNAVAILABLE");
  }
}

function jsonError(status: number, message: string, code = "DEMO_PROXY_ERROR"): Response {
  return Response.json({ code, message }, { status });
}

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
