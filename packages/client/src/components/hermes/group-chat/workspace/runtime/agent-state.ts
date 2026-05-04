// ─── Agent State Derivation ──────────────────────────────────
// Derives workspace agent states from existing Pinia store data.

import type { RoomAgent } from '@/api/hermes/group-chat'
import type { AgentWorkspaceState, AgentWorkStatus } from './types'
import { DEFAULT_SEATS } from './types'

/**
 * Derive workspace states from store.agents + store.contextStatuses.
 * Maps each agent to a seat and derives work status from context_status events.
 */
export function deriveAgentStates(
    agents: RoomAgent[],
    contextStatuses: Map<string, { agentName: string; status: string }>,
): AgentWorkspaceState[] {
    return agents.map((agent, index) => {
        const statusEntry = contextStatuses.get(agent.name)
        let status: AgentWorkStatus = 'idle'
        if (statusEntry?.status === 'compressing') status = 'compressing'
        else if (statusEntry?.status === 'replying') status = 'replying'

        const seat = DEFAULT_SEATS[index % DEFAULT_SEATS.length]

        return {
            agentId: agent.agentId,
            agentName: agent.name,
            profile: agent.profile,
            status,
            seatIndex: index,
            zone: seat.zone,
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
