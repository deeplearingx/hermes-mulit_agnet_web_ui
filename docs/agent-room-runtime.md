# Agent Room Runtime

## Architecture Overview

```text
┌──────────────┐     POST /workflow/start      ┌──────────────────────┐
│   Frontend   │ ──────────────────────────────►│   Koa Route Layer    │
│  Pinia Store │     POST /workflow/run-sync    │   agent-room.ts      │
│              │ ◄──────────────────────────────│                      │
└──────────────┘     { success, run }           └──────────┬───────────┘
                                                   │         │
                                                   ▼         ▼
┌──────────────────────────────────────────────────────────────────────┐
│                        Service Layer index.ts                       │
│                                                                      │
│  startWorkflow                runWorkflow                           │
│  ┌─────────────────┐         ┌─────────────────┐                    │
│  │ createRunRecord │         │ createRunRecord │                    │
│  │ queued          │         │ queued          │                    │
│  └────────┬────────┘         └────────┬────────┘                    │
│           │                           │                              │
│           ▼                           ▼                              │
│  ┌─────────────────────────────────────────────┐                    │
│  │              executeRun rethrow             │                    │
│  │  1. run.status = running                    │                    │
│  │  2. Build roleBindings from DB              │                    │
│  │  3. Build hooks                             │                    │
│  │     onUpstreamRunCreated                    │                    │
│  │     onRawEvent                              │                    │
│  │  4. Call runner.run ctx                     │                    │
│  │  5. Apply result to DB                      │                    │
│  │  6. run.status = completed or failed        │                    │
│  │  sync path  rethrow=true                    │                    │
│  │  async path rethrow=false + console.error   │                    │
│  └─────────────────────────────────────────────┘                    │
└──────────────────────────────────────────────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────────────────┐
│                     Runner Layer RealAgentRunner                    │
│                                                                      │
│  1. Extract HermesAgentRuntimeInput from context                     │
│  2. Call runtime.runTask input                                       │
│  3. Translate runtime output to RunnerResult                         │
└──────────────────────────────────────────────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────────────────┐
│              Runtime Layer                                            │
│                                                                      │
│  GatewayHermesRuntime (single-role, mode=real/gateway)               │
│  ─────────────────────────────────────────────────────               │
│  Executes developer role only                                        │
│  1. Resolve profileName from roleBindings developer                  │
│     or assignedAgentId fallback                                      │
│  2. Call profileResolver profileName upstream apiKey                 │
│  3. Call runHermesGatewayTask with hooks                             │
│  4. Build ordered steps from Gateway output                          │
│                                                                      │
│  OrchestratedGatewayRuntime (dual-role, mode=orchestrated)           │
│  ─────────────────────────────────────────────────────               │
│  Executes planner → developer dual-run orchestration                 │
│  1. Resolve planner binding → execute planner Gateway run            │
│  2. Resolve developer binding → execute developer Gateway run        │
│  3. Return: planned → assigned → in_progress → submitted_for_review  │
│  4. Failure: phase-specific error with console.error                 │
│     planner fail → "Orchestrated planner phase failed"               │
│     developer fail → "Orchestrated developer phase failed"           │
└──────────────────────────────────────────────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────────────────┐
│              Gateway Client gateway-run-client.ts                   │
│                                                                      │
│  1. POST /v1/runs → get run_id                                       │
│  2. Call onUpstreamRunCreated run_id                                 │
│  3. Stream SSE events → call onRawEvent event                        │
│  4. Return output runId sessionId                                    │
└──────────────────────────────────────────────────────────────────────┘

Future multi-role model:

┌──────────────────────────────────────────────────────────────────────┐
│ workflow run                                                        │
│   ├─ planner role run                                               │
│   ├─ developer role run                                             │
│   ├─ reviewer role run                                              │
│   └─ delivery role run                                              │
└──────────────────────────────────────────────────────────────────────┘
```

## Workflow API Routes

### `POST /workflow/start` Async

Starts workflow execution asynchronously. Returns immediately with a run record.

- **Response**: `{ success: true, run: AgentRoomRun }`
- **Run status**: `queued` and may already be `running` by the time the caller inspects it
- **Use case**: frontend starts workflow and polls for progress
- **Error handling**: background errors are logged and the run is marked `failed`; caller is not notified directly

### `POST /workflow/run-sync` Sync

Executes workflow synchronously. Blocks until completion.

- **Response**: `{ success: true, run: AgentRoomRun }`
- **Run status**: `completed` or `failed`
- **Use case**: tests, scripts, backward compatibility
- **Error handling**: errors propagate to the caller

### `POST /workflow` Legacy Sync

Same as `/workflow/run-sync`. Preserved for backward compatibility.

## Task Status vs Run Status

Task status represents business workflow state.
Run status represents execution lifecycle state.

A completed run does not necessarily mean the task is completed.
For example, a successful developer run usually moves the task to `submitted_for_review`.

## Run Event Sources

Run events in `agent_room_run_events` have a `source` column indicating their origin:

| Source | Description |
|--------|-------------|
| `gateway_sse` | Raw SSE events from the upstream Gateway such as `run.created` and `step.completed` |
| `runner` | Step-level events synthesized by the runner such as `step:planned` and `step:in_progress` |

