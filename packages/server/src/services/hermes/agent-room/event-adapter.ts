// ─── Workflow Event → Chat Message Adapter ─────────────────────
// Pure template module: converts workflow event metadata into message data.
// Does NOT import from ./index (avoids circular dependency).
// The caller (index.ts) is responsible for persisting via addMessage / addWorkflowEvent.

import type {
    AgentRoomWorkflowEventType,
    AgentRoomRole,
    AgentRoomMessageType,
} from './index'

// ─── Agent Metadata ────────────────────────────────────────────
const AGENT_META: Record<AgentRoomRole, { id: string; name: string }> = {
    conversation: { id: 'conversation', name: '会话 Agent' },
    planner:      { id: 'planner',      name: '规划 Agent' },
    developer:    { id: 'developer',    name: '开发 Agent' },
    reviewer:     { id: 'reviewer',     name: '审核 Agent' },
    delivery:     { id: 'delivery',     name: '交付 Agent' },
}

// ─── Output Type ───────────────────────────────────────────────
export interface AdaptedMessage {
    senderId: string
    senderName: string
    senderRole: AgentRoomRole
    type: AgentRoomMessageType
    content: string
    metadata?: {
        taskId?: string
        event?: string
        status?: string
        roundIndex?: number
        reviewComment?: string
    }
}

// ─── Event → Message Template ──────────────────────────────────
export function buildMessageFromEvent(
    eventType: AgentRoomWorkflowEventType,
    agentRole: AgentRoomRole,
    taskTitle: string,
    taskId: string,
    payload?: Record<string, unknown>,
): AdaptedMessage {
    const agent = AGENT_META[agentRole] ?? AGENT_META.conversation

    const base = {
        senderId: agent.id,
        senderName: agent.name,
        senderRole: agentRole,
    }

    switch (eventType) {
        case 'task_created':
            return {
                ...base,
                type: 'task_event' as const,
                content: `收到任务需求：${taskTitle}。正在转交规划 Agent 处理。`,
                metadata: { taskId, event: 'task_created' },
            }
        case 'task_planned':
            return {
                ...base,
                type: 'agent_message' as const,
                content: `已分析任务「${taskTitle}」，制定执行计划如下：\n1. 需求分析\n2. 方案设计\n3. 编码实现\n4. 测试验证`,
                metadata: { taskId, event: 'task_planned' },
            }
        case 'task_assigned':
            return {
                ...base,
                type: 'agent_message' as const,
                content: '已接收任务，开始执行开发工作...',
                metadata: { taskId, event: 'task_assigned' },
            }
        case 'task_started':
            return {
                ...base,
                type: 'agent_message' as const,
                content: '正在开发中...',
                metadata: { taskId, event: 'task_started' },
            }
        case 'task_submitted':
            return {
                ...base,
                type: 'task_event' as const,
                content: '开发完成，提交审核。',
                metadata: { taskId, event: 'task_submitted' },
            }
        case 'review_passed':
            return {
                ...base,
                type: 'review_result' as const,
                content: `✅ 审核通过：任务「${taskTitle}」符合要求。`,
                metadata: {
                    taskId,
                    event: 'review_passed',
                    reviewComment: payload?.comment as string | undefined,
                },
            }
        case 'review_rejected':
            return {
                ...base,
                type: 'review_result' as const,
                content: `❌ 审核驳回：任务「${taskTitle}」需要修改。`,
                metadata: {
                    taskId,
                    event: 'review_rejected',
                    reviewComment: payload?.comment as string | undefined,
                    roundIndex: payload?.revisionRound as number | undefined,
                },
            }
        case 'revision_started':
            return {
                ...base,
                type: 'task_event' as const,
                content: `开始第 ${(payload?.revisionRound as number) ?? '?'} 轮修改...`,
                metadata: {
                    taskId,
                    event: 'revision_started',
                    roundIndex: payload?.revisionRound as number | undefined,
                },
            }
        case 'delivery_started':
            return {
                ...base,
                type: 'task_event' as const,
                content: `任务「${taskTitle}」开始交付流程。`,
                metadata: { taskId, event: 'delivery_started' },
            }
        case 'delivery_completed':
            return {
                ...base,
                type: 'final_delivery' as const,
                content: `🎉 任务「${taskTitle}」已完成交付。`,
                metadata: { taskId, event: 'delivery_completed' },
            }
        case 'task_failed':
            return {
                ...base,
                type: 'error' as const,
                content: `💥 任务「${taskTitle}」执行失败。`,
                metadata: { taskId, event: 'task_failed' },
            }
        case 'need_user_decision':
            return {
                ...base,
                type: 'review_result' as const,
                content: `⚠️ 任务「${taskTitle}」已达到最大修改轮次（${payload?.maxRevisionRounds ?? '?'}），需要用户决策。`,
                metadata: {
                    taskId,
                    event: 'need_user_decision',
                    roundIndex: payload?.revisionRound as number | undefined,
                },
            }
        default:
            return {
                ...base,
                type: 'task_event' as const,
                content: `[${eventType}] ${taskTitle}`,
                metadata: { taskId, event: eventType },
            }
    }
}
