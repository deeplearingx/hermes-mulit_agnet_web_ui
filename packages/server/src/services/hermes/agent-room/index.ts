// ─── Agent Room Service ────────────────────────────────────────
// Independent domain service for Agent Room workflow.
// Manages sessions, tasks, reviews, messages, and workflow events.

import { randomUUID } from 'node:crypto'

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
const VALID_TRANSITIONS: Record<AgentRoomTaskStatus, AgentRoomTaskStatus[]> = {
    created: ['planned'],
    planned: ['assigned'],
    assigned: ['in_progress'],
    in_progress: ['submitted_for_review', 'failed'],
    submitted_for_review: ['review_passed', 'review_rejected'],
    review_passed: ['delivering'],
    review_rejected: ['revision_required', 'need_user_decision', 'in_progress'],
    revision_required: ['in_progress'],
    delivering: ['completed', 'failed'],
    completed: [],
    failed: ['created', 'in_progress'],
    need_user_decision: ['in_progress', 'failed'],
}

// ─── In-Memory Storage (v1) ────────────────────────────────────
const sessions = new Map<string, AgentRoomSession>()
const tasks = new Map<string, AgentRoomTask>()
const reviews = new Map<string, AgentRoomReview[]>()
const messages = new Map<string, AgentRoomMessage[]>()
const workflowEvents = new Map<string, AgentRoomWorkflowEvent[]>()

// ─── Session CRUD ──────────────────────────────────────────────
export function createSession(name: string): AgentRoomSession {
    const session: AgentRoomSession = {
        id: randomUUID(),
        name,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    }
    sessions.set(session.id, session)
    messages.set(session.id, [])
    workflowEvents.set(session.id, [])
    return session
}

export function getSession(sessionId: string): AgentRoomSession | null {
    return sessions.get(sessionId) ?? null
}

