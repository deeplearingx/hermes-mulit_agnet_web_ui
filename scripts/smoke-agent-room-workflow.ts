// ─── Agent Room Workflow Smoke Test ─────────────────────────────
// Validates the GatewayHermesRuntime → AgentRoom ordered steps mapping
// without touching the DB, frontend, or AgentRoom facade.
//
// Usage:
//   UPSTREAM=http://127.0.0.1:8642 npm run smoke:agent-room-workflow
//
// Optional env vars:
//   HERMES_GATEWAY_API_KEY   — API key for Authorization header
//   HERMES_AGENT_TIMEOUT_MS  — timeout per phase (default 300000)
//   AGENT_ROOM_INIT_GATEWAY_MANAGER=1 — initialize GatewayManager before resolving profiles

import { GatewayHermesRuntime } from '../packages/server/src/services/hermes/agent-room/runner/runtime/gateway-hermes-runtime'
import type { HermesAgentRuntimeInput } from '../packages/server/src/services/hermes/agent-room/runner/runtime/types'

const UPSTREAM = process.env.UPSTREAM || 'http://127.0.0.1:8642'
const API_KEY = process.env.HERMES_GATEWAY_API_KEY || undefined
const TIMEOUT_MS = Number(process.env.HERMES_AGENT_TIMEOUT_MS || 300_000)
const ASSIGNED_AGENT_ID = process.env.AGENT_ROOM_ASSIGNED_AGENT_ID || undefined
const INIT_GATEWAY_MANAGER = process.env.AGENT_ROOM_INIT_GATEWAY_MANAGER === '1'

async function main(): Promise<void> {
    console.log('─── Agent Room Workflow Smoke Test ───')
    console.log(`upstream:              ${UPSTREAM}`)
    console.log(`timeout:               ${TIMEOUT_MS}ms`)
    console.log(`apiKey:                ${API_KEY ? '(set)' : '(not set)'}`)
    console.log(`assignedAgentId:       ${ASSIGNED_AGENT_ID ?? '(not set)'}`)
    console.log(`initGatewayManager:    ${INIT_GATEWAY_MANAGER}`)
    console.log()

    if (INIT_GATEWAY_MANAGER) {
        console.log('Initializing GatewayManager...')
        const { initGatewayManager } = await import('../packages/server/src/services/gateway-bootstrap')
        await initGatewayManager()
        console.log('GatewayManager initialized.')
        console.log()
    }

    const runtime = new GatewayHermesRuntime(UPSTREAM, API_KEY, TIMEOUT_MS)

    const input: HermesAgentRuntimeInput = {
        taskTitle: 'workflow smoke',
        taskDescription: '请用一句话回复 workflow-ok。',
        currentStatus: 'created',
        sessionId: `agent-room-workflow-smoke-${Date.now()}`,
        taskId: 'task-smoke-001',
        assignedAgentId: ASSIGNED_AGENT_ID,
        revisionRound: 0,
    }

    try {
        const output = await runtime.runTask(input)

        console.log('✅ Workflow smoke passed')
        console.log(`steps:     ${output.steps.length}`)
        console.log(`status chain: ${output.steps.map(s => s.status).join(' → ')}`)
        console.log()

        const lastStep = output.steps[output.steps.length - 1]
        const submittedMessage = lastStep?.messages?.find(m => m.content)
        console.log('─── submitted_for_review message ───')
        console.log(submittedMessage?.content ?? '(no message)')
        console.log()

        console.log('─── artifacts ───')
        if (!output.artifacts || output.artifacts.length === 0) {
            console.log('(no artifacts)')
        } else {
            for (const artifact of output.artifacts) {
                console.log(`name:     ${artifact.name}`)
                console.log(`type:     ${artifact.type}`)
                console.log(`metadata: ${JSON.stringify(artifact.metadata ?? {}, null, 2)}`)
                console.log(`content:  ${artifact.content.slice(0, 200)}${artifact.content.length > 200 ? '...' : ''}`)
                console.log()
            }
        }

        // Basic assertions for smoke validation
        const errors: string[] = []
        if (output.steps.length < 4) {
            errors.push(`Expected at least 4 steps for created path, got ${output.steps.length}`)
        }
        if (lastStep?.status !== 'submitted_for_review') {
            errors.push(`Last step should be submitted_for_review, got ${lastStep?.status}`)
        }
        if (!submittedMessage?.content) {
            errors.push('submitted_for_review step missing message content')
        }
        if (!output.artifacts || output.artifacts.length === 0) {
            errors.push('Expected at least one artifact')
        }
        const codeOutput = output.artifacts?.find(a => a.type === 'code_output')
        if (!codeOutput) {
            errors.push('Expected a code_output artifact')
        }
        if (codeOutput && !codeOutput.metadata?.runId) {
            errors.push('code_output artifact missing metadata.runId')
        }
        if (codeOutput && codeOutput.metadata?.source !== 'hermes-gateway') {
            errors.push('code_output artifact missing metadata.source=hermes-gateway')
        }
        if (ASSIGNED_AGENT_ID && codeOutput?.metadata?.profileName !== ASSIGNED_AGENT_ID) {
            errors.push(`Expected metadata.profileName=${ASSIGNED_AGENT_ID}, got ${codeOutput?.metadata?.profileName}`)
        }
        if (ASSIGNED_AGENT_ID && INIT_GATEWAY_MANAGER && codeOutput?.metadata?.transportSource !== 'gateway-manager') {
            errors.push(`Expected metadata.transportSource=gateway-manager, got ${codeOutput?.metadata?.transportSource}`)
        }
        if (ASSIGNED_AGENT_ID && !INIT_GATEWAY_MANAGER && codeOutput?.metadata?.transportSource !== 'constructor-fallback') {
            errors.push(`Expected metadata.transportSource=constructor-fallback, got ${codeOutput?.metadata?.transportSource}`)
        }

        if (errors.length > 0) {
            console.error('❌ Workflow smoke assertions failed')
            for (const err of errors) {
                console.error(`  - ${err}`)
            }
            process.exit(1)
        }
    } catch (err: unknown) {
        console.error('❌ Workflow smoke failed')
        console.error(`error: ${err instanceof Error ? err.message : String(err)}`)
        process.exit(1)
    }
}

main()
