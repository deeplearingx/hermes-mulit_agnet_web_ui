// ─── Agent Room Runner Types ───────────────────────────────────
// Defines the runner interface for workflow execution.
// The service layer owns locking and validation; runners only execute steps.

import type { AgentRoomTask, AgentRoomWorkflowEventType, AgentRoomRole } from '../index'

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

/**
 * Runner interface. Implementations execute the workflow steps.
 * The facade layer handles locking, validation, and error mapping.
 */
export interface AgentRoomRunner {
    /** Human-readable runner name for logging/debugging. */
    readonly name: 'mock' | 'real'

    /** Execute the workflow for the given task context. */
    run(ctx: AgentRoomRunnerContext): Promise<void>
}
