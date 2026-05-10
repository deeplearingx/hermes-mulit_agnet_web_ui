# Project Structure Overview

This document is a token-saving navigation map for future subtasks.
It is not a full architectural spec.
It highlights the main directories, the execution paths, and the files that are most relevant for AgentRoom and Hermes runtime work.

## Workspace Root

- `README.md`
- `README_zh.md`
- `package.json`
- `tsconfig.json`
- `tsconfig.app.json`
- `vitest.config.ts`
- `docs/`
- `packages/`
- `scripts/`
- `scripts/smoke-agent-room-workflow.ts`
  - Single-role GatewayHermesRuntime smoke test
- `scripts/smoke-orchestrated-dual-role.ts`
  - Orchestrated planner → developer dual-role smoke helper
  - Validates full API chain: session → role bindings → task → workflow → runs → events → artifacts
  - Verifies _agentRole, plannerRunId/developerRunId, submitted_for_review, upstreamRunId semantics
- `tests/`

## Docs

- `docs/agent-room-runtime.md`
  - AgentRoom runtime documentation
- `docs/docker.md`
- `docs/openapi.json`
- `docs/plans/`
- `docs/superpowers/`

## Packages

### `packages/server/`

Main backend application.

- `packages/server/src/index.ts`
  - server entry
- `packages/server/src/config.ts`
  - runtime config

### Backend Layers

#### Controllers

- `packages/server/src/controllers/`
- `packages/server/src/controllers/hermes/`

Controllers contain request handling logic before route wiring.

#### Routes

- `packages/server/src/routes/`
- `packages/server/src/routes/hermes/`
- `packages/server/src/routes/hermes/agent-room.ts`
  - AgentRoom HTTP API
- `packages/server/src/routes/hermes/proxy-handler.ts`
  - SSE proxy and event normalization related path

#### DB

- `packages/server/src/db/index.ts`
- `packages/server/src/db/hermes/schemas.ts`
  - SQLite schemas and table initialization
- `packages/server/src/db/hermes/agent-room-store.ts`
  - AgentRoom persistence facade

#### Services

- `packages/server/src/services/logger.ts`
- `packages/server/src/services/gateway-bootstrap.ts`
- `packages/server/src/services/hermes/gateway-manager.ts`
- `packages/server/src/services/hermes/gateway-run-client.ts`
  - POST `/v1/runs` and SSE event stream client

## AgentRoom Backend Core

### Service facade

- `packages/server/src/services/hermes/agent-room/index.ts`
  - AgentRoom service facade
  - workflow start and run lifecycle
  - run hooks and run event persistence
  - role binding CRUD

### Role definitions

- `packages/server/src/services/hermes/agent-room/role-types.ts`

### Event adapter

- `packages/server/src/services/hermes/agent-room/event-adapter.ts`

## AgentRoom Runner Layer

- `packages/server/src/services/hermes/agent-room/runner/index.ts`
  - runner exports and active runner selection
- `packages/server/src/services/hermes/agent-room/runner/types.ts`
  - runner context and result protocol
- `packages/server/src/services/hermes/agent-room/runner/mock-runner.ts`
- `packages/server/src/services/hermes/agent-room/runner/real-agent-runner.ts`
  - runtime adapter

## AgentRoom Runtime Layer

Directory:

- `packages/server/src/services/hermes/agent-room/runner/runtime/`

Important files:

- `packages/server/src/services/hermes/agent-room/runner/runtime/index.ts`
  - runtime facade and mode selection
- `packages/server/src/services/hermes/agent-room/runner/runtime/types.ts`
  - runtime input output hooks types
- `packages/server/src/services/hermes/agent-room/runner/runtime/gateway-hermes-runtime.ts`
  - current single-role Gateway runtime
- `packages/server/src/services/hermes/agent-room/runner/runtime/orchestrated-gateway-runtime.ts`
   - orchestrated runtime with planner → developer dual-run Gateway orchestration (P4.11-A3 + P4.11-A4)
   - P4.11-A5 observability: role-tagged SSE hooks, dual run IDs, combined metadata
   - P2 reviewer phase: planner → developer → reviewer triple-run with unified reviewer metadata
   - P3 revision retry: developer + reviewer (skip planner) for revision_required/need_user_decision/failed
   - P4.11-A6 failure handling: phase-specific try/catch with console.error for planner/developer failures
- `packages/server/src/services/hermes/agent-room/runner/runtime/gateway-profile-resolver.ts`
  - DB-free profileName → Gateway target resolution
- `packages/server/src/services/hermes/agent-room/runner/runtime/deterministic-runtime.ts`
  - mock deterministic runtime
- `packages/server/src/services/hermes/agent-room/runner/runtime/real-hermes-runtime.ts`
  - HTTP bridge runtime
- `packages/server/src/services/hermes/agent-room/runner/runtime/http-client.ts`
- `packages/server/src/services/hermes/agent-room/runner/runtime/parse-output.ts`

## Client

Client code currently lives under server package frontend path.

- `packages/server/client/src/main.ts`
- `packages/server/client/src/stores/hermes/agent-room.ts`
  - AgentRoom client store
