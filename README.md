# Hermes Agent Room：多 Agent 协同开发平台

> 本仓库基于 Hermes Web UI 扩展了独立的 Agent Room 模块，面向复杂任务执行场景，将 Agent 从单轮问答升级为可规划、可执行、可审核、可修订、可交付、可追踪的多 Agent 工作流系统。

原项目 Hermes Web UI 是面向 Hermes Agent 的 Web Dashboard。本分支 `feature/agent-room` 在保留原有 Chat、Group Chat、Profile、Gateway、Model Management 等能力的基础上，重点实现了 **Agent Room 多 Agent 协同任务平台**。

---

## 面试官快速查看

### 项目定位

Hermes Agent Room 的核心不是聊天 UI，而是一个 **多 Agent 工作流执行引擎**。系统将用户任务抽象为 Session、Task、Review、Artifact、Run、RoleRun 等实体，支持 Planner、Developer、Reviewer、Delivery 多角色协作，并通过状态机约束任务生命周期。

### 核心价值

- **可控性**：用确定性状态机管理 Agent 任务生命周期，避免 LLM 输出直接控制业务状态。
- **可扩展性**：通过 Runtime Adapter 接入 Hermes Gateway，支持不同 profile、model、provider 和远端 Agent Runtime。
- **可观测性**：记录 Run、RoleRun、SSE event、WorkflowEvent、Message 和 Artifact，方便追踪每个 Agent 的执行过程。
- **闭环能力**：支持任务规划、执行、审核、修订、自动 / 手动交付和最终产物归档。
- **工程化验证**：建立 Agent 工作流验证指标体系，覆盖任务完成、状态流转、SSE 事件、角色运行和最终交付等维度。

### 当前验证指标

| 指标 | 含义 | 当前结果 |
| --- | --- | --- |
| 关键事件断言通过率 | 基于核心事件断言验证工作流观测链路 | 94.44% |
| SSE 事件完整率 | Gateway / Runtime SSE 关键事件是否完整回填 | 94.44% |
| 角色运行成功率 | RoleRun 是否正确记录各角色执行状态 | 81.82% |
| 最终交付成功率 | 应交付任务是否成功生成 final_delivery | 83.33% |

> 说明：当前评测覆盖完整成功、workflow:* 回填、SSE 不完整、非法状态链、run 失败、review 通过但未交付、review 打回、交付产物缺失和多轮 run 等典型场景。指标用于回归验证和问题定位，不等价于简单产品成功率。

---

## Agent Room 功能概览

### 1. 多 Agent 角色协作

Agent Room 当前围绕以下角色组织任务：

| 角色 | 职责 |
| --- | --- |
| Planner | 任务规划与步骤拆解 |
| Developer | 执行任务并提交结果 |
| Reviewer | 审核执行结果，决定通过、打回或需要用户决策 |
| Delivery | 汇总任务过程与产物，生成最终交付结果 |

### 2. 任务状态机

任务生命周期由后端状态机约束，避免非法流转：

```text
created
  → planned
  → assigned
  → in_progress
  → submitted_for_review
  → review_passed
  → delivering
  → completed
```

异常 / 分支状态包括：

```text
review_rejected
revision_required
need_user_decision
failed
```

设计原则：

- LLM / Gateway Runtime 只返回执行内容；
- 状态流转由 Agent Room 后端统一校验；
- Task、Message、WorkflowEvent、Artifact、Run、RoleRun 通过事务化逻辑统一写入；
- 非法状态链、缺失事件、失败 run 会被显式记录或拦截。

### 3. Hermes Gateway Runtime Adapter

Agent Room 通过 Gateway Runtime Adapter 接入远端 Hermes Agent：

```text
Agent Room Task
  → build runtime input
  → POST /v1/runs
  → GET /v1/runs/:run_id/events
  → collect SSE events
  → map run.completed.output to ordered steps
  → persist workflow event / message / run record / artifact
```

这个设计让 Agent Room 与具体模型或执行后端解耦，后续可以接入不同 provider、不同模型或不同 profile。

### 4. 角色绑定与运行追踪

支持不同 Agent 角色绑定不同运行 profile：

```text
Planner  → profile/model/provider A
Developer → profile/model/provider B
Reviewer → profile/model/provider C
Delivery → profile/model/provider D
```

系统会记录：

- role run status
- upstream run id
- SSE event
- workflow event
- model / provider / profileName
- task status transition
- artifact metadata

### 5. 最终交付与 Artifact 管理

任务审核通过后可进入 Delivery 阶段，系统汇总：

- 用户任务描述
- Planner 规划结果
- Developer 执行输出
- Reviewer 审核反馈
- 修订轮次
- 过程消息和中间产物

最终生成 `final_delivery` artifact，形成从任务执行到结果交付的闭环。

---

## 技术栈

