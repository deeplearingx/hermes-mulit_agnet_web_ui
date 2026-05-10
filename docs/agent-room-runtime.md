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
│  OrchestratedGatewayRuntime (triple-role, mode=orchestrated)         │
│  ─────────────────────────────────────────────────────               │
│  Executes planner → developer → reviewer triple-run pipeline         │
│  1. Resolve planner binding → execute planner Gateway run            │
│  2. Resolve developer binding → execute developer Gateway run        │
│  3. Resolve reviewer binding → execute reviewer Gateway run          │
│  4. Parse reviewer decision → map to final status                    │
│  5. Return steps: planned → assigned → in_progress →                 │
│     submitted_for_review → review_passed | review_rejected →         │
│     revision_required | need_user_decision                           │
│  6. Retry path (revision_required/need_user_decision/failed):        │
│     developer (with feedback) → reviewer, skips planner              │
│  7. Failure: phase-specific error with console.error                 │
│     planner fail → "Orchestrated planner phase failed"               │
│     developer fail → "Orchestrated developer phase failed"           │
│     reviewer fail → "Orchestrated reviewer phase failed"             │
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
| `orchestrated` / `gateway-multi-role` | `OrchestratedGatewayRuntime` | planner → developer → reviewer | Triple-role pipeline |

Both `reviewer` and `delivery` are fully implemented:
- `reviewer` executes as a separate Gateway run in the orchestrated pipeline
- `delivery` is implemented as a service-level operation (`deliverTaskCore`), not a separate Gateway role

## OrchestratedGatewayRuntime (P2 + P3 + P4.11-A)

Triple-role orchestrated runtime that executes planner → developer → reviewer sequential Gateway runs.

### Pipeline

```text
planner → developer → reviewer
```

Each phase is an independent Gateway run with its own profile resolution, SSE event stream, and metadata.

### Step Sequence (Initial Run — created path)

```text
planned → assigned → in_progress → submitted_for_review → review_passed | review_rejected → revision_required | need_user_decision
```

1. **planned** (activeRole: planner): Planner Gateway run completes, plan captured
2. **assigned** (activeRole: developer): Developer binding resolved, task assigned
3. **in_progress** (activeRole: developer): Developer Gateway run starts
4. **submitted_for_review** (activeRole: developer): Developer run completes, output submitted
5. **review_passed** (activeRole: reviewer): Reviewer approves → delivery eligible
6. **review_rejected** (activeRole: reviewer): Reviewer rejects → transient state
7. **revision_required** / **need_user_decision** (activeRole: reviewer): Final reviewer decision

### Reviewer Decision Mapping

| Reviewer Output | Task Status | Event Type |
|----------------|-------------|------------|
| `approved` | `review_passed` | `review_passed` |
| `revision_required` | `revision_required` | `review_rejected` |
| `need_user_decision` | `need_user_decision` | `need_user_decision` |

### Profile Resolution

Planner and reviewer bindings are **required** — throws if `roleBindings.get('planner')` or `roleBindings.get('reviewer')` is missing.

Developer binding resolution priority:
1. `roleBindings.get('developer')` → `bindingSource: 'role-binding'`
2. `assignedAgentId` → `bindingSource: 'assigned-agent'`
3. neither → `bindingSource: 'none'`

### Observability

- All three roles' SSE events persisted as `gateway_sse` run_events
- `_agentRole` dimension injected into raw event payload for role attribution
- Metadata includes `plannerRunId`, `developerRunId`, `reviewerRunId`, and corresponding profile names
- `run.upstreamRunId` ends with developer's run ID (last-wins, developer is primary execution role)
- Reviewer metadata (`reviewDecision`, `reviewFeedback`) compatible with manual `submitReview` path

### Failure Handling

Phase-specific error messages with `console.error`:

| Phase | Error Prefix | Error Message | Includes |
|-------|-------------|---------------|----------|
| Planner | `[orchestrated-runtime] Planner phase failed` | `Orchestrated planner phase failed: <msg>` | profileName, taskId |
| Developer | `[orchestrated-runtime] Developer phase failed` | `Orchestrated developer phase failed: <msg>` | profileName, plannerRunId, taskId |
| Reviewer | `[orchestrated-runtime] Reviewer phase failed` | `Orchestrated reviewer phase failed: <msg>` | profileName, developerRunId, taskId |

On failure:
- Error propagates to `executeRun()` in service layer
- `run.status` → `failed`, `run.errorMessage` set
- Task status stays unchanged (no partial advancement)
- `console.error` logged for background debugging

## autoDelivery

### Configuration

- **Default**: `false` (manual delivery)
- **Controlled by**: `session.autoDeliveryEnabled` field on `AgentRoomSession`
- **API**: `getSessionConfig()` / `updateSessionConfig()` in service layer
- **DB column**: `auto_delivery_enabled` in `agent_room_sessions`

### Delivery Contract

Both manual and auto delivery share the same `deliverTaskCore()` implementation:

```text
review_passed → delivering → completed
```

- Emits `delivery_started` and `delivery_completed` workflow events
- Creates a `final_delivery` artifact with enriched metadata (deliveryMode, revisionRound, reviewFeedback, deliveredAt)

### Trigger Points

1. **`submitReview()`**: After reviewer marks task as `passed`, checks `session.autoDeliveryEnabled` and calls `deliverTaskCore()` inline within the same transaction
2. **`executeRun()`**: After runner completes and task reaches `review_passed` status (e.g. orchestrated reviewer approval), checks `session.autoDeliveryEnabled` and calls `deliverTaskCore()` in a separate transaction

