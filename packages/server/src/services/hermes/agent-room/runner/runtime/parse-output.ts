// ─── Runtime Output Parser ─────────────────────────────────────
// Validates the raw JSON response from an external Hermes agent service.
// Performs structural validation only — status/event semantic validation
// is handled by the service facade (validateRunnerStep).

import type { HermesAgentRuntimeOutput } from './types'

/**
 * Parse and validate raw JSON into HermesAgentRuntimeOutput.
 * Throws descriptive errors for malformed responses.
 */
export function parseHermesRuntimeOutput(raw: unknown): HermesAgentRuntimeOutput {
    if (!raw || typeof raw !== 'object') {
        throw new Error('Invalid Hermes runtime output: expected object')
    }

    const output = raw as Partial<HermesAgentRuntimeOutput>

    if (!Array.isArray(output.steps)) {
        throw new Error('Invalid Hermes runtime output: steps must be array')
    }

    for (const [index, step] of output.steps.entries()) {
        if (!step.status) {
            throw new Error(`Invalid Hermes runtime output: steps[${index}].status is required`)
        }

        if (!Array.isArray(step.events) || step.events.length === 0) {
            throw new Error(`Invalid Hermes runtime output: steps[${index}].events must be non-empty array`)
        }

        for (const [eventIndex, event] of step.events.entries()) {
            if (!event.type || !event.agentRole) {
                throw new Error(
                    `Invalid Hermes runtime output: steps[${index}].events[${eventIndex}] requires type and agentRole`,
                )
            }
        }
    }

    return output as HermesAgentRuntimeOutput
}
