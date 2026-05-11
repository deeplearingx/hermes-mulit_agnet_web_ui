// ─── Agent Room Service ────────────────────────────────────────
// Independent domain service for Agent Room workflow.
// Manages sessions, tasks, reviews, messages, and workflow events.
// Persistence: SQLite via agent-room-store.ts (no in-memory Maps).

import { randomUUID } from 'node:crypto'
import { buildMessageFromEvent } from './event-adapter'
import * as store from '../../../db/hermes/agent-room-store'
import { activeRunner } from './runner'
import type { AgentRoomRunnerContext, AgentRoomRunnerResult, AgentRoomRunnerStep, RunnerRoleBinding } from './runner'
import type { HermesAgentRuntimeHooks } from './runner/runtime/types'

// ─── Types ─────────────────────────────────────────────────────
import type { AgentRoomRole } from './role-types'
import { assertAgentRoomRole } from './role-types'
export type { AgentRoomRole }
export { isAgentRoomRole, assertAgentRoomRole, AGENT_ROOM_ROLES } from './role-types'
export type { AgentRoomRunStatus, AgentRoomRun, AgentRoomRoleRunStatus, AgentRoomRoleRun } from '../../../db/hermes/agent-room-store'
export type AgentRoomTaskStatus =
    | 'created'
    | 'planned'
    | 'assigned'
    | 'in_progress'
    | 'submitted_for_review'
    | 'review_passed'
    | 'review_rejected'
    | 'revision_required'
    | 'delivering'
    | 'completed'
    | 'failed'
    | 'need_user_decision'

export type AgentRoomMessageType =
    | 'user_message'
    | 'agent_message'
    | 'task_event'
    | 'review_result'
    | 'final_delivery'
    | 'error'

export type AgentRoomWorkflowEventType =
    | 'task_created'
    | 'task_planned'
    | 'task_assigned'
    | 'task_started'
    | 'task_submitted'
    | 'review_passed'
    | 'review_rejected'
    | 'revision_started'
    | 'delivery_started'
    | 'delivery_completed'
    | 'task_failed'
    | 'need_user_decision'

export interface AgentRoomSession {
    id: string
    name: string
    autoDeliveryEnabled: boolean
    createdAt: string
    updatedAt: string
}

export interface AgentRoomTask {
    id: string
    sessionId: string
    title: string
    description: string
    assignedAgentId?: string
    status: AgentRoomTaskStatus
    parentTaskId?: string
    revisionRound: number
    maxRevisionRounds: number
    createdAt: string
    updatedAt: string
}

export interface AgentRoomReview {
    id: string
    sessionId: string
    taskId: string
    reviewerAgentId: string
    status: 'passed' | 'rejected'
    comment: string
    metadata?: Record<string, unknown>
    /** Flattened from metadata — top-level convenience fields for DTO consumers. */
    reviewerRunId?: string
    reviewerProfileName?: string
    reviewDecision?: 'approved' | 'revision_required' | 'need_user_decision'
    reviewFeedback?: string
    createdAt: string
}

export interface AgentRoomMessage {
    id: string
    sessionId: string
    senderId: string
    senderName: string
    senderRole: AgentRoomRole | 'user'
    type: AgentRoomMessageType
    content: string
    metadata?: {
        taskId?: string
        event?: string
        status?: string
        roundIndex?: number
        reviewComment?: string
    }
    createdAt: string
}

export interface AgentRoomWorkflowEvent {
    id: string
    sessionId: string
    taskId: string
    type: AgentRoomWorkflowEventType
    agentId: string
    agentRole: AgentRoomRole
    payload?: Record<string, unknown>
    createdAt: string
}

export type AgentRoomArtifactType = 'final_delivery' | 'code_output' | 'review_report' | 'log' | 'other'

export interface AgentRoomArtifact {
    id: string
    sessionId: string
    taskId: string
    name: string
    type: AgentRoomArtifactType
    content?: string
    /** P6.4: Flattened from metadata — top-level convenience field for DTO consumers. */
    storageUrl?: string
    metadata?: Record<string, unknown>
    createdAt: string
}

// ─── Constants ─────────────────────────────────────────────────
const MAX_REVISION_ROUNDS = 3

// ─── Step Event Expectation ────────────────────────────────────
// Maps target status → allowed event types for that transition.
// Used by validateRunnerStep() to enforce status/event correspondence.
const EXPECTED_EVENTS_FOR_STATUS: Partial<Record<AgentRoomTaskStatus, AgentRoomWorkflowEventType[]>> = {
    planned: ['task_planned'],
    assigned: ['task_assigned'],
    in_progress: ['task_started', 'revision_started'],
    submitted_for_review: ['task_submitted'],
    review_passed: ['review_passed'],
    review_rejected: ['review_rejected'],
    revision_required: ['revision_started'],
    need_user_decision: ['need_user_decision'],
    delivering: ['delivery_started'],
    completed: ['delivery_completed'],
    failed: ['task_failed'],
}

// ─── Status Transition Rules ───────────────────────────────────
// review_rejected is a TRANSIENT state — submitReview always immediately
// transitions it to either revision_required or need_user_decision.
const VALID_TRANSITIONS: Record<AgentRoomTaskStatus, AgentRoomTaskStatus[]> = {
    created: ['planned'],
    planned: ['assigned'],
    assigned: ['in_progress'],
    in_progress: ['submitted_for_review', 'failed'],
    submitted_for_review: ['review_passed', 'review_rejected'],
    review_passed: ['delivering'],
    review_rejected: ['revision_required', 'need_user_decision'],
    revision_required: ['in_progress'],
    delivering: ['completed', 'failed'],
    completed: [],
    failed: ['created', 'in_progress'],
    need_user_decision: ['in_progress', 'failed'],
}

// ─── In-Memory: only runtime concurrency lock ──────────────────
const runningWorkflows = new Set<string>()

// ─── Workflow Startable Statuses ───────────────────────────────
const WORKFLOW_STARTABLE_STATUSES: AgentRoomTaskStatus[] = [
    'created', 'revision_required', 'need_user_decision', 'failed',
]

// ─── Session Boundary Helpers ──────────────────────────────────
function assertSessionExists(sessionId: string): AgentRoomSession {
    const session = store.getSession(sessionId)
    if (!session) throw new Error(`Session not found: ${sessionId}`)
    return session
}

function assertTaskInSession(taskId: string, sessionId: string): AgentRoomTask {
    assertSessionExists(sessionId)
    const task = store.getTask(taskId)
    if (!task) throw new Error(`Task not found: ${taskId}`)
    if (task.sessionId !== sessionId) {
        throw new Error(`Task ${taskId} belongs to session ${task.sessionId}, not ${sessionId}`)
    }
    return task as AgentRoomTask
}

