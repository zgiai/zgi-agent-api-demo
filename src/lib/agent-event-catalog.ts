export type AgentEventCategory = "message" | "progress" | "skill" | "memory" | "workflow" | "interaction" | "unknown";

export interface AgentEventDefinition {
  category: AgentEventCategory;
  categoryLabel: string;
  title: string;
  description: string;
  clientAction: string;
  keyFields: string[];
}

type DefinitionInput = Omit<AgentEventDefinition, "category" | "categoryLabel">;

const CATEGORY_LABELS: Record<AgentEventCategory, string> = {
  message: "消息",
  progress: "进度与文件",
  skill: "Skill 与工具",
  memory: "Memory",
  workflow: "工作流",
  interaction: "等待交互",
  unknown: "未知",
};

function define(category: AgentEventCategory, events: Record<string, DefinitionInput>) {
  return Object.fromEntries(Object.entries(events).map(([name, value]) => [name, {
    ...value,
    category,
    categoryLabel: CATEGORY_LABELS[category],
  }])) as Record<string, AgentEventDefinition>;
}

export const AGENT_EVENT_CATALOG: Record<string, AgentEventDefinition> = {
  ...define("message", {
    message_start: { title: "消息开始", description: "助手消息记录已经创建，正文尚未开始输出。", clientAction: "立即保存会话和消息 ID，并创建或绑定回答容器。", keyFields: ["conversation_id", "message_id", "parent_id", "title", "model", "replace", "created_at"] },
    message: { title: "回答片段", description: "模型产生了一段新的可见回答文本。", clientAction: "按 message_id 把 answer 追加到当前回答。", keyFields: ["conversation_id", "message_id", "answer", "sequence", "created_at_ms"] },
    message_retract: { title: "撤回候选文本", description: "此前发送的候选文本不再属于最终回答。", clientAction: "从正文移除 answer；process 可移入过程区，discard 直接丢弃。", keyFields: ["conversation_id", "message_id", "presentation_disposition", "answer"] },
    message_end: { title: "消息阶段结束", description: "本次 SSE 阶段已经结束，可能是终态，也可能等待用户交互。", clientAction: "读取 status；等待态保留消息并开放交互，终态结束本次运行。", keyFields: ["conversation_id", "message_id", "status", "answer", "metadata"] },
    error: { title: "运行错误", description: "流式传输或 Agent runtime 返回了客户端安全错误。", clientAction: "展示 message、记录 code，并在没有后续 message_end 时按失败结束。", keyFields: ["conversation_id", "message_id", "message", "code", "params"] },
  }),
  ...define("progress", {
    agent_progress: { title: "模型处理进度", description: "Agent 正在等待模型、复核工具结果、推理或准备动作。", clientAction: "只显示高层加载状态，不把它当作模型正文或思维链。", keyFields: ["phase", "progress_id", "activity", "stage", "source", "round", "elapsed_ms"] },
    agent_intermediate_answer: { title: "阶段性答案", description: "Agent 产生了可以单独展示的中间结果。", clientAction: "按 answer_id 分组；delta=true 追加，否则替换，done=true 时封口。", keyFields: ["answer_id", "title", "content", "delta", "index", "done", "status"] },
    file_parse_start: { title: "文件解析开始", description: "开始解析本轮引用的一个上传文件。", clientAction: "展示文件级解析进度和 index / total。", keyFields: ["file_id", "name", "kind", "index", "total", "status"] },
    file_parse_end: { title: "文件解析完成", description: "文件解析完成，内容也可能被策略过滤。", clientAction: "结束对应文件进度，并检查 content_status。", keyFields: ["file_id", "name", "status", "content_status", "content_chars", "from_cache", "filtered_reason"] },
    file_parse_error: { title: "文件解析失败", description: "单个上传文件未能成功解析。", clientAction: "标记该文件失败并展示安全 message，不要默认终止其他文件。", keyFields: ["file_id", "name", "status", "message", "index", "total"] },
  }),
  ...define("skill", {
    skill_load_start: { title: "Skill 加载开始", description: "兼容执行模式开始加载 Skill 指令。", clientAction: "可显示加载进度，但不能据此判断工具已经执行。", keyFields: ["skill_id", "status", "effective_version"] },
    skill_load_end: { title: "Skill 加载完成", description: "兼容执行模式完成 Skill 加载。", clientAction: "结束加载进度，摘要字段仅用于诊断。", keyFields: ["skill_id", "status", "instruction_digest", "instruction_chars"] },
    skill_reference_read: { title: "Skill 参考资料", description: "Skill 读取了一份公开参考资料。", clientAction: "可按 skill_id 和 path 展示为执行轨迹。", keyFields: ["skill_id", "path", "status", "access_status"] },
    skill_call_start: { title: "工具调用开始", description: "Agent 开始一次 Skill 工具调用。", clientAction: "用 invocation_id 创建运行步骤并展示公开参数摘要。", keyFields: ["skill_id", "tool_name", "invocation_id", "arguments_summary", "arguments", "status"] },
    skill_call_end: { title: "工具调用完成", description: "Skill 工具调用成功结束。", clientAction: "用 invocation_id 完成原步骤并展示公开 result。", keyFields: ["skill_id", "tool_name", "invocation_id", "result", "duration_ms", "status"] },
    skill_call_error: { title: "工具调用失败", description: "Skill 工具调用失败，但模型仍可能继续生成回答。", clientAction: "标记对应 invocation_id 失败并展示安全错误信息。", keyFields: ["skill_id", "tool_name", "invocation_id", "message", "error_code", "duration_ms", "status"] },
    skill_artifact_created: { title: "文件产物已生成", description: "Skill 创建了可以展示或下载的文件产物。", clientAction: "展示文件卡片，优先使用 download_url，并检查 expires_at。", keyFields: ["invocation_id", "artifact_id", "file_id", "filename", "mime_type", "size", "download_url", "expires_at"] },
    tool_governance_decision: { title: "工具治理决定", description: "已发布 Agent 对工具执行做出了非交互式允许或拒绝决定。", clientAction: "可展示或记录原因；requires_approval=false，不要渲染人工审批 UI。", keyFields: ["correlation_id", "decision", "requires_approval", "reason", "risk_level", "effect", "asset_type"] },
  }),
  ...define("memory", {
    memory_create: { title: "Memory 新建", description: "首次写入一个 Agent Memory 槽位。", clientAction: "刷新对应槽位，并在 operation_id 可用时提供撤销入口。", keyFields: ["memory_scope", "action", "key", "display_name", "operation_id", "revision", "undoable_until"] },
    memory_update: { title: "Memory 更新", description: "已有 Agent Memory 槽位被替换或自动更新。", clientAction: "用 revision 使本地缓存失效并刷新该槽位。", keyFields: ["memory_scope", "action", "key", "operation_id", "revision", "source_kind"] },
    memory_delete: { title: "Memory 删除", description: "一个 Agent Memory 槽位值被删除。", clientAction: "清空对应槽位并更新 revision。", keyFields: ["memory_scope", "action", "key", "operation_id", "revision"] },
    memory_clear: { title: "Memory 批量清空", description: "当前外部用户的可写 Agent Memory 被批量清空。", clientAction: "刷新整份 Memory，而不是只更新一个槽位。", keyFields: ["memory_scope", "action", "status", "operation_id"] },
  }),
  ...define("interaction", {
    user_input_requested: { title: "需要补充输入", description: "Skill 需要用户补充字段，或工作流问题被投影为通用输入结构。", clientAction: "按 source 分流：工作流问题走 workflow continuation，其余走 user-input continue。", keyFields: ["request_id", "message", "questions", "source", "workflow_run_id", "node_id", "round"] },
    approval_requested: { title: "需要人工审批", description: "工作流暂停并请求最终用户审批。", clientAction: "从嵌套 approval_form 渲染字段和动作，提交顶层 approval_token。", keyFields: ["workflow_run_id", "approval_form_id", "approval_token", "approval_url", "ui_approval_allowed", "approval_form"] },
    approval_result_filled: { title: "审批结果已提交", description: "审批动作和表单输入已经成功提交。", clientAction: "把审批卡片切为只读结果并等待工作流继续。", keyFields: ["form_id", "action_id", "action_label", "inputs", "rendered_content"] },
    approval_expired: { title: "审批已过期", description: "审批令牌或表单已经超过有效期。", clientAction: "禁用提交入口，并提示用户重新发起对应任务。", keyFields: ["form_id", "expires_at", "status"] },
    question_answer_requested: { title: "需要回答工作流问题", description: "工作流节点暂停，等待用户选择或输入答案。", clientAction: "渲染 question 和 choices，通过 workflow continuation 提交。", keyFields: ["workflow_run_id", "node_id", "node_title", "question", "choices", "round"] },
    question_answer_submitted: { title: "工作流答案已提交", description: "用户答案已经提交给暂停的工作流。", clientAction: "把问题卡片切为已回答状态并等待工作流继续。", keyFields: ["workflow_run_id", "node_id", "answer", "trigger_id", "round"] },
  }),
  ...define("workflow", {
    workflow_started: { title: "工作流开始", description: "Agent 绑定的工作流开始运行。", clientAction: "创建顶层运行步骤并保存 workflow_run_id。", keyFields: ["workflow_run_id", "id", "workflow_id", "status"] },
    workflow_paused: { title: "工作流暂停", description: "工作流因审批或问答进入暂停。", clientAction: "保留运行上下文并等待紧邻的交互请求事件。", keyFields: ["workflow_run_id", "status", "reasons", "paused_at"] },
    workflow_resumed: { title: "工作流恢复", description: "暂停的工作流已经恢复执行。", clientAction: "清除等待态并把顶层运行步骤改回运行中。", keyFields: ["workflow_run_id", "status"] },
    workflow_finished: { title: "工作流完成", description: "工作流成功结束并产生最终输出。", clientAction: "完成顶层运行步骤；最终聊天正文仍以消息事件为准。", keyFields: ["workflow_run_id", "status", "outputs", "elapsed_time", "total_tokens", "total_steps", "finished_at"] },
    workflow_failed: { title: "工作流失败", description: "工作流以失败状态结束。", clientAction: "标记运行失败并展示公开 error 摘要。", keyFields: ["workflow_run_id", "status", "error", "elapsed_time", "finished_at"] },
    workflow_stopped: { title: "工作流停止", description: "工作流被用户或系统停止。", clientAction: "标记运行已停止并展示可用 reasons。", keyFields: ["workflow_run_id", "status", "reasons", "finished_at"] },
    node_started: { title: "节点开始", description: "工作流中的一个节点开始执行。", clientAction: "按 node_id 创建子步骤，可展示标题和公开输入摘要。", keyFields: ["id", "node_id", "node_type", "title", "index", "inputs", "created_at"] },
    node_finished: { title: "节点结束", description: "工作流节点完成或失败。", clientAction: "按 node_id 更新已有步骤，并展示状态、输出或安全错误。", keyFields: ["id", "node_id", "node_type", "title", "status", "outputs", "error", "elapsed_time", "finished_at"] },
    iteration_started: { title: "迭代开始", description: "迭代容器开始处理一组项目。", clientAction: "创建迭代容器步骤并记录 node_id。", keyFields: ["id", "node_id", "node_type", "title", "inputs", "status"] },
    iteration_next: { title: "下一项迭代", description: "迭代容器开始处理下一项。", clientAction: "更新 iteration_index 或 index 进度。", keyFields: ["id", "node_id", "index", "iteration_index", "status"] },
    iteration_completed: { title: "迭代处理完成", description: "所有迭代项已运行，容器准备汇总。", clientAction: "展示 steps / outputs 摘要，等待最终 succeeded 或 failed。", keyFields: ["id", "node_id", "steps", "outputs", "status"] },
    iteration_succeeded: { title: "迭代成功", description: "迭代容器成功终止。", clientAction: "完成迭代步骤并记录耗时。", keyFields: ["id", "node_id", "outputs", "elapsed_time", "finished_at"] },
    iteration_failed: { title: "迭代失败", description: "迭代容器失败终止。", clientAction: "标记迭代失败并展示公开 error。", keyFields: ["id", "node_id", "error", "elapsed_time", "finished_at"] },
    loop_started: { title: "循环开始", description: "循环容器开始执行。", clientAction: "创建循环容器步骤并记录 node_id。", keyFields: ["id", "node_id", "node_type", "title", "inputs", "status"] },
    loop_next: { title: "下一轮循环", description: "循环容器进入下一轮。", clientAction: "更新 loop_index 或 index 进度。", keyFields: ["id", "node_id", "index", "loop_index", "status"] },
    loop_completed: { title: "循环处理完成", description: "循环条件结束，容器准备汇总。", clientAction: "展示 steps / outputs 摘要，等待最终 succeeded 或 failed。", keyFields: ["id", "node_id", "steps", "outputs", "status"] },
    loop_succeeded: { title: "循环成功", description: "循环容器成功终止。", clientAction: "完成循环步骤并记录耗时。", keyFields: ["id", "node_id", "outputs", "elapsed_time", "finished_at"] },
    loop_failed: { title: "循环失败", description: "循环容器失败终止。", clientAction: "标记循环失败并展示公开 error。", keyFields: ["id", "node_id", "error", "elapsed_time", "finished_at"] },
    text_chunk: { title: "工作流文本片段", description: "会话型工作流追加了一段可见文本。", clientAction: "把 text 或 answer 追加到当前助手回答。", keyFields: ["workflow_run_id", "text", "answer", "data"] },
    text_replace: { title: "工作流文本替换", description: "会话型工作流要求替换此前可见文本。", clientAction: "用 text 或 answer 替换当前助手回答，而不是追加。", keyFields: ["workflow_run_id", "text", "answer", "data"] },
  }),
};

export const PUBLIC_AGENT_EVENT_NAMES = Object.freeze(Object.keys(AGENT_EVENT_CATALOG));

export function getAgentEventDefinition(eventName: string): AgentEventDefinition {
  return AGENT_EVENT_CATALOG[eventName] || {
    category: "unknown",
    categoryLabel: CATEGORY_LABELS.unknown,
    title: "未识别事件",
    description: "服务端发送了当前 demo 尚未登记的新事件。",
    clientAction: "保留完整 payload 便于诊断；业务 UI 应安全忽略未知事件。",
    keyFields: [],
  };
}
