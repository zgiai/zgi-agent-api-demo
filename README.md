# ZGI Agent API · Next.js 接入 Demo

一个可直接运行的 ZGI 落地页级前端示例。它使用 Next.js App Router 和 TypeScript，覆盖公开 Agent API 的主要接入链路。为方便本地验证，Base URL 和 API Key 直接在页面中填写，请求通过 demo 的同源 Next.js 代理访问 ZGI。

## 已覆盖能力

- 从 `/agents/config` 渲染已发布 Agent 的名称、欢迎语、主题色、推荐问题和能力开关
- 消费 `/agents/chat` 原生 SSE 流，处理核心消息、进度、错误、Skill 和工作流交互事件
- 使用 GFM 规则渲染 Agent Markdown 回答，支持表格、任务列表、引用、链接、图片、行内代码和代码块；原始 HTML 不执行
- 保存 SSE `id`，通过 `/events?message_id=...&after_id=...` 恢复中断的运行流
- 按外部用户记住最后打开的会话；页面重新打开时从事件起点重建运行中或等待中的消息，同一页面断线时使用 `after_id` 增量重连
- 新建、查看、搜索、重命名和删除当前外部用户的会话
- 停止生成、重新生成上一条回答；按 `/parameters` 的数量、扩展名和大小限制上传文件，在下一轮消息中引用文件 id
- 为每个上传文件展示独立的上传中、成功、失败、重试与移除状态，并在会话历史中还原用户附件
- 消费 `skill_artifact_created` 并渲染生成文件卡片；实时事件按 artifact id 去重，历史消息从 `metadata.generated_files` 恢复
- 回答 `user_input_requested`，处理工作流问题和审批后继续同一条消息
- 查看、编辑、清除、导出和撤销 Agent Memory；写操作使用 revision 做并发保护
- 内置开发者事件检查器，覆盖 OpenAPI 声明的全部公开事件，展示事件类别、作用、客户端处理建议、接收来源、恢复游标、关联标识和完整 JSON

## 启动

前提：本地 ZGI 网关已经运行，并且你已经为一个已发布 Agent 创建 API Key。无需创建 `.env` 文件，直接启动：

```bash
pnpm install
pnpm dev
```

