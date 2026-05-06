// ─── Agent Room Service ────────────────────────────────────────
// Independent domain service for Agent Room workflow.
// Manages sessions, tasks, reviews, messages, and workflow events.
// Persistence: SQLite via agent-room-store.ts (no in-memory Maps).

import { randomUUID } from 'node:crypto'
import { buildMessageFromEvent } from './event-adapter'
import * as store from '../../../db/hermes/agent-room-store'

// ─── Types ─────────────────────────────────────────────────────
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

export type AgentRoomRole = 'conversation' | 'planner' | 'developer' | 'reviewer' | 'delivery'

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

// ─── Constants ─────────────────────────────────────────────────
const MAX_REVISION_ROUNDS = 3

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
    const review: AgentRoomReview & { sessionId: string } = {
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

// ─── Workflow Engine (v1 mock) ─────────────────────────────────
// Simulates the full agent workflow with mock responses.
// All messages are produced via the event adapter — no direct addMessage calls.
export async function runMockWorkflow(sessionId: string, taskId: string): Promise<void> {
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
        const delay = (ms: number) => new Promise(r => setTimeout(r, ms))

        // Step 1: Conversation Agent receives → planned
        store.runInTransaction(() => {
            updateTaskStatus(taskId, 'planned')
            emitEventAndMessage(sessionId, taskId, 'task_planned', 'conversation', task.title)
        })
        await delay(300)

        // Step 2: Planner Agent plans → assigned
        store.runInTransaction(() => {
            updateTaskStatus(taskId, 'assigned')
            emitEventAndMessage(sessionId, taskId, 'task_planned', 'planner', task.title)
        })
        await delay(300)

        // Step 3: Developer starts → in_progress
        store.runInTransaction(() => {
            updateTaskStatus(taskId, 'in_progress')
            emitEventAndMessage(sessionId, taskId, 'task_assigned', 'developer', task.title)
        })
        await delay(500)

        // Step 4: Developer submits for review → submitted_for_review
        store.runInTransaction(() => {
            updateTaskStatus(taskId, 'submitted_for_review')
            emitEventAndMessage(sessionId, taskId, 'task_started', 'developer', task.title)
            emitEventAndMessage(sessionId, taskId, 'task_submitted', 'developer', task.title)
        })
        await delay(300)

        // Workflow stops here at submitted_for_review.
        // Actual review must be triggered manually via ReviewDecisionModal.
    } finally {
        runningWorkflows.delete(taskId)
    }
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

    return store.getTask(taskId) as AgentRoomTask | null
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
    })

    return store.getTask(taskId) as AgentRoomTask | null
}
