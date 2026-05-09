// ─── Hermes Agent Runtime Types ────────────────────────────────
// Defines the boundary between AgentRoom runner and Hermes runtime.
// The runner is a protocol translation layer: AgentRoom context ↔ runtime I/O ↔ ordered result.
// The runtime is responsible for actual agent orchestration (LLM calls, tool use, etc.).

import type {
    AgentRoomTaskStatus,
    AgentRoomWorkflowEventType,
    AgentRoomRole,
    AgentRoomArtifactType,
    AgentRoomMessageType,
} from '../../index'

/**
 * Role binding entry for multi-role profile resolution in the runtime.
 * Mirrors RunnerRoleBinding from runner/types.ts without circular import.
 */
export interface RuntimeRoleBinding {
    role: AgentRoomRole
    profileName: string
}

/**
 * Input to the Hermes agent runtime.
 * Derived from AgentRoom context — the runner extracts these fields.
 */
export interface HermesAgentRuntimeInput {
    /** The task title / description for the agent to work on. */
    taskTitle: string
    taskDescription: string

    /** Current task status — determines which workflow path to take. */
    currentStatus: AgentRoomTaskStatus

    /** Session and task IDs for context. */
    sessionId: string
    taskId: string

    /** Assigned agent ID (if any). */
    assignedAgentId?: string

    /** Revision round number (0 for first attempt). */
    revisionRound: number

    /**
     * Role bindings for this session, keyed by role.
     * Enables the runtime to resolve per-role profile names for multi-role workflows.
     * Example: roleBindings.get('planner') → { role: 'planner', profileName: 'gpt-4o' }
     */
    roleBindings?: Map<AgentRoomRole, RuntimeRoleBinding>

    /**
     * Optional hooks for real-time observability during task execution.
     * The runtime should call these at key lifecycle points (e.g. when upstream run_id is received).
     */
    hooks?: HermesAgentRuntimeHooks
}

/** A workflow event in runtime output. */
export interface HermesAgentRuntimeEvent {
    type: AgentRoomWorkflowEventType
    agentRole: AgentRoomRole
    payload?: Record<string, unknown>
}

/** A chat message in runtime output. */
export interface HermesAgentRuntimeMessage {
    senderRole: AgentRoomRole
    senderId?: string
    senderName?: string
    type?: AgentRoomMessageType
    content: string
    metadata?: Record<string, unknown>
}

/**
 * A single step returned by the Hermes runtime.
 * Supports multiple events and messages per step (aligned with AgentRoomRunnerStep).
 */
export interface HermesAgentRuntimeStep {
    /** Target status for this step. */
    status: AgentRoomTaskStatus

    /**
     * The primary role executing this step (e.g. 'planner', 'developer', 'reviewer', 'delivery').
     * Used for run_events observability and role-binding-aware execution.
     * If omitted, defaults to the first event's agentRole or 'developer'.
     */
    activeRole?: AgentRoomRole

    /** Events to emit at this step. */
    events: HermesAgentRuntimeEvent[]

    /** Optional messages from the agent at this step. */
    messages?: HermesAgentRuntimeMessage[]
}

/** An artifact produced by the runtime. */
export interface HermesAgentRuntimeArtifact {
    name: string
    type: AgentRoomArtifactType
    content: string
    metadata?: Record<string, unknown>
}

/**
 * Output from the Hermes agent runtime.
 * Contains ordered steps that the runner translates to AgentRoomRunnerResult.
 */
export interface HermesAgentRuntimeOutput {
    /** Ordered steps to execute. */
    steps: HermesAgentRuntimeStep[]

    /** Optional artifacts produced by the runtime. */
    artifacts?: HermesAgentRuntimeArtifact[]
}

/**
 * Runtime hooks for observability during task execution.
 * Called by the runtime implementation (e.g. GatewayHermesRuntime) at key lifecycle points.
 * All hooks are fire-and-forget — errors are swallowed to avoid breaking the main flow.
 */
export interface HermesAgentRuntimeHooks {
    /**
     * Called when the upstream Gateway returns a run_id from POST /v1/runs.
     * Enables the caller to bind the upstream run_id to the local run record in real time.
     */
    onUpstreamRunCreated?: (upstreamRunId: string) => void

    /**
     * Called for every parsed SSE event from the upstream Gateway.
     * Enables real-time event persistence and observability.
     */
    onRawEvent?: (event: Record<string, unknown>) => void
}

/**
 * Hermes agent runtime interface.
 * Implementations execute the actual agent logic (LLM calls, tool use, etc.).
 * The runner layer translates between AgentRoom protocol and this interface.
 */
export interface HermesAgentRuntime {
    /**
     * Execute a task through the Hermes agent runtime.
     * Returns ordered steps that the runner translates to AgentRoomRunnerResult.
     */
    runTask(input: HermesAgentRuntimeInput): Promise<HermesAgentRuntimeOutput>
}
