// ─── Agent Room Runner Facade ──────────────────────────────────
// Selects and exports the active runner implementation.
// Set AGENT_ROOM_RUNNER=real to use RealAgentRunner (not yet implemented).
// Defaults to MockAgentRoomRunner.

export type { AgentRoomRunner, AgentRoomRunnerContext } from './types'
export { MockAgentRoomRunner } from './mock-runner'
export { RealAgentRunner } from './real-agent-runner'

import type { AgentRoomRunner } from './types'
import { MockAgentRoomRunner } from './mock-runner'
import { RealAgentRunner } from './real-agent-runner'

function resolveRunner(): AgentRoomRunner {
    const env = (process.env.AGENT_ROOM_RUNNER ?? 'mock').toLowerCase()
    if (env === 'real') return new RealAgentRunner()
    return new MockAgentRoomRunner()
}

/** Active runner instance — selected by AGENT_ROOM_RUNNER env var. */
export const activeRunner: AgentRoomRunner = resolveRunner()
