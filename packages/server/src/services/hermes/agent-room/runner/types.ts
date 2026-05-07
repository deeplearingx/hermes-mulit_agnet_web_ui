// ─── Agent Room Runner Types ───────────────────────────────────
// Defines the runner interface for workflow execution.
// The service layer owns locking and validation; runners only execute steps.

import type {
    AgentRoomTask,
    AgentRoomWorkflowEventType,
    AgentRoomRole,
    AgentRoomArtifact,
} from '../index'

/**
 * Context passed to a runner during execution.
 * Provides the task, session info, and service-layer helpers.
 * Runners MUST NOT manage locking or status validation — those are facade concerns.
 */
export interface AgentRoomRunnerContext {
    sessionId: string
    taskId: string
    task: AgentRoomTask

    /** Transition task status via the service state machine. */
    updateTaskStatus(taskId: string, newStatus: AgentRoomTask['status']): AgentRoomTask | null

    /** Emit a workflow event AND produce the corresponding chat message. */
    emitEventAndMessage(
        sessionId: string,
        taskId: string,
        type: AgentRoomWorkflowEventType,
        agentRole: AgentRoomRole,
        taskTitle: string,
        payload?: Record<string, unknown>,
    ): void

    /** Execute a synchronous callback inside a store transaction. */
    runInTransaction(fn: () => void): void

    /** Bump session updatedAt after workflow completes. */
    updateSessionTimestamp(sessionId: string): void
}

// ─── RunnerResult Protocol ─────────────────────────────────────
// Structured output from a runner. The facade layer applies these
// to the store via applyRunnerResult(), keeping runners DB-free.

/** A workflow event to be emitted by the facade. */
export interface AgentRoomRunnerEvent {
    type: AgentRoomWorkflowEventType
    agentRole: AgentRoomRole
    payload?: Record<string, unknown>
}

/** A chat message to be created by the facade. */
export interface AgentRoomRunnerMessage {
    senderRole: AgentRoomRole
    content: string
    metadata?: Record<string, unknown>
}

/** An artifact to be created by the facade. */
export interface AgentRoomRunnerArtifact {
    name: string
    type: AgentRoomArtifact['type']
    content: string
    metadata?: Record<string, unknown>
}

/**
 * Structured result returned by a runner.
 * All fields are optional — the facade applies only what is present.
 * Runners that use ctx helpers directly (legacy) may return void.
 */
export interface AgentRoomRunnerResult {
    /** Final task status to apply via the service state machine. */
    status?: AgentRoomTask['status']

    /** Workflow events to emit (each produces both event + message). */
    events?: AgentRoomRunnerEvent[]

    /** Direct chat messages to create (independent of events). */
    messages?: AgentRoomRunnerMessage[]

    /** Artifacts to create for this task. */
    artifacts?: AgentRoomRunnerArtifact[]
}

/**
 * Runner interface. Implementations execute the workflow steps.
 * The facade layer handles locking, validation, and error mapping.
 *
 * Legacy runners (MockAgentRoomRunner) use ctx helpers directly and return void.
 * Future runners (RealAgentRunner) should return AgentRoomRunnerResult.
 */
export interface AgentRoomRunner {
    /** Human-readable runner name for logging/debugging. */
    readonly name: 'mock' | 'real'

    /** Execute the workflow for the given task context. */
    run(ctx: AgentRoomRunnerContext): Promise<AgentRoomRunnerResult | void>
}
