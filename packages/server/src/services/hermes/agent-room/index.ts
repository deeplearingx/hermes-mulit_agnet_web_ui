// ─── Agent Room Service ────────────────────────────────────────
// Independent domain service for Agent Room workflow.
// Manages sessions, tasks, reviews, messages, and workflow events.
// Persistence: SQLite via agent-room-store.ts (no in-memory Maps).

import { randomUUID } from 'node:crypto'
import { buildMessageFromEvent } from './event-adapter'
import * as store from '../../../db/hermes/agent-room-store'
import { activeRunner } from './runner'
import type { AgentRoomRunnerContext, AgentRoomRunnerResult, AgentRoomRunnerStep } from './runner'

// ─── Types ─────────────────────────────────────────────────────
import type { AgentRoomRole } from './role-types'
export type { AgentRoomRole }
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

export function createTask(sessionId: string, title: string, description: string, assignedAgentId?: string): AgentRoomTask {
    assertSessionExists(sessionId)
    const task: AgentRoomTask = {
        id: randomUUID(),
        sessionId,
        title,
        description,
        assignedAgentId,
        status: 'created',
        revisionRound: 0,
        maxRevisionRounds: MAX_REVISION_ROUNDS,
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
 * Apply a single step to the store.
 * Each step: validate → status transition → events → messages.
 */
function applyRunnerStep(
    sessionId: string,
    taskId: string,
    taskTitle: string,
    step: AgentRoomRunnerStep,
    isOrderedStep = false,
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
 */
function applyRunnerResult(
    sessionId: string,
    taskId: string,
    taskTitle: string,
    result: AgentRoomRunnerResult,
): void {
    store.runInTransaction(() => {
        // Apply ordered steps (preferred path)
        if (result.steps?.length) {
            for (const step of result.steps) {
                applyRunnerStep(sessionId, taskId, taskTitle, step, true)
            }
        } else {
            // Legacy flat path (backward compat)
            applyRunnerStep(sessionId, taskId, taskTitle, {
                status: result.status,
                events: result.events,
                messages: result.messages,
            })
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

        store.updateSessionTimestamp(sessionId)
    })
}

/**
 * Run the workflow for a task using the active runner.
 * Locking and startable-status validation remain in this facade.
 */
export async function runWorkflow(sessionId: string, taskId: string): Promise<void> {
    const task = assertTaskInSession(taskId, sessionId)

    // Guard: prevent duplicate workflow runs on the same task
    if (runningWorkflows.has(taskId)) {
        throw new Error('Workflow is already running')
    }

    // Guard: only allow starting from specific statuses
    if (!WORKFLOW_STARTABLE_STATUSES.includes(task.status)) {
        throw new Error(
            `Cannot start workflow in status "${task.status}". ` +
            `Expected one of: ${WORKFLOW_STARTABLE_STATUSES.join(', ')}`,
        )
    }

    runningWorkflows.add(taskId)
    try {
        const ctx: AgentRoomRunnerContext = {
            sessionId,
            taskId,
            task,
            updateTaskStatus: (tid, newStatus) => updateTaskStatus(tid, newStatus),
            emitEventAndMessage: (sid, tid, type, role, title, payload) => {
                emitEventAndMessage(sid, tid, type, role, title, payload)
            },
            runInTransaction: (fn) => store.runInTransaction(fn),
            updateSessionTimestamp: (sid) => store.updateSessionTimestamp(sid),
        }

        const result = await activeRunner.run(ctx)

        // If runner returned a structured result, apply it via facade
        if (result) {
            applyRunnerResult(sessionId, taskId, task.title, result)
        }
    } finally {
        store.updateSessionTimestamp(sessionId)
        runningWorkflows.delete(taskId)
    }
}

/**
 * Compatibility alias — delegates to runWorkflow.
 * Preserved for backward compatibility with existing callers.
 */
export async function runMockWorkflow(sessionId: string, taskId: string): Promise<void> {
    return runWorkflow(sessionId, taskId)
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
 * Deliver a task: review_passed → delivering → completed.
 * All messages produced via event adapter.
 */
export function deliverTask(sessionId: string, taskId: string): AgentRoomTask | null {
    const task = assertTaskInSession(taskId, sessionId)

    store.runInTransaction(() => {
        // Transition to delivering via state machine
        updateTaskStatus(taskId, 'delivering')
        emitEventAndMessage(sessionId, taskId, 'delivery_started', 'delivery', task.title)

        // Complete via state machine
        updateTaskStatus(taskId, 'completed')
        emitEventAndMessage(sessionId, taskId, 'delivery_completed', 'delivery', task.title)

        // Create final_delivery artifact
        const artifact: AgentRoomArtifact = {
            id: randomUUID(),
            sessionId,
            taskId,
            name: `${task.title} — 交付结果`,
            type: 'final_delivery',
            content: `任务「${task.title}」已完成交付。`,
            createdAt: new Date().toISOString(),
        }
        store.createArtifact(artifact as store.AgentRoomArtifact)
    })

    store.updateSessionTimestamp(sessionId)
    return store.getTask(taskId) as AgentRoomTask | null
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
    store.createRoleBinding(binding)
    store.updateSessionTimestamp(sessionId)
    return binding
}

/**
 * Upsert a role binding: create if not exists, update profileName if exists.
 * Preferred API for frontend/UI callers.
 */
export function setRoleBinding(sessionId: string, role: AgentRoomRole, profileName: string): AgentRoomRoleBinding {
    assertSessionExists(sessionId)
    const normalized = normalizeProfileName(profileName)
    const existing = store.getRoleBindingBySessionAndRole(sessionId, role)
    if (existing) {
        const updated: AgentRoomRoleBinding = { ...existing, role: existing.role as AgentRoomRole, profileName: normalized }
        store.updateRoleBinding(updated)
        store.updateSessionTimestamp(sessionId)
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
    store.updateRoleBinding(updated as store.AgentRoomRoleBinding)
    store.updateSessionTimestamp(sessionId)
    return updated
}

export function deleteRoleBinding(sessionId: string, bindingId: string): void {
    assertSessionExists(sessionId)
    const binding = store.getRoleBinding(bindingId)
    if (!binding) throw new Error('Role binding not found')
    if (binding.sessionId !== sessionId) {
        throw new Error(`Role binding belongs to session ${binding.sessionId}, not ${sessionId}`)
    }
    store.deleteRoleBinding(bindingId)
    store.updateSessionTimestamp(sessionId)
}
