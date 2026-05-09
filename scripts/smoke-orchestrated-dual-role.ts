// ─── Orchestrated Dual-Role Smoke Helper ─────────────────────────
// Validates the planner → developer dual-run orchestration through the
// AgentRoom HTTP API. Exercises the full verification chain:
//   create session → set role bindings → create task → start workflow
//   → poll runs → inspect run events → inspect task artifacts
//
// Verification targets:
//   - planner _agentRole in run events
//   - developer _agentRole in run events
//   - plannerRunId + developerRunId in artifact metadata
//   - final task status = submitted_for_review
//   - developer-last upstreamRunId on the run record
//   - code_output artifact with orchestrated-dual-run source
//
// Usage:
//   AGENT_ROOM_API=http://127.0.0.1:8648 \
//   PLANNER_PROFILE=my-planner \
//   DEVELOPER_PROFILE=my-developer \
//   npm run smoke:orchestrated-dual-role
//
// Optional env vars:
//   AGENT_ROOM_API          — server base URL (default: http://127.0.0.1:8648)
//   AUTH_TOKEN              — Bearer token for server auth (optional, auto-detected from server config)
//   PLANNER_PROFILE        — Hermes profile name for planner role (required)
//   DEVELOPER_PROFILE      — Hermes profile name for developer role (required)
//   AGENT_ROOM_RUNNER      — runner mode: mock | real (default: mock)
//   AGENT_ROOM_RUNTIME     — runtime mode: deterministic | gateway | orchestrated (default: deterministic)
//   POLL_INTERVAL_MS       — ms between polls (default: 1000)
//   POLL_TIMEOUT_MS        — max ms to wait for completion (default: 120000)
//   TASK_TITLE             — task title (default: "dual-role smoke")
//   TASK_DESCRIPTION       — task description (default: "请用一句话回复 dual-role-ok。")
//   VERBOSE               — set to 1 for detailed step logging (default: 0)

const API = (process.env.AGENT_ROOM_API || 'http://127.0.0.1:8648').replace(/\/$/, '')
const AUTH_TOKEN = process.env.AUTH_TOKEN || ''  // Bearer token for server auth
const PLANNER_PROFILE = process.env.PLANNER_PROFILE || ''
const DEVELOPER_PROFILE = process.env.DEVELOPER_PROFILE || ''
const RUNNER = process.env.AGENT_ROOM_RUNNER || 'mock'
const RUNTIME = process.env.AGENT_ROOM_RUNTIME || 'deterministic'
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 1000)
const POLL_TIMEOUT_MS = Number(process.env.POLL_TIMEOUT_MS || 120_000)
const TASK_TITLE = process.env.TASK_TITLE || 'dual-role smoke'
const TASK_DESCRIPTION = process.env.TASK_DESCRIPTION || '请用一句话回复 dual-role-ok。'
const VERBOSE = process.env.VERBOSE === '1'

// ─── Types ───────────────────────────────────────────────────────

interface Session { id: string; name: string; createdAt: string; updatedAt: string }
interface Task { id: string; sessionId: string; title: string; description: string; status: string; revisionRound: number; createdAt: string; updatedAt: string }
interface Run { id: string; sessionId: string; taskId: string; status: string; upstreamRunId?: string; runnerName: string; errorMessage?: string; startedAt?: string; finishedAt?: string; createdAt: string; updatedAt: string }
interface RunEvent { id: string; runId: string; sessionId: string; taskId: string; upstreamRunId?: string; source: string; sequence: number; eventType: string; payload?: Record<string, unknown>; createdAt: string }
interface Artifact { id: string; sessionId: string; taskId: string; name: string; type: string; content?: string; metadata?: Record<string, unknown>; createdAt: string }
interface RoleBinding { id: string; sessionId: string; role: string; profileName: string; createdAt: string }
interface WorkflowEvent { id: string; sessionId: string; taskId: string; type: string; agentId: string; agentRole: string; payload?: Record<string, unknown>; createdAt: string }

// ─── Helpers ─────────────────────────────────────────────────────

function log(msg: string): void {
    console.log(`[smoke] ${msg}`)
}

function verbose(msg: string): void {
    if (VERBOSE) console.log(`[smoke:verbose] ${msg}`)
}

function logStep(step: string): void {
    console.log(`\n═══ ${step} ═══`)
}

const errors: string[] = []

function fail(msg: string): void {
    errors.push(msg)
    console.error(`  ✗ ${msg}`)
}

