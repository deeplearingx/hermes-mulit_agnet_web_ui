// ─── Deterministic Hermes Runtime ──────────────────────────────
// Test/runtime implementation that returns hardcoded ordered steps.
// Does NOT call any LLM — produces deterministic output for a given input.
// Used as the default runtime when no real Hermes runtime is configured.

import type {
    HermesAgentRuntime,
    HermesAgentRuntimeInput,
    HermesAgentRuntimeOutput,
} from './types'

export class DeterministicHermesRuntime implements HermesAgentRuntime {
    async runTask(input: HermesAgentRuntimeInput): Promise<HermesAgentRuntimeOutput> {
        const { taskTitle, currentStatus } = input

        if (currentStatus === 'created') {
            return {
                steps: [
                    {
                        status: 'planned',
                        eventType: 'task_planned',
                        agentRole: 'planner',
                        message: {
                            senderRole: 'planner',
                            senderId: 'planner',
                            senderName: '规划 Agent',
                            content: `已完成任务「${taskTitle}」的规划`,
                        },
                    },
                    {
                        status: 'assigned',
                        eventType: 'task_assigned',
                        agentRole: 'developer',
                    },
                    {
                        status: 'in_progress',
                        eventType: 'task_started',
                        agentRole: 'developer',
                        message: {
                            senderRole: 'developer',
                            senderId: 'developer',
                            senderName: '开发 Agent',
                            content: `开始执行任务「${taskTitle}」`,
                        },
                    },
                    {
                        status: 'submitted_for_review',
                        eventType: 'task_submitted',
                        agentRole: 'developer',
                        message: {
                            senderRole: 'developer',
                            senderId: 'developer',
                            senderName: '开发 Agent',
                            content: `任务「${taskTitle}」已提交审核`,
                        },
                    },
                ],
            }
        }

        if (currentStatus === 'revision_required' || currentStatus === 'need_user_decision') {
            return {
                steps: [
                    {
                        status: 'in_progress',
                        eventType: 'revision_started',
                        agentRole: 'developer',
                        message: {
                            senderRole: 'developer',
                            senderId: 'developer',
                            senderName: '开发 Agent',
                            content: `开始根据反馈修改任务「${taskTitle}」`,
                        },
                    },
                    {
                        status: 'submitted_for_review',
                        eventType: 'task_submitted',
                        agentRole: 'developer',
                        message: {
                            senderRole: 'developer',
                            senderId: 'developer',
                            senderName: '开发 Agent',
                            content: `任务「${taskTitle}」已重新提交审核`,
                        },
                    },
                ],
            }
        }

        if (currentStatus === 'failed') {
            return {
                steps: [
                    {
                        status: 'in_progress',
                        eventType: 'task_started',
                        agentRole: 'developer',
                        message: {
                            senderRole: 'developer',
                            senderId: 'developer',
                            senderName: '开发 Agent',
                            content: `重新执行失败任务「${taskTitle}」`,
                        },
                    },
                    {
                        status: 'submitted_for_review',
                        eventType: 'task_submitted',
                        agentRole: 'developer',
                    },
                ],
            }
        }

        throw new Error(`DeterministicHermesRuntime: unsupported start status "${currentStatus}"`)
    }
}
