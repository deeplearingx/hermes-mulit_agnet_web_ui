// ─── Real Agent Room Runner ────────────────────────────────────
// Placeholder for real multi-agent execution.
// Will be implemented when connecting to Hermes agent runtime.
//
// Future implementation should return AgentRoomRunnerResult instead of void.
// The facade layer (applyRunnerResult) will handle all DB mutations:
//   - status transitions via updateTaskStatus()
//   - workflow events via emitEventAndMessage()
//   - artifacts via store.createArtifact()
//   - session timestamp via store.updateSessionTimestamp()
//
// This keeps the runner DB-free and focused on agent orchestration.

import type { AgentRoomRunner, AgentRoomRunnerContext, AgentRoomRunnerResult } from './types'

export class RealAgentRunner implements AgentRoomRunner {
    readonly name = 'real' as const

    async run(_ctx: AgentRoomRunnerContext): Promise<AgentRoomRunnerResult> {
        throw new Error(
            'RealAgentRunner is not yet implemented. ' +
            'Use MockAgentRoomRunner or connect to Hermes agent runtime.',
        )
    }
}
