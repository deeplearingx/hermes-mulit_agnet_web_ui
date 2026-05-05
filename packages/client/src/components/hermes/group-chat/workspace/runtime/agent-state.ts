// ─── Agent State Derivation ──────────────────────────────────
// Derives workspace agent states from existing Pinia store data.
// P7-2: Added role inference. P7-3: Task-driven seat assignment.
// P8-1: Added getActiveTask / getDisplayTask.
// P10-3: Per-agent task binding with source tracking (no global fallback).
// P10-7: Seat overflow clamped to zone bounds.
// P10-9: Decomposed into 4-layer helper functions.

import type { RoomAgent, WorkspaceLayoutItem, GroupTask, GroupArtifact } from '@/api/hermes/group-chat'
import type { AgentWorkspaceState, AgentWorkStatus, AgentRoleType } from './types'
import { DEFAULT_SEATS, ROLE_DEFAULT_ZONE } from './types'
import { ZONE_RECTS } from './map-config'

// ─── P10-8: Timestamp Normalization ─────────────────────────

/** P10-8: Normalize timestamp from various formats to epoch ms */
function normalizeTimestamp(value: unknown): number {
    if (typeof value === 'number') return value
    if (typeof value === 'string') return new Date(value).getTime()
    return 0
}

// ─── Global Task Helpers (exported, used by other modules) ──

/**
 * Canvas-driven: only return truly active tasks (planning/running/reviewing).
 * Used by PhaserWorkspace, zone highlighting, agent movement.
 */
export function getActiveTask(tasks: GroupTask[]): GroupTask | null {
    return tasks.find(t => ['planning', 'running', 'reviewing'].includes(t.status)) ?? null
}

/**
 * Display-driven: active task > any non-done task > first task.
 * Used by right-side main task card so users always see "something".
 */
export function getDisplayTask(tasks: GroupTask[]): GroupTask | null {
    return getActiveTask(tasks)
        ?? tasks.find(t => t.status !== 'done')
        ?? tasks[0] ?? null
}

// ─── Event / Role Utilities ─────────────────────────────────

/** Map runtime event type to visual agent status */
export function runtimeEventToStatus(eventType: string): AgentWorkStatus | null {
    const map: Record<string, AgentWorkStatus> = {
        run_started: 'replying',
        context_compressing: 'compressing',
        replying: 'replying',
        tool_call: 'calling_tool',
        run_completed: 'completed',
        run_failed: 'failed',
    }
    return map[eventType] ?? null
}

/**
 * Infer agent role with three-layer fallback (P8-5):
 * 1. Explicit roleType from database
 * 2. Keyword inference from name/profile/description
 * 3. Default 'observer'
 */
export function inferAgentRole(agent: RoomAgent): AgentRoleType {
    // Layer 1: Explicit configuration
    if (agent.roleType) return agent.roleType as AgentRoleType
    // Layer 2: Keyword inference
    return inferRoleByText(agent.name, agent.profile, agent.description)
}

function inferRoleByText(name: string, profile: string, description?: string): AgentRoleType {
    const text = `${name} ${profile} ${description || ''}`.toLowerCase()
    if (text.includes('架构') || text.includes('planner') || text.includes('architect')) return 'planner'
    if (text.includes('开发') || text.includes('engineer') || text.includes('coder')) return 'developer'
    if (text.includes('测试') || text.includes('tester') || text.includes('qa')) return 'tester'
    if (text.includes('评审') || text.includes('review')) return 'reviewer'
    if (text.includes('交付') || text.includes('release') || text.includes('doc')) return 'delivery'
    return 'observer'
}

// ─── P10-3: Per-Agent Task Binding ───────────────────────────

export interface AgentTaskBinding {
    task: GroupTask
    source: 'event' | 'assignee'
    isOwner: boolean
}

/**
 * P10-3: Per-agent task binding with explicit source tracking.
 * Priority:
 *   1. Agent's most recent liveEvent that has a taskId → source: 'event'
 *   2. assigneeAgentId === agentId 的 running/reviewing/planning/draft → source: 'assignee'
 *   3. No fallback — agents without explicit task association return null
 */
