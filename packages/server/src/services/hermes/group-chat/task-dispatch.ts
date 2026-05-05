// ─── Task Dispatch Service ────────────────────────────────────
// Phase 12: Task Command → Agent Execution bridge
// Builds task-specific instructions and manages action transitions.

import type { GroupRuntimeEvent } from './agent-clients'

// ─── Task Action Definitions ──────────────────────────────────

export type TaskAction =
    | 'start_planning'
    | 'start_coding'
    | 'request_review'
    | 'revise'
    | 'deliver'

export interface TaskActionTransition {
    from: string[]  // valid source statuses for this action
    onDispatch: { status: string; phase: string }
    onStart: { status: string; phase: string }
    onComplete: { status: string; phase: string }
}

export const TASK_ACTION_TRANSITIONS: Record<TaskAction, TaskActionTransition> = {
    start_planning: {
        from: ['draft'],
        onDispatch: { status: 'planning', phase: 'planning' },
        onStart: { status: 'running', phase: 'planning' },
        onComplete: { status: 'reviewing', phase: 'planning' },
    },
    start_coding: {
        from: ['planning', 'running', 'reviewing'],
        onDispatch: { status: 'running', phase: 'coding' },
        onStart: { status: 'running', phase: 'coding' },
        onComplete: { status: 'reviewing', phase: 'review' },
    },
    request_review: {
        from: ['running'],
        onDispatch: { status: 'reviewing', phase: 'review' },
        onStart: { status: 'reviewing', phase: 'review' },
        onComplete: { status: 'reviewing', phase: 'review' },
    },
    revise: {
        from: ['reviewing'],
        onDispatch: { status: 'running', phase: 'coding' },
        onStart: { status: 'running', phase: 'coding' },
        onComplete: { status: 'reviewing', phase: 'review' },
    },
    deliver: {
        from: ['reviewing'],
        onDispatch: { status: 'running', phase: 'delivery' },
        onStart: { status: 'running', phase: 'delivery' },
        onComplete: { status: 'done', phase: 'delivery' },
    },
}

// ─── Instruction Builder ──────────────────────────────────────

export interface TaskContext {
    taskId: string
    taskTitle: string
    taskDescription?: string
    taskPhase: string
    assigneeAgentId?: string
    assigneeAgentName?: string
}

export interface RoomContext {
    roomId: string
    roomName?: string
    memberNames?: string[]
}

/**
 * Build a task-specific instruction for the agent.
 * This replaces the generic @mention prompt with a structured task command.
 */
export function buildTaskInstruction(
    action: TaskAction,
    task: TaskContext,
    room?: RoomContext,
): string {
    const taskHeader = `## 任务指令\n\n任务标题：${task.taskTitle}${task.taskDescription ? `\n任务描述：${task.taskDescription}` : ''}`

    switch (action) {
        case 'start_planning':
            return [
                taskHeader,
                '',
                '你是该任务的规划负责人。请基于以上任务信息生成执行计划：',
                '1. 拆解子任务',
                '2. 给出开发步骤',
                '3. 标明风险点与待确认项',
                '',
                '请以结构化方式输出计划。',
            ].join('\n')

        case 'start_coding':
            return [
                taskHeader,
                '',
                '你是开发 Agent。请根据任务描述和已有上下文开始实现：',
                '1. 修改必要文件',
                '2. 说明改动点',
                '3. 如果产出文件，返回路径与摘要',
                '',
                '请开始执行。',
            ].join('\n')

        case 'request_review':
            return [
                taskHeader,
                '',
                '请从评审视角审查当前任务产出：',
                '1. 检查逻辑正确性',
                '2. 检查代码质量',
                '3. 给出通过 / 打回建议',
                '',
                '请给出评审意见。',
            ].join('\n')

        case 'revise':
            return [
                taskHeader,
                '',
                '上一轮评审提出了修改意见。请根据评审反馈重新修改：',
                '1. 聚焦缺陷修复',
                '2. 说明修改内容',
                '3. 确认问题已解决',
                '',
                '请开始修改。',
            ].join('\n')

        case 'deliver':
            return [
                taskHeader,
                '',
                '任务已通过审核，请生成最终交付总结：',
                '1. 总结完成的工作',
                '2. 罗列主要产物与结果',
                '3. 标注注意事项（如有）',
                '',
                '请输出交付总结。',
            ].join('\n')

        default:
            return taskHeader
    }
}

/**
 * Resolve the transition for a runtime event given a task action.
 * Returns null if no transition applies or currentStatus is not in the expected `from` list.
 */
export function resolveTaskTransition(
    eventType: GroupRuntimeEvent['type'],
    taskAction?: string,
    currentStatus?: string,
): { status: string; phase: string } | null {
    if (!taskAction || !(taskAction in TASK_ACTION_TRANSITIONS)) {
        return null
    }

    const transitions = TASK_ACTION_TRANSITIONS[taskAction as TaskAction]

    // Bug fix: validate currentStatus against expected `from` states
    // Skip validation for run_failed (always applicable) and when currentStatus is unknown
    if (currentStatus && eventType !== 'run_failed' && !transitions.from.includes(currentStatus)) {
        return null
    }

    switch (eventType) {
        case 'run_started':
            return transitions.onStart
        case 'run_completed':
            return transitions.onComplete
        case 'run_failed':
            // For failed runs, keep current status but mark as failed
            return { status: 'failed', phase: transitions.onStart.phase }
        default:
            return null
    }
}