// ─── Event + Message Helper ────────────────────────────────────
// Emits a workflow event AND produces the corresponding chat message.
// Does NOT open a transaction — caller is responsible.
function emitEventAndMessage(
    sessionId: string,
    taskId: string,
    type: AgentRoomWorkflowEventType,
    agentRole: AgentRoomRole,
    taskTitle: string,
    payload?: Record<string, unknown>,
): { event: AgentRoomWorkflowEvent; message: AgentRoomMessage } {
    const event = addWorkflowEvent(sessionId, taskId, type, agentRole, agentRole, payload)
    const adapted = buildMessageFromEvent(type, agentRole, taskTitle, taskId, payload)
    const message = addMessage({
        sessionId,
        ...adapted,
    })
    return { event, message }
}

// ─── Session CRUD ──────────────────────────────────────────────
export function createSession(name: string): AgentRoomSession {
    const session: AgentRoomSession = {
        id: randomUUID(),
        name,
        autoDeliveryEnabled: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    }
    store.createSession(session)
    return session
}

export function getSession(sessionId: string): AgentRoomSession | null {
    return store.getSession(sessionId)
}

export function listSessions(): AgentRoomSession[] {
    return store.listSessions()
}

// ─── Message CRUD ──────────────────────────────────────────────
export function listMessages(sessionId: string): AgentRoomMessage[] {
    assertSessionExists(sessionId)
    return store.listMessagesBySession(sessionId) as AgentRoomMessage[]
}

export function addMessage(msg: Omit<AgentRoomMessage, 'id' | 'createdAt'>): AgentRoomMessage {
    assertSessionExists(msg.sessionId)
    const full: AgentRoomMessage = {
        ...msg,
        id: randomUUID(),
        createdAt: new Date().toISOString(),
    }
    store.createMessage(full as store.AgentRoomMessage)
    store.updateSessionTimestamp(msg.sessionId)
    return full
}

// ─── Task CRUD ─────────────────────────────────────────────────
export function listTasks(sessionId: string): AgentRoomTask[] {
    assertSessionExists(sessionId)
    return store.listTasksBySession(sessionId) as AgentRoomTask[]
}

export function getTask(taskId: string): AgentRoomTask | null {
    return store.getTask(taskId) as AgentRoomTask | null
}

export function createTask(sessionId: string, title: string, description: string, assignedAgentId?: string, maxRevisionRounds?: number): AgentRoomTask {
    assertSessionExists(sessionId)
    const task: AgentRoomTask = {
        id: randomUUID(),
        sessionId,
        title,
        description,
        assignedAgentId,
        status: 'created',
        revisionRound: 0,
        maxRevisionRounds: maxRevisionRounds ?? MAX_REVISION_ROUNDS,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    }

    store.runInTransaction(() => {
        store.createTask(task as store.AgentRoomTask)
        // Emit task_created event + chat message
        emitEventAndMessage(sessionId, task.id, 'task_created', 'conversation', title)
        store.updateSessionTimestamp(sessionId)
    })

    return task
}

export function updateTaskStatus(taskId: string, newStatus: AgentRoomTaskStatus): AgentRoomTask | null {
    const task = store.getTask(taskId) as AgentRoomTask | null
    if (!task) return null

    // Validate transition
    const allowed = VALID_TRANSITIONS[task.status]
    if (!allowed.includes(newStatus)) {
        throw new Error(`Invalid transition: ${task.status} → ${newStatus}`)
    }

    task.status = newStatus
    task.updatedAt = new Date().toISOString()

    // Increment revision round on revision_required
    if (newStatus === 'revision_required') {
        task.revisionRound++
    }

    store.updateTask(task as store.AgentRoomTask)
    return task
}

/**
 * Update task status with session boundary check and timestamp refresh.
 * Intended for external callers (routes) that operate on a specific session.
 */
export function updateTaskStatusInSession(sessionId: string, taskId: string, newStatus: AgentRoomTaskStatus): AgentRoomTask {
    assertSessionExists(sessionId)
    const task = assertTaskInSession(taskId, sessionId)

    // Validate transition
    const allowed = VALID_TRANSITIONS[task.status]
    if (!allowed.includes(newStatus)) {
        throw new Error(`Invalid transition: ${task.status} → ${newStatus}`)
    }

    task.status = newStatus
    task.updatedAt = new Date().toISOString()

    // Increment revision round on revision_required
    if (newStatus === 'revision_required') {
        task.revisionRound++
    }

    store.updateTask(task as store.AgentRoomTask)
    store.updateSessionTimestamp(sessionId)
    return task as AgentRoomTask
}

// ─── Review CRUD ───────────────────────────────────────────────
export function listReviews(sessionId: string): AgentRoomReview[] {
    assertSessionExists(sessionId)
    return store.listReviewsBySession(sessionId) as AgentRoomReview[]
}

/**
 * Submit a review for a task.
 * - passed:  submitted_for_review → review_passed
 * - rejected: submitted_for_review → review_rejected → (revision_required | need_user_decision)
 *
 * reviewComment is allowed to be empty.
 * revisionRound is incremented when entering revision_required.
 * When revisionRound would exceed maxRevisionRounds, transitions to need_user_decision instead.
 */
export function submitReview(
    sessionId: string,
    taskId: string,
    reviewerAgentId: string,
    status: 'passed' | 'rejected',
    comment: string,
): AgentRoomReview | null {
    const task = assertTaskInSession(taskId, sessionId)

    // Only allow review when task is in submitted_for_review
    if (task.status !== 'submitted_for_review') {
        throw new Error(`Cannot review task in status "${task.status}". Expected: submitted_for_review`)
    }

    // 1. Record the review (comment can be empty)
    const review: AgentRoomReview = {
        id: randomUUID(),
        sessionId,
        taskId,
        reviewerAgentId,
        status,
        comment,
        createdAt: new Date().toISOString(),
    }

    store.runInTransaction(() => {
        store.createReview(review as store.AgentRoomReview)

        if (status === 'passed') {
            // 2a. submitted_for_review → review_passed
            updateTaskStatus(taskId, 'review_passed')
            emitEventAndMessage(sessionId, taskId, 'review_passed', 'reviewer', task.title, { comment })

            // Auto-delivery: if session has auto-delivery enabled, deliver immediately
            // Uses deliverTaskCore to avoid nested runInTransaction()
            const session = store.getSession(sessionId)
            if (session?.autoDeliveryEnabled) {
                deliverTaskCore(sessionId, taskId, task, 'auto')
            }
        } else {
            // 2b. submitted_for_review → review_rejected (transient)
            // Compute nextRevisionRound BEFORE any state mutation
            const nextRevisionRound = task.revisionRound + 1
            updateTaskStatus(taskId, 'review_rejected')
            emitEventAndMessage(sessionId, taskId, 'review_rejected', 'reviewer', task.title, {
                comment,
                revisionRound: nextRevisionRound,
            })

            // 3. Check revision round limit
            // maxRevisionRounds = max allowed revision rounds.
            // If nextRevisionRound >= maxRevisionRounds, no more revisions allowed.
            if (nextRevisionRound >= task.maxRevisionRounds) {
                // Exceeded max rounds → need_user_decision
                // Re-read task from DB (updateTaskStatus wrote review_rejected),
                // then explicitly persist nextRevisionRound before transitioning.
                const freshTask = store.getTask(taskId)!
                freshTask.revisionRound = nextRevisionRound
                store.updateTask(freshTask)
                updateTaskStatus(taskId, 'need_user_decision')
                emitEventAndMessage(sessionId, taskId, 'need_user_decision', 'reviewer', task.title, {
                    revisionRound: nextRevisionRound,
                    maxRevisionRounds: task.maxRevisionRounds,
                })
            } else {
                // Within limit → revision_required (updateTaskStatus auto-increments revisionRound)
                updateTaskStatus(taskId, 'revision_required')
                emitEventAndMessage(sessionId, taskId, 'revision_started', 'developer', task.title, {
                    revisionRound: nextRevisionRound,
                })
            }
        }
    })

    store.updateSessionTimestamp(sessionId)
    return review
}

