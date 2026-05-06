// ─── Agent Room API Types & Client ─────────────────────────────
// Independent from group-chat. v1 fixed five agents + workflow state machine.

// ─── Task Status ───────────────────────────────────────────────
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

// ─── Agent Roles ───────────────────────────────────────────────
export type AgentRoomRole = 'conversation' | 'planner' | 'developer' | 'reviewer' | 'delivery'

export interface AgentRoomAgent {
    id: string
    name: string
    role: AgentRoomRole
    description: string
    avatar?: string
}

// ─── Task Entity ───────────────────────────────────────────────
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

// ─── Review Entity ─────────────────────────────────────────────
export interface AgentRoomReview {
    id: string
    taskId: string
    reviewerAgentId: string
    status: 'passed' | 'rejected'
    comment: string
    createdAt: string
}

// ─── Message Entity (display only) ─────────────────────────────
export type AgentRoomMessageType =
    | 'user_message'
    | 'agent_message'
    | 'task_event'
    | 'review_result'
    | 'final_delivery'
    | 'error'

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

// ─── Workflow Event ────────────────────────────────────────────
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

// ─── Session Entity ────────────────────────────────────────────
export interface AgentRoomSession {
    id: string
    name: string
    createdAt: string
    updatedAt: string
}

// ─── Fixed Agents (v1) ────────────────────────────────────────
export const AGENT_ROOM_AGENTS: AgentRoomAgent[] = [
    {
        id: 'conversation',
        name: '会话 Agent',
        role: 'conversation',
        description: '负责接收用户输入与协调任务流程',
    },
    {
        id: 'planner',
        name: '规划 Agent',
        role: 'planner',
        description: '负责拆解任务与制定执行计划',
    },
    {
        id: 'developer',
        name: '开发 Agent',
        role: 'developer',
        description: '负责执行具体任务',
    },
    {
        id: 'reviewer',
        name: '审核 Agent',
        role: 'reviewer',
        description: '负责审核、通过或打回修改',
    },
    {
        id: 'delivery',
        name: '交付 Agent',
        role: 'delivery',
        description: '负责最终汇报与结果交付',
    },
]

// ─── API Client ────────────────────────────────────────────────
const BASE = '/api/agent-room'

async function request<T>(url: string, init?: RequestInit): Promise<T> {
    const res = await fetch(url, init)
    if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || `Agent Room API error: ${res.status}`)
    }
    return res.json()
}

export async function createSession(name: string): Promise<AgentRoomSession> {
    return request(`${BASE}/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
    })
}

export async function getSession(sessionId: string): Promise<AgentRoomSession> {
    return request(`${BASE}/sessions/${sessionId}`)
}

export async function listSessions(): Promise<AgentRoomSession[]> {
    return request(`${BASE}/sessions`)
}

export async function listMessages(sessionId: string): Promise<AgentRoomMessage[]> {
    return request(`${BASE}/sessions/${sessionId}/messages`)
}

export async function sendMessage(sessionId: string, content: string): Promise<AgentRoomMessage> {
    return request(`${BASE}/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
    })
}

export async function listTasks(sessionId: string): Promise<AgentRoomTask[]> {
    return request(`${BASE}/sessions/${sessionId}/tasks`)
}

export async function createTask(sessionId: string, data: {
    title: string
    description?: string
    assignedAgentId?: string
}): Promise<AgentRoomTask> {
    return request(`${BASE}/sessions/${sessionId}/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
    })
}

export async function updateTaskStatus(sessionId: string, taskId: string, status: AgentRoomTaskStatus): Promise<AgentRoomTask> {
    return request(`${BASE}/sessions/${sessionId}/tasks/${taskId}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
    })
}

export async function submitReview(sessionId: string, taskId: string, data: {
    reviewerAgentId: string
    status: 'passed' | 'rejected'
    comment?: string
}): Promise<AgentRoomReview> {
    return request(`${BASE}/sessions/${sessionId}/tasks/${taskId}/review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
    })
}

export async function retryTask(sessionId: string, taskId: string): Promise<AgentRoomTask> {
    return request(`${BASE}/sessions/${sessionId}/tasks/${taskId}/retry`, {
        method: 'POST',
    })
}

export async function deliverTask(sessionId: string, taskId: string): Promise<AgentRoomTask> {
    return request(`${BASE}/sessions/${sessionId}/tasks/${taskId}/deliver`, {
        method: 'POST',
    })
}

export async function listWorkflowEvents(sessionId: string): Promise<AgentRoomWorkflowEvent[]> {
    return request(`${BASE}/sessions/${sessionId}/events`)
}

export async function runWorkflow(sessionId: string, taskId: string): Promise<{ success: boolean }> {
    return request(`${BASE}/sessions/${sessionId}/tasks/${taskId}/workflow`, {
        method: 'POST',
    })
}
