# Agent Room Runtime 配置与验收说明

## 目标

本文档说明 Agent Room 在本地与真实 runtime 环境下的可执行配置组合，以及 `scripts/smoke-agent-room-runtime-matrix.ts` 的结果语义。收口目标是让 deterministic 本地路径始终可验证，让 Gateway、HTTP bridge、orchestrated 多角色路径在缺少外部环境时明确跳过，而不是硬编码外部地址或密钥。

## 通用入口

- Runner 入口：`AGENT_ROOM_RUNNER=real` 才会走真实 runtime adapter；未设置时默认使用 mock runner。
- Runtime 选择：`HERMES_AGENT_RUNTIME` 由 `createHermesAgentRuntime()` 解析。
- 超时：可选 `HERMES_AGENT_TIMEOUT_MS`，默认 `60000` 毫秒；必须为正数。
- 执行 smoke：`rtk npm run smoke:agent-room-runtime-matrix`。

## Runtime 配置矩阵

| 场景 | 必需环境变量 | 可选/依赖环境 | 说明 |
| --- | --- | --- | --- |
| deterministic local | `AGENT_ROOM_RUNNER=real`, `HERMES_AGENT_RUNTIME=deterministic` | 无 | 本地纯 deterministic runtime，runtime matrix 永远执行此项。 |
| gateway / real single-role | `AGENT_ROOM_RUNNER=real`, `HERMES_AGENT_RUNTIME=gateway` 或 `HERMES_AGENT_RUNTIME=real`, `AGENT_ROOM_RUNTIME_MATRIX_GATEWAY=1` | GatewayManager profile 配置，或 Gateway fallback upstream/apiKey 配置；`AGENT_ROOM_ASSIGNED_AGENT_ID` 可作为 profileName fallback | 走 Gateway `/v1/runs` 协议；`real` 是 gateway runtime 的别名，不是 HTTP bridge。 |
| http / bridge | `AGENT_ROOM_RUNNER=real`, `HERMES_AGENT_RUNTIME=http` 或 `HERMES_AGENT_RUNTIME=bridge`, `HERMES_AGENT_BASE_URL=<bridge base url>` | `HERMES_AGENT_TIMEOUT_MS` | 走自定义 HTTP bridge，调用 `${HERMES_AGENT_BASE_URL}/agent-room/run-task`。`bridge` 是 `http` runtime 的别名。 |
| orchestrated / gateway-multi-role | `AGENT_ROOM_RUNNER=real`, `HERMES_AGENT_RUNTIME=orchestrated` 或 `HERMES_AGENT_RUNTIME=gateway-multi-role`, `AGENT_ROOM_RUNTIME_MATRIX_ORCHESTRATED=1` | planner/developer/reviewer/delivery role bindings 对应的 Gateway profiles；`AGENT_ROOM_ASSIGNED_AGENT_ID` 仅可作为 developer fallback | 多角色 Gateway orchestration；`gateway-multi-role` 是 `orchestrated` runtime 的别名。真实业务请求需在 session 中配置 planner、developer、reviewer role bindings。 |

## Runtime matrix smoke 结果语义

- `PASS <case>`：该 case 的必需 env 已满足，runner 成功返回至少一个 workflow step。
- `SKIP <case>: missing ...`：该 case 需要外部 Gateway、HTTP bridge 或 orchestrated 环境变量，但当前环境未提供；这是可接受的本地结果，不代表失败。
- `FAIL runtime matrix smoke`：case 环境变量已满足但执行抛错，或 runner 返回无 workflow steps；脚本以非 0 退出，应视为需要修复或环境不可用。
- Summary 中 `passed` 计数包含 deterministic 与所有实际执行成功的外部 runtime；`skipped` 只表示未配置外部依赖。

## 本地无外部依赖时的期望

在未设置 `AGENT_ROOM_RUNTIME_MATRIX_GATEWAY`、`HERMES_AGENT_BASE_URL`、`AGENT_ROOM_RUNTIME_MATRIX_ORCHESTRATED` 时，预期只有 deterministic case 通过，其余外部 case skip。不要为了让 smoke 通过而提交外部地址、token 或密钥。
