# ZGI Agent API · Next.js 接入 Demo

一个可直接运行的 ZGI 落地页级前端示例。它使用 Next.js App Router 和 TypeScript，覆盖公开 Agent API 的主要接入链路，并把 API Key 安全地留在服务端。

## 已覆盖能力

- 从 `/agents/config` 渲染已发布 Agent 的名称、欢迎语、主题色、推荐问题和能力开关
- 消费 `/agents/chat` 原生 SSE 流，处理核心消息、进度、错误、Skill 和工作流交互事件
- 保存 SSE `id`，通过 `/events?message_id=...&after_id=...` 恢复中断的运行流
- 按外部用户记住最后打开的会话；页面重新打开时从事件起点重建运行中或等待中的消息，同一页面断线时使用 `after_id` 增量重连
- 新建、查看、搜索、重命名和删除当前外部用户的会话
- 停止生成、重新生成上一条回答、上传文件并在下一轮消息中引用文件 id
- 回答 `user_input_requested`，处理工作流问题和审批后继续同一条消息
- 查看、编辑、清除、导出和撤销 Agent Memory；写操作使用 revision 做并发保护
- 内置开发者事件抽屉，便于检查最近的事件名称、游标和 JSON 数据结构

## 启动

前提：本地 ZGI 网关已经运行，并且你已经为一个已发布 Agent 创建 API Key。

```powershell
Copy-Item .env.example .env.local
```

编辑 `.env.local`：

```dotenv
ZGI_API_BASE_URL=http://localhost:2870/api/v1
ZGI_AGENT_API_KEY=your-published-agent-api-key
```

然后启动：

```bash
pnpm install
pnpm dev
```

打开 [http://localhost:3000](http://localhost:3000)。如果 3000 已占用，Next.js 会提示实际端口。

## 安全结构

浏览器不会直接请求 ZGI，也不会拿到 `ZGI_AGENT_API_KEY`。所有请求先进入 [`src/app/api/zgi/[...path]/route.ts`](src/app/api/zgi/%5B...path%5D/route.ts)，由该服务端路由：

1. 校验目标路径白名单；
2. 从服务端环境变量读取 API Key；
3. 把 demo 用户标识转换为 `X-External-User-ID`；
4. 将 JSON、multipart 或 SSE 响应透明转发给浏览器。

页面右上角可切换外部用户，方便本地验证数据隔离。这里的用户标识由浏览器传给代理，仅适合演示。生产环境必须从你自己的已认证服务端会话推导稳定、不可识别个人身份的标识，并在代理层校验 Agent 访问权限、限流和请求大小；不要信任浏览器提交的用户 id，也不要使用邮箱或手机号。

## 代码导航

- [`src/components/agent-demo.tsx`](src/components/agent-demo.tsx)：落地页、会话管理、SSE 状态机和继续交互
- [`src/components/memory-panel.tsx`](src/components/memory-panel.tsx)：Agent Memory 管理
- [`src/lib/approval-state.ts`](src/lib/approval-state.ts)：统一实时事件与历史 metadata 的审批状态，并控制等待态按钮可用时机
- [`src/lib/zgi-client.ts`](src/lib/zgi-client.ts)：JSON 请求封装和增量 SSE 解析器
- [`src/lib/agent-api-types.ts`](src/lib/agent-api-types.ts)：公开响应与事件的前端类型
- [`src/app/api/zgi/[...path]/route.ts`](src/app/api/zgi/%5B...path%5D/route.ts)：保护 API Key 的服务端代理

## SSE 接入要点

ZGI 同时发送原生 `event:` 名称和 JSON envelope：

```text
id: 1715750400000-0
event: message
data: {"event":"message","data":{"conversation_id":"...","message_id":"...","answer":"Hello"}}
```

示例解析器支持数据跨网络 chunk、多个 `data:` 行、CRLF 和末尾未带空行的 frame。UI 以原生/JSON 事件名分派，以 `data` 内的 `conversation_id`、`message_id` 做关联，并把最近非空 `id` 持久化作为恢复游标。

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

此项目是接入参考，不包含登录系统、持久化业务用户映射、生产级限流、审计或监控；上线前应在服务端代理层补齐这些能力。
