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
