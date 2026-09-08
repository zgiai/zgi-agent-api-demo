"use client";

import {
  FormEvent,
  KeyboardEvent,
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  AgentConfig,
  Conversation,
  ConversationList,
  ConversationMessage,
  JsonObject,
  MessageList,
  PendingInteraction,
  SearchResult,
  SseEvent,
  UiMessage,
  UploadedFile,
  UserInputQuestion,
} from "@/lib/agent-api-types";
import {
  AgentApiError,
  asString,
  consumeSse,
  errorMessage,
  isObject,
  zgiFetch,
  zgiJson,
} from "@/lib/zgi-client";
import { isPendingInteractionDisabled, normalizeApprovalState } from "@/lib/approval-state";
import { MemoryPanel } from "./memory-panel";

const DEFAULT_USER = "demo-user-001";
const MAX_RECONNECT_ATTEMPTS = 5;

type ConnectionPhase = "idle" | "connecting" | "streaming" | "reconnecting" | "restoring" | "waiting" | "failed";

interface StreamOptions {
  optimisticMessageId?: string;
  conversationId?: string;
  messageId?: string;
  replayFromStart?: boolean;
  reconnect?: boolean;
  clearPendingOnStart?: boolean;
}

export function AgentDemo() {
  const [activeUser, setActiveUser] = useState(DEFAULT_USER);
  const [userDraft, setUserDraft] = useState(DEFAULT_USER);
  const [config, setConfig] = useState<AgentConfig | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [search, setSearch] = useState("");
  const [currentConversationId, setCurrentConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [query, setQuery] = useState("");
  const [uploads, setUploads] = useState<UploadedFile[]>([]);
  const [uploading, setUploading] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [continuing, setContinuing] = useState(false);
  const [progress, setProgress] = useState("");
  const [pending, setPending] = useState<PendingInteraction | null>(null);
  const [eventLog, setEventLog] = useState<SseEvent[]>([]);
  const [showEvents, setShowEvents] = useState(false);
  const [mobilePanel, setMobilePanel] = useState<"sessions" | "memory" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [fatalError, setFatalError] = useState<string | null>(null);
  const [connection, setConnection] = useState<{ phase: ConnectionPhase; attempt: number }>({ phase: "idle", attempt: 0 });
  const streamController = useRef<AbortController | null>(null);
  const messagesEnd = useRef<HTMLDivElement | null>(null);

  const currentConversation = useMemo(
    () => conversations.find((item) => item.id === currentConversationId) ?? null,
    [conversations, currentConversationId],
  );
  const restoreConversation = useEffectEvent((id: string) => {
    void openConversation(id);
  });

  useEffect(() => {
    const storedUser = window.localStorage.getItem("zgi-demo-user");
    if (!storedUser || storedUser === DEFAULT_USER) return;
    const timer = window.setTimeout(() => {
      setActiveUser(storedUser);
      setUserDraft(storedUser);
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  const loadConversations = useCallback(
    async (needle = search) => {
      try {
        if (needle.trim()) {
          const results = await zgiJson<SearchResult[]>(
            `agents/conversations/search?query=${encodeURIComponent(needle.trim())}&limit=30`,
            activeUser,
          );
          setSearchResults(results);
        } else {
          const result = await zgiJson<ConversationList>(
            "agents/conversations?page=1&limit=50",
            activeUser,
          );
          setConversations(result.data);
          setSearchResults([]);
        }
      } catch (error) {
        setFatalError(errorMessage(error));
      }
    },
    [activeUser, search],
  );

  useEffect(() => {
    let cancelled = false;
    async function bootstrap() {
      setFatalError(null);
      try {
        const [nextConfig, list] = await Promise.all([
          zgiJson<AgentConfig>("agents/config", activeUser),
          zgiJson<ConversationList>("agents/conversations?page=1&limit=50", activeUser),
        ]);
        if (cancelled) return;
        setConfig(nextConfig);
        setConversations(list.data);
        const storedConversationId = window.localStorage.getItem(conversationKey(activeUser));
        if (storedConversationId && list.data.some((item) => item.id === storedConversationId)) {
          restoreConversation(storedConversationId);
        }
      } catch (error) {
        if (!cancelled) setFatalError(errorMessage(error));
      }
    }
    void bootstrap();
    return () => {
      cancelled = true;
    };
  }, [activeUser]);

  useEffect(() => {
    messagesEnd.current?.scrollIntoView({ behavior: streaming ? "instant" : "smooth" });
  }, [messages, pending, streaming]);

  function applyUser() {
    const normalized = userDraft.trim();
    if (!normalized) {
      setNotice("用户标识不能为空");
      return;
    }
    if ([...normalized].length > 128) {
      setNotice("用户标识不能超过 128 个字符");
      return;
    }
    window.localStorage.setItem("zgi-demo-user", normalized);
    streamController.current?.abort();
    setActiveUser(normalized);
    setCurrentConversationId(null);
    setMessages([]);
    setPending(null);
    setEventLog([]);
    setProgress("");
    setConnection({ phase: "idle", attempt: 0 });
    setNotice(`已切换到 ${normalized}`);
  }

  async function openConversation(id: string) {
    if (streaming) return;
    setFatalError(null);
    setPending(null);
    setEventLog([]);
    setProgress("");
    setConnection({ phase: "idle", attempt: 0 });
    setCurrentConversationId(id);
    setMobilePanel(null);
    try {
      const [detail, result] = await Promise.all([
        zgiJson<Conversation>(`agents/conversations/${encodeURIComponent(id)}`, activeUser),
        zgiJson<MessageList>(
          `agents/conversations/${encodeURIComponent(id)}/messages?page=1&limit=200`,
          activeUser,
        ),
      ]);
      const ordered = [...result.data].sort(compareMessagesChronologically);
      const latest = ordered.at(-1);
      setConversations((current) => upsertConversation(current, detail));
      setMessages(ordered.flatMap(toUiMessages));
      window.localStorage.setItem(conversationKey(activeUser), id);

      const durablePending = latest ? pendingFromMessageMetadata(latest) : null;
      setPending(durablePending);
      if (durablePending) setConnection({ phase: "waiting", attempt: 0 });

      const recoveryMessageId = detail.active_message_id
        || (latest && isWaitingStatus(latest.status) ? latest.id : "");
      if (recoveryMessageId) {
        const controller = new AbortController();
        streamController.current = controller;
        const response = await zgiFetch(
          `agents/conversations/${encodeURIComponent(id)}/events?message_id=${encodeURIComponent(recoveryMessageId)}`,
          activeUser,
          { signal: controller.signal },
        );
        await runEventStream(response, {
          conversationId: id,
          messageId: recoveryMessageId,
          replayFromStart: true,
          reconnect: detail.runtime_status === "running",
        });
      }
    } catch (error) {
      setFatalError(errorMessage(error));
      setConnection({ phase: "failed", attempt: 0 });
    }
  }

  function newConversation() {
    if (streaming) return;
    setCurrentConversationId(null);
    setMessages([]);
    setPending(null);
    setEventLog([]);
    setProgress("");
    setConnection({ phase: "idle", attempt: 0 });
    window.localStorage.removeItem(conversationKey(activeUser));
    setMobilePanel(null);
  }

  function updateAssistant(id: string, update: (message: UiMessage) => UiMessage) {
    setMessages((current) => {
      const index = current.findIndex((message) => message.id === id && message.role === "assistant");
      if (index < 0) return [...current, update({ id, role: "assistant", content: "", status: "running" })];
      return current.map((message, messageIndex) => (messageIndex === index ? update(message) : message));
    });
  }

  async function runEventStream(response: Response, options: StreamOptions = {}) {
    const activeController = streamController.current;
    let conversationId = response.headers.get("x-zgi-conversation-id")
      || options.conversationId
      || currentConversationId
      || "";
    let messageId = response.headers.get("x-zgi-message-id")
      || options.messageId
      || options.optimisticMessageId
      || "";
    let unboundOptimisticId = options.optimisticMessageId;
    const replaying = !!options.replayFromStart;
    let replayTextStarted = false;
    let finalStreamStatus = "";

    const bindMessageId = (actualMessageId: string) => {
      if (!unboundOptimisticId || !actualMessageId || unboundOptimisticId === actualMessageId) return;
      const placeholderId = unboundOptimisticId;
      unboundOptimisticId = undefined;
      setMessages((current) => bindOptimisticAssistant(current, placeholderId, actualMessageId));
    };

    if (conversationId) {
      setCurrentConversationId(conversationId);
      window.localStorage.setItem(conversationKey(activeUser), conversationId);
    }
    bindMessageId(messageId);

    setStreaming(true);
    setConnection({ phase: replaying ? "restoring" : "connecting", attempt: 0 });
    setProgress(replaying ? "正在恢复消息状态…" : "正在连接 Agent…");
    setFatalError(null);
    try {
      await consumeSseWithReconnect(response, (event) => {
        const eventConversationId = asString(event.data.conversation_id, conversationId);
        const eventMessageId = asString(event.data.message_id, messageId);
        if (eventConversationId) {
          conversationId = eventConversationId;
          setCurrentConversationId(eventConversationId);
          window.localStorage.setItem(conversationKey(activeUser), eventConversationId);
        }
        if (eventMessageId) messageId = eventMessageId;
        bindMessageId(messageId);

        if (event.id && messageId) {
          window.localStorage.setItem(cursorKey(activeUser, messageId), event.id);
        }
        setEventLog((current) => [...current.slice(-39), event]);
        setConnection({ phase: "streaming", attempt: 0 });

        if (event.event === "message_start") {
          if (options.clearPendingOnStart) setPending(null);
          updateAssistant(messageId, (message) => ({
            ...message,
            status: "running",
            model: asString(event.data.model, message.model),
          }));
          setProgress(replaying ? "正在回放已保存事件…" : "Agent 正在生成回答…");
          return;
        }

        if (event.event === "message" || event.event === "text_chunk") {
          const chunk = asString(event.data.answer) || asString(event.data.text);
          updateAssistant(messageId, (message) => ({
            ...message,
            content: replaying && !replayTextStarted ? chunk : message.content + chunk,
            status: "running",
          }));
          replayTextStarted = true;
          setProgress("");
          return;
        }

        if (event.event === "text_replace") {
          const content = asString(event.data.answer) || asString(event.data.text);
          replayTextStarted = true;
          updateAssistant(messageId, (message) => ({ ...message, content }));
          return;
        }

        if (event.event === "message_retract") {
          const answer = asString(event.data.answer);
          updateAssistant(messageId, (message) => ({
            ...message,
            content: answer && message.content.endsWith(answer)
              ? message.content.slice(0, -answer.length)
              : message.content,
          }));
          return;
        }

        if (event.event === "agent_progress") {
          setProgress(progressLabel(event.data));
          return;
        }

        if (event.event === "user_input_requested") {
          setPending(pendingFromUserInputEvent(event.data, conversationId, messageId));
          setProgress("等待你的回答");
          return;
        }

        if (event.event === "question_answer_requested") {
          setPending(pendingFromWorkflowQuestionEvent(event.data, conversationId, messageId));
          setProgress("工作流等待回答");
          return;
        }

        if (event.event === "approval_requested") {
          setPending(pendingFromApprovalEvent(event.data, conversationId, messageId));
          setProgress("工作流等待审批");
          return;
        }

        if (event.event === "approval_expired") {
          setPending((current) => current?.kind === "approval" && current.messageId === messageId
            ? { ...current, expired: true }
            : {
                kind: "unavailable",
                conversationId,
                messageId,
                status: "waiting_approval",
                title: "审批已过期",
                reason: "服务端已拒绝继续使用这次审批，请重新发起对应任务。",
              });
          setConnection({ phase: "waiting", attempt: 0 });
          setProgress("审批已过期");
          return;
        }

        if (["workflow_resumed", "approval_result_filled", "question_answer_submitted"].includes(event.event)) {
          setPending(null);
          setProgress("工作流已恢复…");
          return;
        }

        if (event.event === "error") {
          finalStreamStatus = "error";
          const message = asString(event.data.message, "Agent 运行失败");
          updateAssistant(messageId, (item) => ({ ...item, status: "error", error: message }));
          setFatalError(message);
          setConnection({ phase: "failed", attempt: 0 });
          setProgress("");
          return;
        }

        if (event.event === "message_end") {
          const status = asString(event.data.status, "completed");
          finalStreamStatus = status;
          const completeAnswer = asString(event.data.answer);
          updateAssistant(messageId, (message) => ({
            ...message,
            content: completeAnswer || message.content,
            status,
          }));
          setConnection({ phase: isWaitingStatus(status) ? "waiting" : "idle", attempt: 0 });
          setProgress(isWaitingStatus(status) ? "等待继续操作" : "");
          if (isWaitingStatus(status)) {
            // A waiting message is ready for user input even if the HTTP stream
            // takes a little longer to close. End this stream phase immediately.
            setStreaming(false);
            activeController?.abort();
          }
        }
      }, {
        reconnect: options.reconnect ?? true,
        signal: activeController?.signal,
        recover: async (afterId) => {
          if (!conversationId || !messageId) throw new Error("缺少恢复事件流所需的会话或消息 id");
          const params = new URLSearchParams({ message_id: messageId });
          if (afterId) params.set("after_id", afterId);
          return zgiFetch(
            `agents/conversations/${encodeURIComponent(conversationId)}/events?${params}`,
            activeUser,
            { signal: activeController?.signal },
          );
        },
        onReconnect: (attempt, delay) => {
          setConnection({ phase: "reconnecting", attempt });
          setProgress(`连接中断，${Math.round(delay / 100) / 10} 秒后进行第 ${attempt} 次恢复…`);
        },
        onRecovered: () => {
          setConnection({ phase: "streaming", attempt: 0 });
          setProgress("连接已恢复，继续接收事件…");
        },
      });
      if (options.replayFromStart && !options.reconnect && !finalStreamStatus) {
        setConnection({ phase: "waiting", attempt: 0 });
        setProgress("等待继续操作");
      }
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        const message = errorMessage(error);
        setFatalError(message);
        setConnection({ phase: "failed", attempt: MAX_RECONNECT_ATTEMPTS });
        setProgress("自动恢复未成功，可点击“恢复状态”再次尝试");
      }
    } finally {
      if (streamController.current === activeController) {
        setStreaming(false);
        streamController.current = null;
      }
      void loadConversations("");
    }
  }

  async function sendMessage(event?: FormEvent, override?: string) {
    event?.preventDefault();
    const text = (override ?? query).trim();
    if (!text || streaming) return;

    const optimisticMessageId = `pending-${crypto.randomUUID()}`;
    setMessages((current) => [
      ...current,
      { id: `${optimisticMessageId}-user`, role: "user", content: text },
      { id: optimisticMessageId, role: "assistant", content: "", status: "running" },
    ]);
    setQuery("");
    setPending(null);
    const body: JsonObject = { query: text, response_mode: "streaming" };
    if (currentConversationId) body.conversation_id = currentConversationId;
    if (uploads.length) body.file_ids = uploads.map((file) => file.id);

    const controller = new AbortController();
    streamController.current = controller;
    try {
      const response = await zgiFetch("agents/chat", activeUser, {
        method: "POST",
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      setUploads([]);
      await runEventStream(response, { optimisticMessageId, reconnect: true });
    } catch (error) {
      setStreaming(false);
      setFatalError(errorMessage(error));
    }
  }

  async function stopStream() {
    if (!currentConversationId) return;
    try {
      await zgiJson(`agents/conversations/${encodeURIComponent(currentConversationId)}/stop`, activeUser, {
        method: "POST",
      });
      setProgress("停止请求已发送…");
    } catch (error) {
      setFatalError(errorMessage(error));
    }
  }

  async function recoverStream() {
    if (!currentConversation || streaming) return;
    try {
      const latestAssistant = [...messages].reverse().find((message) =>
        message.role === "assistant" && !message.id.startsWith("pending-"),
      );
      const messageId = currentConversation.active_message_id || latestAssistant?.id;
      if (!messageId) return;
      const params = new URLSearchParams({ message_id: messageId });
      const controller = new AbortController();
      streamController.current = controller;
      const response = await zgiFetch(
        `agents/conversations/${encodeURIComponent(currentConversation.id)}/events?${params}`,
        activeUser,
        { signal: controller.signal },
      );
      await runEventStream(response, {
        conversationId: currentConversation.id,
        messageId,
        replayFromStart: true,
        reconnect: !!currentConversation.active_message_id,
      });
    } catch (error) {
      setFatalError(errorMessage(error));
      setStreaming(false);
    }
  }

  async function regenerate() {
    const lastAssistant = [...messages].reverse().find((message) =>
      message.role === "assistant" && !message.id.startsWith("pending-"),
    );
    if (!lastAssistant || streaming) return;
    try {
      const optimisticId = `pending-${crypto.randomUUID()}`;
      setMessages((current) => [...current, { id: optimisticId, role: "assistant", content: "", status: "running" }]);
      const controller = new AbortController();
      streamController.current = controller;
      const response = await zgiFetch(
        `agents/messages/${encodeURIComponent(lastAssistant.id)}/regenerate`,
        activeUser,
        { method: "POST", body: "{}", signal: controller.signal },
      );
      await runEventStream(response, { optimisticMessageId: optimisticId, reconnect: true });
    } catch (error) {
      setFatalError(errorMessage(error));
      setStreaming(false);
    }
  }

  async function uploadFiles(files: FileList | null) {
    if (!files?.length) return;
    setUploading(true);
    setFatalError(null);
    try {
      const next: UploadedFile[] = [];
      for (const file of Array.from(files)) {
        const form = new FormData();
        form.append("file", file);
        next.push(await zgiJson<UploadedFile>("files/upload", activeUser, { method: "POST", body: form }));
      }
      setUploads((current) => [...current, ...next]);
    } catch (error) {
      setFatalError(errorMessage(error));
    } finally {
      setUploading(false);
    }
  }

  async function continueInteraction(body: JsonObject) {
    if (!pending || pending.kind === "unavailable" || streaming || continuing) return;
    const path = pending.kind === "skill"
      ? `agents/conversations/${encodeURIComponent(pending.conversationId)}/messages/${encodeURIComponent(pending.messageId)}/user-input/${encodeURIComponent(pending.requestId)}/continue`
      : `agents/conversations/${encodeURIComponent(pending.conversationId)}/messages/${encodeURIComponent(pending.messageId)}/workflow-continuation`;
    const interaction = pending;
    setContinuing(true);
    try {
      const controller = new AbortController();
      streamController.current = controller;
      const response = await zgiFetch(path, activeUser, {
        method: "POST",
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      await runEventStream(response, {
        conversationId: interaction.conversationId,
        messageId: interaction.messageId,
        reconnect: true,
        clearPendingOnStart: true,
      });
    } catch (error) {
      setPending(interaction);
      setFatalError(errorMessage(error));
      setStreaming(false);
    } finally {
      setContinuing(false);
    }
  }

  async function renameConversation(item: Conversation) {
    const title = window.prompt("输入新的会话名称", item.title)?.trim();
    if (title === undefined || !title) return;
    try {
      const updated = await zgiJson<Conversation>(
        `agents/conversations/${encodeURIComponent(item.id)}`,
        activeUser,
        { method: "PATCH", body: JSON.stringify({ title }) },
      );
      setConversations((current) => current.map((conversation) =>
        conversation.id === updated.id ? updated : conversation,
      ));
    } catch (error) {
      setFatalError(errorMessage(error));
    }
  }

  async function deleteConversation(item: Conversation) {
    if (!window.confirm(`确定删除“${item.title}”吗？`)) return;
    try {
      await zgiJson(`agents/conversations/${encodeURIComponent(item.id)}`, activeUser, { method: "DELETE" });
      if (item.id === currentConversationId) newConversation();
      await loadConversations("");
    } catch (error) {
      setFatalError(errorMessage(error));
    }
  }

  function onComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void sendMessage();
    }
  }

  const title = config?.home_title || config?.name || "ZGI Agent API Demo";
  const accent = validColor(config?.theme_color) ? config?.theme_color : "#7157e8";
  const displayItems = search.trim() ? uniqueSearchResults(searchResults) : conversations;
  const latestAssistant = [...messages].reverse().find((message) => message.role === "assistant");
  const canRecover = !!currentConversation && !streaming && (
    !!currentConversation.active_message_id
    || pending?.kind === "unavailable"
    || isWaitingStatus(latestAssistant?.status || "")
    || connection.phase === "failed"
  );

  return (
    <main className="app-shell" style={{ "--accent": accent } as React.CSSProperties}>
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">Z</span>
          <div>
            <strong>{config?.name || "ZGI Agent"}</strong>
            <span>Agent API · Next.js reference</span>
          </div>
        </div>
        <div className="top-actions">
          <button className="mobile-button" onClick={() => setMobilePanel("sessions")} aria-label="打开会话列表">会话</button>
          <label className="user-switcher">
            <span>外部用户</span>
            <input
              value={userDraft}
              onChange={(event) => setUserDraft(event.target.value)}
              onKeyDown={(event) => event.key === "Enter" && applyUser()}
              maxLength={128}
              aria-label="外部用户标识"
            />
            <button onClick={applyUser}>应用</button>
          </label>
          <span className={`status-pill ${fatalError ? "is-error" : ""}`}>
            <i /> {fatalError ? "需要配置" : "API 已连接"}
          </span>
          <button className="mobile-button" onClick={() => setMobilePanel("memory")} aria-label="打开记忆面板">记忆</button>
        </div>
      </header>

      <div className="workspace">
        <aside className={`sidebar ${mobilePanel === "sessions" ? "is-open" : ""}`}>
          <div className="side-heading">
            <div><span className="eyebrow">Workspace</span><h2>会话</h2></div>
            <button className="icon-button mobile-close" onClick={() => setMobilePanel(null)}>×</button>
          </div>
          <button className="new-chat" onClick={newConversation}><span>＋</span> 新建会话</button>
          <form
            className="search-box"
            onSubmit={(event) => { event.preventDefault(); void loadConversations(search); }}
          >
            <span>⌕</span>
            <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索会话和消息" />
          </form>
          <div className="conversation-list">
            {displayItems.map((item) => {
              const id = "id" in item ? item.id : item.conversation_id;
              const itemTitle = "title" in item ? item.title : item.conversation_title;
              const conversation = "id" in item ? item : conversations.find((entry) => entry.id === id);
              return (
                <div key={id} className={`conversation-row ${id === currentConversationId ? "is-active" : ""}`}>
                  <button className="conversation-main" onClick={() => void openConversation(id)}>
                    <span className="conversation-icon">✦</span>
                    <span><strong>{itemTitle || "新会话"}</strong>
                      <small>{"snippet" in item ? item.snippet : `${item.dialogue_count} 轮 · ${formatTime(item.updated_at)}`}</small>
                    </span>
                  </button>
                  {conversation && (
                    <span className="row-actions">
                      <button onClick={() => void renameConversation(conversation)} aria-label="重命名">✎</button>
                      <button onClick={() => void deleteConversation(conversation)} aria-label="删除">×</button>
                    </span>
                  )}
                </div>
              );
            })}
            {!displayItems.length && <p className="empty-copy">还没有会话。发送第一条消息开始体验。</p>}
          </div>
          <div className="identity-note"><span>i</span><p>会话、文件与记忆均由 <code>{activeUser}</code> 独立隔离。</p></div>
        </aside>

        <section className="chat-panel">
          <div className="chat-header">
            <div>
              <span className="eyebrow">Published agent</span>
              <h1>{currentConversation?.title || title}</h1>
            </div>
            <div className="header-meta">
              <span className={`connection-state is-${connection.phase}`}>
                <i /> {connectionLabel(connection)}
              </span>
              {canRecover && (
                <button className="secondary-button" onClick={() => void recoverStream()}>恢复状态</button>
              )}
              {config?.version && <span>{config.version}</span>}
              <button className="event-toggle" onClick={() => setShowEvents((value) => !value)}>
                {showEvents ? "收起事件" : `事件 ${eventLog.length}`}
              </button>
            </div>
          </div>

          {fatalError && (
            <div className="error-banner"><strong>连接未就绪</strong><span>{fatalError}</span><button onClick={() => setFatalError(null)}>×</button></div>
          )}
          {notice && <div className="notice" onAnimationEnd={() => setNotice(null)}>{notice}</div>}

          <div className="message-scroll">
            {!messages.length ? (
              <Welcome config={config} title={title} onPrompt={(prompt) => void sendMessage(undefined, prompt)} />
            ) : (
              <div className="messages">
                {messages.map((message) => <MessageBubble key={`${message.role}-${message.id}`} message={message} />)}
                {progress && <div className="progress-line"><span className="thinking-dots"><i /><i /><i /></span>{progress}</div>}
                {pending && (
                  <InteractionCard
                    key={`${pending.kind}-${pending.messageId}-${pending.kind === "approval" ? pending.formId : ""}`}
                    interaction={pending}
                    onSubmit={(body) => void continueInteraction(body)}
                    onRecover={() => void recoverStream()}
                    disabled={isPendingInteractionDisabled(streaming, connection.phase, continuing)}
                  />
                )}
                <div ref={messagesEnd} />
              </div>
            )}
          </div>

          {showEvents && <EventDrawer events={eventLog} onClose={() => setShowEvents(false)} />}

          <div className="composer-wrap">
            {!!uploads.length && (
              <div className="upload-chips">
                {uploads.map((file) => (
                  <span key={file.id}>⌑ {file.name}<button onClick={() => setUploads((current) => current.filter((item) => item.id !== file.id))}>×</button></span>
                ))}
              </div>
            )}
            <form className="composer" onSubmit={(event) => void sendMessage(event)}>
              {config?.file_upload_enabled && (
                <label className={`attach-button ${uploading ? "is-loading" : ""}`} title="上传附件">
                  <input type="file" multiple onChange={(event) => { void uploadFiles(event.target.files); event.target.value = ""; }} disabled={uploading || streaming} />
                  {uploading ? "…" : "＋"}
                </label>
              )}
              <textarea
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={onComposerKeyDown}
                placeholder={config?.input_placeholder || "输入消息，Enter 发送，Shift + Enter 换行"}
                rows={1}
                disabled={streaming}
              />
              {streaming ? (
                <button type="button" className="stop-button" onClick={() => void stopStream()} title="停止生成"><span /></button>
              ) : (
                <button type="submit" className="send-button" disabled={!query.trim()} title="发送">↑</button>
              )}
            </form>
            <div className="composer-footer">
              <span>API Key 仅保存在 Next.js 服务端</span>
              {!!messages.length && !streaming && <button onClick={() => void regenerate()}>↻ 重新生成上一条</button>}
            </div>
          </div>
        </section>

        <aside className={`memory-sidebar ${mobilePanel === "memory" ? "is-open" : ""}`}>
          <div className="side-heading memory-heading">
            <div><span className="eyebrow">User context</span><h2>Agent Memory</h2></div>
            <button className="icon-button mobile-close" onClick={() => setMobilePanel(null)}>×</button>
          </div>
          <MemoryPanel activeUser={activeUser} enabled={config?.agent_memory_enabled ?? false} onError={setFatalError} />
        </aside>
      </div>
      {mobilePanel && <button className="scrim" aria-label="关闭面板" onClick={() => setMobilePanel(null)} />}
    </main>
  );
}

function Welcome({ config, title, onPrompt }: { config: AgentConfig | null; title: string; onPrompt: (value: string) => void }) {
  return (
    <div className="welcome">
      <div className="agent-avatar">
        {config?.icon_url
          ? <span className="agent-avatar-image" role="img" aria-label={`${config.name} 图标`} style={{ backgroundImage: `url(${JSON.stringify(config.icon_url)})` }} />
          : <span>{config?.icon_type === "emoji" ? config.icon || "✦" : "✦"}</span>}
      </div>
      <span className="eyebrow">Start a conversation</span>
      <h2>{title}</h2>
      <p>{config?.opening_statement || config?.description || "这是一个覆盖完整 Agent API 接入链路的参考实现。"}</p>
      {!!config?.suggested_questions?.length && (
        <div className="suggestions">
          {config.suggested_questions.map((prompt) => <button key={prompt} onClick={() => onPrompt(prompt)}>{prompt}<span>↗</span></button>)}
        </div>
      )}
      <div className="capability-row">
        <span>◉ 流式回答</span><span>◫ 会话恢复</span>
        {config?.file_upload_enabled && <span>⌑ 文件上传</span>}
        {config?.agent_memory_enabled && <span>◇ 用户记忆</span>}
      </div>
    </div>
  );
}

function MessageBubble({ message }: { message: UiMessage }) {
  return (
    <article className={`message ${message.role}`}>
      <div className="message-avatar">{message.role === "user" ? "你" : "Z"}</div>
      <div className="message-body">
        <div className="message-label"><strong>{message.role === "user" ? "你" : "Agent"}</strong>{message.model && <span>{message.model}</span>}{message.status && <span>{statusLabel(message.status)}</span>}</div>
        <div className="message-content">{message.content || (message.status === "running" ? <span className="thinking-dots"><i /><i /><i /></span> : "（无文本输出）")}</div>
        {message.error && <p className="message-error">{message.error}</p>}
      </div>
    </article>
  );
}

function InteractionCard({ interaction, onSubmit, onRecover, disabled }: {
  interaction: PendingInteraction;
  onSubmit: (body: JsonObject) => void;
  onRecover: () => void;
  disabled: boolean;
}) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [questionAnswer, setQuestionAnswer] = useState("");
  const [choiceId, setChoiceId] = useState("");
  const [approvalInputs, setApprovalInputs] = useState<Record<string, unknown>>(() =>
    interaction.kind === "approval" ? approvalFieldDefaults(interaction.fields) : {},
  );
  const approvalExpiresAt = interaction.kind === "approval"
    ? approvalExpiryTimestamp(interaction.expiresAt)
    : null;
  const [expiryReached, setExpiryReached] = useState(false);

  useEffect(() => {
    let timer: number | undefined;
    const refreshExpiry = () => {
      const expired = approvalExpiresAt !== null && approvalExpiresAt <= Date.now();
      setExpiryReached(expired);
      if (!expired && approvalExpiresAt !== null) {
        timer = window.setTimeout(
          refreshExpiry,
          Math.min(approvalExpiresAt - Date.now(), 2_147_483_647),
        );
      }
    };
    refreshExpiry();
    return () => window.clearTimeout(timer);
  }, [approvalExpiresAt]);

  if (interaction.kind === "unavailable") {
    return (
      <section className="interaction-card unavailable-card">
        <span className="interaction-tag">STATE RECOVERY</span>
        <h3>{interaction.title}</h3>
        <p>{interaction.reason}</p>
        <button className="primary-button" disabled={disabled} onClick={onRecover}>重新加载事件状态</button>
      </section>
    );
  }

  if (interaction.kind === "approval") {
    const expired = interaction.expired || expiryReached;
    const missingRequired = interaction.fields.some((field, index) => {
      if (field.required !== true) return false;
      return approvalValueMissing(approvalInputs[approvalFieldKey(field, index)]);
    });
    return (
      <section className="interaction-card approval-card">
        <span className="interaction-tag">APPROVAL REQUIRED</span>
        <h3>{interaction.title}</h3>
        <p>{renderUnknown(interaction.content)}</p>
        {interaction.expiresAt !== undefined && (
          <p className={`approval-expiry ${expired ? "is-expired" : ""}`}>
            {expired ? "此审批已过期" : `有效期至 ${formatApprovalExpiry(interaction.expiresAt)}`}
          </p>
        )}
        {!!interaction.fields.length && (
          <div className="approval-fields">
            {interaction.fields.map((field, index) => {
              const key = approvalFieldKey(field, index);
              return (
                <ApprovalFieldInput
                  key={key}
                  field={field}
                  fieldKey={key}
                  value={approvalInputs[key]}
                  disabled={disabled || expired}
                  onChange={(value) => setApprovalInputs((current) => ({ ...current, [key]: value }))}
                />
              );
            })}
          </div>
        )}
        <div className="interaction-actions">
          {interaction.actions.map((action, index) => {
            const id = asString(action.id) || asString(action.value) || asString(action.action) || `action-${index}`;
            const label = asString(action.label) || asString(action.name) || asString(action.title) || id;
            const style = asString(action.style).toLowerCase();
            return (
              <button
                className={style === "danger" || /reject|deny|拒绝|驳回/i.test(id) ? "is-danger" : ""}
                key={id}
                disabled={disabled || expired || !interaction.token || missingRequired}
                onClick={() => onSubmit({ type: "approval", approval_token: interaction.token, action: id, inputs: approvalInputs })}
              >
                {label}
              </button>
            );
          })}
          {!interaction.actions.length && <span className="interaction-warning">没有可渲染的审批操作，请重新加载事件状态。</span>}
        </div>
      </section>
    );
  }

  if (interaction.kind === "question") {
    const choices = interaction.choices.map(normalizeChoice);
    return (
      <section className="interaction-card">
        <span className="interaction-tag">WORKFLOW QUESTION</span>
        <h3>{interaction.title}</h3>
        <p>{interaction.question}</p>
        {!!choices.length && <div className="choice-grid">{choices.map((choice) => <button className={choiceId === choice.id ? "selected" : ""} key={choice.id} onClick={() => { setChoiceId(choice.id); setQuestionAnswer(choice.label); }}>{choice.label}</button>)}</div>}
        <input value={questionAnswer} onChange={(event) => setQuestionAnswer(event.target.value)} placeholder="输入回答" />
        <button className="primary-button" disabled={disabled || !questionAnswer.trim()} onClick={() => onSubmit({ type: "question_answer", inputs: { query: questionAnswer.trim(), ...(choiceId ? { question_answer_option_id: choiceId } : {}) } })}>提交并继续</button>
      </section>
    );
  }

  return (
    <section className="interaction-card">
      <span className="interaction-tag">SKILL INPUT</span>
      <h3>{interaction.title}</h3>
      {interaction.questions.map((question) => (
        <label className="question-field" key={question.id}>
          <span>{question.question}</span>
          {question.options?.length ? (
            <select value={answers[question.id] || ""} onChange={(event) => setAnswers((current) => ({ ...current, [question.id]: event.target.value }))}>
              <option value="">请选择</option>
              {question.options.map((option) => {
                const value = typeof option === "string" ? option : option.label;
                return <option key={value} value={value}>{value}</option>;
              })}
            </select>
          ) : (
            <input value={answers[question.id] || ""} onChange={(event) => setAnswers((current) => ({ ...current, [question.id]: event.target.value }))} placeholder="请输入" />
          )}
        </label>
      ))}
      <button className="primary-button" disabled={disabled || interaction.questions.some((question) => !answers[question.id]?.trim())} onClick={() => onSubmit({ answers })}>提交并继续</button>
    </section>
  );
}

function ApprovalFieldInput({ field, fieldKey, value, disabled, onChange }: {
  field: JsonObject;
  fieldKey: string;
  value: unknown;
  disabled: boolean;
  onChange: (value: unknown) => void;
}) {
  const label = asString(field.label) || asString(field.title) || asString(field.name) || fieldKey;
  const fieldType = (asString(field.type) || asString(field.input_type) || "text").toLowerCase();
  const options = Array.isArray(field.options) ? field.options.map(normalizeChoice) : [];
  const required = field.required === true;

  if (["checkbox", "boolean", "switch"].includes(fieldType)) {
    return (
      <label className="approval-field checkbox-field">
        <input type="checkbox" checked={value === true} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
        <span>{label}{required && <b> *</b>}</span>
      </label>
    );
  }

  return (
    <label className="approval-field">
      <span>{label}{required && <b> *</b>}</span>
      {fieldType === "textarea" || fieldType === "long_text" ? (
        <textarea
          value={String(value ?? "")}
          disabled={disabled}
          placeholder={asString(field.placeholder)}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : options.length || ["select", "radio"].includes(fieldType) ? (
        <select value={String(value ?? "")} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
          <option value="">请选择</option>
          {options.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
        </select>
      ) : (
        <input
          type={fieldType === "number" ? "number" : "text"}
          value={String(value ?? "")}
          disabled={disabled}
          placeholder={asString(field.placeholder)}
          onChange={(event) => onChange(fieldType === "number" ? event.target.valueAsNumber : event.target.value)}
        />
      )}
      {asString(field.description) && <small>{asString(field.description)}</small>}
    </label>
  );
}

function approvalFieldKey(field: JsonObject, index: number): string {
  return asString(field.id) || asString(field.key) || asString(field.name) || `field_${index + 1}`;
}

function approvalFieldDefaults(fields: JsonObject[]): Record<string, unknown> {
  return Object.fromEntries(fields.map((field, index) => [
    approvalFieldKey(field, index),
    field.default_value ?? field.value ?? (asString(field.type) === "checkbox" ? false : ""),
  ]));
}

function approvalValueMissing(value: unknown): boolean {
  return value === undefined || value === null || value === "" || Number.isNaN(value);
}

function formatApprovalExpiry(value: string | number): string {
  const parsedNumber = typeof value === "number" ? value : Number(value);
  const timestamp = Number.isFinite(parsedNumber)
    ? parsedNumber * (parsedNumber < 10_000_000_000 ? 1000 : 1)
    : Date.parse(String(value));
  if (!Number.isFinite(timestamp)) return String(value);
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(timestamp);
}

function EventDrawer({ events, onClose }: { events: SseEvent[]; onClose: () => void }) {
  return (
    <aside className="event-drawer">
      <header><div><span className="eyebrow">Developer view</span><h3>SSE 事件</h3></div><button onClick={onClose}>×</button></header>
      <p>保留最近 40 个事件。每个非空 <code>id</code> 都会作为恢复游标保存。</p>
      <div className="event-list">
        {[...events].reverse().map((event, index) => (
          <details key={`${event.id || "event"}-${index}`}>
            <summary><span>{event.event}</span><code>{event.id || "non-recoverable"}</code></summary>
            <pre>{JSON.stringify(event.data, null, 2)}</pre>
          </details>
        ))}
        {!events.length && <p className="empty-copy">发送消息后可在这里检查事件负载。</p>}
      </div>
    </aside>
  );
}

interface ReconnectOptions {
  reconnect: boolean;
  signal?: AbortSignal;
  recover: (afterId: string) => Promise<Response>;
  onReconnect: (attempt: number, delay: number) => void;
  onRecovered: () => void;
}

async function consumeSseWithReconnect(
  initialResponse: Response,
  onEvent: (event: SseEvent) => void,
  options: ReconnectOptions,
): Promise<void> {
  let response = initialResponse;
  let lastEventId = "";
  let attempt = 0;
  let terminal = false;
  const seenEventIds = new Set<string>();

  while (true) {
    let streamError: unknown;
    try {
      await consumeSse(response, (event) => {
        if (event.id) {
          if (seenEventIds.has(event.id)) return;
          seenEventIds.add(event.id);
          lastEventId = event.id;
        }
        if (event.event === "message_end" || event.event === "error") terminal = true;
        onEvent(event);
      });
    } catch (error) {
      streamError = error;
    }

    if (terminal || !options.reconnect) {
      if (streamError) throw streamError;
      return;
    }
    if (options.signal?.aborted || isAbortError(streamError)) throw streamError;
    if (streamError && !isRetryableStreamError(streamError)) throw streamError;
    if (attempt >= MAX_RECONNECT_ATTEMPTS) {
      throw streamError || new Error("事件流在进入终态前断开，自动重连次数已用尽");
    }

    attempt += 1;
    const delay = reconnectDelay(attempt);
    options.onReconnect(attempt, delay);
    await abortableDelay(delay, options.signal);
    response = await options.recover(lastEventId);
    if (response.ok) options.onRecovered();
  }
}

function reconnectDelay(attempt: number): number {
  return Math.min(800 * 2 ** (attempt - 1), 8000);
}

function isRetryableStreamError(error: unknown): boolean {
  return !(error instanceof AgentApiError) || error.status === 429 || error.status >= 500;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      window.clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    const timer = window.setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function pendingFromUserInputEvent(
  data: JsonObject,
  conversationId: string,
  messageId: string,
): PendingInteraction {
  if (asString(data.source) === "agent_workflow_question_answer") {
    const questions = toQuestions(data.questions);
    const rawQuestion = jsonObjectArray(data.questions)[0] || {};
    return {
      kind: "question",
      conversationId,
      messageId,
      title: asString(data.node_title, "工作流问题"),
      question: questions[0]?.question || "请选择或输入答案",
      choices: Array.isArray(rawQuestion.options) ? rawQuestion.options : [],
    };
  }
  return {
    kind: "skill",
    conversationId,
    messageId,
    requestId: asString(data.request_id),
    title: asString(data.message, "Agent 需要补充信息"),
    questions: toQuestions(data.questions),
  };
}

function pendingFromWorkflowQuestionEvent(
  data: JsonObject,
  conversationId: string,
  messageId: string,
): PendingInteraction {
  return {
    kind: "question",
    conversationId,
    messageId,
    title: asString(data.node_title) || asString(data.title, "工作流问题"),
    question: asString(data.question, "请选择或输入答案"),
    choices: Array.isArray(data.choices) ? data.choices : [],
  };
}

function pendingFromApprovalEvent(
  data: JsonObject,
  conversationId: string,
  messageId: string,
): PendingInteraction {
  const approval = normalizeApprovalState(data);
  if (!approval.uiAllowed) {
    return {
      kind: "unavailable",
      conversationId,
      messageId,
      status: "waiting_approval",
      title: "审批状态需要恢复",
      reason: "此审批不允许在当前 API 客户端中处理。",
    };
  }
  return {
    kind: "approval",
    conversationId,
    messageId,
    title: approval.title,
    content: approval.content,
    token: approval.token,
    formId: approval.formId,
    fields: approval.fields,
    actions: approval.actions,
    expiresAt: approval.expiresAt,
    expired: isExpiredApproval(approval.expiresAt),
  };
}

function pendingFromMessageMetadata(message: ConversationMessage): PendingInteraction | null {
  if (!isWaitingStatus(message.status)) return null;
  const metadata = message.metadata || {};

  if (message.status === "waiting_approval") {
    const continuation = objectValue(metadata.agent_workflow_continuation);
    const form = latestApprovalForm(metadata);
    const approval = normalizeApprovalState(continuation, form);

    if (approval.token && approval.actions.length && approval.uiAllowed) {
      return {
        kind: "approval",
        conversationId: message.conversation_id,
        messageId: message.id,
        title: approval.title,
        content: approval.content,
        token: approval.token,
        formId: approval.formId,
        fields: approval.fields,
        actions: approval.actions,
        expiresAt: approval.expiresAt,
        expired: isExpiredApproval(approval.expiresAt),
      };
    }

    return {
      kind: "unavailable",
      conversationId: message.conversation_id,
      messageId: message.id,
      status: "waiting_approval",
      title: "审批状态需要恢复",
      reason: approval.uiAllowed
        ? "历史消息中缺少完整审批表单或可用操作，请重新回放该消息的事件流。"
        : "此审批不允许在当前 API 客户端中处理。",
    };
  }

  return pendingQuestionFromMetadata(message, metadata);
}

function pendingQuestionFromMetadata(
  message: ConversationMessage,
  metadata: JsonObject,
): PendingInteraction {
  const request = objectValue(metadata.user_input_request);
  const questions = toQuestions(request.questions);
  if (asString(request.source) === "agent_workflow_question_answer" && questions.length) {
    const rawQuestion = jsonObjectArray(request.questions)[0] || {};
    return {
      kind: "question",
      conversationId: message.conversation_id,
      messageId: message.id,
      title: asString(request.node_title, "工作流问题"),
      question: questions[0].question,
      choices: Array.isArray(rawQuestion.options) ? rawQuestion.options : [],
    };
  }
  if (asString(request.request_id) && questions.length) {
    return {
      kind: "skill",
      conversationId: message.conversation_id,
      messageId: message.id,
      requestId: asString(request.request_id),
      title: asString(request.message, "Agent 需要补充信息"),
      questions,
    };
  }
  return {
    kind: "unavailable",
    conversationId: message.conversation_id,
    messageId: message.id,
    status: "waiting_question",
    title: "问答状态需要恢复",
    reason: "历史消息中缺少问题定义，请重新回放该消息的事件流。",
  };
}

function latestApprovalForm(metadata: JsonObject): JsonObject {
  const runs = Array.isArray(metadata.workflow_runs) ? [...metadata.workflow_runs].reverse() : [];
  for (const value of runs) {
    const run = objectValue(value);
    const approval = objectValue(run.approval);
    const form = objectValue(approval.approval_form);
    if (Object.keys(form).length) return form;
  }
  return {};
}

function objectValue(value: unknown): JsonObject {
  return isObject(value) ? value : {};
}

function jsonObjectArray(value: unknown): JsonObject[] {
  return Array.isArray(value) ? value.filter(isObject) : [];
}

function isExpiredApproval(expiresAt?: string | number): boolean {
  const timestamp = approvalExpiryTimestamp(expiresAt);
  return timestamp !== null && timestamp <= Date.now();
}

function approvalExpiryTimestamp(expiresAt?: string | number): number | null {
  if (expiresAt === undefined) return null;
  const parsedNumber = typeof expiresAt === "number" ? expiresAt : Number(expiresAt);
  const timestamp = Number.isFinite(parsedNumber)
    ? parsedNumber * (parsedNumber < 10_000_000_000 ? 1000 : 1)
    : Date.parse(String(expiresAt));
  return Number.isFinite(timestamp) ? timestamp : null;
}

function isWaitingStatus(status: string): status is "waiting_approval" | "waiting_question" {
  return status === "waiting_approval" || status === "waiting_question";
}

function upsertConversation(items: Conversation[], detail: Conversation): Conversation[] {
  if (items.some((item) => item.id === detail.id)) {
    return items.map((item) => item.id === detail.id ? detail : item);
  }
  return [detail, ...items];
}

function toUiMessages(message: ConversationMessage): UiMessage[] {
  const result: UiMessage[] = [];
  if (message.query) result.push({ id: `${message.id}-user`, role: "user", content: message.query });
  result.push({ id: message.id, role: "assistant", content: message.answer, status: message.status, model: message.model_name, error: message.error || undefined });
  return result;
}

function compareMessagesChronologically(left: ConversationMessage, right: ConversationMessage): number {
  return left.created_at - right.created_at
    || left.updated_at - right.updated_at
    || left.id.localeCompare(right.id);
}

function bindOptimisticAssistant(
  messages: UiMessage[],
  placeholderId: string,
  actualMessageId: string,
): UiMessage[] {
  const placeholderIndex = messages.findIndex(
    (message) => message.role === "assistant" && message.id === placeholderId,
  );
  if (placeholderIndex < 0) return messages;

  const actualIndex = messages.findIndex(
    (message) => message.role === "assistant" && message.id === actualMessageId,
  );
  if (actualIndex >= 0) {
    return messages.filter((_, index) => index !== placeholderIndex);
  }

  return messages.map((message, index) =>
    index === placeholderIndex ? { ...message, id: actualMessageId } : message,
  );
}

function toQuestions(value: unknown): UserInputQuestion[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isObject).map((question, index) => ({
    id: asString(question.id, `question-${index + 1}`),
    question: asString(question.question, `问题 ${index + 1}`),
    options: Array.isArray(question.options)
      ? question.options.filter((option): option is string | { label: string; description?: string } =>
          typeof option === "string" || (isObject(option) && typeof option.label === "string"),
        )
      : undefined,
  }));
}

function progressLabel(data: JsonObject): string {
  const activity = asString(data.activity);
  const labels: Record<string, string> = {
    awaiting_response: "等待模型响应…",
    reviewing_tool_result: "正在整理工具结果…",
    reasoning: "正在处理复杂问题…",
    preparing_action: "正在准备下一步操作…",
  };
  return labels[activity] || "Agent 正在处理…";
}

function connectionLabel(connection: { phase: ConnectionPhase; attempt: number }): string {
  const labels: Record<ConnectionPhase, string> = {
    idle: "就绪",
    connecting: "连接中",
    streaming: "流式接收",
    reconnecting: `重连 ${connection.attempt}/${MAX_RECONNECT_ATTEMPTS}`,
    restoring: "恢复状态",
    waiting: "等待交互",
    failed: "连接中断",
  };
  return labels[connection.phase];
}

function normalizeChoice(value: unknown, index: number) {
  if (typeof value === "string") return { id: value, label: value };
  if (isObject(value)) {
    const id = asString(value.id) || asString(value.value) || asString(value.option_id) || String(index);
    return { id, label: asString(value.label) || asString(value.name) || asString(value.title) || id };
  }
  return { id: String(index), label: String(value) };
}

function renderUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "请确认是否允许工作流继续执行。";
  return JSON.stringify(value, null, 2);
}

function uniqueSearchResults(results: SearchResult[]): SearchResult[] {
  return [...new Map(results.map((item) => [item.conversation_id, item])).values()];
}

function cursorKey(user: string, messageId: string) {
  return `zgi-sse:${user}:${messageId}`;
}

function conversationKey(user: string) {
  return `zgi-demo-conversation:${user}`;
}

function validColor(value?: string): boolean {
  return !!value && /^(#[0-9a-f]{3,8}|rgb|hsl)/i.test(value);
}

function statusLabel(status: string) {
  const labels: Record<string, string> = {
    running: "生成中",
    completed: "已完成",
    stopped: "已停止",
    error: "失败",
    failed: "失败",
    waiting_approval: "待审批",
    waiting_question: "待回答",
  };
  return labels[status] || status;
}

function formatTime(timestamp: number) {
  if (!timestamp) return "刚刚";
  return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(timestamp * 1000);
}
