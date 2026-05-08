// ─── Agent Room Gateway Smoke Test ──────────────────────────────
// Validates the real Hermes Gateway /v1/runs + SSE /events pipeline.
// Prints the raw event shape for every SSE event received, so we can
// verify that extractGatewayOutput() covers the real response format.
//
// Usage:
//   UPSTREAM=http://127.0.0.1:8642 npm run smoke:agent-room-gateway
//
// Optional env vars:
//   HERMES_GATEWAY_API_KEY   — API key for Authorization header
//   HERMES_AGENT_TIMEOUT_MS  — timeout per phase (default 120000)

import { runHermesGatewayTask } from '../packages/server/src/services/hermes/gateway-run-client'

const UPSTREAM = process.env.UPSTREAM || 'http://127.0.0.1:8642'
const API_KEY = process.env.HERMES_GATEWAY_API_KEY || undefined
const TIMEOUT_MS = Number(process.env.HERMES_AGENT_TIMEOUT_MS || 120_000)

async function main(): Promise<void> {
    console.log('─── Agent Room Gateway Smoke Test ───')
    console.log(`upstream:  ${UPSTREAM}`)
    console.log(`timeout:   ${TIMEOUT_MS}ms`)
    console.log(`apiKey:    ${API_KEY ? '(set)' : '(not set)'}`)
    console.log()

    const sessionId = `agent-room-smoke-${Date.now()}`
    const rawEvents: Record<string, unknown>[] = []

    try {
        const result = await runHermesGatewayTask({
            upstream: UPSTREAM,
            apiKey: API_KEY,
            input: 'AgentRoom Gateway smoke test: 请用一句话回复 smoke-ok，并说明你已收到任务。',
            instructions: '你是 AgentRoom 的开发 Agent。只返回执行结果，不要返回状态机字段。',
            sessionId,
            timeoutMs: TIMEOUT_MS,
            onRawEvent: (event) => {
                rawEvents.push(event)
            },
        })

        console.log('✅ Gateway smoke passed')
        console.log(`runId:     ${result.runId}`)
        console.log(`sessionId: ${result.sessionId}`)
        console.log(`output:    ${result.output.slice(0, 200)}${result.output.length > 200 ? '...' : ''}`)
        console.log()

        // Print raw event shape for diagnostics
        console.log(`─── Raw SSE Events (${rawEvents.length}) ───`)
        for (const [i, event] of rawEvents.entries()) {
            console.log(`\n[event ${i}]`)
            console.log(JSON.stringify(event, null, 2))
        }
    } catch (err: unknown) {
        console.error('❌ Gateway smoke failed')
        console.error(`error: ${err instanceof Error ? err.message : String(err)}`)

        if (rawEvents.length > 0) {
            console.error(`\n─── Raw SSE Events Before Failure (${rawEvents.length}) ───`)
            for (const [i, event] of rawEvents.entries()) {
                console.error(`\n[event ${i}]`)
                console.error(JSON.stringify(event, null, 2))
            }
        }

        process.exit(1)
    }
}

main()
