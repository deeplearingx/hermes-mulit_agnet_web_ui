// ─── Agent Room Runner Facade ──────────────────────────────────
// Selects and exports the active runner implementation.
// Swap to RealAgentRunner when connecting to Hermes agent runtime.

export type { AgentRoomRunner, AgentRoomRunnerContext } from './types'
export { MockAgentRoomRunner } from './mock-runner'
export { RealAgentRunner } from './real-agent-runner'

import type { AgentRoomRunner } from './types'
import { MockAgentRoomRunner } from './mock-runner'

/** Default runner instance. Replace with RealAgentRunner when ready. */
export const activeRunner: AgentRoomRunner = new MockAgentRoomRunner()
