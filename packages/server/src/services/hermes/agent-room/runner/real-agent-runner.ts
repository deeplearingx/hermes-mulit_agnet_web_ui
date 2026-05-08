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

        return {
            steps: [
                {
                    status: 'planned',
                    events: [{ type: 'task_planned', agentRole: 'planner' }],
                    messages: [{ senderRole: 'planner', content: `已完成任务「${title}」的规划` }],
                },
                {
                    status: 'assigned',
                    events: [{ type: 'task_assigned', agentRole: 'developer' }],
                },
                {
                    status: 'in_progress',
                    events: [{ type: 'task_started', agentRole: 'developer' }],
                    messages: [{ senderRole: 'developer', content: `开始执行任务「${title}」` }],
                },
                {
                    status: 'submitted_for_review',
                    events: [{ type: 'task_submitted', agentRole: 'developer' }],
                    messages: [{ senderRole: 'developer', content: `任务「${title}」已提交审核` }],
                },
            ],
        }
    }
}
