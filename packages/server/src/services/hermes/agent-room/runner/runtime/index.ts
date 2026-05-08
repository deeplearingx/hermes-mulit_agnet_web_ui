// ─── Hermes Agent Runtime Facade ───────────────────────────────
// Exports runtime types and implementations.
// Set HERMES_AGENT_RUNTIME=real to use the HTTP bridge runtime.
// Set HERMES_AGENT_RUNTIME=deterministic (default) for the hardcoded test runtime.

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

import type { HermesAgentRuntime } from './types'
import { DeterministicHermesRuntime } from './deterministic-runtime'
import { RealHermesRuntime } from './real-hermes-runtime'

/**
 * Create a runtime instance based on the given mode.
 * @param mode - 'real' for HTTP bridge, 'deterministic' (default) for hardcoded test runtime.
 */
export function createHermesAgentRuntime(mode?: string): HermesAgentRuntime {
    const normalized = (mode ?? 'deterministic').toLowerCase()

    switch (normalized) {
        case 'real':
            return new RealHermesRuntime()
        case 'deterministic':
        case 'mock':
        case '':
            return new DeterministicHermesRuntime()
        default:
            return new DeterministicHermesRuntime()
    }
}