// ─── Workflow Events ───────────────────────────────────────────
export function listWorkflowEvents(sessionId: string): AgentRoomWorkflowEvent[] {
    assertSessionExists(sessionId)
    return store.listWorkflowEventsBySession(sessionId) as AgentRoomWorkflowEvent[]
}

export function addWorkflowEvent(
    sessionId: string,
    taskId: string,
    type: AgentRoomWorkflowEventType,
    agentId: string,
    agentRole: AgentRoomRole,
    payload?: Record<string, unknown>,
): AgentRoomWorkflowEvent {
    const event: AgentRoomWorkflowEvent = {
        id: randomUUID(),
        sessionId,
        taskId,
        type,
        agentId,
        agentRole,
        payload,
        createdAt: new Date().toISOString(),
    }
    store.createWorkflowEvent(event as store.AgentRoomWorkflowEvent)
    return event
}

// ─── Workflow Engine ───────────────────────────────────────────
// Facade layer: owns locking, validation, and context construction.
// Delegates actual step execution to the active runner.

/**
 * Validate a single runner step for status/event semantic correctness.
 * Throws if the step violates the protocol contract.
 * Messages are NOT validated — they are free-form.
 *
 * Rules:
 * 1. Ordered steps with events MUST have a status (no event-only steps). Legacy flat is exempt.
 * 2. If step.status is present, the transition must be valid (checked here, not deferred).
 * 3. If step has both status and events, each event type must be in the expected set for that target status.
 */
function validateRunnerStep(
    taskId: string,
    step: AgentRoomRunnerStep,
    isOrderedStep: boolean,
): void {
    // Rule 1: Ordered steps with events MUST have a status (no event-only steps)
    // Legacy flat path is exempt — it may have events without status
    if (isOrderedStep && step.events?.length && !step.status) {
        throw new Error('Invalid RunnerResult step: events require status in ordered steps')
    }

    if (!step.status) return // No status change → no further validation needed

    // Rule 2: Validate transition legality
    const task = store.getTask(taskId) as AgentRoomTask | null
    if (!task) throw new Error(`Task not found: ${taskId}`)
    const allowed = VALID_TRANSITIONS[task.status]
    if (!allowed.includes(step.status)) {
        throw new Error(`Invalid step transition: ${task.status} → ${step.status}`)
    }

    // Rule 3: Validate event/status correspondence
    if (step.events?.length) {
        const expected = EXPECTED_EVENTS_FOR_STATUS[step.status]
        if (expected) {
            for (const event of step.events) {
                if (!expected.includes(event.type)) {
                    throw new Error(
                        `Event "${event.type}" is not expected for status "${step.status}". ` +
                        `Expected one of: ${expected.join(', ')}`,
                    )
                }
            }
        }
    }
}

/**
 * Resolve the active role for a step.
 * Priority: step.activeRole → first event's agentRole → 'developer'.
 */
function resolveStepActiveRole(step: AgentRoomRunnerStep): AgentRoomRole {
    if (step.activeRole) return step.activeRole
    if (step.events?.length) return step.events[0].agentRole
    return 'developer'
}

/**
 * Apply a single step to the store.
 * Each step: validate → status transition → events → messages.
 * Also emits a run_event for observability if a runId is provided.
 */
function applyRunnerStep(
    sessionId: string,
    taskId: string,
    taskTitle: string,
    step: AgentRoomRunnerStep,
    isOrderedStep = false,
    runId?: string,
): void {
    // Validate step semantics before applying
    validateRunnerStep(taskId, step, isOrderedStep)

    // Transition status via state machine (validates each transition)
    if (step.status) {
        updateTaskStatus(taskId, step.status)
    }

    // Emit workflow events (each produces both event + message via event-adapter)
    for (const event of step.events ?? []) {
        emitEventAndMessage(
            sessionId,
            taskId,
            event.type,
            event.agentRole,
            taskTitle,
            event.payload,
        )
    }

    // Create direct chat messages (independent of events, not validated)
    for (const msg of step.messages ?? []) {
        addMessage({
            sessionId,
            senderId: msg.senderId ?? msg.senderRole,
            senderName: msg.senderName ?? msg.senderRole,
            senderRole: msg.senderRole,
            type: msg.type ?? 'agent_message',
            content: msg.content,
            metadata: { taskId, ...msg.metadata },
        })
    }

    // Emit run_event for multi-role step observability
    if (runId) {
        const activeRole = resolveStepActiveRole(step)
        const runEvent: store.AgentRoomRunEvent = {
            id: randomUUID(),
            runId,
            sessionId,
            taskId,
            source: 'runner',
            sequence: store.getNextRunEventSequence(runId),
            eventType: step.status ? `step:${step.status}` : 'step:info',
            payload: {
                activeRole,
                status: step.status,
                eventTypes: step.events?.map(e => e.type) ?? [],
                messageCount: step.messages?.length ?? 0,
            },
            createdAt: new Date().toISOString(),
        }
        store.createRunEvent(runEvent)
    }
}

/**
 * Apply a structured RunnerResult to the store.
 * Used by runWorkflow() when a runner returns AgentRoomRunnerResult instead of void.
 *
 * Supports two modes:
 * 1. **Ordered steps** (preferred): `result.steps` applied sequentially.
 * 2. **Legacy flat** (backward compat): `result.status` + `result.events` + `result.messages`.
 *
 * Artifacts are always created after all steps/status transitions complete.
 * When runId is provided, each step emits a run_event for multi-role observability.
 */
