import type {
  GeneratedArtifact,
  JsonObject,
  MessageAttachment,
  UploadedFile,
} from "./agent-api-types.ts";

export function attachmentFromUploadedFile(file: UploadedFile): MessageAttachment {
  return {
    id: file.id,
    name: file.name,
    size: file.size,
    extension: file.extension,
    mimeType: file.mime_type,
  };
}

export function attachmentsFromMetadata(metadata?: JsonObject): MessageAttachment[] {
  if (!metadata || !Array.isArray(metadata.files)) return [];
  return metadata.files.flatMap((value) => {
    const file = objectValue(value);
    const id = stringValue(file.id);
    const name = stringValue(file.name) || stringValue(file.filename);
    if (!id || !name) return [];
    return [{
      id,
      name,
      size: numberValue(file.size) ?? 0,
      extension: stringValue(file.extension) || fileExtension(name),
      mimeType: stringValue(file.mime_type),
      contentStatus: stringValue(file.content_status) || undefined,
    }];
  });
}

export function normalizeGeneratedArtifact(
  payload: JsonObject,
  fallbackMessageId: string,
): GeneratedArtifact | null {
  const nested = objectValue(payload.file);
  const value = (key: string): unknown => nested[key] ?? payload[key];
  const string = (key: string): string => stringValue(value(key));

  const messageId = string("message_id") || fallbackMessageId;
  const toolFileId = string("tool_file_id");
  const uploadFileId = string("upload_file_id");
  const fileId = string("file_id") || uploadFileId || toolFileId;
  const filename = string("filename") || string("name");
  const downloadUrl = string("download_url");
  const url = string("url");
  const artifactId = string("artifact_id");
  const invocationId = string("invocation_id");

  if (!messageId || (!filename && !fileId) || (!artifactId && !fileId && !url && !downloadUrl)) {
    return null;
  }

  const target = string("target");
  const managed = target === "managed_file" || Boolean(uploadFileId);
  const displayName = filename || `生成文件-${fileId.slice(0, 8)}`;
  const key = artifactId
    || (fileId ? `${managed ? "managed_file" : "tool_file"}:${fileId}` : "")
    || `${messageId}:${invocationId}:${displayName}:${downloadUrl || url}`;

  return {
    key,
    messageId,
    artifactId: artifactId || undefined,
    invocationId: invocationId || undefined,
    skillId: string("skill_id") || undefined,
    toolName: string("tool_name") || undefined,
    fileId: fileId || undefined,
    toolFileId: toolFileId || undefined,
    uploadFileId: uploadFileId || undefined,
    filename: displayName,
    extension: string("extension") || fileExtension(displayName),
    mimeType: string("mime_type"),
    size: numberValue(value("size")) ?? undefined,
    url: url || undefined,
    downloadUrl: downloadUrl || undefined,
    target: target || undefined,
    lifecycle: string("lifecycle") || undefined,
    availability: string("availability") || undefined,
    expiresAt: stringOrNumber(value("expires_at")),
    transferMethod: string("transfer_method") || undefined,
  };
}

export function generatedArtifactsFromMetadata(
  metadata: JsonObject | undefined,
  messageId: string,
): GeneratedArtifact[] {
  if (!metadata || !Array.isArray(metadata.generated_files)) return [];
  return metadata.generated_files.reduce<GeneratedArtifact[]>((artifacts, value) => {
    const artifact = normalizeGeneratedArtifact(objectValue(value), messageId);
    return artifact ? upsertGeneratedArtifact(artifacts, artifact) : artifacts;
  }, []);
}

export function upsertGeneratedArtifact(
  artifacts: GeneratedArtifact[],
  incoming: GeneratedArtifact,
): GeneratedArtifact[] {
  const index = artifacts.findIndex((artifact) => artifact.key === incoming.key);
  if (index < 0) return [...artifacts, incoming];
  return artifacts.map((artifact, itemIndex) =>
    itemIndex === index ? { ...artifact, ...incoming } : artifact,
  );
}

export function artifactExpiryTimestamp(value?: string | number): number | null {
  if (value === undefined) return null;
  const numeric = typeof value === "number" ? value : Number(value);
  const timestamp = Number.isFinite(numeric)
    ? numeric * (numeric < 10_000_000_000 ? 1000 : 1)
    : Date.parse(String(value));
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function artifactIsUnavailable(artifact: GeneratedArtifact, now = Date.now()): boolean {
  const availability = artifact.availability?.toLowerCase();
  if (availability && ["expired", "gone", "deleted", "unavailable"].includes(availability)) return true;
  const expiry = artifactExpiryTimestamp(artifact.expiresAt);
  return expiry !== null && expiry <= now;
}

export function resolveArtifactUrl(rawUrl: string | undefined, apiBaseUrl: string): string {
  if (!rawUrl?.trim()) return "";
  try {
    const base = new URL(apiBaseUrl);
    const url = new URL(rawUrl.trim(), `${base.origin}/`);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return "";
    return url.toString();
  } catch {
    return "";
  }
}

export function formatFileSize(size?: number): string {
  if (size === undefined || !Number.isFinite(size) || size < 0) return "大小未知";
  if (size < 1024) return `${size} B`;
  if (size < 1024 ** 2) return `${trimDecimal(size / 1024)} KB`;
  if (size < 1024 ** 3) return `${trimDecimal(size / 1024 ** 2)} MB`;
  return `${trimDecimal(size / 1024 ** 3)} GB`;
}

function trimDecimal(value: number): string {
  return value >= 10 ? value.toFixed(0) : value.toFixed(1).replace(/\.0$/, "");
}

function fileExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > -1 ? name.slice(dot + 1).toLowerCase() : "";
}

function objectValue(value: unknown): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringOrNumber(value: unknown): string | number | undefined {
  return typeof value === "string" || typeof value === "number" ? value : undefined;
}
