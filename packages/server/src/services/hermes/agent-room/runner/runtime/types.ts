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

// ─── P5.2: Reviewer JSON Output Protocol ─────────────────────────
// Structured output contract for the reviewer agent.

/** Valid reviewer decisions. */
export type ReviewerDecision = 'approved' | 'revision_required' | 'need_user_decision'

/** Structured reviewer output from JSON protocol. */
export interface ReviewerOutput {
    /** Review decision. */
    decision: ReviewerDecision
    /** Review feedback text. */
    feedback: string
    /** Optional list of issues raised. */
    issues?: string[]
    /** Optional confidence score (0.0 - 1.0). */
    confidence?: number
}

/**
 * Role binding entry for multi-role profile resolution in the runtime.
 * Mirrors RunnerRoleBinding from runner/types.ts without circular import.
 */
export interface RuntimeRoleBinding {
    role: AgentRoomRole
    profileName: string
    /** Optional explicit provider override for Gateway /v1/runs body. */
    provider?: string
    /** Optional explicit model override for Gateway /v1/runs body. */
    model?: string
}

/**
 * Forward-compatible metadata contract for planner → developer orchestration.
 * All fields are optional — populated only when multi-role orchestration is active.
 *
 * Design notes:
 *   - plannerRunId / developerRunId: upstream Gateway run IDs for observability correlation
 *   - plannerProfileName / developerProfileName: resolved profile names for each role phase
 *   - This interface is a contract placeholder; actual population logic is deferred to P4.11-A3+
 */
export interface HermesAgentRuntimeMetadata {
    /** Upstream Gateway run ID for the planner phase (if executed). */
    plannerRunId?: string
    /** Upstream Gateway run ID for the developer phase (if executed). */
    developerRunId?: string
    /** Resolved profile name used for the planner role. */
    plannerProfileName?: string
    /** Resolved profile name used for the developer role. */
    developerProfileName?: string
    /** Upstream Gateway run ID for the reviewer phase (if executed). */
    reviewerRunId?: string
    /** Resolved profile name used for the reviewer role. */
    reviewerProfileName?: string
    /** Reviewer decision: approved | revision_required | need_user_decision. */
    reviewDecision?: ReviewerDecision
    /** Structured or free-form reviewer feedback. */
    reviewFeedback?: string
    /** Issues raised by the reviewer (structured JSON output). */
    reviewIssues?: string[]
    /** Reviewer confidence score (0.0 - 1.0). */
    reviewConfidence?: number
    /** Extensible bag for future metadata without interface changes. */
    [key: string]: unknown
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

    /**
     * Optional planner output / plan artifact from a prior planner phase.
     * Forward-compatible placeholder for planner → developer handoff.
     * When present, the runtime may use this to guide developer execution.
     * Currently unused — will be consumed by orchestrated runtime in P4.11-A3+.
     */
    plannerPlan?: string

    /**
     * Forward-compatible metadata for planner/developer orchestration.
     * All fields are optional and additive — populated only when multi-role orchestration is active.
     * See {@link HermesAgentRuntimeMetadata} for the full shape.
     * Currently unused by GatewayHermesRuntime — reserved for OrchestratedGatewayRuntime in P4.11-A3+.
    */
   metadata?: HermesAgentRuntimeMetadata

   /**
    * P3: Feedback from the most recent rejected review.
    * Populated when retrying from revision_required or need_user_decision.
    * Enables the developer agent to address specific reviewer concerns.
    * Empty/undefined when retrying from failed or first attempt.
    */
   previousReviewFeedback?: string
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
 * P6.3: Reviewer decision data carried by runtime output.
 * Moved from onReviewerDecision hook → runtime output so the runner result
 * can carry it through to applyRunnerResult() transaction.
 */
export interface HermesAgentRuntimeReviewDecision {
    sessionId: string
    taskId: string
    reviewerProfileName: string
    reviewDecision: ReviewerDecision
    reviewFeedback: string
    reviewerRunId?: string
    reviewIssues?: string[]
    reviewConfidence?: number
}

/**
 * Output from the Hermes agent runtime.
 * Contains ordered steps that the runner translates to AgentRoomRunnerResult.
 * P6.3: reviewerDecision carries auto-reviewer data for transactional write.
 */
export interface HermesAgentRuntimeOutput {
    /** Ordered steps to execute. */
    steps: HermesAgentRuntimeStep[]

    /** Optional artifacts produced by the runtime. */
    artifacts?: HermesAgentRuntimeArtifact[]

    /** P6.3: Auto reviewer decision data for transactional review creation. */
    reviewerDecision?: HermesAgentRuntimeReviewDecision
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
     *
     * P5.1: Optional `context` carries role attribution for role-aware binding.
     * When present, the service layer uses `context.role` to bind the upstream run_id
     * to the correct role_run, eliminating order-dependent (index-based) binding.
     * When absent, the service layer falls back to sequential index binding
     * for backward compatibility with single-role runtimes (GatewayHermesRuntime).
     */
    onUpstreamRunCreated?: (upstreamRunId: string, context?: { role: AgentRoomRole }) => void

    /**
     * Called for every parsed SSE event from the upstream Gateway.
     * Enables real-time event persistence and observability.
     */
    onRawEvent?: (event: Record<string, unknown>) => void

    /**
     * P5.3: Called when the auto reviewer produces a decision.
     * Enables the service layer to write a review record to agent_room_reviews,
     * unifying the audit/retry-feedback data source between manual submitReview()
     * and automated reviewer decisions.
     *
     * The service layer stores full metadata JSON (source, reviewerRunId,
     * reviewerProfileName, reviewDecision, reviewFeedback, reviewIssues,
     * reviewConfidence) in the review comment field for maximum observability.
     *
     * Fire-and-forget — errors are swallowed to avoid breaking the main flow.
     */
    onReviewerDecision?: (decision: {
        sessionId: string
        taskId: string
        reviewerProfileName: string
        reviewDecision: ReviewerDecision
        reviewFeedback: string
        reviewerRunId?: string
        reviewIssues?: string[]
        reviewConfidence?: number
    }) => void
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