## Run Lifecycle

```text
queued → running → completed
                 → failed
```

1. **queued**: run record created, waiting to start
2. **running**: execution in progress
3. **completed**: runner finished successfully
4. **failed**: runner threw an error

## Current Execution Scope

Two runtime modes are available:

| Mode | Class | Roles | Use Case |
|------|-------|-------|----------|
| `real` / `gateway` | `GatewayHermesRuntime` | developer only | Single-role execution |
| `orchestrated` / `gateway-multi-role` | `OrchestratedGatewayRuntime` | planner → developer | Dual-role orchestration |

`reviewer` and `delivery` bindings are persisted but not yet executed as separate Gateway runs.

## OrchestratedGatewayRuntime (P4.11-A)

Dual-role orchestrated runtime that executes planner → developer sequential Gateway runs.

### Step Sequence

```text
planned → assigned → in_progress → submitted_for_review
```

1. **planned** (activeRole: planner): Planner Gateway run completes, plan captured
2. **assigned** (activeRole: developer): Developer binding resolved, task assigned
3. **in_progress** (activeRole: developer): Developer Gateway run starts
4. **submitted_for_review** (activeRole: developer): Developer run completes, output submitted

### Profile Resolution

Planner binding is **required** — throws if `roleBindings.get('planner')` is missing.

Developer binding resolution priority:
1. `roleBindings.get('developer')` → `bindingSource: 'role-binding'`
2. `assignedAgentId` → `bindingSource: 'assigned-agent'`
3. neither → `bindingSource: 'none'`

### Observability

- Both planner and developer SSE events persisted as `gateway_sse` run_events
- `_agentRole` dimension injected into raw event payload for role attribution
- Metadata includes `plannerRunId`, `developerRunId`, `plannerProfileName`, `developerProfileName`
- `run.upstreamRunId` ends with developer's run ID (last-wins, developer is primary execution role)

### Failure Handling

Phase-specific error messages with `console.error`:

| Phase | Error Prefix | Error Message | Includes |
|-------|-------------|---------------|----------|
| Planner | `[orchestrated-runtime] Planner phase failed` | `Orchestrated planner phase failed: <msg>` | profileName, taskId |
| Developer | `[orchestrated-runtime] Developer phase failed` | `Orchestrated developer phase failed: <msg>` | profileName, plannerRunId, taskId |

On failure:
- Error propagates to `executeRun()` in service layer
- `run.status` → `failed`, `run.errorMessage` set
- Task status stays unchanged (no partial advancement)
- `console.error` logged for background debugging

## Async Execution Model Limitations

`startWorkflow` currently uses in-process fire-and-forget execution.
It is suitable for local or single-instance runtime.
It does not yet provide restart recovery or distributed locking.

## Profile Resolution DB Free

The `GatewayProfileResolver` is a pure function with no DB access:

```text
profileName fallbackUpstream fallbackApiKey → GatewayRuntimeTarget
```

Role binding resolution `sessionId + role → profileName` is handled by the service layer
before calling the resolver. The runtime resolves `profileName` from `input.roleBindings`:

1. `input.roleBindings.get('developer')` → `bindingSource: 'role-binding'`
2. `input.assignedAgentId` → `bindingSource: 'assigned-agent'`
3. neither → `bindingSource: 'none'`

## Future Multi-Role Run Model

Planner → developer dual-role orchestration is now implemented via `OrchestratedGatewayRuntime`.

Future extensions may add:

```text
workflow run
  → planner role run          ✅ implemented
  → developer role run        ✅ implemented
  → reviewer role run         🔲 future
  → delivery role run         🔲 future
```

That model would separate:

- workflow-level coordination state
- role-level execution lifecycle state
- cross-role handoff events and artifacts

## Artifact Metadata

### GatewayHermesRuntime (single-role)

| Field | Source |
|-------|--------|
| `runId` | Gateway run_id |
| `source` | Always `hermes-gateway` |
| `profileName` | From roleBindings or assignedAgentId |
| `bindingSource` | `role-binding`, `assigned-agent`, or `none` |
| `transportSource` | `gateway-manager` or `constructor-fallback` |
| `model` | From resolver when available |
| `provider` | From resolver when available |

### OrchestratedGatewayRuntime (dual-role)

| Field | Source |
|-------|--------|
| `plannerRunId` | Planner Gateway run_id |
| `developerRunId` | Developer Gateway run_id |
| `plannerProfileName` | From roleBindings.get('planner') |
| `developerProfileName` | From roleBindings.get('developer') or assignedAgentId |
| `plannerSource` | Always `orchestrated-planner` |
| `developerSource` | Always `orchestrated-developer` |
| `developerBindingSource` | `role-binding`, `assigned-agent`, or `none` |
| `source` | Always `orchestrated-dual-run` |
| `plannerModel` / `developerModel` | From resolver when available |
| `plannerProvider` / `developerProvider` | From resolver when available |
| `plannerTransportSource` / `developerTransportSource` | From resolver when available |

**Note**: `apiKey` is never included in metadata.
