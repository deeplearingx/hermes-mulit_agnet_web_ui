import { io } from 'socket.io-client'
import { request, getApiKey } from '../client'

// ─── Types ──────────────────────────────────────────────────

export interface RoomInfo {
    id: string
    name: string
    inviteCode: string | null
    triggerTokens?: number
    maxHistoryTokens?: number
    tailMessageCount?: number
    totalTokens?: number
}

export interface RoomAgent {
    id: string
    roomId: string
    agentId: string
    profile: string
    name: string
    description: string
    invited: number
    roleType?: string
}

export interface ChatMessage {
    id: string
    roomId: string
    senderId: string
    senderName: string
    content: string
    timestamp: number
}

export interface MemberInfo {
    id: string
    userId: string
    name: string
    description: string
    joinedAt: number
}

export interface JoinResult {
    roomId: string
    roomName: string
    members: MemberInfo[]
    messages: ChatMessage[]
    rooms: string[]
}

// ─── Socket.IO Client ──────────────────────────────────────

let socket: ReturnType<typeof io> | null = null

export function connectGroupChat(opts?: { userId?: string; userName?: string; description?: string }): ReturnType<typeof io> {
    if (socket?.connected) return socket

    const token = getApiKey()
    const userId = opts?.userId || localStorage.getItem('gc_user_id') || generateUUID()
    localStorage.setItem('gc_user_id', userId)

    socket = io('/group-chat', {
        auth: {
            token: token || undefined,
            userId,
            name: opts?.userName || localStorage.getItem('gc_user_name') || undefined,
            description: opts?.description || localStorage.getItem('gc_user_description') || undefined,
        },
        transports: ['websocket'],
        reconnection: true,
        reconnectionAttempts: Infinity,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 30000,
    })

    return socket
}

export function getStoredUserId(): string {
    let id = localStorage.getItem('gc_user_id')
    if (!id) {
        id = generateUUID()
        localStorage.setItem('gc_user_id', id)
    }
    return id
}

export function getStoredUserName(): string | null {
    return localStorage.getItem('gc_user_name')
}

function generateUUID(): string {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = Math.random() * 16 | 0
        const v = c === 'x' ? r : (r & 0x3 | 0x8)
        return v.toString(16)
    })
}

export function getSocket(): ReturnType<typeof io> | null {
    return socket?.connected ? socket : null
}

export function disconnectGroupChat(): void {
    if (socket) {
        socket.disconnect()
        socket = null
    }
}

// ─── REST API ───────────────────────────────────────────────

export async function createRoom(data: {
    name: string
    inviteCode: string
    agents?: { profile: string; name?: string; description?: string; invited?: boolean }[]
    compression?: { triggerTokens?: number; maxHistoryTokens?: number; tailMessageCount?: number }
}): Promise<{ room: RoomInfo; agents: RoomAgent[] }> {
    return request('/api/hermes/group-chat/rooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
    })
}

export async function listRooms(): Promise<{ rooms: RoomInfo[] }> {
    return request('/api/hermes/group-chat/rooms')
}

export async function getRoomDetail(roomId: string): Promise<{ room: RoomInfo; messages: ChatMessage[]; agents: RoomAgent[]; members: MemberInfo[] }> {
    return request(`/api/hermes/group-chat/rooms/${roomId}`)
}

export async function joinRoomByCode(code: string): Promise<{ room: RoomInfo }> {
    return request(`/api/hermes/group-chat/rooms/join/${code}`)
}

export async function updateInviteCode(roomId: string, inviteCode: string): Promise<void> {
    return request(`/api/hermes/group-chat/rooms/${roomId}/invite-code`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ inviteCode }),
    })
}

export async function addAgent(roomId: string, data: {
    profile: string
    name?: string
    description?: string
    invited?: boolean
    roleType?: string
}): Promise<{ agent: RoomAgent }> {
    return request(`/api/hermes/group-chat/rooms/${roomId}/agents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
    })
}

export async function listAgents(roomId: string): Promise<{ agents: RoomAgent[] }> {
    return request(`/api/hermes/group-chat/rooms/${roomId}/agents`)
}

export async function removeAgent(roomId: string, agentId: string): Promise<void> {
    return request(`/api/hermes/group-chat/rooms/${roomId}/agents/${agentId}`, {
        method: 'DELETE',
    })
}

export async function deleteRoom(roomId: string): Promise<void> {
    return request(`/api/hermes/group-chat/rooms/${roomId}`, {
        method: 'DELETE',
    })
}

export async function updateRoomConfig(roomId: string, config: { triggerTokens?: number; maxHistoryTokens?: number; tailMessageCount?: number }): Promise<{ room: RoomInfo }> {
    return request(`/api/hermes/group-chat/rooms/${roomId}/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
    })
}

