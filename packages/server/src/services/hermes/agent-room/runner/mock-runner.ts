// ─── Mock Agent Room Runner ────────────────────────────────────
// Simulates the full agent workflow with mock responses.
// All messages are produced via the event adapter — no direct addMessage calls.
//
// Two paths:
//   created  → planned → assigned → in_progress → submitted_for_review
//   retry (revision_required | need_user_decision | failed) → in_progress → submitted_for_review

import type { AgentRoomRunner, AgentRoomRunnerContext } from './types'

const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

export class MockAgentRoomRunner implements AgentRoomRunner {
    readonly name = 'mock' as const

    async run(ctx: AgentRoomRunnerContext): Promise<void> {
        const { sessionId, taskId, task } = ctx
        const startStatus = task.status

        if (startStatus === 'created') {
            // ── created path: full new-task pipeline ──────────────
            // Step 1: Planner plans → planned
            ctx.runInTransaction(() => {
                ctx.updateTaskStatus(taskId, 'planned')
                ctx.emitEventAndMessage(sessionId, taskId, 'task_planned', 'planner', task.title)
            })
            await delay(300)

            // Step 2: Developer assigned → assigned
            ctx.runInTransaction(() => {
                ctx.updateTaskStatus(taskId, 'assigned')
                ctx.emitEventAndMessage(sessionId, taskId, 'task_assigned', 'developer', task.title)
            })
            await delay(300)

            // Step 3: Developer starts → in_progress
            ctx.runInTransaction(() => {
                ctx.updateTaskStatus(taskId, 'in_progress')
                ctx.emitEventAndMessage(sessionId, taskId, 'task_started', 'developer', task.title)
            })
            await delay(500)

            // Step 4: Developer submits → submitted_for_review
            ctx.runInTransaction(() => {
                ctx.updateTaskStatus(taskId, 'submitted_for_review')
                ctx.emitEventAndMessage(sessionId, taskId, 'task_submitted', 'developer', task.title)
            })
            await delay(300)
        } else {
            // ── retry path: skip planning/assignment ──────────────
            // Step 1: Developer resumes → in_progress
            ctx.runInTransaction(() => {
                ctx.updateTaskStatus(taskId, 'in_progress')
                if (startStatus === 'revision_required' || startStatus === 'need_user_decision') {
                    ctx.emitEventAndMessage(sessionId, taskId, 'revision_started', 'developer', task.title, {
                        revisionRound: task.revisionRound,
                    })
                } else {
                    // failed
                    ctx.emitEventAndMessage(sessionId, taskId, 'task_started', 'developer', task.title)
                }
            })
            await delay(500)

            // Step 2: Developer submits → submitted_for_review
            ctx.runInTransaction(() => {
                ctx.updateTaskStatus(taskId, 'submitted_for_review')
                ctx.emitEventAndMessage(sessionId, taskId, 'task_submitted', 'developer', task.title)
            })
            await delay(300)
        }

        // Workflow stops here at submitted_for_review.
        // Actual review must be triggered manually via ReviewDecisionModal.
    }
}
