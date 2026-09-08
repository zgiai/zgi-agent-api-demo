export type JsonObject = Record<string, unknown>;

export interface ApiEnvelope<T> {
  code: string;
  message: string;
  data: T;
}

export interface AgentConfig {
  agent_id: string;
  web_app_id: string;
  agent_type: string;
  name: string;
  description: string;
  icon: string;
  icon_type: string;
  icon_url: string;
  home_title: string;
  opening_statement: string;
  input_placeholder: string;
  theme_color: string;
  suggested_questions: string[];
  file_upload_enabled: boolean;
  supports_vision: boolean;
  agent_memory_enabled: boolean;
  memory_requires_user: boolean;
  external_user_required: boolean;
  version: string;
  version_uuid: string;
}

export interface Conversation {
  id: string;
  title: string;
  status: string;
  runtime_status: string;
  current_leaf_message_id?: string | null;
  active_message_id?: string | null;
  dialogue_count: number;
  created_at: number;
  updated_at: number;
}

export interface ConversationList {
  data: Conversation[];
  page: number;
  limit: number;
  total: number;
  has_more: boolean;
}

export interface ConversationMessage {
  id: string;
  conversation_id: string;
  parent_id?: string | null;
  query: string;
  answer: string;
  status: string;
  error?: string | null;
  model_name: string;
  metadata?: JsonObject;
  created_at: number;
  updated_at: number;
}

export interface MessageList {
  data: ConversationMessage[];
  page: number;
  limit: number;
  total: number;
  has_more: boolean;
}

export interface SearchResult {
  type: "conversation" | "message";
  conversation_id: string;
  conversation_title: string;
  message_id?: string | null;
  snippet: string;
  updated_at: number;
}

export interface UploadedFile {
  id: string;
  name: string;
  size: number;
  extension: string;
  mime_type: string;
  created_by: string;
  created_at: number;
}

export interface MemorySlot {
  id: string;
  key: string;
  name: string;
  description: string;
  max_chars: number;
  enabled: boolean;
  sort_order: number;
  content: string;
  revision: number;
  source_kind: string;
  last_operation_id?: string;
  undoable_until?: number;
  updated_at_display: string;
}

export interface MemoryExport {
  agent_id: string;
  user_scope: "end_user";
  user_id: string;
  exported_at: number;
  values: MemorySlot[];
}

export interface SseEvent {
  id?: string;
  event: string;
  data: JsonObject;
}

export interface UserInputQuestion {
  id: string;
  question: string;
  options?: Array<string | { label: string; description?: string }>;
}

export interface UiMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  status?: string;
  model?: string;
  error?: string;
}

export type PendingInteraction =
  | {
      kind: "skill";
      conversationId: string;
      messageId: string;
      requestId: string;
      title: string;
      questions: UserInputQuestion[];
    }
  | {
      kind: "question";
      conversationId: string;
      messageId: string;
      title: string;
      question: string;
      choices: unknown[];
    }
  | {
      kind: "approval";
      conversationId: string;
      messageId: string;
      title: string;
      content: unknown;
      token: string;
      formId?: string;
      fields: JsonObject[];
      actions: JsonObject[];
      expiresAt?: string | number;
      expired: boolean;
    }
  | {
      kind: "unavailable";
      conversationId: string;
      messageId: string;
      status: "waiting_approval" | "waiting_question";
      title: string;
      reason: string;
    };