export async function forceCompress(roomId: string): Promise<{ success: boolean; summary: string }> {
    return request(`/api/hermes/group-chat/rooms/${roomId}/compress`, {
        method: 'POST',
    })
}

// ─── Agent Override ─────────────────────────────────────

export interface AgentOverride {
    model?: string
    provider?: string
    skillsAllowList?: string[]
    systemPrompt?: string
    contextEnabled?: boolean
    triggerTokens?: number
    maxHistoryTokens?: number
    tailMessageCount?: number
}

export async function getAgentOverride(roomId: string, agentId: string): Promise<AgentOverride> {
    const res = await request<{ override: AgentOverride | null }>(`/api/hermes/group-chat/rooms/${roomId}/agents/${agentId}/override`)
    return res.override ?? {}
}

export async function putAgentOverride(roomId: string, agentId: string, override: AgentOverride): Promise<AgentOverride> {
    const res = await request<{ override: AgentOverride }>(`/api/hermes/group-chat/rooms/${roomId}/agents/${agentId}/override`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(override),
    })
    return res.override
}

// ─── Workspace API ──────────────────────────────────────────

export interface WorkspaceLayoutItem {
    agentId: string
    x: number
    y: number
    zone: string
    pinned?: boolean  // P9-3: 用户固定位置
}

export interface GroupTask {
    id: string
    roomId: string
    title: string
    description: string
    status: 'draft' | 'planning' | 'running' | 'reviewing' | 'done' | 'failed'
    phase: 'requirement' | 'planning' | 'coding' | 'review' | 'delivery'
    assigneeAgentId: string | null
    createdAt: number
    updatedAt: number
}

export interface GroupArtifact {
    id: string
    roomId: string
    taskId: string | null
    agentId: string | null
    name: string
    type: string
    path: string | null
    contentPreview: string | null
    createdAt: number
}

export interface WorkspaceState {
    layout: WorkspaceLayoutItem[]
    tasks: GroupTask[]
    artifacts: GroupArtifact[]
}

export async function getWorkspaceState(roomId: string): Promise<WorkspaceState> {
    return request(`/api/hermes/group-chat/rooms/${roomId}/workspace`)
}

export async function updateWorkspaceLayout(roomId: string, layout: WorkspaceLayoutItem[]): Promise<void> {
    await request(`/api/hermes/group-chat/rooms/${roomId}/workspace/layout`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ layout }),
    })
}

export async function createGroupTask(roomId: string, data: {
    title: string
    description?: string
    assigneeAgentId?: string
    phase?: string
}): Promise<{ task: GroupTask }> {
    return request(`/api/hermes/group-chat/rooms/${roomId}/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
    })
}

export async function updateGroupTask(roomId: string, taskId: string, patch: {
    title?: string
    description?: string
    status?: string
    phase?: string
    assigneeAgentId?: string
}): Promise<{ task: GroupTask }> {
    return request(`/api/hermes/group-chat/rooms/${roomId}/tasks/${taskId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
    })
}

// Phase 12: Task dispatch API
export async function dispatchGroupTask(roomId: string, taskId: string, data: {
    action: string
    assigneeAgentId?: string
}): Promise<{ success: boolean; task: GroupTask; dispatch: { taskId: string; agentId: string; action: string } | null }> {
    return request(`/api/hermes/group-chat/rooms/${roomId}/tasks/${taskId}/dispatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
    })
}

export async function createGroupArtifact(roomId: string, data: {
    name: string
    type: string
    taskId?: string
    agentId?: string
    path?: string
    contentPreview?: string
}): Promise<{ artifact: GroupArtifact }> {
    return request(`/api/hermes/group-chat/rooms/${roomId}/artifacts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
    })
}

export async function getGroupArtifact(roomId: string, artifactId: string): Promise<{ artifact: GroupArtifact }> {
    return request(`/api/hermes/group-chat/rooms/${roomId}/artifacts/${artifactId}`)
}

export async function updateGroupArtifact(roomId: string, artifactId: string, patch: {
    name?: string
    type?: string
    path?: string
    contentPreview?: string
}): Promise<{ artifact: GroupArtifact }> {
    return request(`/api/hermes/group-chat/rooms/${roomId}/artifacts/${artifactId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
    })
}

export async function deleteGroupArtifact(roomId: string, artifactId: string): Promise<void> {
    await request(`/api/hermes/group-chat/rooms/${roomId}/artifacts/${artifactId}`, {
        method: 'DELETE',
    })
}
