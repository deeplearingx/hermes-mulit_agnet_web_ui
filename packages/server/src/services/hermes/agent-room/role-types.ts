// ─── Agent Room Role Types ──────────────────────────────────────
// Lightweight shared type for AgentRoom roles.
// Used by service layer, resolver, and runtime to avoid circular imports.

export type AgentRoomRole = 'conversation' | 'planner' | 'developer' | 'reviewer' | 'delivery'
