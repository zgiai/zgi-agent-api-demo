import assert from "node:assert/strict";
import test from "node:test";

import {
  artifactExpiryTimestamp,
  artifactIsUnavailable,
  attachmentsFromMetadata,
  formatFileSize,
  generatedArtifactsFromMetadata,
  normalizeGeneratedArtifact,
  resolveArtifactUrl,
  upsertGeneratedArtifact,
} from "../src/lib/file-presentation.ts";

test("normalizes uploaded attachment metadata for conversation history", () => {
  assert.deepEqual(attachmentsFromMetadata({
    files: [{
      id: "upload-1",
      name: "brief.pdf",
      size: 1536,
      extension: "pdf",
      mime_type: "application/pdf",
      content_status: "extracted",
    }],
  }), [{
    id: "upload-1",
    name: "brief.pdf",
    size: 1536,
    extension: "pdf",
    mimeType: "application/pdf",
    contentStatus: "extracted",
  }]);
});

test("normalizes nested artifact payload and prefers durable identity", () => {
  const artifact = normalizeGeneratedArtifact({
    message_id: "message-1",
    invocation_id: "invocation-1",
    skill_id: "file-generator",
    tool_name: "generate_file",
    file: {
      artifact_id: "tool_file:file-1",
      file_id: "file-1",
      filename: "report.csv",
      extension: "csv",
      mime_type: "text/csv",
      size: 2048,
      url: "/files/tools/file-1?token=preview",
      download_url: "/files/tools/file-1?token=download&download=1",
      lifecycle: "temporary",
      expires_at: 2_000_000_000,
    },
  }, "fallback");

  assert.equal(artifact?.key, "tool_file:file-1");
  assert.equal(artifact?.messageId, "message-1");
  assert.equal(artifact?.filename, "report.csv");
  assert.equal(artifact?.downloadUrl, "/files/tools/file-1?token=download&download=1");
});

test("restores, deduplicates, and refreshes generated artifacts from metadata", () => {
  const restored = generatedArtifactsFromMetadata({
    generated_files: [
      { artifact_id: "tool_file:1", file_id: "1", filename: "old.txt", url: "/old" },
      { artifact_id: "tool_file:1", file_id: "1", filename: "new.txt", url: "/new" },
    ],
  }, "message-1");
  assert.equal(restored.length, 1);
  assert.equal(restored[0].filename, "new.txt");

  const updated = upsertGeneratedArtifact(restored, {
    ...restored[0],
    downloadUrl: "/download",
  });
  assert.equal(updated.length, 1);
  assert.equal(updated[0].downloadUrl, "/download");
});

test("treats expired or explicitly unavailable artifacts as unavailable", () => {
  const base = {
    key: "tool_file:1",
    messageId: "message-1",
    filename: "report.csv",
    extension: "csv",
    mimeType: "text/csv",
  };
  assert.equal(artifactExpiryTimestamp(2_000_000_000), 2_000_000_000_000);
  assert.equal(artifactIsUnavailable({ ...base, expiresAt: 100 }, 101_000), true);
  assert.equal(artifactIsUnavailable({ ...base, availability: "gone" }), true);
  assert.equal(artifactIsUnavailable({ ...base, expiresAt: 2_000_000_000 }, 1_900_000_000_000), false);
});

test("resolves only safe HTTP artifact links against the ZGI origin", () => {
  assert.equal(
    resolveArtifactUrl("/files/tools/1?token=x", "http://localhost:2870/api/v1"),
    "http://localhost:2870/files/tools/1?token=x",
  );
  assert.equal(
    resolveArtifactUrl("https://cdn.example.test/report.pdf", "http://localhost:2870/api/v1"),
    "https://cdn.example.test/report.pdf",
  );
  assert.equal(resolveArtifactUrl("javascript:alert(1)", "http://localhost:2870/api/v1"), "");
  assert.equal(resolveArtifactUrl("https://user:secret@example.test/file", "http://localhost:2870/api/v1"), "");
});

test("formats binary file sizes without fake precision", () => {
  assert.equal(formatFileSize(512), "512 B");
  assert.equal(formatFileSize(1536), "1.5 KB");
  assert.equal(formatFileSize(12 * 1024 * 1024), "12 MB");
  assert.equal(formatFileSize(undefined), "大小未知");
});