function applyRunnerResult(
    sessionId: string,
    taskId: string,
    taskTitle: string,
    result: AgentRoomRunnerResult,
    runId?: string,
): void {
    store.runInTransaction(() => {
        // Apply ordered steps (preferred path)
        if (result.steps?.length) {
            for (const step of result.steps) {
                applyRunnerStep(sessionId, taskId, taskTitle, step, true, runId)
            }
        } else {
            // Legacy flat path (backward compat)
            applyRunnerStep(sessionId, taskId, taskTitle, {
                status: result.status,
                events: result.events,
                messages: result.messages,
            }, false, runId)
        }

        // Create artifacts (always after all steps complete)
        for (const art of result.artifacts ?? []) {
            const artifact: AgentRoomArtifact = {
                id: randomUUID(),
                sessionId,
                taskId,
                name: art.name,
                type: art.type,
                content: art.content,
                metadata: art.metadata,
                createdAt: new Date().toISOString(),
            }
            store.createArtifact(artifact as store.AgentRoomArtifact)
        }

        // P6.3: Create auto-reviewer review record in the same transaction.
        // Previously written via onReviewerDecision hook outside the transaction.
        // Now the runner result carries reviewerDecision and we write it here.
        if (result.reviewerDecision) {
            const decision = result.reviewerDecision
            const reviewStatus: 'passed' | 'rejected' =
                decision.reviewDecision === 'approved' ? 'passed' : 'rejected'

            const reviewMetadata: Record<string, unknown> = {
                source: 'orchestrated-reviewer',
                reviewerRunId: decision.reviewerRunId,
                reviewerProfileName: decision.reviewerProfileName,
                reviewDecision: decision.reviewDecision,
                reviewFeedback: decision.reviewFeedback,
                reviewIssues: decision.reviewIssues,
                reviewConfidence: decision.reviewConfidence,
            }

            const review: store.AgentRoomReview = {
                id: randomUUID(),
                sessionId: decision.sessionId,
                taskId: decision.taskId,
                reviewerAgentId: decision.reviewerProfileName,
                status: reviewStatus,
                comment: decision.reviewFeedback,
                metadata: reviewMetadata,
                createdAt: new Date().toISOString(),
            }
            store.createReview(review)
        }

        store.updateSessionTimestamp(sessionId)
    })
}

/**
 * Emit run_events from workflow events produced during a void-runner execution.
 * This bridges the gap for runners (like MockAgentRoomRunner) that use ctx helpers
 * directly and return void — their workflow events are retroactively mapped to run_events.
 */
function emitRunEventsFromWorkflowEvents(runId: string, sessionId: string, taskId: string): void {
    const workflowEvents = store.listWorkflowEventsBySession(sessionId)
    const taskEvents = workflowEvents.filter(e => e.taskId === taskId)

    // Deduplicate: only emit run_events for events that don't already have a corresponding run_event
    const existingRunEvents = store.listRunEventsByRun(runId)
    const existingEventTypes = new Set(existingRunEvents.map(e => e.eventType))

    for (const evt of taskEvents) {
        const runEventType = `workflow:${evt.type}`
        // Skip if already emitted by applyRunnerResult
        if (existingEventTypes.has(runEventType)) continue

        const runEvent: store.AgentRoomRunEvent = {
            id: randomUUID(),
            runId,
            sessionId,
            taskId,
            source: 'runner',
            sequence: store.getNextRunEventSequence(runId),
            eventType: runEventType,
            payload: {
                activeRole: evt.agentRole,
                workflowEventType: evt.type,
                agentId: evt.agentId,
            },
            createdAt: new Date().toISOString(),
        }
        store.createRunEvent(runEvent)
    }
}

/**
 * Map AgentRoom role to the corresponding phase name for role run tracking.
 */
function roleToPhase(role: AgentRoomRole): string {
    switch (role) {
        case 'planner': return 'planning'
        case 'developer': return 'development'
        case 'reviewer': return 'review'
        case 'delivery': return 'delivery'
        case 'conversation': return 'conversation'
        default: return 'unknown'
    }
}

/**
 * Create role run records for each bound role in a workflow run.
 * Returns the created role runs in binding order (planner → developer → reviewer → delivery).
 */
function createRoleRunsForRun(
    run: store.AgentRoomRun,
    bindings: Map<AgentRoomRole, RunnerRoleBinding>,
): store.AgentRoomRoleRun[] {
    const now = new Date().toISOString()
    const roleRuns: store.AgentRoomRoleRun[] = []
    for (const [role, binding] of bindings) {
        const roleRun: store.AgentRoomRoleRun = {
            id: randomUUID(),
            runId: run.id,
            sessionId: run.sessionId,
            taskId: run.taskId,
            role,
            phase: roleToPhase(role),
            profileName: binding.profileName,
            status: 'queued',
            createdAt: now,
            updatedAt: now,
        }
        store.createRoleRun(roleRun)
        roleRuns.push(roleRun)
    }
    return roleRuns
}

/**
 * Finalize role run records after workflow completion or failure.
 * - Roles that were already started (running) get marked as terminalStatus.
 * - Roles that were never started (queued) get marked as 'skipped'.
 * On failure, only the first non-terminal role run gets the error message.
 */
function finalizeRoleRuns(
    roleRuns: store.AgentRoomRoleRun[],
    terminalStatus: 'completed' | 'failed',
    errorMessage?: string,
): void {
    const now = new Date().toISOString()
    let errorApplied = false
    for (const roleRun of roleRuns) {
        if (roleRun.status === 'completed' || roleRun.status === 'failed' || roleRun.status === 'skipped') {
            continue // already finalized
        }
        if (roleRun.status === 'running') {
            // Was started — mark as terminal
            roleRun.status = terminalStatus
            roleRun.finishedAt = now
            roleRun.updatedAt = now
            if (terminalStatus === 'failed' && errorMessage && !errorApplied) {
                roleRun.errorMessage = errorMessage
                errorApplied = true
            }
        } else {
            // queued — never started, mark as skipped
            roleRun.status = 'skipped'
            roleRun.finishedAt = now
            roleRun.updatedAt = now
        }
        store.updateRoleRun(roleRun)
    }
}

/**
 * Build runtime hooks for a run record.
 * onUpstreamRunCreated: binds the upstream Gateway run_id to the local run record
 *   and advances the role run lifecycle (P3.3).
 * onRawEvent: persists SSE events as run_events with role_run_id correlation (P3.3/P3.4).
 * Both hooks swallow errors to avoid breaking the main execution flow.
 *
 * @param run       The workflow-level run record
 * @param roleRuns  Optional role run records for role-level observability (P3.3)
 */
/**
 * Build runtime hooks for a run record.
 *
 * P5.1: Role-aware binding — uses `context.role` from onUpstreamRunCreated
 * to bind upstream run_id to the correct role_run by role name.
 * Falls back to sequential index for backward compatibility with single-role
 * runtimes (GatewayHermesRuntime) that don't pass role context.
 *
 * onRawEvent: uses `payload._agentRole` to resolve role_run_id for gateway_sse events.
 * Falls back to most-recently-bound role_run when _agentRole is absent.
 *
 * @param run       The workflow-level run record
 * @param roleRuns  Optional role run records for role-level observability (P3.3)
 */
