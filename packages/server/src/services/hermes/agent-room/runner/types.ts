// ─── Agent Room Runner Types ───────────────────────────────────
// Defines the runner interface for workflow execution.
// The service layer owns locking and validation; runners only execute steps.

import type {
    AgentRoomTask,
    AgentRoomWorkflowEventType,
    AgentRoomRole,
    AgentRoomArtifact,
    AgentRoomMessageType,
} from '../index'
import type { HermesAgentRuntimeHooks } from './runtime/types'

/**
 * Role binding entry passed to runners for multi-role profile resolution.
 * Mirrors AgentRoomRoleBinding from the service layer without importing it
 * (avoids circular dependency).
 */
export interface RunnerRoleBinding {
    role: AgentRoomRole
    profileName: string
    /** Optional explicit provider override for Gateway /v1/runs body. */
    provider?: string
    /** Optional explicit model override for Gateway /v1/runs body. */
    model?: string
}

/**
 * Context passed to a runner during execution.
 * Provides the task, session info, role bindings, and service-layer helpers.
 * Runners MUST NOT manage locking or status validation — those are facade concerns.
 */
export interface AgentRoomRunnerContext {
    sessionId: string
    taskId: string
    task: AgentRoomTask

    /**
     * Role bindings for this session, keyed by role.
     * Runners use this to resolve per-role profile names for multi-role workflows.
     * Example: roleBindings.get('planner') → { role: 'planner', profileName: 'gpt-4o' }
     */
    roleBindings: Map<AgentRoomRole, RunnerRoleBinding>

    /**
     * Optional hooks for real-time observability during task execution.
     * The runner should pass these through to the runtime implementation.
     */
    hooks?: HermesAgentRuntimeHooks

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

    /**
     * P3: Get the most recent rejected review comment for a task.
     * Returns undefined if no rejected review exists.
     * Used to pass review feedback to the developer agent during retry.
     */
    getLatestReviewFeedback?(taskId: string): string | undefined
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
    /** Override senderId (defaults to senderRole if omitted). */
    senderId?: string
    /** Override senderName (defaults to senderRole if omitted). */
    senderName?: string
    /** Message type (defaults to 'agent_message' if omitted). */
    type?: AgentRoomMessageType
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
 * A single step in an ordered workflow execution.
 * Each step transitions the task status and emits events/messages.
 * Steps are applied sequentially — the facade validates each transition.
 */
export interface AgentRoomRunnerStep {
    /** Task status to transition to at this step. */
    status?: AgentRoomTask['status']

    /**
     * The primary role executing this step (e.g. 'planner', 'developer', 'reviewer', 'delivery').
     * Used for run_events observability and role-binding-aware execution.
     * If omitted, defaults to the first event's agentRole or 'developer'.
     */
    activeRole?: AgentRoomRole

    /** Events to emit at this step (each produces both event + message). */
    events?: AgentRoomRunnerEvent[]

    /** Direct chat messages to create at this step. */
    messages?: AgentRoomRunnerMessage[]
}

/**
 * P6.3: Reviewer decision data carried by runner result.
 * Defined here to avoid circular imports with runtime types.
 * Structurally identical to HermesAgentRuntimeReviewDecision.
 */
export interface AgentRoomRunnerReviewDecision {
    sessionId: string
    taskId: string
    reviewerProfileName: string
    reviewDecision: 'approved' | 'revision_required' | 'need_user_decision'
    reviewFeedback: string
    reviewerRunId?: string
    reviewIssues?: string[]
    reviewConfidence?: number
}

/**
 * Structured result returned by a runner.
 * Supports two modes:
 *
 * 1. **Ordered steps** (preferred): `steps` array drives multi-step workflows.
 *    Each step transitions status then emits events. The facade validates
 *    every transition via the state machine.
 *
 * 2. **Legacy flat** (backward compat): `status` + `events` + `messages`
 *    for single-step results. Still supported but deprecated for new runners.
 *
 * `artifacts` are always created after all steps/status transitions complete.
 * Runners that use ctx helpers directly (MockAgentRoomRunner) may return void.
 *
 * P6.3: `reviewerDecision` carries auto-reviewer data for transactional
 * review creation inside applyRunnerResult().
 */
export interface AgentRoomRunnerResult {
    /**
     * Ordered workflow steps. Each step is applied sequentially:
     * status transition → events → messages.
     * Preferred over flat status/events for multi-step workflows.
     */
    steps?: AgentRoomRunnerStep[]

    /** Artifacts to create for this task (applied after all steps). */
    artifacts?: AgentRoomRunnerArtifact[]

    /** P6.3: Auto reviewer decision data for transactional review creation. */
    reviewerDecision?: AgentRoomRunnerReviewDecision

    // ── Legacy flat fields (deprecated for new runners) ──────────

    /** @deprecated Use steps[].status instead for multi-step workflows. */
    status?: AgentRoomTask['status']

    /** @deprecated Use steps[].events instead for multi-step workflows. */
    events?: AgentRoomRunnerEvent[]

    /** @deprecated Use steps[].messages instead for multi-step workflows. */
    messages?: AgentRoomRunnerMessage[]
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
