// ─── Real Hermes Agent Runtime ─────────────────────────────────
// HTTP bridge to an external Hermes agent service.
// Does NOT touch DB, service state machine, or frontend.
//
// Responsibilities:
//   1. Map HermesAgentRuntimeInput → HTTP request body
//   2. POST to HERMES_AGENT_BASE_URL/agent-room/run-task
//   3. Validate response structure via parseHermesRuntimeOutput
//   4. Return HermesAgentRuntimeOutput
//
// Failure modes:
//   - Missing baseUrl → throw immediately
//   - HTTP non-2xx → throw (infra failure, not task failure)
//   - Invalid JSON structure → throw (malformed response)
//   - Timeout → throw via AbortController

import type { HermesAgentRuntime, HermesAgentRuntimeInput, HermesAgentRuntimeOutput } from './types'
import { postJson } from './http-client'
import { parseHermesRuntimeOutput } from './parse-output'

function parseEnvTimeoutMs(): number {
    const parsed = Number(process.env.HERMES_AGENT_TIMEOUT_MS ?? 60000)
    if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`Invalid HERMES_AGENT_TIMEOUT_MS: "${process.env.HERMES_AGENT_TIMEOUT_MS}"`)
    }
    return parsed
}

function assertValidTimeoutMs(value: number): void {
    if (!Number.isFinite(value) || value <= 0) {
        throw new Error(`Invalid timeoutMs: ${value}`)
    }
}

export class RealHermesRuntime implements HermesAgentRuntime {
    private readonly baseUrl: string
    private readonly timeoutMs: number

    constructor(baseUrl?: string, timeoutMs?: number) {
        this.baseUrl = baseUrl ?? process.env.HERMES_AGENT_BASE_URL ?? ''
        this.timeoutMs = timeoutMs ?? parseEnvTimeoutMs()
        assertValidTimeoutMs(this.timeoutMs)
    }

    async runTask(input: HermesAgentRuntimeInput): Promise<HermesAgentRuntimeOutput> {
        if (!this.baseUrl) {
            throw new Error('HERMES_AGENT_BASE_URL is required when HERMES_AGENT_RUNTIME=real')
        }

        const url = `${this.baseUrl.replace(/\/$/, '')}/agent-room/run-task`

        const raw = await postJson(
            url,
            {
                sessionId: input.sessionId,
                taskId: input.taskId,
                title: input.taskTitle,
                description: input.taskDescription,
                currentStatus: input.currentStatus,
                assignedAgentId: input.assignedAgentId,
                revisionRound: input.revisionRound,
            },
            this.timeoutMs,
        )

        return parseHermesRuntimeOutput(raw)
    }
}