function buildRunHooks(run: store.AgentRoomRun, roleRuns?: store.AgentRoomRoleRun[]): HermesAgentRuntimeHooks {
    // P5.1: Build role → roleRun map for O(1) role-aware lookup
    const roleRunMap = new Map<string, store.AgentRoomRoleRun>()
    for (const rr of roleRuns ?? []) {
        roleRunMap.set(rr.role, rr)
    }

    // Track which role run was most recently bound (for fallback paths)
    let lastBoundRoleRun: store.AgentRoomRoleRun | undefined

    // Legacy sequential index for callers without role context
    let activeRoleRunIndex = 0

    return {
        onUpstreamRunCreated: (upstreamRunId: string, context?: { role?: string }) => {
            try {
                updateRunUpstreamId(run.id, upstreamRunId)
                // Also update in-memory object so the final store.updateRun() preserves it
                run.upstreamRunId = upstreamRunId

                // P5.1: Role-aware binding — resolve by role name if context is provided
                let targetRoleRun: store.AgentRoomRoleRun | undefined
                if (context?.role) {
                    targetRoleRun = roleRunMap.get(context.role)
                } else {
                    // Fallback: sequential index for legacy callers
                    targetRoleRun = roleRuns?.[activeRoleRunIndex]
                }

                if (targetRoleRun && targetRoleRun.status === 'queued') {
                    targetRoleRun.upstreamRunId = upstreamRunId
                    targetRoleRun.status = 'running'
                    targetRoleRun.startedAt = new Date().toISOString()
                    targetRoleRun.updatedAt = targetRoleRun.startedAt
                    store.updateRoleRun(targetRoleRun)
                    lastBoundRoleRun = targetRoleRun
                    // Only advance legacy index for non-role-aware callers
                    if (!context?.role) {
                        activeRoleRunIndex++
                    }
                }
            } catch { /* swallow — non-critical */ }
        },
        onRawEvent: (event: Record<string, unknown>) => {
            try {
                const eventType = typeof event.event === 'string' ? event.event : 'unknown'

                // P5.1: Resolve role_run_id from event payload _agentRole
                // (set by createRoleTaggedHooks in orchestrated runtime)
                // Falls back to most-recently-bound role_run for backward compat.
                const eventRole = typeof event._agentRole === 'string' ? event._agentRole : undefined
                let activeRoleRunId: string | undefined
                if (eventRole) {
                    activeRoleRunId = roleRunMap.get(eventRole)?.id
                }
                // Fallback: use most recently bound role_run
                if (!activeRoleRunId) {
                    activeRoleRunId = lastBoundRoleRun?.id
                }

                const runEvent: store.AgentRoomRunEvent = {
                    id: randomUUID(),
                    runId: run.id,
                    sessionId: run.sessionId,
                    taskId: run.taskId,
                    roleRunId: activeRoleRunId,
                    source: 'gateway_sse',
                    sequence: store.getNextRunEventSequence(run.id),
                    eventType,
                    payload: event,
                    createdAt: new Date().toISOString(),
                }
                store.createRunEvent(runEvent)
            } catch { /* swallow — non-critical */ }
        },
        // P6.3: onReviewerDecision handler removed — review creation moved to applyRunnerResult() transaction
    }
}

/**
 * Create a run record in 'queued' status.
 * Shared helper for both sync and async workflow entry points.
 */
function createRunRecord(sessionId: string, taskId: string): store.AgentRoomRun {
    const now = new Date().toISOString()
    const run: store.AgentRoomRun = {
        id: randomUUID(),
        sessionId,
        taskId,
        status: 'queued',
        runnerName: activeRunner.name,
        createdAt: now,
        updatedAt: now,
    }
    store.createRun(run)
    return run
}

/**
 * Core execution logic shared by sync and async paths.
 * Operates on an already-created run record.
 * Transitions the run through running → completed/failed lifecycle.
 *
 * @param run       Pre-created run record (status: queued)
 * @param rethrow   If true (sync path), rethrow errors after marking run as failed.
 *                  If false (async/background path), swallow errors after logging.
 */
async function executeRun(
    sessionId: string,
    taskId: string,
    task: AgentRoomTask,
    run: store.AgentRoomRun,
    rethrow: boolean,
): Promise<void> {
    runningWorkflows.add(taskId)

    // Transition to running
    run.status = 'running'
    run.startedAt = new Date().toISOString()
    run.updatedAt = run.startedAt
    store.updateRun(run)

    // P3.3: Create role run records for each bound role
    const bindings = store.listRoleBindingsBySession(sessionId)
    const roleBindings = new Map<AgentRoomRole, RunnerRoleBinding>()
    for (const b of bindings) {
        roleBindings.set(b.role as AgentRoomRole, { role: b.role as AgentRoomRole, profileName: b.profileName })
    }
    const roleRuns = createRoleRunsForRun(run, roleBindings)

    try {
        // Build hooks for real-time observability (P3.3: with role run tracking)
        const hooks = buildRunHooks(run, roleRuns)

        const ctx: AgentRoomRunnerContext = {
            sessionId,
            taskId,
            task,
            roleBindings,
            hooks,
            updateTaskStatus: (tid, newStatus) => updateTaskStatus(tid, newStatus),
            emitEventAndMessage: (sid, tid, type, role, title, payload) => {
                emitEventAndMessage(sid, tid, type, role, title, payload)
            },
            runInTransaction: (fn) => store.runInTransaction(fn),
            updateSessionTimestamp: (sid) => store.updateSessionTimestamp(sid),
            getLatestReviewFeedback: (tid) => getLatestReviewFeedback(tid),
        }

        const result = await activeRunner.run(ctx)

        // If runner returned a structured result, apply it via facade
        if (result) {
            applyRunnerResult(sessionId, taskId, task.title, result, run.id)
        }

        // Emit run_events for observability (covers both void and result paths).
        // For result paths, applyRunnerResult already emitted step-level run_events.
        // For void paths (mock runner), we synthesize run_events from workflow events.
        if (!result) {
            emitRunEventsFromWorkflowEvents(run.id, sessionId, taskId)
        }

        // ─── Unified autoDelivery hook ──────────────────────────────
        // After runner completes, check if the task reached review_passed
        // and the session has autoDelivery enabled. This unifies the
        // autoDelivery logic between manual submitReview() and runner-produced
        // review_passed status (e.g. orchestrated reviewer approval).
        const taskAfterRun = store.getTask(taskId) as AgentRoomTask | null
        if (taskAfterRun?.status === 'review_passed') {
            const session = store.getSession(sessionId)
            if (session?.autoDeliveryEnabled) {
                store.runInTransaction(() => {
                    deliverTaskCore(sessionId, taskId, taskAfterRun, 'auto')
                })
            }
        }

        // Mark run as completed
        run.status = 'completed'
        run.finishedAt = new Date().toISOString()
        run.updatedAt = run.finishedAt
        store.updateRun(run)

        // P3.3: Finalize role runs — mark completed ones, skip unstarted ones
        finalizeRoleRuns(roleRuns, 'completed')
    } catch (err: any) {
        // Mark run as failed
        run.status = 'failed'
        run.errorMessage = err?.message ?? 'Unknown error'
        run.finishedAt = new Date().toISOString()
        run.updatedAt = run.finishedAt
        store.updateRun(run)

        // P3.3: Finalize role runs — mark active one as failed, skip remaining
        finalizeRoleRuns(roleRuns, 'failed', err?.message)

        if (rethrow) {
            throw err
        } else {
            // Background execution: log error instead of propagating
            console.error(`[agent-room] Background workflow failed (run=${run.id}, task=${taskId}):`, err?.message ?? err)
        }
    } finally {
        store.updateSessionTimestamp(sessionId)
        runningWorkflows.delete(taskId)
    }
}

