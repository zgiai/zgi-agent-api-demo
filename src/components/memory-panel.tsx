"use client";

import { useCallback, useEffect, useState } from "react";
import type { MemoryExport, MemorySlot } from "@/lib/agent-api-types";
import { errorMessage, zgiFetch, zgiJson } from "@/lib/zgi-client";

interface MemoryPanelProps {
  activeUser: string;
  enabled: boolean;
  onError: (message: string | null) => void;
}

export function MemoryPanel({ activeUser, enabled, onError }: MemoryPanelProps) {
  const [memory, setMemory] = useState<MemoryExport | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!enabled) {
      setMemory(null);
      return;
    }
    setLoading(true);
    try {
      const result = await zgiJson<MemoryExport>("agents/memory", activeUser);
      setMemory(result);
      setDrafts(Object.fromEntries(result.values.map((slot) => [slot.key, slot.content])));
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }, [activeUser, enabled, onError]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  async function save(slot: MemorySlot) {
    setBusyKey(slot.key);
    try {
      await zgiJson<MemorySlot>(`agents/memory/${encodeURIComponent(slot.key)}`, activeUser, {
        method: "PUT",
        body: JSON.stringify({ content: drafts[slot.key] || "", expected_revision: slot.revision }),
      });
      await load();
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setBusyKey(null);
    }
  }

  async function clearSlot(slot: MemorySlot) {
    setBusyKey(slot.key);
    try {
      await zgiJson<MemorySlot>(
        `agents/memory/${encodeURIComponent(slot.key)}?expected_revision=${slot.revision}`,
        activeUser,
        { method: "DELETE" },
      );
      await load();
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setBusyKey(null);
    }
  }

  async function undo(slot: MemorySlot) {
    if (!slot.last_operation_id) return;
    setBusyKey(slot.key);
    try {
      await zgiJson(
        `agents/memory/operations/${encodeURIComponent(slot.last_operation_id)}/undo`,
        activeUser,
        { method: "POST" },
      );
      await load();
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setBusyKey(null);
    }
  }

  async function clearAll() {
    if (!window.confirm("确定清空当前用户的所有可写 Agent Memory 吗？")) return;
    setBusyKey("*");
    try {
      await zgiJson("agents/memory", activeUser, { method: "DELETE" });
      await load();
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setBusyKey(null);
    }
  }

  async function downloadExport() {
    try {
      const response = await zgiFetch("agents/memory/export", activeUser);
      if (!response.ok) throw new Error(`导出失败（HTTP ${response.status}）`);
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "agent-memory.json";
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      onError(errorMessage(error));
    }
  }

  if (!enabled) {
    return (
      <div className="memory-empty">
        <span>◇</span>
        <h3>Memory 未启用</h3>
        <p>当前发布版本没有开启 Agent Memory，客户端不应展示编辑入口。</p>
      </div>
    );
  }

  return (
    <div className="memory-panel">
      <p className="memory-intro">这些槽位只属于当前外部用户。保存时携带 revision，避免覆盖其他客户端的新修改。</p>
      <div className="memory-toolbar">
        <button onClick={() => void load()} disabled={loading}>↻ 刷新</button>
        <button onClick={() => void downloadExport()}>⇩ 导出</button>
        <button className="danger-link" onClick={() => void clearAll()} disabled={busyKey === "*"}>清空</button>
      </div>
      <div className="memory-list">
        {memory?.values.map((slot) => {
          const changed = (drafts[slot.key] ?? "") !== slot.content;
          const canUndo = !!slot.last_operation_id;
          return (
            <section className="memory-card" key={slot.key}>
              <header>
                <div><strong>{slot.name}</strong><code>{slot.key}</code></div>
                <span>rev {slot.revision}</span>
              </header>
              {slot.description && <p>{slot.description}</p>}
              <textarea
                value={drafts[slot.key] ?? ""}
                onChange={(event) => setDrafts((current) => ({ ...current, [slot.key]: event.target.value }))}
                maxLength={slot.max_chars}
                disabled={!slot.enabled || busyKey === slot.key}
                placeholder="暂无记忆内容"
              />
              <div className="memory-meta">
                <span>{(drafts[slot.key] || "").length} / {slot.max_chars}</span>
                <span>{slot.updated_at_display || slot.source_kind}</span>
              </div>
              <footer>
                <button disabled={!changed || busyKey === slot.key} onClick={() => void save(slot)}>保存</button>
                <button disabled={!slot.content || busyKey === slot.key} onClick={() => void clearSlot(slot)}>清除</button>
                {canUndo && <button disabled={busyKey === slot.key} onClick={() => void undo(slot)}>撤销上次修改</button>}
              </footer>
            </section>
          );
        })}
        {loading && <div className="memory-loading">正在读取 Memory…</div>}
        {!loading && !memory?.values.length && <div className="memory-empty"><span>◇</span><h3>暂无可见槽位</h3><p>请先在 Agent 的发布配置中添加并启用 Memory 槽位。</p></div>}
      </div>
      {memory && <p className="scope-id">派生用户 UUID<br /><code>{memory.user_id}</code></p>}
    </div>
  );
}