export function deriveAgentTaskBinding(
    agent: RoomAgent,
    tasks: GroupTask[],
    agentEvents: Array<{ agentId: string; type: string; payload: Record<string, any>; timestamp: number }> = [],
): AgentTaskBinding | null {
    // 1. 从 agentEvents 找最近事件关联的 taskId
    const sortedEvents = agentEvents
        .filter(e => e.agentId === agent.agentId)
        .sort((a, b) => b.timestamp - a.timestamp)

    for (const evt of sortedEvents) {
        const taskId = evt.payload?.taskId
        if (!taskId) continue
        const task = tasks.find(t =>
            t.id === taskId && !['done', 'failed'].includes(t.status),
        )
        if (task) {
            return {
                task,
                source: 'event',
                isOwner: task.assigneeAgentId === agent.agentId,
            }
        }
    }

    // 2. assigneeAgentId 匹配的活跃任务
    const assigned = tasks.find(t =>
        t.assigneeAgentId === agent.agentId &&
        ['running', 'reviewing', 'planning', 'draft'].includes(t.status),
    )
    if (assigned) {
        return { task: assigned, source: 'assignee', isOwner: true }
    }

    // 3. 无 fallback — 没有任务的 Agent 不绑定
    return null
}

// ─── P10-9: Position Derivation ──────────────────────────────

interface AgentPositionInput {
    agent: RoomAgent
    roleType: AgentRoleType
    binding: AgentTaskBinding | null
    layout: WorkspaceLayoutItem | undefined
    index: number
    occupiedCoords: Set<string>
}

function deriveAgentPosition(input: AgentPositionInput): {
    zone: string; x?: number; y?: number; pinned: boolean
} {
    const { roleType, binding, layout, index, occupiedCoords } = input

    // P9-3 优先级：pinned → task owner → layout → role default
    if (layout?.pinned) {
        const { x, y, zone } = layout
        if (x != null && y != null) occupiedCoords.add(`${x},${y}`)
        return { zone, x, y, pinned: true }
    }

    if (binding?.isOwner && binding.task) {
        const zone = binding.task.phase
        const seat = findZoneSeat(zone, occupiedCoords, index)
        return { zone, x: seat.x, y: seat.y, pinned: false }
    }

    if (layout) {
        const { x, y, zone } = layout
        if (x != null && y != null) occupiedCoords.add(`${x},${y}`)
        return { zone, x, y, pinned: false }
    }

    const zone = ROLE_DEFAULT_ZONE[roleType]
    const seat = findZoneSeat(zone, occupiedCoords, index)
    return { zone, x: seat.x, y: seat.y, pinned: false }
}

// ─── P10-9: Activity Derivation ──────────────────────────────

function deriveAgentActivity(
    _agentId: string,
    status: AgentWorkStatus,
    agentEvents: Array<{ agentId: string; type: string; payload: Record<string, any>; timestamp: number }>,
    agentArtifacts: GroupArtifact[],
): {
    lastEventType?: string
    lastEventPayload?: string
    activeToolName?: string
    lastArtifactName?: string
    lastEventAt: number
} {
    const lastEvent = agentEvents[0]
    return {
        lastEventType: lastEvent?.type,
        lastEventPayload: lastEvent?.payload?.toolName || lastEvent?.payload?.model || undefined,
        activeToolName: status === 'calling_tool'
            ? agentEvents.find(e => e.type === 'tool_call')?.payload?.toolName
            : undefined,
        lastArtifactName: agentArtifacts[0]?.name,
        lastEventAt: normalizeTimestamp(lastEvent?.timestamp),
    }
}

// ─── P10-9: Runtime Status Derivation ────────────────────────

function deriveAgentRuntimeStatus(
    agent: RoomAgent,
    contextStatuses: Map<string, { agentId: string; agentName: string; status: string }>,
): AgentWorkStatus {
    const statusEntry = contextStatuses.get(agent.agentId) ?? contextStatuses.get(agent.name)
    if (statusEntry?.status === 'compressing') return 'compressing'
    if (statusEntry?.status === 'replying') return 'replying'
    if (statusEntry?.status === 'calling_tool') return 'calling_tool'
    if (statusEntry?.status === 'completed') return 'completed'
    if (statusEntry?.status === 'failed') return 'failed'
    return 'idle'
}

// ─── Seat Assignment ─────────────────────────────────────────

/**
 * Find an available seat in the given zone, using index as tiebreaker (P7-3).
 * Returns the first seat in the zone whose position hasn't been taken yet.
 * P10-7: Overflow is clamped within zone bounds.
 */