/**
 * Validate that a workflow can be started for the given task.
 * Shared guard logic for both `runWorkflow()` and `startWorkflow()`.
 * Returns the validated task.
 */
function assertWorkflowStartable(sessionId: string, taskId: string): AgentRoomTask {
    const task = assertTaskInSession(taskId, sessionId)

    // Guard: prevent duplicate workflow runs on the same task (in-memory fast path)
    if (runningWorkflows.has(taskId)) {
        throw new Error('Workflow is already running')
    }

    // DB-level guard: check for active runs in persisted storage (belt-and-suspenders)
    if (store.hasActiveRunForTask(taskId)) {
        throw new Error('Workflow is already running')
    }

    // Guard: only allow starting from specific statuses
    if (!WORKFLOW_STARTABLE_STATUSES.includes(task.status)) {
        throw new Error(
            `Cannot start workflow in status "${task.status}". ` +
            `Expected one of: ${WORKFLOW_STARTABLE_STATUSES.join(', ')}`,
        )
    }

    return task
}

/**
 * Run the workflow synchronously: validates, executes, and returns the completed/failed run.
 * This is the original behavior preserved for backward compatibility and tests.
 */
export async function runWorkflow(sessionId: string, taskId: string): Promise<store.AgentRoomRun> {
    const task = assertWorkflowStartable(sessionId, taskId)
    const run = createRunRecord(sessionId, taskId)
    await executeRun(sessionId, taskId, task, run, true)
    return run
}

/**
 * Start the workflow asynchronously: validates, creates the run record,
 * kicks off execution in the background, and returns the run immediately.
 * The returned run status is 'queued' (may have transitioned to 'running' by the time
 * the caller inspects it). Callers should use polling to track progress.
 */
export function startWorkflow(sessionId: string, taskId: string): store.AgentRoomRun {
    const task = assertWorkflowStartable(sessionId, taskId)
    const run = createRunRecord(sessionId, taskId)
    // Fire-and-forget: errors are caught and logged inside executeRun
    void executeRun(sessionId, taskId, task, run, false)
    return run
}

/**
 * Compatibility alias — delegates to runWorkflow.
 * Preserved for backward compatibility with existing callers.
 */
export async function runMockWorkflow(sessionId: string, taskId: string): Promise<store.AgentRoomRun> {
    return runWorkflow(sessionId, taskId)
}

// ─── Run Queries ────────────────────────────────────────────────

export function listRuns(sessionId: string): store.AgentRoomRun[] {
    assertSessionExists(sessionId)
    return store.listRunsBySession(sessionId)
}

export function listTaskRuns(sessionId: string, taskId: string): store.AgentRoomRun[] {
    assertSessionExists(sessionId)
    assertTaskInSession(taskId, sessionId)
    return store.listRunsByTask(taskId)
}

export function getRun(runId: string): store.AgentRoomRun | null {
    return store.getRun(runId)
}

/**
 * Update the upstream_run_id for a run record.
 * Used for SSE/Gateway integration: local run id is decoupled from Gateway run_id,
 * but upstreamRunId provides the link for event correlation.
 */
export function updateRunUpstreamId(runId: string, upstreamRunId: string): store.AgentRoomRun | null {
    const run = store.getRun(runId)
    if (!run) return null
    run.upstreamRunId = upstreamRunId
    run.updatedAt = new Date().toISOString()
    store.updateRun(run)
    return run
}

/**
 * Find a run by its upstream (Gateway) run_id.
 * Returns null if no match.
 */
export function findRunByUpstreamId(upstreamRunId: string): store.AgentRoomRun | null {
    return store.findByUpstreamRunId(upstreamRunId)
}

// ─── Review Feedback Helper ─────────────────────────────────────

/**
 * Get the most recent rejected review comment for a task.
 * Returns undefined if no rejected review exists.
 * Used by the runner to pass review feedback to the developer agent during retry.
 */
function getLatestReviewFeedback(taskId: string): string | undefined {
    const reviews = store.listReviewsByTask(taskId)
    const rejected = reviews.filter(r => r.status === 'rejected')
    if (rejected.length === 0) return undefined
    // Reviews are ordered by created_at ASC; get the last rejected one
    return rejected[rejected.length - 1].comment || undefined
}

// ─── Retry / Deliver ───────────────────────────────────────────

/**
 * Retry a task: transitions from a retryable status to in_progress.
 * Retryable statuses: revision_required, need_user_decision, failed.
 * Note: review_rejected is NOT retryable — it's a transient state that
 * submitReview immediately transitions to revision_required or need_user_decision.
 */
export function retryTask(sessionId: string, taskId: string): AgentRoomTask | null {
    const task = assertTaskInSession(taskId, sessionId)

    // Validate: only retryable statuses can be retried
    const retryableStatuses: AgentRoomTaskStatus[] = [
        'revision_required', 'need_user_decision', 'failed',
    ]
    if (!retryableStatuses.includes(task.status)) {
        throw new Error(`Cannot retry task in status "${task.status}". Expected one of: ${retryableStatuses.join(', ')}`)
    }

    // Save old status BEFORE mutation (updateTaskStatus modifies task in-place)
    const oldStatus = task.status

    store.runInTransaction(() => {
        // Use state machine to transition to in_progress
        updateTaskStatus(taskId, 'in_progress')

        // Emit appropriate event based on the ORIGINAL status
        if (oldStatus === 'revision_required' || oldStatus === 'need_user_decision') {
            emitEventAndMessage(sessionId, taskId, 'revision_started', 'developer', task.title, {
                revisionRound: task.revisionRound,
            })
        } else if (oldStatus === 'failed') {
            emitEventAndMessage(sessionId, taskId, 'task_started', 'developer', task.title)
        }
    })

    store.updateSessionTimestamp(sessionId)
    return store.getTask(taskId) as AgentRoomTask | null
}

// ─── Delete ─────────────────────────────────────────────────────

/**
 * Delete a session and all its child records.
 * Throws if any task in the session has a running workflow.
 */
export function deleteSession(sessionId: string): void {
    assertSessionExists(sessionId)
    // Check: no running workflows for any task in this session
    const tasks = store.listTasksBySession(sessionId)
    for (const task of tasks) {
        if (runningWorkflows.has(task.id)) {
            throw new Error('Cannot delete session while workflow is running')
        }
    }
    store.runInTransaction(() => {
        store.deleteSessionCascade(sessionId)
    })
}

/**
 * Delete a task and its child records (reviews, workflow events, task-scoped messages).
 * Throws if the task has a running workflow.
 */
