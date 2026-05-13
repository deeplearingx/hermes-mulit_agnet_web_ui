// ─── Hermes Agent Runtime Facade ───────────────────────────────
// Exports runtime types and implementations.
//
// Modes:
//   orchestrated|gateway-multi-role (default outside test) → OrchestratedGatewayRuntime — multi-role orchestrated runtime
//   deterministic|mock (default in test)                    → DeterministicHermesRuntime — hardcoded test runtime
//   gateway|real                                            → GatewayHermesRuntime — uses Hermes Gateway /v1/runs protocol
//   http|bridge                                             → RealHermesRuntime — custom HTTP bridge to /agent-room/run-task

export type {
    HermesAgentRuntime,
    HermesAgentRuntimeInput,
    HermesAgentRuntimeOutput,
    HermesAgentRuntimeStep,
    HermesAgentRuntimeEvent,
    HermesAgentRuntimeMessage,
    HermesAgentRuntimeArtifact,
    HermesAgentRuntimeMetadata,
    HermesAgentRuntimeReviewDecision,
    ReviewerDecision,
    ReviewerOutput,
} from './types'
export { DeterministicHermesRuntime } from './deterministic-runtime'
export { RealHermesRuntime } from './real-hermes-runtime'
export { GatewayHermesRuntime } from './gateway-hermes-runtime'
export { OrchestratedGatewayRuntime } from './orchestrated-gateway-runtime'
export type { OrchestratedRuntimeConfig } from './orchestrated-gateway-runtime'

import type { HermesAgentRuntime } from './types'
import { DeterministicHermesRuntime } from './deterministic-runtime'
import { RealHermesRuntime } from './real-hermes-runtime'
import { GatewayHermesRuntime } from './gateway-hermes-runtime'
import { OrchestratedGatewayRuntime } from './orchestrated-gateway-runtime'

/**
 * Create a runtime instance based on the given mode.
 * @param mode - 'gateway'|'real' for Gateway protocol,
 *               'http'|'bridge' for custom HTTP bridge,
 *               'orchestrated'|'gateway-multi-role' (default outside test) for multi-role orchestrated runtime,
 *               'deterministic'|'mock' (default in test) for hardcoded test runtime.
 */
export function createHermesAgentRuntime(mode?: string): HermesAgentRuntime {
    const explicitMode = mode ?? process.env.HERMES_AGENT_RUNTIME
    const defaultMode = process.env.NODE_ENV === 'test' ? 'deterministic' : 'orchestrated'
    const normalized = (explicitMode ?? defaultMode).toLowerCase()

    switch (normalized) {
        case 'gateway':
        case 'real':
            return new GatewayHermesRuntime()
        case 'http':
        case 'bridge':
            return new RealHermesRuntime()
        case 'orchestrated':
        case 'gateway-multi-role':
            return new OrchestratedGatewayRuntime()
        case 'deterministic':
        case 'mock':
        case '':
            return new DeterministicHermesRuntime()
        default:
            return new DeterministicHermesRuntime()
    }
}
