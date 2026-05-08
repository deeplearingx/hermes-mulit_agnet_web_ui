// ─── Hermes Agent Runtime Facade ───────────────────────────────
// Exports runtime types and implementations.
// Set HERMES_AGENT_RUNTIME=deterministic to use the deterministic runtime (default).

export type {
    HermesAgentRuntime,
    HermesAgentRuntimeInput,
    HermesAgentRuntimeOutput,
    HermesAgentRuntimeStep,
} from './types'
export { DeterministicHermesRuntime } from './deterministic-runtime'

import type { HermesAgentRuntime } from './types'
import { DeterministicHermesRuntime } from './deterministic-runtime'

/**
 * Create a runtime instance based on the given mode.
 * @param mode - 'deterministic' (default) or future 'real'.
 */
export function createHermesAgentRuntime(mode?: string): HermesAgentRuntime {
    const normalized = (mode ?? 'deterministic').toLowerCase()
    // Future: if (normalized === 'real') return new RealHermesRuntime()
    return new DeterministicHermesRuntime()
}
