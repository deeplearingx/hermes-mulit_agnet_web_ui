// ─── Real Agent Room Runner ────────────────────────────────────
// Placeholder for real multi-agent execution.
// Will be implemented when connecting to Hermes agent runtime.

import type { AgentRoomRunner, AgentRoomRunnerContext } from './types'

export class RealAgentRunner implements AgentRoomRunner {
    readonly name = 'real' as const

    async run(_ctx: AgentRoomRunnerContext): Promise<void> {
        throw new Error(
            'RealAgentRunner is not yet implemented. ' +
            'Use MockAgentRoomRunner or connect to Hermes agent runtime.',
        )
    }
}