function assert(condition: boolean, msg: string): void {
    if (!condition) fail(msg)
    else verbose(`  ✓ ${msg}`)
}

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
    const url = `${API}${path}`
    verbose(`  → ${init?.method || 'GET'} ${url}`)
    const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(init?.headers as Record<string, string>) }
    if (AUTH_TOKEN) headers['Authorization'] = `Bearer ${AUTH_TOKEN}`
    const res = await fetch(url, {
        headers,
        ...init,
    })
    const body = await res.json() as any
    if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${body.error || JSON.stringify(body)}`)
    }
    return body as T
}

async function pollUntil<T>(
    fn: () => Promise<T>,
    predicate: (result: T) => boolean,
    timeoutMs: number,
    intervalMs: number,
    label: string,
): Promise<T> {
    const start = Date.now()
    let lastResult: T | undefined
    while (Date.now() - start < timeoutMs) {
        lastResult = await fn()
        if (predicate(lastResult)) return lastResult
        await new Promise(r => setTimeout(r, intervalMs))
    }
    throw new Error(`Poll timeout for "${label}" after ${timeoutMs}ms. Last result: ${JSON.stringify(lastResult)}`)
}

// ─── Main ────────────────────────────────────────────────────────

async function main(): Promise<void> {
    console.log('─── Orchestrated Dual-Role Smoke Helper ───')
    console.log(`  API:             ${API}`)
    console.log(`  authToken:       ${AUTH_TOKEN ? '(set)' : '(not set)'}`)
    console.log(`  plannerProfile:  ${PLANNER_PROFILE || '(not set)'}`)
    console.log(`  developerProfile:${DEVELOPER_PROFILE || '(not set)'}`)
    console.log(`  runner:          ${RUNNER}`)
    console.log(`  runtime:         ${RUNTIME}`)
    console.log(`  pollInterval:    ${POLL_INTERVAL_MS}ms`)
    console.log(`  pollTimeout:     ${POLL_TIMEOUT_MS}ms`)
    console.log()

    // Validate required env vars
    if (!PLANNER_PROFILE) fail('PLANNER_PROFILE env var is required')
    if (!DEVELOPER_PROFILE) fail('DEVELOPER_PROFILE env var is required')
    if (errors.length > 0) {
        console.error('\n❌ Missing required configuration:')
        for (const e of errors) console.error(`  - ${e}`)
        process.exit(1)
    }

    // ── Step 1: Create session ────────────────────────────────────
    logStep('Step 1: Create session')
    const session = await fetchJson<Session>('/api/agent-room/sessions', {
        method: 'POST',
        body: JSON.stringify({ name: `dual-role-smoke-${Date.now()}` }),
    })
    log(`  session.id = ${session.id}`)

    // ── Step 2: Set planner role binding ──────────────────────────
    logStep('Step 2: Set planner role binding')
    const plannerBinding = await fetchJson<RoleBinding>(
        `/api/agent-room/sessions/${session.id}/role-bindings/planner`,
        { method: 'PUT', body: JSON.stringify({ profileName: PLANNER_PROFILE }) },
    )
    log(`  planner.profileName = ${plannerBinding.profileName}`)
    assert(plannerBinding.profileName === PLANNER_PROFILE, 'planner profileName matches')
    assert(plannerBinding.role === 'planner', 'planner role is "planner"')

    // ── Step 3: Set developer role binding ────────────────────────
    logStep('Step 3: Set developer role binding')
    const developerBinding = await fetchJson<RoleBinding>(
        `/api/agent-room/sessions/${session.id}/role-bindings/developer`,
        { method: 'PUT', body: JSON.stringify({ profileName: DEVELOPER_PROFILE }) },
    )
    log(`  developer.profileName = ${developerBinding.profileName}`)
    assert(developerBinding.profileName === DEVELOPER_PROFILE, 'developer profileName matches')
    assert(developerBinding.role === 'developer', 'developer role is "developer"')

    // ── Step 4: Create task ───────────────────────────────────────
    logStep('Step 4: Create task')
    const task = await fetchJson<Task>(`/api/agent-room/sessions/${session.id}/tasks`, {
        method: 'POST',
        body: JSON.stringify({ title: TASK_TITLE, description: TASK_DESCRIPTION }),
    })
    log(`  task.id = ${task.id}`)
    log(`  task.status = ${task.status}`)
    assert(task.status === 'created', 'task initial status is "created"')

    // ── Step 5: Start workflow ────────────────────────────────────
    logStep('Step 5: Start workflow (async)')
    const startResult = await fetchJson<{ success: boolean; run?: Run }>(
        `/api/agent-room/sessions/${session.id}/tasks/${task.id}/workflow/start`,
        { method: 'POST' },
    )
    assert(startResult.success === true, 'workflow start returned success')
    const run = startResult.run!
    log(`  run.id = ${run.id}`)
    log(`  run.status = ${run.status}`)
    assert(run.status === 'queued' || run.status === 'running', 'run initial status is queued or running')

    // ── Step 6: Poll for run completion ───────────────────────────
    logStep('Step 6: Poll for run completion')
    const completedRun = await pollUntil<Run>(
        () => fetchJson<Run>(`/api/agent-room/runs/${run.id}`),
        (r) => r.status === 'completed' || r.status === 'failed',
        POLL_TIMEOUT_MS,
        POLL_INTERVAL_MS,
        'run completion',
    )
    log(`  run.status = ${completedRun.status}`)
    log(`  run.upstreamRunId = ${completedRun.upstreamRunId || '(none)'}`)
    assert(completedRun.status === 'completed', 'run completed successfully')

    // ── Step 7: Verify task status ────────────────────────────────
    logStep('Step 7: Verify task status')
    const finalTask = await fetchJson<Task>(
        `/api/agent-room/sessions/${session.id}/tasks/${task.id}/status`,
    ).catch(() => null)
    // Fallback: get task from list
    const tasks = await fetchJson<Task[]>(`/api/agent-room/sessions/${session.id}/tasks`)
    const finalTaskFromList = tasks.find(t => t.id === task.id)!
    log(`  task.status = ${finalTaskFromList.status}`)
    assert(finalTaskFromList.status === 'submitted_for_review', 'final task status is "submitted_for_review"')

    // Determine if orchestrated runtime is active (produces _agentRole events + artifacts)
    const isOrchestratedRuntime = RUNTIME === 'orchestrated' || RUNTIME === 'gateway-multi-role'
    const isGatewayRuntime = RUNTIME === 'gateway' || RUNTIME === 'real'
    const producesAgentRoleEvents = isOrchestratedRuntime || isGatewayRuntime
    const producesArtifacts = isOrchestratedRuntime || isGatewayRuntime

    // ── Step 8: Inspect run events ────────────────────────────────
    logStep('Step 8: Inspect run events')
    const runEvents = await fetchJson<RunEvent[]>(`/api/agent-room/runs/${run.id}/events`)
    log(`  total run events: ${runEvents.length}`)

    // Check for planner _agentRole (only in orchestrated/gateway runtime)
    const plannerEvents = runEvents.filter(e => {
        const payload = e.payload as Record<string, unknown> | undefined
        return payload?._agentRole === 'planner'
    })
    log(`  planner _agentRole events: ${plannerEvents.length}`)
    if (producesAgentRoleEvents) {
        assert(plannerEvents.length > 0, 'at least one planner _agentRole event exists')
    } else {
        log('  (skipped: mock/deterministic runtime does not produce _agentRole run events)')
    }

    // Check for developer _agentRole (only in orchestrated/gateway runtime)
    const developerEvents = runEvents.filter(e => {
        const payload = e.payload as Record<string, unknown> | undefined
        return payload?._agentRole === 'developer'
    })
    log(`  developer _agentRole events: ${developerEvents.length}`)
    if (producesAgentRoleEvents) {
        assert(developerEvents.length > 0, 'at least one developer _agentRole event exists')
    } else {
        log('  (skipped: mock/deterministic runtime does not produce _agentRole run events)')
    }

    // Check for step events
    const stepEvents = runEvents.filter(e => e.eventType.startsWith('step:'))
    log(`  step events: ${stepEvents.length}`)
    for (const evt of stepEvents) {
        verbose(`    step: ${evt.eventType} (source=${evt.source})`)
    }

    // ── Step 9: Inspect task artifacts ────────────────────────────
    logStep('Step 9: Inspect task artifacts')
    const artifacts = await fetchJson<Artifact[]>(
        `/api/agent-room/sessions/${session.id}/tasks/${task.id}/artifacts`,
    )
    log(`  total artifacts: ${artifacts.length}`)
    if (producesArtifacts) {
        assert(artifacts.length > 0, 'at least one artifact exists')
    } else {
        log('  (skipped: mock/deterministic runtime does not produce artifacts via RunnerResult)')
    }

    const codeOutput = artifacts.find(a => a.type === 'code_output')
    if (producesArtifacts) {
        assert(!!codeOutput, 'code_output artifact exists')
    }
    if (codeOutput) {
        log(`  code_output.name = ${codeOutput.name}`)
        log(`  code_output.metadata = ${JSON.stringify(codeOutput.metadata, null, 2)}`)

        const meta = codeOutput.metadata || {}
        assert(!!meta.plannerRunId, 'code_output has plannerRunId')
        assert(!!meta.developerRunId, 'code_output has developerRunId')
        assert(meta.source === 'orchestrated-dual-run' || meta.source === 'mock' || meta.source === 'deterministic',
            `code_output source is valid (got: ${meta.source})`)
        assert(!!meta.plannerProfileName, 'code_output has plannerProfileName')
        assert(!!meta.developerProfileName, 'code_output has developerProfileName')

        // Verify planner/developer profile names match bindings
        if (RUNNER === 'mock' || RUNTIME === 'deterministic') {
            // In mock/deterministic mode, profile names come from role bindings
            verbose(`  mock mode: skipping profile name exact match (mock uses defaults)`)
        } else {
            assert(meta.plannerProfileName === PLANNER_PROFILE, 'plannerProfileName matches binding')
            assert(meta.developerProfileName === DEVELOPER_PROFILE, 'developerProfileName matches binding')
        }
    }

    // ── Step 10: Verify upstreamRunId semantics ───────────────────
    logStep('Step 10: Verify upstreamRunId semantics')
    if (completedRun.upstreamRunId) {
        log(`  run.upstreamRunId = ${completedRun.upstreamRunId}`)
        // In orchestrated mode, upstreamRunId should be the developer's run ID (last-wins)
        if (codeOutput?.metadata?.developerRunId) {
            assert(
                completedRun.upstreamRunId === codeOutput.metadata.developerRunId,
                'upstreamRunId matches developerRunId (developer-last semantics)',
            )
        }
    } else {
        log('  run.upstreamRunId is empty (expected in mock/deterministic mode)')
    }

    // ── Step 11: Inspect workflow events ──────────────────────────
    logStep('Step 11: Inspect workflow events')
    const workflowEvents = await fetchJson<WorkflowEvent[]>(
        `/api/agent-room/sessions/${session.id}/events`,
    )
    log(`  total workflow events: ${workflowEvents.length}`)

    const taskEvents = workflowEvents.filter(e => e.taskId === task.id)
    log(`  task-scoped events: ${taskEvents.length}`)

    const expectedEventTypes = ['task_created', 'task_planned', 'task_assigned', 'task_started', 'task_submitted']
    for (const expected of expectedEventTypes) {
        const found = taskEvents.some(e => e.type === expected)
        assert(found, `workflow event "${expected}" exists`)
    }

    // Verify agent roles in workflow events
    const plannerWfEvents = taskEvents.filter(e => e.agentRole === 'planner')
    const developerWfEvents = taskEvents.filter(e => e.agentRole === 'developer')
    log(`  planner workflow events: ${plannerWfEvents.length}`)
    log(`  developer workflow events: ${developerWfEvents.length}`)
    assert(plannerWfEvents.length > 0, 'at least one planner workflow event')
    assert(developerWfEvents.length > 0, 'at least one developer workflow event')

    // ── Summary ───────────────────────────────────────────────────
    console.log('\n─── Smoke Result ───')
    if (errors.length > 0) {
        console.error(`❌ ${errors.length} assertion(s) failed:`)
        for (const e of errors) console.error(`  - ${e}`)
        process.exit(1)
    } else {
        console.log('✅ All assertions passed — orchestrated dual-role smoke passed')
        console.log()
        console.log('Validated:')
        console.log('  ✓ Session creation')
        console.log('  ✓ Planner role binding')
        console.log('  ✓ Developer role binding')
        console.log('  ✓ Task creation')
        console.log('  ✓ Async workflow start')
        console.log('  ✓ Run completion via polling')
        console.log('  ✓ Final task status = submitted_for_review')
        if (producesAgentRoleEvents) {
            console.log('  ✓ Planner _agentRole in run events')
            console.log('  ✓ Developer _agentRole in run events')
        } else {
            console.log('  ⊘ Planner/developer _agentRole (skipped: mock/deterministic mode)')
        }
        if (producesArtifacts && codeOutput) {
            console.log('  ✓ plannerRunId + developerRunId in artifact metadata')
            console.log('  ✓ code_output artifact with valid source')
        } else {
            console.log('  ⊘ Artifact metadata (skipped: mock/deterministic mode)')
        }
        if (completedRun.upstreamRunId) {
            console.log('  ✓ upstreamRunId developer-last semantics')
        } else {
            console.log('  ⊘ upstreamRunId (skipped: not set in mock/deterministic mode)')
        }
        console.log('  ✓ Workflow events with planner + developer agent roles')
    }
}

main().catch((err: unknown) => {
    console.error('❌ Smoke helper failed with error:')
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
})