export function listSessions(): AgentRoomSession[] {
    return [...sessions.values()].sort((a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    )
}

// ─── Message CRUD ──────────────────────────────────────────────
export function listMessages(sessionId: string): AgentRoomMessage[] {
    return messages.get(sessionId) ?? []
}

export function addMessage(msg: Omit<AgentRoomMessage, 'id' | 'createdAt'>): AgentRoomMessage {
    const full: AgentRoomMessage = {
        ...msg,
        id: randomUUID(),
        createdAt: new Date().toISOString(),
    }
    const list = messages.get(msg.sessionId) ?? []
    list.push(full)
    messages.set(msg.sessionId, list)
    return full
}

// ─── Task CRUD ─────────────────────────────────────────────────
export function listTasks(sessionId: string): AgentRoomTask[] {
    return [...tasks.values()].filter(t => t.sessionId === sessionId)
}

export function getTask(taskId: string): AgentRoomTask | null {
    return tasks.get(taskId) ?? null
}

export function createTask(sessionId: string, title: string, description: string, assignedAgentId?: string): AgentRoomTask {
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
    tasks.set(task.id, task)
    return task
}

export function updateTaskStatus(taskId: string, newStatus: AgentRoomTaskStatus): AgentRoomTask | null {
    const task = tasks.get(taskId)
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

    return task
}

// ─── Review CRUD ───────────────────────────────────────────────
export function listReviews(sessionId: string): AgentRoomReview[] {
    const sessionTasks = listTasks(sessionId)
    const taskIds = new Set(sessionTasks.map(t => t.id))
    const result: AgentRoomReview[] = []
    for (const [taskId, taskReviews] of reviews) {
        if (taskIds.has(taskId)) {
            result.push(...taskReviews)
        }
    }
    return result
}

export function submitReview(
    taskId: string,
    reviewerAgentId: string,
    status: 'passed' | 'rejected',
    comment: string,
): AgentRoomReview | null {
    const task = tasks.get(taskId)
    if (!task) return null

    const review: AgentRoomReview = {
        id: randomUUID(),
        taskId,
        reviewerAgentId,
        status,
        comment,
        createdAt: new Date().toISOString(),
    }

    const list = reviews.get(taskId) ?? []
    list.push(review)
    reviews.set(taskId, list)

    // Auto-advance task based on review result
    if (status === 'passed') {
        updateTaskStatus(taskId, 'review_passed')
    } else {
        // Check revision round limit
        if (task.revisionRound >= task.maxRevisionRounds) {
            updateTaskStatus(taskId, 'need_user_decision')
        } else {
            updateTaskStatus(taskId, 'review_rejected')
        }
    }

    return review
}

// ─── Workflow Events ───────────────────────────────────────────
export function listWorkflowEvents(sessionId: string): AgentRoomWorkflowEvent[] {
    return workflowEvents.get(sessionId) ?? []
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
    const list = workflowEvents.get(sessionId) ?? []
    list.push(event)
    workflowEvents.set(sessionId, list)
    return event
}

// ─── Workflow Engine (v1 mock) ─────────────────────────────────
// Simulates the full agent workflow with mock responses
export async function runMockWorkflow(sessionId: string, taskId: string): Promise<void> {
    const task = tasks.get(taskId)
    if (!task) throw new Error('Task not found')

    const delay = (ms: number) => new Promise(r => setTimeout(r, ms))

    // Step 1: Conversation Agent receives
    addMessage({
        sessionId,
        senderId: 'conversation',
        senderName: '会话 Agent',
        senderRole: 'conversation',
        type: 'agent_message',
        content: `收到任务需求：${task.title}。正在转交规划 Agent 处理。`,
        metadata: { taskId, event: 'task_created' },
    })
    addWorkflowEvent(sessionId, taskId, 'task_created', 'conversation', 'conversation')
    updateTaskStatus(taskId, 'planned')
    await delay(300)

    // Step 2: Planner Agent plans
    addMessage({
        sessionId,
        senderId: 'planner',
        senderName: '规划 Agent',
        senderRole: 'planner',
        type: 'agent_message',
        content: `已分析任务「${task.title}」，制定执行计划如下：\n1. 需求分析\n2. 方案设计\n3. 编码实现\n4. 测试验证`,
        metadata: { taskId, event: 'task_planned' },
    })
    addWorkflowEvent(sessionId, taskId, 'task_planned', 'planner', 'planner')
    updateTaskStatus(taskId, 'assigned')
    await delay(300)

    // Step 3: Developer starts
    addMessage({
        sessionId,
        senderId: 'developer',
        senderName: '开发 Agent',
        senderRole: 'developer',
        type: 'agent_message',
        content: '已接收任务，开始执行开发工作...',
        metadata: { taskId, event: 'task_assigned' },
    })
    addWorkflowEvent(sessionId, taskId, 'task_assigned', 'developer', 'developer')
    updateTaskStatus(taskId, 'in_progress')
    await delay(500)

    // Step 4: Developer submits for review
    addMessage({
        sessionId,
        senderId: 'developer',
        senderName: '开发 Agent',
        senderRole: 'developer',
        type: 'agent_message',
        content: '开发完成，提交审核。',
        metadata: { taskId, event: 'task_submitted' },
    })
    addWorkflowEvent(sessionId, taskId, 'task_started', 'developer', 'developer')
    updateTaskStatus(taskId, 'submitted_for_review')
    addWorkflowEvent(sessionId, taskId, 'task_submitted', 'developer', 'developer')
    await delay(300)

    // Step 5: Reviewer reviews
    addMessage({
        sessionId,
        senderId: 'reviewer',
        senderName: '审核 Agent',
        senderRole: 'reviewer',
        type: 'agent_message',
        content: `正在审核任务「${task.title}」的实现...`,
        metadata: { taskId },
    })
}

// ─── Retry / Deliver ───────────────────────────────────────────
export function retryTask(taskId: string): AgentRoomTask | null {
    const task = tasks.get(taskId)
    if (!task) return null

    // Validate: only retryable statuses can be retried
    const retryableStatuses: AgentRoomTaskStatus[] = [
        'review_rejected', 'revision_required', 'need_user_decision', 'failed',
    ]
    if (!retryableStatuses.includes(task.status)) {
        throw new Error(`Cannot retry task in status "${task.status}". Expected one of: ${retryableStatuses.join(', ')}`)
    }

    // Use state machine to transition to in_progress
    return updateTaskStatus(taskId, 'in_progress')
}

export function deliverTask(sessionId: string, taskId: string): AgentRoomTask | null {
    const task = tasks.get(taskId)
    if (!task) return null

    // Transition to delivering via state machine
    let result = updateTaskStatus(taskId, 'delivering')

    // Add delivery message
    addMessage({
        sessionId,
        senderId: 'delivery',
        senderName: '交付 Agent',
        senderRole: 'delivery',
        type: 'final_delivery',
        content: `任务「${task.title}」已完成交付。`,
        metadata: { taskId, event: 'delivery_completed' },
    })
    addWorkflowEvent(sessionId, taskId, 'delivery_started', 'delivery', 'delivery')

    // Complete via state machine
    result = updateTaskStatus(taskId, 'completed')
    addWorkflowEvent(sessionId, taskId, 'delivery_completed', 'delivery', 'delivery')

    return result
}
