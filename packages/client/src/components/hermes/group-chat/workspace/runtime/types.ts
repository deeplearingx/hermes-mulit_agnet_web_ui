// ─── Workspace Types ─────────────────────────────────────────
// Types for the pixel-style workspace visualization mode.

import { ZONE_SEATS } from './map-config'

export type AgentWorkStatus = 'idle' | 'compressing' | 'replying' | 'thinking'
    | 'calling_tool' | 'completed' | 'failed'

export type AgentRoleType = 'observer' | 'planner' | 'developer' | 'reviewer' | 'delivery' | 'tester'

// P11-2: Agent work mode — long-term task phase, not transient runtime status
export type AgentWorkMode = 'idle' | 'requirement' | 'planning' | 'coding' | 'review' | 'delivery'

export interface AgentWorkspaceState {
    agentId: string
    agentName: string
    profile: string
    status: AgentWorkStatus
    seatIndex: number
    zone: string
    roleType: AgentRoleType          // 角色类型
    currentTaskId?: string           // 当前绑定任务 ID
    currentTaskTitle?: string        // 当前任务标题
    phase?: string                   // 当前任务阶段
    isTaskOwner?: boolean            // 是否为当前任务负责人
    x?: number   // 从 workspaceLayout 恢复的坐标
    y?: number
    pinned?: boolean                 // P9-3: 用户固定位置，不被任务流转覆盖
    lastEventType?: string           // P9-6: 最近一次事件类型
    lastEventPayload?: string        // P9-6: 最近事件摘要
    lastArtifactName?: string        // P9-6: 最近产出物名称
    activeToolName?: string          // P9-6: 正在调用的工具名
    lastEventAt: number
    // P11-2: Two-layer state — long-term work mode + transient runtime label
    workMode: AgentWorkMode          // 长期工作模式（由任务 phase 决定）
    workLabel: string                // 工作模式标签（如"等待审核"）
    runtimeLabel?: string            // 瞬时运行行为（如"生成回复"、"调用工具"）
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

/** Zone label mapping */
const ZONE_LABELS: Record<string, string> = {
    requirement: '需求区',
    planning: '规划区',
    coding: '开发区',
    review: '评审区',
    delivery: '产出区',
}

/** P8-7: Default seats derived from ZONE_SEATS (4 per zone, 20 total) */
export const DEFAULT_SEATS: AgentSeat[] = Object.entries(ZONE_SEATS).flatMap(([zone, seats]) =>
    seats.map(seat => ({
        zone,
        x: seat.x,
        y: seat.y,
        label: ZONE_LABELS[zone] ?? zone,
    }))
)

/** Role → default zone mapping (P7-1, P8-5: added tester, P9-4: tester→review) */
export const ROLE_DEFAULT_ZONE: Record<AgentRoleType, string> = {
    observer: 'requirement',
    planner: 'planning',
    developer: 'coding',
    reviewer: 'review',
    delivery: 'delivery',
    tester: 'review',
}

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
