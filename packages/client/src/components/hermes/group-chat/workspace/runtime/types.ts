// ─── Workspace Types ─────────────────────────────────────────
// Types for the pixel-style workspace visualization mode.

export type AgentWorkStatus = 'idle' | 'compressing' | 'replying' | 'thinking'

export interface AgentWorkspaceState {
    agentId: string
    agentName: string
    profile: string
    status: AgentWorkStatus
    seatIndex: number
    zone: string
    lastEventAt: number
}

export interface WorkspaceEvent {
    id: string
    type: 'message' | 'typing' | 'context_status' | 'member_joined' | 'member_left' | 'room_updated'
    agentName?: string
    senderName?: string
    content?: string
    status?: string
    timestamp: number
}

export interface AgentSeat {
    zone: string
    x: number
    y: number
    label: string
}

/** Default office layout — 4 zones with 2 seats each */
export const DEFAULT_SEATS: AgentSeat[] = [
    // 需求区 (Requirement Zone) — top-left
    { zone: 'requirement', x: 160, y: 130, label: '需求区' },
    { zone: 'requirement', x: 160, y: 230, label: '需求区' },
    // 开发区 (Development Zone) — top-right
    { zone: 'coding', x: 440, y: 130, label: '开发区' },
    { zone: 'coding', x: 440, y: 230, label: '开发区' },
    // 评审区 (Review Zone) — bottom-left
    { zone: 'review', x: 160, y: 370, label: '评审区' },
    { zone: 'review', x: 160, y: 470, label: '评审区' },
    // 产出区 (Delivery Zone) — bottom-right
    { zone: 'delivery', x: 440, y: 370, label: '产出区' },
    { zone: 'delivery', x: 440, y: 470, label: '产出区' },
]

/** Zone color palette (pixel-art friendly) */
export const ZONE_COLORS: Record<string, { bg: number; border: number; label: string }> = {
    requirement: { bg: 0x1a2744, border: 0x3b82f6, label: '📋 需求区' },
    coding:      { bg: 0x1a3320, border: 0x22c55e, label: '💻 开发区' },
    review:      { bg: 0x332a1a, border: 0xf59e0b, label: '🔍 评审区' },
    delivery:    { bg: 0x2a1a33, border: 0xa855f7, label: '📦 产出区' },
}

/** Agent status → visual mapping */
export const STATUS_VISUALS: Record<AgentWorkStatus, { color: number; label: string; emoji: string }> = {
    idle:        { color: 0x6b7280, label: '空闲',   emoji: '💤' },
    compressing: { color: 0xf59e0b, label: '压缩中', emoji: '⚙️' },
    replying:    { color: 0x3b82f6, label: '回复中', emoji: '✍️' },
    thinking:    { color: 0xa855f7, label: '思考中', emoji: '🤔' },
}
