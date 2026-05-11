# Agent Room 收口 Code 子任务计划

## gstack 前置记录

- 要求流程：Load gstack，运行 `/office-hours`，再运行 `/autoplan`。
- 执行情况：`rtk` 不在默认 PATH；按用户补充切换到 WSL conda 环境 `zx` 后，`/home/ly/.local/bin/rtk` 可用，但 `gstack` 未安装/不可发现，`rtk` 也不支持代理任意 `gstack` 子命令。
- 用户确认：gstack 为外部交互命令，当前环境不可用；记录为阻塞/跳过原因，并继续按计划实现代码收口。
- 本子任务复核：在 `/home/ly/hermes-web-ui` 运行 `rtk proxy bash -lc '... command -v gstack ...'`，确认 `gstack unavailable: command not found in PATH`；因此无法实际执行 `/office-hours` 与 `/autoplan`，继续按保存计划收口。

## `/office-hours` 风险澄清

- 范围边界：只修改 Agent Room 自身、通用 DB 初始化/测试隔离、Agent Room smoke 脚本与 package 脚本；不修改 group-chat 业务逻辑、Socket.IO、`gc_*` 表或 group-chat 后端。
- 首要风险：Vitest 并行文件共享固定 dev SQLite DB，导致 `database is locked`；优先通过测试环境 worker 独立 DB 路径与 SQLite pragma 缓解，而不是全局串行化测试。
- Runtime 验收：新增低风险 smoke matrix，deterministic 必跑；Gateway/http/orchestrated 在缺少必需 env 时清晰 skip，不把外部依赖缺失判定为失败。
- Pixel UI 1B：只改 Agent Room Phaser scene，保持 fallback graphics，不引入 group-chat 状态/数据复用。

## `/autoplan` 执行计划

1. 用 code-review-graph 先获取结构上下文，再用文件读取/搜索补齐缺失细节。
2. 保存本计划，并用 git diff/status 持续确认范围，保护已有未跟踪文件。
3. 修改 `packages/server/src/db/index.ts`：测试环境按 Vitest worker 派生独立 DB/JSON 路径；统一设置 `busy_timeout`、`foreign_keys`，测试环境保留安全 pragma。
4. 如必要，补 `session-sync.test.ts` 表初始化，避免独立空 DB 下直接 `DELETE` 缺表。
5. 新增 `scripts/smoke-agent-room-runtime-matrix.ts`，并在 `package.json` 新增脚本入口，覆盖 deterministic 与外部 runtime skip。
6. 在 `AgentRoomOfficeScene.ts` 小步增强视觉：地板/墙面细节、zone 装饰、role desk props、任务状态进度 strip 与 active feedback。
7. 运行验证：`rtk npx vitest run tests/server/session-sync.test.ts`、相关 server DB/Agent Room 测试、`rtk npm test`、新增 runtime matrix smoke、`rtk npm run smoke:agent-room-workflow`、`rtk npm run build`。
8. 汇报修改文件、命令结果、skip 原因和剩余风险。

## 本子任务剩余收口计划

1. P0：先修复 `tests/server/proxy-handler.test.ts` 中 3 个 SSE `run.completed` / `updateUsage` 断言失败；先判断是测试 mock 与 Agent Room SSE 持久化新增依赖脱节、usage 事件顺序变化，还是代理实现回归。
2. P0 验证：运行 `rtk npx vitest run tests/server/proxy-handler.test.ts`，再运行相关 proxy/server 定向测试，最后纳入全量 `rtk npm test`。
3. P1：补充 Agent Room runtime 配置说明，明确 deterministic、gateway/real、http/bridge、orchestrated/gateway-multi-role 环境变量组合，以及 runtime matrix 的 passed/skipped/failed 语义。
4. P2：为 `AgentRoomOfficeScene.ts` 增加轻量测试或稳定 smoke 策略，优先覆盖 scene 创建不崩溃、`agent-room:state:update` instanceId 过滤、shutdown 清理；若 Phaser/jsdom 成本过高，采用脚本级或纯函数测试，不做大重构。
5. P3：运行 `rtk npm run build`、`rtk npm test`、`rtk npm run smoke:agent-room-workflow`、`rtk npm run smoke:agent-room-runtime-matrix`，记录通过/失败/skip 与剩余风险。
