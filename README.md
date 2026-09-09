# ZGI Agent API · Next.js 接入 Demo

一个可直接运行的 ZGI 落地页级前端示例。它使用 Next.js App Router 和 TypeScript，覆盖公开 Agent API 的主要接入链路。为方便本地验证，Base URL 和 API Key 直接在页面中填写，浏览器会直连 ZGI。

## 已覆盖能力

- 从 `/agents/config` 渲染已发布 Agent 的名称、欢迎语、主题色、推荐问题和能力开关
- 消费 `/agents/chat` 原生 SSE 流，处理核心消息、进度、错误、Skill 和工作流交互事件
- 保存 SSE `id`，通过 `/events?message_id=...&after_id=...` 恢复中断的运行流
- 按外部用户记住最后打开的会话；页面重新打开时从事件起点重建运行中或等待中的消息，同一页面断线时使用 `after_id` 增量重连
- 新建、查看、搜索、重命名和删除当前外部用户的会话
- 停止生成、重新生成上一条回答、上传文件并在下一轮消息中引用文件 id
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

Base URL 保存在 localStorage；API Key 只保存在当前标签页的 sessionStorage，刷新页面仍可使用，关闭标签页后清除。切换 Base URL 或 Key 时，demo 会终止现有事件流并重新加载 Agent 配置和会话。

## 浏览器直连与安全边界

这个仓库有意采用浏览器直连，以便只修改页面配置就能验证不同环境和 Agent。每个请求都由前端添加 `Authorization: Bearer <API Key>` 和 `X-External-User-ID`。因此 ZGI 网关必须允许 demo 页面来源的 CORS，并允许 `Authorization`、`X-External-User-ID`、`Content-Type` 请求头。

本地 Docker 环境可把 demo 的精确来源加入 `WEB_API_CORS_ALLOW_ORIGINS`，例如 `http://localhost:3000`，然后重建或重启 API 容器。若 Next.js 自动使用了其他端口，也必须加入那个实际来源；不要在生产环境使用宽泛的通配来源。

这种结构不适合生产环境：页面 JavaScript、浏览器扩展和开发者工具都可能访问 API Key。正式接入应把 Key 放在自己的服务端代理中，由已认证会话推导稳定、不可识别个人身份的外部用户标识，并在代理层校验 Agent 权限、限流和请求大小。不要信任浏览器提交的用户 id，也不要使用邮箱或手机号。

## 代码导航

- [`src/components/agent-demo.tsx`](src/components/agent-demo.tsx)：落地页、会话管理、SSE 状态机和继续交互
- [`src/components/memory-panel.tsx`](src/components/memory-panel.tsx)：Agent Memory 管理
- [`src/lib/approval-state.ts`](src/lib/approval-state.ts)：统一实时事件与历史 metadata 的审批状态，并控制等待态按钮可用时机
- [`src/lib/zgi-client.ts`](src/lib/zgi-client.ts)：JSON 请求封装和增量 SSE 解析器
- [`src/lib/agent-event-catalog.ts`](src/lib/agent-event-catalog.ts)：公开事件目录、中文解释和客户端处理建议
- [`src/lib/agent-api-types.ts`](src/lib/agent-api-types.ts)：公开响应与事件的前端类型

## SSE 接入要点

ZGI 同时发送原生 `event:` 名称和 JSON envelope：

```text
id: 1715750400000-0
event: message
data: {"event":"message","data":{"conversation_id":"...","message_id":"...","answer":"Hello"}}
```

示例解析器支持数据跨网络 chunk、多个 `data:` 行、CRLF 和末尾未带空行的 frame。UI 以原生/JSON 事件名分派，以 `data` 内的 `conversation_id`、`message_id` 做关联，并把最近非空 `id` 持久化作为恢复游标。

事件检查器保留当前会话最近 100 个事件，并区分聊天、重新生成、继续接口、状态回放和断线重连。每个事件都会显示对应的公开语义和建议处理方式；未识别的新事件会保留完整负载，但业务 UI 安全忽略。侧栏助手专属的客户端协同事件不属于 Agent API，也不在目录中。

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

此项目是浏览器直连接入参考，不包含登录系统、持久化业务用户映射、生产级密钥保护、限流、审计或监控；上线前应在你自己的服务端代理层补齐这些能力。
