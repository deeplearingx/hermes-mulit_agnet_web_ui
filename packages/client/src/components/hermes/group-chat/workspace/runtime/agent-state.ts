// ─── Agent State Derivation ──────────────────────────────────
// Derives workspace agent states from existing Pinia store data.
// P7-2: Added role inference. P7-3: Task-driven seat assignment.

import type { RoomAgent, WorkspaceLayoutItem, GroupTask } from '@/api/hermes/group-chat'
import type { AgentWorkspaceState, AgentWorkStatus, AgentRoleType } from './types'
import { DEFAULT_SEATS, ROLE_DEFAULT_ZONE } from './types'

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
 * Infer agent role from name/profile/description keywords (P7-2).
 */
export function inferAgentRole(agent: RoomAgent): AgentRoleType {
    const text = `${agent.name} ${agent.profile} ${agent.description || ''}`.toLowerCase()
    if (text.includes('架构') || text.includes('planner') || text.includes('architect')) return 'planner'
    if (text.includes('开发') || text.includes('engineer') || text.includes('coder')) return 'developer'
    if (text.includes('评审') || text.includes('review')) return 'reviewer'
    if (text.includes('交付') || text.includes('release') || text.includes('doc')) return 'delivery'
    return 'observer'
}

/**
 * Find an available seat in the given zone, using index as tiebreaker (P7-3).
 * Returns the first seat in the zone whose position hasn't been taken yet.
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
    // All seats occupied — use fallback modulo
    const fallback = zoneSeats[fallbackIndex % zoneSeats.length] ?? DEFAULT_SEATS[0]
    return { x: fallback.x, y: fallback.y }
}

/**
 * Derive workspace states from store.agents + store.contextStatuses + workspaceLayout + tasks.
 * Maps each agent to a seat and derives work status from context_status events.
 * When workspaceLayout is provided, uses saved x/y coordinates instead of defaults.
 * P7-3: When tasks are provided, assigns agents to zones based on role and task ownership.
 */
export function deriveAgentStates(
    agents: RoomAgent[],
    contextStatuses: Map<string, { agentId: string; agentName: string; status: string }>,
    workspaceLayout?: WorkspaceLayoutItem[],
    tasks?: GroupTask[],
): AgentWorkspaceState[] {
    // Find active task: running > reviewing > first
    const activeTask = tasks?.find(t => t.status === 'running')
        ?? tasks?.find(t => t.status === 'reviewing')
        ?? tasks?.[0]

    // Track occupied coordinates to avoid stacking
    const occupiedCoords = new Set<string>()

    return agents.map((agent, index) => {
        // P0-2: use agentId as primary lookup key, fallback to agent.name
        const statusEntry = contextStatuses.get(agent.agentId) ?? contextStatuses.get(agent.name)
        let status: AgentWorkStatus = 'idle'
        if (statusEntry?.status === 'compressing') status = 'compressing'
        else if (statusEntry?.status === 'replying') status = 'replying'
        else if (statusEntry?.status === 'calling_tool') status = 'calling_tool'
        else if (statusEntry?.status === 'completed') status = 'completed'
        else if (statusEntry?.status === 'failed') status = 'failed'

        // P7-2: infer role
        const roleType = inferAgentRole(agent)
        const isTaskOwner = activeTask?.assigneeAgentId === agent.agentId

        // P7-3: zone/seat assignment with priority:
        //   1. User-dragged layout (workspaceLayout)
        //   2. Task owner → move to task's phase zone
        //   3. Role default zone
        const layout = workspaceLayout?.find(l => l.agentId === agent.agentId)
        let zone: string
        let x: number | undefined
        let y: number | undefined

        if (layout) {
            zone = layout.zone
            x = layout.x
            y = layout.y
            // Mark layout coords as occupied
            if (x != null && y != null) occupiedCoords.add(`${x},${y}`)
        } else if (isTaskOwner && activeTask) {
            zone = activeTask.phase
            const seat = findZoneSeat(zone, occupiedCoords, index)
            x = seat.x
            y = seat.y
        } else {
            zone = ROLE_DEFAULT_ZONE[roleType]
            const seat = findZoneSeat(zone, occupiedCoords, index)
            x = seat.x
            y = seat.y
        }

        return {
            agentId: agent.agentId,
            agentName: agent.name,
            profile: agent.profile,
            status,
            seatIndex: index,
            zone,
            roleType,
            currentTaskId: isTaskOwner ? activeTask?.id : undefined,
            currentTaskTitle: isTaskOwner ? activeTask?.title : undefined,
            phase: isTaskOwner ? activeTask?.phase : undefined,
            isTaskOwner,
            x,
            y,
            lastEventAt: Date.now(),
        }
    })
}

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
