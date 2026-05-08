// ─── Real Agent Room Runner ────────────────────────────────────
// Adapter skeleton for real multi-agent execution.
// Returns deterministic ordered steps without calling any LLM.
// The facade layer (applyRunnerResult) handles all DB mutations:
//   - status transitions via updateTaskStatus()
//   - workflow events via emitEventAndMessage()
//   - artifacts via store.createArtifact()
//   - session timestamp via store.updateSessionTimestamp()
//
// This keeps the runner DB-free and focused on agent orchestration.
// Future versions will replace the hardcoded steps with actual LLM calls.

import type { AgentRoomRunner, AgentRoomRunnerContext, AgentRoomRunnerResult } from './types'

export class RealAgentRunner implements AgentRoomRunner {
    readonly name = 'real' as const

    async run(ctx: AgentRoomRunnerContext): Promise<AgentRoomRunnerResult> {
        const title = ctx.task.title
        const status = ctx.task.status

        // Branch by current task status to produce valid state machine transitions
        if (status === 'created') {
            return {
                steps: [
                    {
                        status: 'planned',
                        events: [{ type: 'task_planned', agentRole: 'planner' }],
                        messages: [{ senderRole: 'planner', senderId: 'planner', senderName: '规划 Agent', content: `已完成任务「${title}」的规划` }],
                    },
                    {
                        status: 'assigned',
                        events: [{ type: 'task_assigned', agentRole: 'developer' }],
                    },
                    {
                        status: 'in_progress',
                        events: [{ type: 'task_started', agentRole: 'developer' }],
                        messages: [{ senderRole: 'developer', senderId: 'developer', senderName: '开发 Agent', content: `开始执行任务「${title}」` }],
                    },
                    {
                        status: 'submitted_for_review',
                        events: [{ type: 'task_submitted', agentRole: 'developer' }],
                        messages: [{ senderRole: 'developer', senderId: 'developer', senderName: '开发 Agent', content: `任务「${title}」已提交审核` }],
                    },
                ],
            }
        }

        if (status === 'revision_required' || status === 'need_user_decision') {
            return {
                steps: [
                    {
                        status: 'in_progress',
                        events: [{ type: 'revision_started', agentRole: 'developer' }],
                        messages: [{ senderRole: 'developer', senderId: 'developer', senderName: '开发 Agent', content: `开始根据反馈修改任务「${title}」` }],
                    },
                    {
                        status: 'submitted_for_review',
                        events: [{ type: 'task_submitted', agentRole: 'developer' }],
                        messages: [{ senderRole: 'developer', senderId: 'developer', senderName: '开发 Agent', content: `任务「${title}」已重新提交审核` }],
                    },
                ],
            }
        }

        if (status === 'failed') {
            return {
                steps: [
                    {
                        status: 'in_progress',
                        events: [{ type: 'task_started', agentRole: 'developer' }],
                        messages: [{ senderRole: 'developer', senderId: 'developer', senderName: '开发 Agent', content: `重新执行失败任务「${title}」` }],
                    },
                    {
                        status: 'submitted_for_review',
                        events: [{ type: 'task_submitted', agentRole: 'developer' }],
                    },
                ],
            }
        }

        // Fallback: should not be reached (runWorkflow guards startable statuses)
        throw new Error(`RealAgentRunner: unsupported start status "${status}"`)
    }
}
