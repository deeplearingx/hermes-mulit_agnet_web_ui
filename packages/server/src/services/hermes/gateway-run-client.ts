// ─── Hermes Gateway Run Client ─────────────────────────────────
// Shared client for POST /v1/runs + GET /v1/runs/:run_id/events.
// Used by GatewayHermesRuntime and potentially GatewaySummarizer.
//
// This module does NOT import AgentRoom types — it's a pure Gateway adapter.
// It returns the raw output string from run.completed, leaving the caller
// responsible for mapping it into domain-specific structures.

import { EventSource } from 'eventsource'

export interface GatewayRunParams {
    /** Gateway upstream URL (e.g. http://127.0.0.1:8642) */
    upstream: string
    /** Optional API key for Authorization header */
    apiKey?: string | null
    /** Input text for the run */
    input: string
    /** System instructions for the agent */
    instructions?: string
    /** Conversation history for context */
    conversationHistory?: Array<{ role: string; content: string }>
    /** Session ID for the run */
    sessionId?: string
    /**
     * Timeout in milliseconds.
     * Applies separately to run creation (POST /v1/runs via AbortSignal.timeout)
     * and event streaming (SSE setTimeout). Total wall-clock time may approach 2 × timeoutMs.
     */
    timeoutMs?: number
    /**
     * Optional callback invoked for every parsed SSE event.
     * Useful for diagnostics / smoke tests to inspect the raw event shape.
     */
    onRawEvent?: (event: Record<string, unknown>) => void
    /** Optional model name to pass to the gateway */
    model?: string
    /** Optional provider name to pass to the gateway */
    provider?: string
}

export interface GatewayRunResult {
    /** The final output text from run.completed */
    output: string
    /** The run ID assigned by the gateway */
    runId: string
    /** The session ID used for the run */
    sessionId: string
}

/**
 * Extract the output text from a run.completed event.
 * Handles multiple possible response shapes from different gateway versions.
 */
export function extractGatewayOutput(event: Record<string, unknown>): string | null {
    // Direct output field
    if (typeof event.output === 'string' && event.output.trim()) {
        return event.output.trim()
    }
    // Nested data.output
    const data = event.data as Record<string, unknown> | undefined
    if (data && typeof data.output === 'string' && data.output.trim()) {
        return data.output.trim()
    }
    // Nested result.output
    const result = event.result as Record<string, unknown> | undefined
    if (result && typeof result.output === 'string' && result.output.trim()) {
        return result.output.trim()
    }
    // Nested message.content
    const message = event.message as Record<string, unknown> | undefined
    if (message && typeof message.content === 'string' && message.content.trim()) {
        return message.content.trim()
    }
    return null
}

/**
 * Run a task on the Hermes Gateway and wait for completion.
 *
 * Flow:
 *   1. POST /v1/runs → get run_id
 *   2. GET /v1/runs/:run_id/events (SSE) → wait for run.completed or run.failed
 *   3. Return { output, runId, sessionId }
 *
 * Timeout semantics:
 *   timeoutMs applies separately to run creation (POST /v1/runs via AbortSignal.timeout)
 *   and event streaming (SSE setTimeout). Total wall-clock time may approach 2 × timeoutMs.
 *
 * Throws on:
 *   - Invalid timeoutMs (NaN / non-positive)
 *   - HTTP errors from /v1/runs
 *   - Missing run_id in response
 *   - run.failed event
 *   - Empty output from run.completed
 *   - SSE connection errors
 *   - Timeout (POST or SSE)
 */
/**
 * Validate that a timeout value is a positive finite number.
 * Throws immediately on NaN / non-positive to surface env-var misconfiguration.
 */
function assertValidTimeoutMs(value: number): void {
    if (!Number.isFinite(value) || value <= 0) {
        throw new Error(`Invalid Gateway timeoutMs: ${value}`)
    }
}

export async function runHermesGatewayTask(params: GatewayRunParams): Promise<GatewayRunResult> {
    const {
        upstream,
        apiKey,
        input,
        instructions,
        conversationHistory,
        sessionId,
        timeoutMs = 120_000,
        onRawEvent,
        model,
        provider,
    } = params

    assertValidTimeoutMs(timeoutMs)

    const cleanUpstream = upstream.replace(/\/$/, '')
    const effectiveSessionId = sessionId || Date.now().toString(36) + Math.random().toString(36).slice(2, 8)

    // ── Step 1: POST /v1/runs ──────────────────────────────────
    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
    }
    if (apiKey) {
        headers['Authorization'] = `Bearer ${apiKey}`
    }

    const body: Record<string, unknown> = {
        input,
        session_id: effectiveSessionId,
    }
    if (instructions) body.instructions = instructions
    if (conversationHistory?.length) body.conversation_history = conversationHistory
    if (model) body.model = model
    if (provider) body.provider = provider

    const runRes = await fetch(`${cleanUpstream}/v1/runs`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
    })

    if (!runRes.ok) {
        const text = await runRes.text().catch(() => '')
        throw new Error(`Hermes Gateway run failed (${runRes.status}): ${text}`)
    }

    const runData = await runRes.json() as Record<string, unknown>
    const runId = runData.run_id as string | undefined
    if (!runId) {
        throw new Error('Hermes Gateway response missing run_id')
    }

    // ── Step 2: GET /v1/runs/:run_id/events (SSE) ──────────────
    return new Promise<GatewayRunResult>((resolve, reject) => {
        const timer = setTimeout(() => {
            source.close()
            reject(new Error(`Hermes Gateway run timed out after ${timeoutMs}ms`))
        }, timeoutMs)

        const eventsUrl = new URL(`${cleanUpstream}/v1/runs/${runId}/events`)

        const eventSourceInit: Record<string, unknown> = apiKey ? {
            fetch: (url: string, init: Record<string, unknown> = {}) => fetch(url, {
                ...init,
                headers: {
                    ...(init.headers || {}),
                    Authorization: `Bearer ${apiKey}`,
                },
            }),
        } : {}

        // @ts-ignore - eventsource library types are too strict
        const source = new EventSource(eventsUrl.toString(), eventSourceInit)

        source.onmessage = (event: MessageEvent) => {
            try {
                const parsed = JSON.parse(event.data) as Record<string, unknown>

                if (onRawEvent) {
                    try { onRawEvent(parsed) } catch { /* swallow diagnostic errors */ }
                }

                if (parsed.event === 'run.completed') {
                    clearTimeout(timer)
                    source.close()

                    const output = extractGatewayOutput(parsed)
                    if (!output) {
                        reject(new Error('Hermes Gateway run.completed returned empty output'))
                        return
                    }
                    resolve({ output, runId, sessionId: effectiveSessionId })
                } else if (parsed.event === 'run.failed') {
                    clearTimeout(timer)
                    source.close()
                    reject(new Error(parsed.error ? String(parsed.error) : 'Hermes Gateway run failed'))
                }
            } catch {
                // ignore parse errors for non-JSON events
            }
        }

        source.onerror = () => {
            clearTimeout(timer)
            source.close()
            reject(new Error('Hermes Gateway SSE connection error'))
        }
    })
}
