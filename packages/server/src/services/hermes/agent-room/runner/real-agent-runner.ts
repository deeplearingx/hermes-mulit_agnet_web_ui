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
import type { HermesAgentRuntime, HermesAgentRuntimeInput, HermesAgentRuntimeOutput } from './runtime/types'
import type { AgentRoomWorkflowEventType, AgentRoomRole } from '../index'

export class RealAgentRunner implements AgentRoomRunner {
    readonly name = 'real' as const

    constructor(private readonly runtime: HermesAgentRuntime) {}

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
     * Maps runtime steps to ordered AgentRoomRunnerSteps with proper typing.
     */
    private translateOutput(output: HermesAgentRuntimeOutput): AgentRoomRunnerResult {
        return {
            steps: output.steps.map(step => ({
                status: step.status,
                events: [{
                    type: step.eventType as AgentRoomWorkflowEventType,
                    agentRole: step.agentRole as AgentRoomRole,
                }],
                messages: step.message ? [{
                    senderRole: step.message.senderRole as AgentRoomRole,
                    senderId: step.message.senderId,
                    senderName: step.message.senderName,
                    content: step.message.content,
                }] : undefined,
            })),
            artifacts: output.artifacts?.map(art => ({
                name: art.name,
                type: art.type as any,
                content: art.content,
            })),
        }
    }
}
