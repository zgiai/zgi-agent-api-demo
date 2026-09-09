# Agent 工作流恢复与 UI 接入

本文描述客户端在正常流式回答、网络断线、页面刷新、审批等待、工作流问答和 Skill 补充输入等状态下应该怎样恢复。示例中的 `agentApiBaseUrl` 是页面配置的 Agent API Base URL，请求由浏览器直连 ZGI。

## 三个必须持久化的标识

一次运行至少涉及：

- `conversation_id`：会话 id，用于历史、事件恢复、停止和工作流继续。
- `message_id`：当前助手消息 id，用于恢复同一条运行和提交继续请求。
- SSE `id`：客户端最后完整处理的事件游标，用作 `after_id`。没有 `id` 的事件不能作为恢复点。

新聊天和重新生成会在响应头提前返回 `X-ZGI-Conversation-ID` 与 `X-ZGI-Message-ID`。应在读取第一帧前保存它们，不能只等待 `message_start`。

## 状态恢复矩阵

| 服务端状态 | 判断依据 | 页面打开后的动作 | 用户操作后的接口 |
| --- | --- | --- | --- |
| 运行中 | `conversation.runtime_status=running` 且存在 `active_message_id` | 加载历史，再从事件起点回放并保持连接 | 可调用 `/stop` |
| 等待审批 | 最新消息为 `waiting_approval` | 先从消息 metadata 恢复表单，再从事件起点回放以取得最新审批事件 | workflow continuation，`type=approval` |
| 工作流问答 | `question_answer_requested`，或 `user_input_requested.source=agent_workflow_question_answer` | 渲染问题与 choices，保留相同 message id | workflow continuation，`type=question_answer` |
| Skill 补充输入 | 其他 `user_input_requested` | 按 `questions[].id` 收集 answers | user-input continuation |
| 已完成/停止/失败 | `completed`、`stopped`、`error`、`failed` | 只恢复消息历史，不建立事件连接 | 无 |

等待状态会结束当前 SSE 阶段，但不会结束整条消息。提交审批或答案后，必须继续消费 continuation 接口返回的新 SSE 流，直到下一次等待或真正终态。

## 同一页面内断线重连

只有在客户端仍保有已经渲染的消息内容时，才使用最后一个 SSE id 增量续拉：

```ts
let lastEventId = "";
const seen = new Set<string>();

async function onEvent(event: ZgiEvent) {
  if (event.id) {
    if (seen.has(event.id)) return;
    seen.add(event.id);
    lastEventId = event.id;
  }
  reduceEventIntoUI(event);
}

async function reconnect(conversationId: string, messageId: string) {
  const query = new URLSearchParams({ message_id: messageId });
  if (lastEventId) query.set("after_id", lastEventId);
  const response = await fetch(
    `${agentApiBaseUrl}/agents/conversations/${conversationId}/events?${query}`,
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "X-External-User-ID": externalUserId,
      },
    },
  );
  await consumeSse(response, onEvent);
}
```

本 demo 对网络错误、HTTP `429` 和 `5xx` 最多自动尝试 5 次，退避时间为 0.8、1.6、3.2、6.4、8 秒。`400/401/403/404` 属于请求、凭据或所有权问题，不应自动重试。用户主动停止或切换会话时，应通过 `AbortController` 终止退避和读取。

聊天 POST 的结果不确定时不要重新 POST，否则可能创建第二条消息。只要已经获得 conversation/message id，就改用 events 接口恢复。

## 页面刷新后的恢复

本 demo 按外部用户保存最近打开的 `conversation_id`，刷新后会在会话仍可见时自动重新打开。仅有本地 SSE 游标并不足以证明 DOM 中已经渲染了哪些文本。安全做法是：

1. 保存并重新打开该外部用户最后选择的 `conversation_id`，获取会话详情和消息历史。
2. 历史接口当前按最新优先返回，展示前按 `created_at` 升序排列。
3. 如果存在 `active_message_id`，调用 events 接口但不传 `after_id`，从起点重建当前消息并保持连接。
4. 如果最新消息是 `waiting_approval` 或 `waiting_question`，同样从起点回放；收到等待态 `message_end` 就立即开放交互控件，不要等待底层 HTTP 响应完全关闭。
5. 回放答案时，第一段 `message` 应替换历史中的临时答案，后续段再追加；`message_end.answer` 存在时用完整答案校正。