export function findZoneSeat(
    zone: string,
    occupiedCoords: Set<string>,
    fallbackIndex: number,
): { x: number; y: number } {
    const zoneSeats = DEFAULT_SEATS.filter(s => s.zone === zone)
    for (const seat of zoneSeats) {
        const key = `${seat.x},${seat.y}`
        if (!occupiedCoords.has(key)) {
            occupiedCoords.add(key)
            return { x: seat.x, y: seat.y }
        }
    }
    // P10-7: 动态溢出，限制在 zone 边界内
    const rect = ZONE_RECTS.find(z => z.key === zone)
    const base = zoneSeats[fallbackIndex % zoneSeats.length] ?? DEFAULT_SEATS[0]

    if (!rect) return { x: base.x, y: base.y }

    const row = Math.floor(fallbackIndex / zoneSeats.length)
    const x = Math.min(base.x + row * 18, rect.x + rect.w - 24)
    const y = Math.min(base.y + row * 14, rect.y + rect.h - 24)

    const key = `${x},${y}`
    occupiedCoords.add(key)
    return { x, y }
}

// ─── Main Entry Point ────────────────────────────────────────

/**
 * Derive workspace states from store.agents + store.contextStatuses + workspaceLayout + tasks.
 * P10-3: Per-agent task binding (no global activeTask fallback).
 * P10-9: Decomposed into 4-layer helper functions.
 */
export function deriveAgentStates(
    agents: RoomAgent[],
    contextStatuses: Map<string, { agentId: string; agentName: string; status: string }>,
    workspaceLayout?: WorkspaceLayoutItem[],
    tasks?: GroupTask[],
    liveEvents?: Array<{ agentId: string; type: string; payload: Record<string, any>; timestamp: number }>,
    artifacts?: GroupArtifact[],
): AgentWorkspaceState[] {
    const occupiedCoords = new Set<string>()

    return agents.map((agent, index) => {
        const roleType = inferAgentRole(agent)
        const status = deriveAgentRuntimeStatus(agent, contextStatuses)

        // P10-3: Per-agent task binding (no global activeTask fallback)
        const agentEvents = liveEvents?.filter(e => e.agentId === agent.agentId) ?? []
        const binding = deriveAgentTaskBinding(agent, tasks ?? [], agentEvents)

        // P10-9: Position derivation
        const layout = workspaceLayout?.find(l => l.agentId === agent.agentId)
        const position = deriveAgentPosition({
            agent, roleType, binding, layout, index, occupiedCoords,
        })

        // P10-9: Activity derivation
        const agentArtifacts = artifacts?.filter(a => a.agentId === agent.agentId) ?? []
        const activity = deriveAgentActivity(agent.agentId, status, agentEvents, agentArtifacts)

        return {
            agentId: agent.agentId,
            agentName: agent.name,
            profile: agent.profile,
            seatIndex: index,
            ...position,
            ...activity,
            roleType,
            status,
            currentTaskId: binding?.task.id,
            currentTaskTitle: binding?.task.title,
            phase: binding?.task.phase,
            isTaskOwner: binding?.isOwner ?? false,
        }
    })
}

// ─── Color Utility ───────────────────────────────────────────

/**
 * Generate a deterministic color for an agent based on their name.
 * Used for avatar circles and sprite tinting.
 */
export function agentColor(name: string): number {
    let hash = 0
    for (let i = 0; i < name.length; i++) {
        hash = name.charCodeAt(i) + ((hash << 5) - hash)
    }
    const hue = Math.abs(hash) % 360
    // Convert HSL to hex (high saturation, medium lightness for pixel art)
    const c = 0.7
    const x = c * (1 - Math.abs(((hue / 60) % 2) - 1))
    const m = 0.3
    let r = 0, g = 0, b = 0
    if (hue < 60)       { r = c; g = x; b = 0 }
    else if (hue < 120) { r = x; g = c; b = 0 }
    else if (hue < 180) { r = 0; g = c; b = x }
    else if (hue < 240) { r = 0; g = x; b = c }
    else if (hue < 300) { r = x; g = 0; b = c }
    else                { r = c; g = 0; b = x }
    const ri = Math.round((r + m) * 255)
    const gi = Math.round((g + m) * 255)
    const bi = Math.round((b + m) * 255)
    return (ri << 16) | (gi << 8) | bi
}