export function deleteTask(sessionId: string, taskId: string): void {
    assertTaskInSession(taskId, sessionId)
    if (runningWorkflows.has(taskId)) {
        throw new Error('Cannot delete task while workflow is running')
    }
    store.runInTransaction(() => {
        store.deleteTaskCascade(sessionId, taskId)
        store.updateSessionTimestamp(sessionId)
    })
}

/**
 * P7.1: Create a delivery role_run attached to the latest workflow run of the task.
 * Returns null when no workflow run exists (compatibility with legacy/manual status changes).
 */
function createDeliveryRoleRunIfPossible(
    sessionId: string,
    taskId: string,
    task: AgentRoomTask,
    deliveryMode: 'manual' | 'auto',
    deliveredAt: string,
): store.AgentRoomRoleRun | null {
    const latestRun = store.listRunsByTask(taskId)[0]
    if (!latestRun) return null
    const roleRun: store.AgentRoomRoleRun = {
        id: randomUUID(),
        runId: latestRun.id,
        sessionId,
        taskId,
        role: 'delivery',
        phase: 'delivery',
        profileName: deliveryMode,
        upstreamRunId: undefined,
        status: 'completed',
        startedAt: deliveredAt,
        finishedAt: deliveredAt,
        errorMessage: undefined,
        metadata: {
            source: deliveryMode === 'manual' ? 'manual-delivery-runtime' : 'auto-delivery-runtime',
            deliveryMode,
            taskStatusBeforeDelivery: task.status,
        },
        createdAt: deliveredAt,
        updatedAt: deliveredAt,
    }
    store.createRoleRun(roleRun)
    return roleRun
}

/**
 * Core delivery logic — does NOT open its own transaction.
 * Callers that are already inside runInTransaction() should call this directly.
 * External callers should use deliverTask() which wraps in a transaction.
 */
function deliverTaskCore(sessionId: string, taskId: string, task: AgentRoomTask, deliveryMode: 'manual' | 'auto'): void {
    // Gather enrichment data
    const reviewFeedback = getLatestReviewFeedback(taskId)
    const deliveredAt = new Date().toISOString()

    // P4.1: Resolve role run IDs for observability
    const roleRuns = store.listRoleRunsByTask(taskId)
    const plannerRunId = roleRuns.find(r => r.role === 'planner')?.runId
    const developerRunId = roleRuns.find(r => r.role === 'developer')?.runId
    const reviewerRunId = roleRuns.find(r => r.role === 'reviewer')?.runId

    // P7.1: Create delivery role_run attached to the latest workflow run
    const deliveryRoleRun = createDeliveryRoleRunIfPossible(sessionId, taskId, task, deliveryMode, deliveredAt)

    // Build delivery event payload with role run linkage
    const deliveryPayload: Record<string, unknown> = {
        deliveryMode,
    }
    if (deliveryRoleRun) {
        deliveryPayload.deliveryRoleRunId = deliveryRoleRun.id
    }

    // Transition to delivering via state machine
    updateTaskStatus(taskId, 'delivering')
    emitEventAndMessage(sessionId, taskId, 'delivery_started', 'delivery', task.title, deliveryPayload)

    // Complete via state machine
    updateTaskStatus(taskId, 'completed')
    emitEventAndMessage(sessionId, taskId, 'delivery_completed', 'delivery', task.title, deliveryPayload)

    // Build enriched delivery summary
    const summaryLines = [
        `任务「${task.title}」已完成交付。`,
        '',
        `交付模式: ${deliveryMode === 'auto' ? '自动' : '手动'}`,
    ]
    if (task.revisionRound > 0) {
        summaryLines.push(`修改轮次: ${task.revisionRound}/${task.maxRevisionRounds}`)
    }
    if (reviewFeedback) {
        summaryLines.push(`审核反馈: ${reviewFeedback}`)
    }
    summaryLines.push(`交付时间: ${deliveredAt}`)

    // P4.1: Standardized final_delivery artifact metadata
    const metadata: Record<string, unknown> = {
        source: deliveryMode === 'auto' ? 'auto-delivery' : 'manual-delivery',
        deliveryMode,
        deliveryRole: 'delivery',
        revisionRound: task.revisionRound,
        maxRevisionRounds: task.maxRevisionRounds,
        reviewFeedback: reviewFeedback ?? null,
        deliveredAt,
    }
    if (plannerRunId) metadata.plannerRunId = plannerRunId
    if (developerRunId) metadata.developerRunId = developerRunId
    if (reviewerRunId) metadata.reviewerRunId = reviewerRunId

    // P7.1: Link delivery role_run in artifact metadata
    if (deliveryRoleRun) {
        metadata.deliveryRoleRunId = deliveryRoleRun.id
        metadata.deliveryRunId = deliveryRoleRun.runId
    }

    // Create final_delivery artifact with enriched metadata
    const artifact: AgentRoomArtifact = {
        id: randomUUID(),
        sessionId,
        taskId,
        name: `${task.title} — 交付结果`,
        type: 'final_delivery',
        content: summaryLines.join('\n'),
        metadata,
        createdAt: deliveredAt,
    }
    store.createArtifact(artifact as store.AgentRoomArtifact)
}

/**
 * Deliver a task: review_passed → delivering → completed.
 * All messages produced via event adapter.
 *
 * @param sessionId  Session containing the task
 * @param taskId     Task to deliver
 * @param deliveryMode  'manual' (default) or 'auto' — recorded in artifact metadata
 */
export function deliverTask(sessionId: string, taskId: string, deliveryMode: 'manual' | 'auto' = 'manual'): AgentRoomTask | null {
    const task = assertTaskInSession(taskId, sessionId)

    // Guard: only review_passed can be delivered
    if (task.status !== 'review_passed') {
        throw new Error(`Cannot deliver task in status "${task.status}". Expected: review_passed`)
    }

    store.runInTransaction(() => {
        deliverTaskCore(sessionId, taskId, task, deliveryMode)
    })

    store.updateSessionTimestamp(sessionId)
    return store.getTask(taskId) as AgentRoomTask | null
}

// ─── Session Config ────────────────────────────────────────────

export interface AgentRoomSessionConfig {
    autoDeliveryEnabled: boolean
}

/**
 * Get session delivery configuration.
 */
export function getSessionConfig(sessionId: string): AgentRoomSessionConfig {
    const session = assertSessionExists(sessionId)
    return { autoDeliveryEnabled: session.autoDeliveryEnabled }
}

/**
 * Update session delivery configuration.
 * Only `autoDeliveryEnabled` is mutable; other fields are immutable.
 */
export function updateSessionConfig(sessionId: string, config: Partial<AgentRoomSessionConfig>): AgentRoomSessionConfig {
    assertSessionExists(sessionId)
    store.runInTransaction(() => {
        if (config.autoDeliveryEnabled !== undefined) {
            store.updateSessionAutoDelivery(sessionId, config.autoDeliveryEnabled)
        }
        store.updateSessionTimestamp(sessionId)
    })
    return getSessionConfig(sessionId)
}

