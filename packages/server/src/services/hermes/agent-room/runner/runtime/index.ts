// ─── Hermes Agent Runtime Facade ───────────────────────────────
// Exports runtime types and implementations.
//
// Modes:
//   gateway|real (default)  → GatewayHermesRuntime — uses Hermes Gateway /v1/runs protocol
//   http|bridge             → RealHermesRuntime    — custom HTTP bridge to /agent-room/run-task
//   deterministic|mock      → DeterministicHermesRuntime — hardcoded test runtime
//   orchestrated|gateway-multi-role → OrchestratedGatewayRuntime — multi-role orchestrated runtime (P4.11-A1 skeleton)

export type {
    HermesAgentRuntime,
    HermesAgentRuntimeInput,
    HermesAgentRuntimeOutput,
    HermesAgentRuntimeStep,
    HermesAgentRuntimeEvent,
    HermesAgentRuntimeMessage,
    HermesAgentRuntimeArtifact,
    HermesAgentRuntimeMetadata,
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
 *               'orchestrated'|'gateway-multi-role' for multi-role orchestrated runtime,
 *               'deterministic'|'mock' (default) for hardcoded test runtime.
 */
export function createHermesAgentRuntime(mode?: string): HermesAgentRuntime {
    const normalized = (mode ?? 'deterministic').toLowerCase()

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