打开 [http://localhost:3000](http://localhost:3000)。如果 3000 已占用，Next.js 会提示实际端口。首次打开后在连接面板填写 Agent API Base URL（例如 `http://localhost:2870/api/v1`）和已发布 Agent 的 API Key。

Base URL 和 API Key 作为一份版本化连接配置保存在当前浏览器的 localStorage，关闭或重启浏览器后仍可复用。升级后的页面会自动迁移旧版 localStorage Base URL 和 sessionStorage API Key；“清除本地连接”会同时移除新旧存储。切换 Base URL 或 Key 时，demo 会终止现有事件流并重新加载 Agent 配置和会话。

## 同源代理与安全边界

页面把 Base URL、API Key 和 demo 用户标识提交给同源 `/api/zgi/*` Route Handler。代理只允许本项目使用的 Agent API 路径，把用户标识转换为 `X-External-User-ID`，并透明转发 JSON、文件和 SSE 响应。浏览器不再跨域请求 ZGI，因此不需要在 ZGI 配置 demo 来源的 CORS。

Base URL 由页面传给代理，适合本地切换测试环境；不要把这个动态目标代理原样公开部署到互联网。正式接入应在自己的服务端固定允许的 ZGI 地址。

本 demo 的 localStorage、浏览器扩展和开发者工具均可访问页面中填写的 Key，因此持久保存只适合可信本机验证。生产环境应由服务端安全配置 Key，并从已认证会话推导稳定、不可识别个人身份的外部用户标识；不要让最终用户输入 Key，也不要信任浏览器提交的用户 id，或使用邮箱、手机号作为用户标识。

## 代码导航

- [`src/components/agent-demo.tsx`](src/components/agent-demo.tsx)：落地页、会话管理、SSE 状态机和继续交互
- [`src/components/markdown-content.tsx`](src/components/markdown-content.tsx)：Agent 回答的安全 GFM Markdown 渲染
- [`src/components/memory-panel.tsx`](src/components/memory-panel.tsx)：Agent Memory 管理
- [`src/lib/approval-state.ts`](src/lib/approval-state.ts)：统一实时事件与历史 metadata 的审批状态，并控制等待态按钮可用时机
- [`src/lib/connection-storage.ts`](src/lib/connection-storage.ts)：版本化保存、旧配置迁移和本地连接清理
- [`src/lib/zgi-client.ts`](src/lib/zgi-client.ts)：JSON 请求封装和增量 SSE 解析器
- [`src/lib/agent-event-catalog.ts`](src/lib/agent-event-catalog.ts)：公开事件目录、中文解释和客户端处理建议
- [`src/lib/file-presentation.ts`](src/lib/file-presentation.ts)：上传附件、生成文件、过期状态和安全下载地址的标准化
- [`src/lib/agent-api-types.ts`](src/lib/agent-api-types.ts)：公开响应与事件的前端类型
- [`src/app/api/zgi/[...path]/route.ts`](src/app/api/zgi/%5B...path%5D/route.ts)：读取页面连接配置并同源转发 Agent API

## SSE 接入要点

ZGI 同时发送原生 `event:` 名称和 JSON envelope：

```text
id: 1715750400000-0
event: message
data: {"event":"message","data":{"conversation_id":"...","message_id":"...","answer":"Hello"}}
```

示例解析器支持数据跨网络 chunk、多个 `data:` 行、CRLF 和末尾未带空行的 frame。UI 以原生/JSON 事件名分派，以 `data` 内的 `conversation_id`、`message_id` 做关联，并把最近非空 `id` 持久化作为恢复游标。

事件检查器保留当前会话最近 100 个事件，并区分聊天、重新生成、继续接口、状态回放和断线重连。每个事件都会显示对应的公开语义和建议处理方式；未识别的新事件会保留完整负载，但业务 UI 安全忽略。侧栏助手专属的客户端协同事件不属于 Agent API，也不在目录中。

## 文件上传与生成文件

上传前先请求 `GET /parameters`，读取 `file_upload.number_limits`、`allowed_file_types` 和 `system_parameters` 中不同媒体类型的大小限制。每个文件单独调用 `POST /files/upload`，不要因为一个文件失败而丢弃同批次里已经成功的文件。发送消息时只把状态为“已上传”的 `id` 放进 `file_ids`；上传仍在进行时禁用发送，失败文件允许独立重试或移除。

`skill_artifact_created` 可能在聊天、继续操作、事件回放或断线重连中重复到达。示例优先使用 `artifact_id`，再使用文件 id 生成稳定键，并用 upsert 更新同一张卡片。下载优先选择 `download_url`，预览选择 `url`；相对地址按 Agent API 的 origin 解析，只接受 HTTP(S) URL。临时文件到达 `expires_at` 或服务端返回 `availability=expired/gone` 后禁用链接。

会话消息的 `metadata.files` 保存本轮用户附件，`metadata.generated_files` 保存 Agent 生成文件。加载历史消息时应从这两个字段还原卡片；仅监听当前 SSE 会导致刷新后产物消失。

## 工作流与恢复范例

完整的状态矩阵、断线重连算法、刷新页面后的状态重建、审批表单渲染和两类问答分流参见：

- [`docs/WORKFLOW_RECOVERY.md`](docs/WORKFLOW_RECOVERY.md)

实现代码位于 [`src/components/agent-demo.tsx`](src/components/agent-demo.tsx)，重点查看 `runEventStream`、`consumeSseWithReconnect` 和 `pendingFromMessageMetadata`。

## 验证

```bash
pnpm test
pnpm exec tsc --noEmit
pnpm lint
pnpm build
```

此项目是本地接入参考，不包含登录系统、持久化业务用户映射、生产级密钥保护、限流、审计或监控；上线前应在你自己的服务端代理层补齐这些能力。
