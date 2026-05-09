// ─── Agent Room Role Types ──────────────────────────────────────
// Lightweight shared type for AgentRoom roles.
// Used by service layer, resolver, and runtime to avoid circular imports.

export type AgentRoomRole = 'conversation' | 'planner' | 'developer' | 'reviewer' | 'delivery'

/** All valid AgentRoom roles. */
export const AGENT_ROOM_ROLES: readonly AgentRoomRole[] = [
    'conversation', 'planner', 'developer', 'reviewer', 'delivery',
]

/** Type guard: returns true if the string is a valid AgentRoomRole. */
export function isAgentRoomRole(role: string): role is AgentRoomRole {
    return (AGENT_ROOM_ROLES as readonly string[]).includes(role)
}

/** Assert that the string is a valid AgentRoomRole, throwing if not. */
export function assertAgentRoomRole(role: string): AgentRoomRole {
    if (!isAgentRoomRole(role)) {
        throw new Error(`Invalid role '${role}'. Must be one of: ${AGENT_ROOM_ROLES.join(', ')}`)
    }
    return role
}