- `packages/server/client/src/views/hermes/AgentRoomView.vue`

Other major client areas:

- `packages/server/client/src/stores/hermes/`
- `packages/server/client/src/views/hermes/`

## Tests

Top-level directory:

- `tests/`

AgentRoom and runtime related tests:

- `tests/server/agent-room-async-start.test.ts`
  - async start path, hook persistence, run event source checks
- `tests/server/agent-room-gateway-runtime.test.ts`
  - single-role Gateway runtime behavior
- `tests/server/agent-room-orchestrated-runtime.test.ts`
    - orchestrated runtime: skeleton, dual-run, failure handling, E2E (65 tests)
- `tests/server/agent-room-retry-loop.test.ts`
    - P3 revision retry loop: orchestrated runtime retry paths, service integration, mixed review modes (16 tests)
- `tests/server/agent-room-runner-result.test.ts`
  - end-to-end runner result protocol and Gateway integration
- `tests/server/agent-room-role-bindings.test.ts`
  - role binding persistence and service behavior
- `tests/server/agent-room-routes.test.ts`
- `tests/server/agent-room-error-mapper.test.ts`
- `tests/server/gateway-run-client.test.ts`
- `tests/client/agent-room-store.test.ts`

## Typical Code Navigation for Future Subtasks

### If changing workflow lifecycle

Start from:

1. `packages/server/src/services/hermes/agent-room/index.ts`
2. `packages/server/src/db/hermes/agent-room-store.ts`
3. `tests/server/agent-room-async-start.test.ts`

### If changing runtime orchestration

Start from:

1. `packages/server/src/services/hermes/agent-room/runner/runtime/index.ts`
2. `packages/server/src/services/hermes/agent-room/runner/runtime/types.ts`
3. `packages/server/src/services/hermes/agent-room/runner/runtime/gateway-hermes-runtime.ts`
4. `packages/server/src/services/hermes/agent-room/runner/runtime/orchestrated-gateway-runtime.ts`
5. `tests/server/agent-room-gateway-runtime.test.ts`
6. `tests/server/agent-room-orchestrated-runtime.test.ts`

### If changing role binding or profile resolution

Start from:

1. `packages/server/src/services/hermes/agent-room/role-types.ts`
2. `packages/server/src/services/hermes/agent-room/index.ts`
3. `packages/server/src/services/hermes/agent-room/runner/runtime/gateway-profile-resolver.ts`
4. `tests/server/agent-room-role-bindings.test.ts`

### If changing frontend polling or run presentation

Start from:

1. `packages/server/client/src/stores/hermes/agent-room.ts`
2. `packages/server/client/src/views/hermes/AgentRoomView.vue`
3. related AgentRoom components under `packages/client/src/components/...` if present in future subtasks
4. `tests/client/agent-room-store.test.ts`

## Current P4.11-A Relevant File Set

For planner → developer dual-role orchestration, the primary file set is:

- `packages/server/src/services/hermes/agent-room/index.ts`
- `packages/server/src/services/hermes/agent-room/runner/index.ts`
- `packages/server/src/services/hermes/agent-room/runner/types.ts`
- `packages/server/src/services/hermes/agent-room/runner/runtime/index.ts`
- `packages/server/src/services/hermes/agent-room/runner/runtime/types.ts`
- `packages/server/src/services/hermes/agent-room/runner/runtime/gateway-hermes-runtime.ts`
- `packages/server/src/services/hermes/agent-room/runner/runtime/orchestrated-gateway-runtime.ts`
- `packages/server/src/services/hermes/agent-room/runner/runtime/gateway-profile-resolver.ts`
- `packages/server/src/services/hermes/gateway-run-client.ts`
- `packages/server/src/db/hermes/agent-room-store.ts`
- `tests/server/agent-room-orchestrated-runtime.test.ts`
- `tests/server/agent-room-async-start.test.ts`
- `tests/server/agent-room-runner-result.test.ts`
- `scripts/smoke-orchestrated-dual-role.ts`

## Usage Note for Future Subtasks

Before a new code subtask starts, use this file as the initial navigation index.
Then only re-read the specific files needed for that batch.
This should reduce repetitive full-tree inspection and save context tokens.

## Maintenance Rule

This file must be updated whenever a new project-relevant file is added.

Especially update it when a subtask adds:

- a new runtime file
- a new route or controller file
- a new store or view entry file
- a new test file
- a new project-level documentation file

The update does not need to restate the whole repository.
It should minimally append or revise the relevant section so the next subtask can discover the new file from this index.

## Subtask Bootstrap Convention

To make this repeatable, every new code subtask should start from the bootstrap template:

- [`docs/code-subtask-bootstrap-template.md`](hermes-web-ui/docs/code-subtask-bootstrap-template.md)

Recommended workflow for future [`new_task`](functions.new_task):

1. Tell the new code subtask to read [`docs/project-structure-overview.md`](hermes-web-ui/docs/project-structure-overview.md) first
2. Tell it to treat that file as the initial navigation index
3. Tell it to only re-read the smallest file set needed for the current batch
4. Tell it to keep validation scoped to the touched area first, then widen only if needed