| 模块 | 技术 |
| --- | --- |
| Frontend | Vue 3, TypeScript, Vite, Pinia, SCSS, Phaser |
| Backend | Koa 2, TypeScript, SQLite |
| Runtime Integration | Hermes Gateway, `/v1/runs`, SSE |
| Agent Workflow | Task state machine, RunnerResult, Runtime Adapter, RoleRun |
| Test / Smoke | Vitest, workflow smoke test, gateway smoke test, runtime matrix test |
| Existing Web UI | Hermes profiles, gateway management, group chat, logs, model management |

---

## 目录重点

```text
packages/
├── client/src/components/hermes/agent-room/
│   ├── AgentRoomPanel.vue              # Agent Room 主工作区
│   ├── AgentRoomTaskPanel.vue          # 任务面板
│   ├── AgentRoomTimelineView.vue       # 工作流事件时间线
│   ├── AgentRoomArtifactsView.vue      # 产物视图
│   ├── AgentRoomRunsView.vue           # Run / RoleRun 观测视图
│   └── AgentRoomRoleBindingModal.vue   # 角色 Profile 绑定
│
├── client/src/stores/hermes/agent-room.ts
│   └── Agent Room 前端状态管理
│
└── server/src/services/hermes/
    ├── agent-room/
    │   ├── index.ts                    # Agent Room 领域服务与状态机
    │   ├── facade.ts                   # RunnerResult 应用与持久化入口
    │   ├── runner/
    │   │   ├── types.ts                # Runner / Runtime 协议定义
    │   │   └── runtime/
    │   │       └── gateway-hermes-runtime.ts
    │   └── event-adapter.ts            # WorkflowEvent → Message 适配
    └── gateway-run-client.ts           # /v1/runs + SSE 客户端

scripts/
├── smoke-agent-room-workflow.ts
├── smoke-agent-room-gateway.ts
├── smoke-agent-room-runtime-matrix.ts
├── smoke-agent-room-full-chain.ts
└── smoke-agent-room-matrix.ts
```

---

## 快速启动 Agent Room 开发环境

安装依赖：

```bash
npm install
```

启动 Agent Room 开发环境：

```bash
npm run dev:agent-room
```

该命令会启动前端和 BFF server，并设置：

```env
HERMES_AGENT_RUNTIME=orchestrated
AGENT_ROOM_RUNNER=real
AUTH_DISABLED=1
PORT=18648
```

如果只需要启动后端：

```bash
npm run dev:server:agent-room
```

---

## 构建与测试

```bash
npm run build
npm run test
```

Agent Room 相关 smoke 测试：

```bash
npm run smoke:agent-room-workflow
npm run smoke:agent-room-gateway
npm run smoke:agent-room-runtime-matrix
npm run smoke:orchestrated-dual-role
npm run smoke:full-chain
npm run smoke:matrix
```

---

## API / 运行链路概览

```text
Browser Agent Room UI
    │
    ▼
Koa BFF Server
    │
    ├── Agent Room routes
    │   ├── sessions
    │   ├── tasks
    │   ├── reviews
    │   ├── artifacts
    │   ├── runs
    │   └── role-runs
    │
    ▼
Agent Room Service
    ├── task state machine
    ├── run / role-run persistence
    ├── workflow event + message adapter
    ├── artifact management
    └── delivery pipeline
    │
    ▼
Gateway Runtime Adapter
    ├── POST /v1/runs
    ├── GET /v1/runs/:run_id/events
    ├── SSE event collection
    └── output → ordered workflow steps
```

---

## 可向面试官说明的项目亮点

- 将 Agent 执行过程抽象为可持久化、可追踪、可恢复的任务工作流，而不是一次性聊天输出。
- 使用状态机约束任务生命周期，把不稳定的 LLM 输出限制在确定性业务流程之内。
- 使用 Gateway Runtime Adapter 解耦业务工作流和具体模型 / Agent Runtime，便于替换模型和扩展 provider。
- 通过 Run、RoleRun、SSE event、WorkflowEvent 和 Artifact 形成完整观测链路，方便定位失败阶段。
- 通过 Reviewer 和 Delivery 阶段支持审核、修订和最终交付，更接近真实 Agent 应用落地场景。

---

## 原 Hermes Web UI 能力

除 Agent Room 外，本仓库仍保留 Hermes Web UI 原有能力：

- AI Chat：多会话聊天、SSE 流式输出、Markdown 渲染、工具调用详情展示；
- Group Chat：多 Agent 聊天房间、@mention 路由、上下文压缩、消息持久化；
- Multi-Profile & Gateway：Hermes profile 管理、多 gateway 启停、端口冲突处理；
- Model Management：OpenAI-compatible provider 管理、模型发现、默认模型切换；
- Usage Analytics：token、成本、模型分布和趋势统计；
- File Browser：本地 / Docker / SSH / Singularity 文件浏览与操作；
- Logs：gateway、agent、error log 查看与过滤；
- Web Terminal：基于 node-pty 与 xterm 的 Web 终端。

---

## License

[MIT](./LICENSE)
