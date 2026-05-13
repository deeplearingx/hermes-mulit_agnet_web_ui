// ─── Agent Room Runner Facade ──────────────────────────────────
// Selects and exports the active runner implementation.
// Set AGENT_ROOM_RUNNER=mock|real to explicitly choose an implementation.
// Defaults to RealAgentRunner outside test and MockAgentRoomRunner in test.

export type {
    AgentRoomRunner,
    AgentRoomRunnerContext,
    AgentRoomRunnerResult,
    AgentRoomRunnerStep,
    AgentRoomRunnerEvent,
    AgentRoomRunnerMessage,
    AgentRoomRunnerArtifact,
    AgentRoomRunnerReviewDecision,
    RunnerRoleBinding,
} from './types'
export { MockAgentRoomRunner } from './mock-runner'
export { RealAgentRunner } from './real-agent-runner'
export type {
    HermesAgentRuntime,
    HermesAgentRuntimeInput,
    HermesAgentRuntimeOutput,
    HermesAgentRuntimeStep,
    HermesAgentRuntimeEvent,
    HermesAgentRuntimeMessage,
    HermesAgentRuntimeArtifact,
} from './runtime'
export { DeterministicHermesRuntime, RealHermesRuntime, GatewayHermesRuntime, OrchestratedGatewayRuntime, createHermesAgentRuntime } from './runtime'
export type { OrchestratedRuntimeConfig } from './runtime'

import type { AgentRoomRunner } from './types'
import { MockAgentRoomRunner } from './mock-runner'
import { RealAgentRunner } from './real-agent-runner'
import { createHermesAgentRuntime } from './runtime'

/**
 * Create a runner instance based on the given mode.
 * @param mode - 'mock' or 'real'. Defaults to 'real' outside test and 'mock' in test.
 * For 'real' mode, injects the default HermesAgentRuntime (orchestrated outside test, deterministic in test).
 */
export function createAgentRoomRunner(mode?: string): AgentRoomRunner {
    const explicitMode = mode ?? process.env.AGENT_ROOM_RUNNER
    const defaultMode = process.env.NODE_ENV === 'test' ? 'mock' : 'real'
    const normalized = (explicitMode ?? defaultMode).toLowerCase()
    if (normalized === 'real') return new RealAgentRunner(createHermesAgentRuntime())
    return new MockAgentRoomRunner()
}

/** Active runner instance — selected by AGENT_ROOM_RUNNER env var. */
export let activeRunner: AgentRoomRunner = createAgentRoomRunner(process.env.AGENT_ROOM_RUNNER)

/**
 * Replace the active runner for testing.
 * Uses ESM live binding so service imports see the new instance.
 */
export function setActiveRunnerForTest(runner: AgentRoomRunner): void {
    activeRunner = runner
}

/** Reset the active runner to the default (env-based) selection. */
export function resetActiveRunnerForTest(): void {
    activeRunner = createAgentRoomRunner(process.env.AGENT_ROOM_RUNNER)
}
