// ─── Hermes Agent Runtime Facade ───────────────────────────────
// Exports runtime types and implementations.
//
// Modes:
//   gateway|real (default) → GatewayHermesRuntime — uses Hermes Gateway /v1/runs protocol
//   http|bridge            → RealHermesRuntime    — custom HTTP bridge to /agent-room/run-task
//   deterministic|mock     → DeterministicHermesRuntime — hardcoded test runtime

export type {
    HermesAgentRuntime,
    HermesAgentRuntimeInput,
    HermesAgentRuntimeOutput,
    HermesAgentRuntimeStep,
    HermesAgentRuntimeEvent,
    HermesAgentRuntimeMessage,
    HermesAgentRuntimeArtifact,
} from './types'
export { DeterministicHermesRuntime } from './deterministic-runtime'
export { RealHermesRuntime } from './real-hermes-runtime'
export { GatewayHermesRuntime } from './gateway-hermes-runtime'

import type { HermesAgentRuntime } from './types'
import { DeterministicHermesRuntime } from './deterministic-runtime'
import { RealHermesRuntime } from './real-hermes-runtime'
import { GatewayHermesRuntime } from './gateway-hermes-runtime'

/**
 * Create a runtime instance based on the given mode.
 * @param mode - 'gateway'|'real' for Gateway protocol, 'http'|'bridge' for custom HTTP bridge,
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
        case 'deterministic':
        case 'mock':
        case '':
            return new DeterministicHermesRuntime()
        default:
            return new DeterministicHermesRuntime()
    }
}
