// ─── Workspace Types ─────────────────────────────────────────
// Types for the pixel-style workspace visualization mode.

export type AgentWorkStatus = 'idle' | 'compressing' | 'replying' | 'thinking'
    | 'calling_tool' | 'completed' | 'failed'

export interface AgentWorkspaceState {
    agentId: string
    agentName: string
    profile: string
    status: AgentWorkStatus
    seatIndex: number
    zone: string
    x?: number   // 从 workspaceLayout 恢复的坐标
    y?: number
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

/** Default office layout — 5 zones with 2 seats each (V4: 960×540 canvas) */
export const DEFAULT_SEATS: AgentSeat[] = [
    // 需求区 (Requirement Zone) — top-left
    { zone: 'requirement', x: 140, y: 140, label: '需求区' },
    { zone: 'requirement', x: 140, y: 260, label: '需求区' },
    // 规划区 (Planning Zone) — top-center
    { zone: 'planning', x: 380, y: 140, label: '规划区' },
    { zone: 'planning', x: 380, y: 260, label: '规划区' },
    // 开发区 (Development Zone) — top-right
    { zone: 'coding', x: 620, y: 140, label: '开发区' },
    { zone: 'coding', x: 620, y: 260, label: '开发区' },
    // 评审区 (Review Zone) — bottom-left
    { zone: 'review', x: 240, y: 380, label: '评审区' },
    { zone: 'review', x: 240, y: 460, label: '评审区' },
    // 产出区 (Delivery Zone) — bottom-right
    { zone: 'delivery', x: 560, y: 380, label: '产出区' },
    { zone: 'delivery', x: 560, y: 460, label: '产出区' },
]

/** Zone color palette (pixel-art friendly) — P0-3: added planning zone */
export const ZONE_COLORS: Record<string, { bg: number; border: number; label: string }> = {
    requirement: { bg: 0x1a2744, border: 0x3b82f6, label: '📋 需求区' },
    planning:    { bg: 0x1a2a33, border: 0x06b6d4, label: '📐 规划区' },
    coding:      { bg: 0x1a3320, border: 0x22c55e, label: '💻 开发区' },
    review:      { bg: 0x332a1a, border: 0xf59e0b, label: '🔍 评审区' },
    delivery:    { bg: 0x2a1a33, border: 0xa855f7, label: '📦 产出区' },
}

/** Agent status → visual mapping */
export const STATUS_VISUALS: Record<AgentWorkStatus, { color: number; label: string; emoji: string }> = {
    idle:        { color: 0x6b7280, label: '空闲',     emoji: '💤' },
    compressing: { color: 0xf59e0b, label: '压缩中',   emoji: '⚙️' },
    replying:    { color: 0x3b82f6, label: '回复中',   emoji: '✍️' },
    thinking:    { color: 0xa855f7, label: '思考中',   emoji: '🤔' },
    calling_tool:{ color: 0x8b5cf6, label: '调用工具', emoji: '🔧' },
    completed:   { color: 0x22c55e, label: '已完成',   emoji: '✅' },
    failed:      { color: 0xef4444, label: '失败',     emoji: '❌' },
}