// ─── Artifact CRUD ─────────────────────────────────────────────

export function listArtifacts(sessionId: string): AgentRoomArtifact[] {
    assertSessionExists(sessionId)
    return store.listArtifactsBySession(sessionId) as AgentRoomArtifact[]
}

export function listTaskArtifacts(sessionId: string, taskId: string): AgentRoomArtifact[] {
    assertSessionExists(sessionId)
    assertTaskInSession(taskId, sessionId)
    return store.listArtifactsByTask(taskId) as AgentRoomArtifact[]
}

export function deleteArtifact(sessionId: string, artifactId: string): void {
    assertSessionExists(sessionId)
    const artifact = store.getArtifact(artifactId)
    if (!artifact) throw new Error('Artifact not found')
    if (artifact.sessionId !== sessionId) {
        throw new Error(`Artifact belongs to session ${artifact.sessionId}, not ${sessionId}`)
    }
    store.deleteArtifact(artifactId)
}

// ─── Role Binding CRUD ─────────────────────────────────────────

export interface AgentRoomRoleBinding {
    id: string
    sessionId: string
    role: AgentRoomRole
    /** The Hermes profile name used for Gateway resolution. Maps to agent_id column. */
    profileName: string
    createdAt: string
}

function normalizeProfileName(profileName: string): string {
    const normalized = profileName.trim()
    if (!normalized) throw new Error('profileName is required')
    return normalized
}

export function createRoleBinding(sessionId: string, role: AgentRoomRole, profileName: string): AgentRoomRoleBinding {
    assertSessionExists(sessionId)
    assertAgentRoomRole(role)
    const normalized = normalizeProfileName(profileName)
    const existing = store.getRoleBindingBySessionAndRole(sessionId, role)
    if (existing) {
        throw new Error(`Role binding already exists for session=${sessionId} role=${role}`)
    }
    const binding: AgentRoomRoleBinding = {
        id: randomUUID(),
        sessionId,
        role,
        profileName: normalized,
        createdAt: new Date().toISOString(),
    }
    store.runInTransaction(() => {
        store.createRoleBinding(binding)
        store.updateSessionTimestamp(sessionId)
    })
    return binding
}

/**
 * Upsert a role binding: create if not exists, update profileName if exists.
 * Preferred API for frontend/UI callers.
 */
export function setRoleBinding(sessionId: string, role: AgentRoomRole, profileName: string): AgentRoomRoleBinding {
    assertSessionExists(sessionId)
    assertAgentRoomRole(role)
    const normalized = normalizeProfileName(profileName)
    const existing = store.getRoleBindingBySessionAndRole(sessionId, role)
    if (existing) {
        const updated: AgentRoomRoleBinding = { ...existing, role: existing.role as AgentRoomRole, profileName: normalized }
        store.runInTransaction(() => {
            store.updateRoleBinding(updated)
            store.updateSessionTimestamp(sessionId)
        })
        return updated
    }
    return createRoleBinding(sessionId, role, normalized)
}

export function listRoleBindings(sessionId: string): AgentRoomRoleBinding[] {
    assertSessionExists(sessionId)
    return store.listRoleBindingsBySession(sessionId) as unknown as AgentRoomRoleBinding[]
}

/**
 * Get the role binding for a specific role in a session.
 * Returns null if no binding exists for that role.
 */
export function getRoleBindingForRole(sessionId: string, role: AgentRoomRole): AgentRoomRoleBinding | null {
    assertSessionExists(sessionId)
    return store.getRoleBindingBySessionAndRole(sessionId, role) as unknown as AgentRoomRoleBinding | null
}

/** @deprecated Use getRoleBindingForRole() instead. */
export const getRoleBindingForAgent = getRoleBindingForRole

export function updateRoleBinding(sessionId: string, bindingId: string, profileName: string): AgentRoomRoleBinding {
    assertSessionExists(sessionId)
    const normalized = normalizeProfileName(profileName)
    const binding = store.getRoleBinding(bindingId)
    if (!binding) throw new Error('Role binding not found')
    if (binding.sessionId !== sessionId) {
        throw new Error(`Role binding belongs to session ${binding.sessionId}, not ${sessionId}`)
    }
    const updated: AgentRoomRoleBinding = { ...binding, role: binding.role as AgentRoomRole, profileName: normalized }
    store.runInTransaction(() => {
        store.updateRoleBinding(updated as store.AgentRoomRoleBinding)
        store.updateSessionTimestamp(sessionId)
    })
    return updated
}

export function deleteRoleBinding(sessionId: string, bindingId: string): void {
    assertSessionExists(sessionId)
    const binding = store.getRoleBinding(bindingId)
    if (!binding) throw new Error('Role binding not found')
    if (binding.sessionId !== sessionId) {
        throw new Error(`Role binding belongs to session ${binding.sessionId}, not ${sessionId}`)
    }
    store.runInTransaction(() => {
        store.deleteRoleBinding(bindingId)
        store.updateSessionTimestamp(sessionId)
    })
}

/**
 * Delete a role binding by session + role (no-op if not found).
 * Preferred API for route-level DELETE by role name.
 */
export function deleteRoleBindingByRole(sessionId: string, role: AgentRoomRole): void {
    assertSessionExists(sessionId)
    assertAgentRoomRole(role)
    const binding = store.getRoleBindingBySessionAndRole(sessionId, role)
    if (!binding) return // no-op
    store.runInTransaction(() => {
        store.deleteRoleBinding(binding.id)
        store.updateSessionTimestamp(sessionId)
    })
}

// ─── Run Event Queries ──────────────────────────────────────────

export type { AgentRoomRunEvent } from '../../../db/hermes/agent-room-store'

/**
 * List all run events for a specific run, ordered by sequence.
 */
export function listRunEventsByRun(runId: string): store.AgentRoomRunEvent[] {
    return store.listRunEventsByRun(runId)
}

/**
 * List all run events for a session, ordered by created_at.
 */
export function listRunEventsBySession(sessionId: string): store.AgentRoomRunEvent[] {
    assertSessionExists(sessionId)
    return store.listRunEventsBySession(sessionId)
}

// ─── Role Run Queries (P3.2) ──────────────────────────────────

/**
 * Get a role run by ID.
 */
export function getRoleRun(roleRunId: string): store.AgentRoomRoleRun | null {
    return store.getRoleRun(roleRunId)
}

/**
 * Get a role run by workflow run ID and role name.
 */
export function getRoleRunByRunAndRole(runId: string, role: AgentRoomRole): store.AgentRoomRoleRun | null {
    return store.getRoleRunByRunAndRole(runId, role)
}

/**
 * List all role runs for a specific workflow run.
 */
export function listRoleRunsByRun(runId: string): store.AgentRoomRoleRun[] {
    return store.listRoleRunsByRun(runId)
}

/**
 * List all role runs for a specific task.
 */
export function listRoleRunsByTask(taskId: string): store.AgentRoomRoleRun[] {
    return store.listRoleRunsByTask(taskId)
}