事件仅保留有限时间。等待态回放为空时，可从消息 metadata 恢复 `user_input_request` 或 `workflow_runs[].approval.approval_form`。如果 metadata 也不完整，UI 应显示“状态不可恢复”，不能猜测审批动作或 request id。

## 审批 UI

`approval_requested` 是在线状态下的实时权威来源；页面刷新时可先用最新消息 metadata 中保存的审批表单作为临时快照，再通过事件回放校正。公开事件的审批令牌与表单是分层结构，不能把表单字段当成事件顶层字段读取：

```ts
type ApprovalRequestedData = {
  conversation_id: string;
  message_id: string;
  approval_form_id: string;
  approval_token?: string;
  approval_url?: string;
  ui_approval_allowed: boolean;
  approval_form: {
    id: string;
    node_id?: string;
    node_title?: string;
    content?: unknown;
    fields?: Array<Record<string, unknown>>;
    actions?: Array<Record<string, unknown>>;
    submit_methods?: Record<string, unknown>;
    expiration_at?: string | number;
    token?: string;
  };
};
```

客户端应先规范化再渲染：`formId` 优先取顶层 `approval_form_id`，`token` 优先取顶层 `approval_token`，标题、正文、字段、动作和有效期从 `approval_form` 读取。历史 metadata 中常常只保存 `approval_form`，所以实时事件与历史快照应共用同一个规范化函数；本 demo 的实现见 `normalizeApprovalState`。

渲染规则：

- `approval_form.content` 是审批摘要；对象可以格式化展示，但不要执行其中的 HTML。
- 按 `approval_form.fields` 的稳定 `id/key/name` 收集输入，校验 required 字段。
- 只渲染 `approval_form.actions` 给出的操作，不要自行补出“同意/拒绝”。
- 到达 `approval_form.expiration_at` 或收到 `approval_expired` 后禁用提交。
- `ui_approval_allowed=false` 表示当前 API 客户端不能直接审批；此时服务端可能不下发 `approval_token`，UI 应展示 `approval_url` 或引导用户到允许的审批渠道，不能伪造令牌。
- 收到同一消息的 `message_end.status=waiting_approval` 后即可启用按钮；底层 SSE/HTTP 连接可能仍在收尾，不能把“响应是否已关闭”当成按钮禁用条件。
- 防止重复提交；提交成功后消费返回的 SSE，而不是创建新聊天。

```ts
await fetch(
  `${agentApiBaseUrl}/agents/conversations/${conversationId}/messages/${messageId}/workflow-continuation`,
  {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "X-External-User-ID": externalUserId,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      type: "approval",
      approval_token: approval.token, // 规范化后的顶层 approval_token
      action: selectedAction.id,
      inputs: formValues,
    }),
  },
);
```

## 两类问题必须分流

工作流问题可能连续出现两个表示同一暂停的事件：`question_answer_requested` 和带有特殊 `source` 的 `user_input_requested`。它们都走 workflow continuation：

```ts
const isWorkflowQuestion =
  event.event === "question_answer_requested" ||
  (event.event === "user_input_requested" &&
    event.data.source === "agent_workflow_question_answer");

if (isWorkflowQuestion) {
  await continueWorkflow({
    type: "question_answer",
    inputs: {
      query: answer,
      question_answer_option_id: selectedChoiceId,
    },
  });
} else if (event.event === "user_input_requested") {
  await continueSkillInput(event.data.request_id, {
    answers: Object.fromEntries(
      event.data.questions.map((question) => [question.id, values[question.id]]),
    ),
  });
}
```

每个 continuation 都沿用原 conversation/message，不应添加一条新的用户聊天消息。返回流可能再次进入审批或问答状态，因此客户端应始终使用同一个状态机处理聊天、恢复和继续接口。
