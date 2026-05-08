// ─── Real Agent Room Runner ────────────────────────────────────
// Protocol translation layer between AgentRoom and Hermes runtime.
// Does NOT call LLMs or touch DB directly — delegates to HermesAgentRuntime.
//
// Responsibilities:
//   1. Extract HermesAgentRuntimeInput from AgentRoomRunnerContext
//   2. Call runtime.runTask(input)
//   3. Translate HermesAgentRuntimeOutput → AgentRoomRunnerResult (ordered steps)
//
// The facade layer (applyRunnerResult) handles all DB mutations.

import type { AgentRoomRunner, AgentRoomRunnerContext, AgentRoomRunnerResult } from './types'
import type { HermesAgentRuntime, HermesAgentRuntimeInput } from './runtime/types'
import { createHermesAgentRuntime } from './runtime'

export class RealAgentRunner implements AgentRoomRunner {
    readonly name = 'real' as const

    constructor(private readonly runtime: HermesAgentRuntime = createHermesAgentRuntime()) {}

    async run(ctx: AgentRoomRunnerContext): Promise<AgentRoomRunnerResult> {
        const input = this.extractInput(ctx)
        const output = await this.runtime.runTask(input)
        return this.translateOutput(output)
    }

    /**
     * Extract HermesAgentRuntimeInput from AgentRoom context.
     * Pure mapping — no side effects.
     */
    private extractInput(ctx: AgentRoomRunnerContext): HermesAgentRuntimeInput {
        return {
            taskTitle: ctx.task.title,
            taskDescription: ctx.task.description,
            currentStatus: ctx.task.status,
            sessionId: ctx.sessionId,
            taskId: ctx.taskId,
            assignedAgentId: ctx.task.assignedAgentId,
            revisionRound: ctx.task.revisionRound,
        }
    }

    /**
     * Translate HermesAgentRuntimeOutput → AgentRoomRunnerResult.
     * Runtime types are now structurally aligned — no cast needed.
     */
    private translateOutput(output: import('./runtime/types').HermesAgentRuntimeOutput): AgentRoomRunnerResult {
        return {
            steps: output.steps.map(step => ({
                status: step.status,
                events: step.events,
                messages: step.messages,
            })),
            artifacts: output.artifacts,
        }
    }
}
