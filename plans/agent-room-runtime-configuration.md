# Agent Room Runtime 配置与验收说明

## 目标

本文档说明 Agent Room 在本地与真实 runtime 环境下的可执行配置组合，以及 `scripts/smoke-agent-room-runtime-matrix.ts` 的结果语义。收口目标是让 deterministic 本地路径始终可验证，让 Gateway、HTTP bridge、orchestrated 多角色路径在缺少外部环境时明确跳过，而不是硬编码外部地址或密钥。

## 通用入口

- Runner 入口：`AGENT_ROOM_RUNNER` 显式设置时优先生效；未设置时，非 test 环境默认 `real`，test 环境默认 `mock`。
- Runtime 选择：`HERMES_AGENT_RUNTIME` 显式设置时优先生效；未设置时，非 test 环境默认 `orchestrated`，test 环境默认 `deterministic`。
- 超时：可选 `HERMES_AGENT_TIMEOUT_MS`，默认 `120000` 毫秒；必须为正数。
- 执行 smoke：`rtk npm run smoke:agent-room-runtime-matrix`。

## Runtime 配置矩阵

| 场景 | 必需环境变量 | 可选/依赖环境 | 说明 |
| --- | --- | --- | --- |
| deterministic local | `AGENT_ROOM_RUNNER=real`, `HERMES_AGENT_RUNTIME=deterministic` | 无 | 本地纯 deterministic runtime，runtime matrix 永远执行此项。 |
| gateway / real single-role | `AGENT_ROOM_RUNNER=real`, `HERMES_AGENT_RUNTIME=gateway` 或 `HERMES_AGENT_RUNTIME=real`, `AGENT_ROOM_RUNTIME_MATRIX_GATEWAY=1` | GatewayManager profile 配置，或 Gateway fallback upstream/apiKey 配置；`AGENT_ROOM_ASSIGNED_AGENT_ID` 可作为 profileName fallback | 走 Gateway `/v1/runs` 协议；`real` 是 gateway runtime 的别名，不是 HTTP bridge。 |
| http / bridge | `AGENT_ROOM_RUNNER=real`, `HERMES_AGENT_RUNTIME=http` 或 `HERMES_AGENT_RUNTIME=bridge`, `HERMES_AGENT_BASE_URL=<bridge base url>` | `HERMES_AGENT_TIMEOUT_MS` | 走自定义 HTTP bridge，调用 `${HERMES_AGENT_BASE_URL}/agent-room/run-task`。`bridge` 是 `http` runtime 的别名。 |
| orchestrated / gateway-multi-role | `AGENT_ROOM_RUNNER=real`, `HERMES_AGENT_RUNTIME=orchestrated` 或 `HERMES_AGENT_RUNTIME=gateway-multi-role`, `AGENT_ROOM_RUNTIME_MATRIX_ORCHESTRATED=1` | planner/developer/reviewer/delivery role bindings 对应的 Gateway profiles；`AGENT_ROOM_ASSIGNED_AGENT_ID` 可作为 planner/developer/reviewer fallback | 多角色 Gateway orchestration；`gateway-multi-role` 是 `orchestrated` runtime 的别名。未绑定 planner/developer/reviewer 时使用当前 active Hermes profile；delivery 未绑定时使用系统交付。 |

## 默认启动语义

- 正常产品启动：未显式设置 `AGENT_ROOM_RUNNER` 或 `HERMES_AGENT_RUNTIME` 时，Agent Room 默认使用 `real + orchestrated`。
- 测试环境：`NODE_ENV=test` 且未显式设置 mode/env 时，默认使用 `mock + deterministic`，保证单元测试不依赖真实 Gateway。
- 显式配置优先：传入 mode 参数或设置 `AGENT_ROOM_RUNNER` / `HERMES_AGENT_RUNTIME` 时，始终尊重显式值。
- Role fallback：planner/developer/reviewer 未绑定时不会阻断 workflow，会按显式绑定、任务分配 profile、`AGENT_ROOM_ASSIGNED_AGENT_ID`、GatewayManager 当前/默认 profile 的顺序解析；delivery 未绑定时不执行 delivery agent，继续使用系统交付。

## Runtime matrix smoke 结果语义

- `PASS <case>`：该 case 的必需 env 已满足，runner 成功返回至少一个 workflow step。
- `SKIP <case>: missing ...`：该 case 需要外部 Gateway、HTTP bridge 或 orchestrated 环境变量，但当前环境未提供；这是可接受的本地结果，不代表失败。
- `FAIL runtime matrix smoke`：case 环境变量已满足但执行抛错，或 runner 返回无 workflow steps；脚本以非 0 退出，应视为需要修复或环境不可用。
- Summary 中 `passed` 计数包含 deterministic 与所有实际执行成功的外部 runtime；`skipped` 只表示未配置外部依赖。

## 本地无外部依赖时的期望

在未设置 `AGENT_ROOM_RUNTIME_MATRIX_GATEWAY`、`HERMES_AGENT_BASE_URL`、`AGENT_ROOM_RUNTIME_MATRIX_ORCHESTRATED` 时，预期只有 deterministic case 通过，其余外部 case skip。不要为了让 smoke 通过而提交外部地址、token 或密钥。