## Artifact Types

| Type | Producer | Content |
|------|----------|---------|
| `code_output` | `OrchestratedGatewayRuntime` | Developer Gateway run output (implementation result) |
| `review_report` | `OrchestratedGatewayRuntime` | Reviewer feedback and decision |
| `final_delivery` | `deliverTaskCore()` | Enriched delivery summary with metadata |
| `log` | (general) | General-purpose log artifacts |
| `other` | (general) | Catch-all for unclassified artifacts |

## Task Status Chains

### Approved Path

```text
created → planned → assigned → in_progress → submitted_for_review
  → review_passed → delivering → completed
```

### Rejected Path (within revision limit)

```text
created → planned → assigned → in_progress → submitted_for_review
  → review_rejected → revision_required → in_progress → submitted_for_review
  → review_passed → delivering → completed
```

### Max Retry Exceeded

```text
created → planned → assigned → in_progress → submitted_for_review
  → review_rejected → need_user_decision
```

### Status Transition Rules

| From | Allowed Transitions |
|------|-------------------|
| `created` | `planned` |
| `planned` | `assigned` |
| `assigned` | `in_progress` |
| `in_progress` | `submitted_for_review`, `failed` |
| `submitted_for_review` | `review_passed`, `review_rejected` |
| `review_passed` | `delivering` |
| `review_rejected` | `revision_required`, `need_user_decision` |
| `revision_required` | `in_progress` |
| `delivering` | `completed`, `failed` |
| `completed` | (none) |
| `failed` | `created`, `in_progress` |
| `need_user_decision` | `in_progress`, `failed` |

## Retry Semantics (P3)

### Entry Points

Retry is triggered via `retryTask()` in the service layer. Retryable statuses:

- `revision_required` — reviewer requested changes
- `need_user_decision` — max revision rounds exceeded
- `failed` — previous execution failed

### Runtime Behavior

When `OrchestratedGatewayRuntime.runTask()` detects a retry status (`revision_required`, `need_user_decision`, `failed`), it routes to `runRetryPath()`:

1. **Skips planner phase** — planner output from the initial run is not regenerated
2. **Executes developer revision run** — uses `buildRevisionDeveloperInput()` with `previousReviewFeedback` context
3. **Executes reviewer run** — same as initial pipeline
4. **Returns steps**: `in_progress → submitted_for_review → review_passed | review_rejected → revision_required | need_user_decision`

### Context Inheritance

| Context | Inherited? | Notes |
|---------|-----------|-------|
| `previousReviewFeedback` | ✅ | Passed from store via `getLatestReviewFeedback()` — last rejected review comment |
| `revisionRound` | ✅ | Managed by service-layer state machine (incremented on `revision_required`) |
| Planner metadata | ❌ | Not inherited — planner is skipped in retry path |
| Developer metadata | 🔄 | New upstream run ID each retry |
| Reviewer metadata | 🔄 | New upstream run ID each retry |

### Max Revision Rounds

- Default: `MAX_REVISION_ROUNDS = 3`
- When `nextRevisionRound >= maxRevisionRounds`, `submitReview()` transitions to `need_user_decision` instead of `revision_required`
- User can then either retry (entering another developer→reviewer cycle) or fail the task

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

## Multi-Role Run Model (Current State)

```text
workflow run
  → planner role run          ✅ implemented (OrchestratedGatewayRuntime)
  → developer role run        ✅ implemented (OrchestratedGatewayRuntime)
  → reviewer role run         ✅ implemented (OrchestratedGatewayRuntime)
  → delivery                  ✅ implemented (service-level deliverTaskCore, auto + manual)
  → delivery as Gateway role  🔲 future
```

The model separates:

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

### OrchestratedGatewayRuntime (triple-role, initial path)

| Field | Source |
|-------|--------|
| `plannerRunId` | Planner Gateway run_id |
| `developerRunId` | Developer Gateway run_id |
| `reviewerRunId` | Reviewer Gateway run_id |
| `plannerProfileName` | From roleBindings.get('planner') |
| `developerProfileName` | From roleBindings.get('developer') or assignedAgentId |
| `reviewerProfileName` | From roleBindings.get('reviewer') |
| `reviewDecision` | Parsed from reviewer output (`approved` / `revision_required` / `need_user_decision`) |
| `reviewFeedback` | Raw reviewer output text |
| `plannerSource` | Always `orchestrated-planner` |
| `developerSource` | Always `orchestrated-developer` |
| `reviewerSource` | Always `orchestrated-reviewer` |
| `developerBindingSource` | `role-binding`, `assigned-agent`, or `none` |
| `source` | Always `orchestrated-triple-run` |
| `plannerModel` / `developerModel` / `reviewerModel` | From resolver when available |
| `plannerProvider` / `developerProvider` / `reviewerProvider` | From resolver when available |
| `plannerTransportSource` / `developerTransportSource` / `reviewerTransportSource` | From resolver when available |

### OrchestratedGatewayRuntime (retry path)

| Field | Source |
|-------|--------|
| `developerRunId` | Developer Gateway run_id (new each retry) |
| `reviewerRunId` | Reviewer Gateway run_id (new each retry) |
| `developerSource` | Always `orchestrated-developer-revision` |
| `reviewerSource` | Always `orchestrated-reviewer-revision` |
| `revisionRound` | Current revision round number |
| `previousReviewFeedback` | Last rejected review comment from store |
| `source` | Always `orchestrated-revision-retry` |

**Note**: `apiKey` is never included in metadata.
