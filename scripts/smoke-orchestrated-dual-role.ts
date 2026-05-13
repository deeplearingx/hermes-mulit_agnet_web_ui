// ─── Orchestrated Multi-Role Smoke Helper (Triple-Run / Dual-Run) ──
// Validates the planner → developer → reviewer orchestrated workflow
// through the AgentRoom HTTP API. Exercises the full verification chain:
//   create session → set role bindings → create task → start workflow
//   → poll runs → inspect run events → inspect task artifacts
//
// Supports two modes:
//   - Triple-run (reviewer bound): planner → developer → reviewer
//   - Dual-run (no reviewer): planner → developer only
//
// Verification targets:
//   - planner, developer, (optional) reviewer _agentRole in run events
//   - plannerRunId + developerRunId + (optional) reviewerRunId in artifact metadata
//   - final task status = submitted_for_review OR review_passed
//   - last-role upstreamRunId on the run record
//   - code_output artifact with orchestrated-triple-run / orchestrated-dual-run source
//
// Usage (triple-run):
//   AGENT_ROOM_API=http://127.0.0.1:38653 \
//   PLANNER_PROFILE=glm \
//   DEVELOPER_PROFILE=glm \
//   REVIEWER_PROFILE=glm \
//   npm run smoke:orchestrated-dual-role
//
// Usage (dual-run, backward compat):
//   AGENT_ROOM_API=http://127.0.0.1:38649 \
//   PLANNER_PROFILE=my-planner \
//   DEVELOPER_PROFILE=my-developer \
//   npm run smoke:orchestrated-dual-role
//
// Optional env vars:
//   AGENT_ROOM_API          — server base URL (default: http://127.0.0.1:38649)
//   AUTH_TOKEN              — Bearer token for server auth (optional, auto-detected from server config)
//   PLANNER_PROFILE        — Hermes profile name for planner role (required)
//   DEVELOPER_PROFILE      — Hermes profile name for developer role (required)
//   REVIEWER_PROFILE       — Hermes profile name for reviewer role (optional; enables triple-run)
//   AGENT_ROOM_RUNNER      — runner mode: mock | real (default: mock)
//   AGENT_ROOM_RUNTIME     — runtime mode: deterministic | gateway | orchestrated (default: deterministic)
//                             NOTE: this controls script-side logging only. The actual server runtime
//                             is determined by HERMES_AGENT_RUNTIME at server startup time.
//   POLL_INTERVAL_MS       — ms between polls (default: 1000)
//   POLL_TIMEOUT_MS        — max ms to wait for completion (default: 120000)
//   TASK_TITLE             — task title (default: "orchestrated smoke")
//   TASK_DESCRIPTION       — task description (default: "请用一句话回复 smoke-ok。")
//   VERBOSE               — set to 1 for detailed step logging (default: 0)

const API = (process.env.AGENT_ROOM_API || 'http://127.0.0.1:38649').replace(/\/$/, '')
const AUTH_TOKEN = process.env.AUTH_TOKEN || ''  // Bearer token for server auth
const PLANNER_PROFILE = process.env.PLANNER_PROFILE || ''
const DEVELOPER_PROFILE = process.env.DEVELOPER_PROFILE || ''
const REVIEWER_PROFILE = process.env.REVIEWER_PROFILE || ''  // optional; enables triple-run
const RUNNER = process.env.AGENT_ROOM_RUNNER || 'mock'
// Read HERMES_AGENT_RUNTIME (server-side) as primary, fall back to AGENT_ROOM_RUNTIME (script-side)
const RUNTIME = process.env.HERMES_AGENT_RUNTIME || process.env.AGENT_ROOM_RUNTIME || 'deterministic'
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 1000)
const POLL_TIMEOUT_MS = Number(process.env.POLL_TIMEOUT_MS || 120_000)
const TASK_TITLE = process.env.TASK_TITLE || 'orchestrated smoke'
const TASK_DESCRIPTION = process.env.TASK_DESCRIPTION || '请用一句话回复 smoke-ok。'
const VERBOSE = process.env.VERBOSE === '1'

// Derived: whether this run includes a reviewer
const HAS_REVIEWER = !!REVIEWER_PROFILE

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
    const res = await fetch(url, { headers, ...init })
    const text = await res.text()
    let body: any
    try {
        body = JSON.parse(text)
    } catch {
        // Non-JSON response — likely wrong server/port or 404 text page
        const snippet = text.slice(0, 200).replace(/\n/g, ' ')
        if (res.status === 401) {
            throw new Error(
                `HTTP 401 Unauthorized from ${url}. Set AUTH_TOKEN or start server with AUTH_DISABLED=1. ` +
                `(Response snippet: ${snippet})`,
            )
        }
        if (res.status === 404) {
            throw new Error(
                `HTTP 404 Not Found from ${url}. Check AGENT_ROOM_API points to the hermes-web-ui server (default http://127.0.0.1:38649), not the Hermes Agent/Gateway (default http://127.0.0.1:8648). ` +
                `(Response snippet: ${snippet})`,
            )
        }
        throw new Error(
            `Non-JSON response from ${url} (HTTP ${res.status}). ` +
            `Content-Type: ${res.headers.get('content-type') || '(none)'}. ` +
            `Snippet: ${snippet}`,
        )
    }
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
    console.log('─── Orchestrated Multi-Role Smoke Helper (Triple-Run / Dual-Run) ───')
    console.log(`  API:              ${API}`)
    console.log(`  authToken:        ${AUTH_TOKEN ? '(set)' : '(not set)'}`)
    console.log(`  plannerProfile:   ${PLANNER_PROFILE || '(not set)'}`)
    console.log(`  developerProfile: ${DEVELOPER_PROFILE || '(not set)'}`)
    console.log(`  reviewerProfile:  ${REVIEWER_PROFILE || '(not set, dual-run mode)'}`)
    console.log(`  mode:             ${HAS_REVIEWER ? 'triple-run (planner→developer→reviewer)' : 'dual-run (planner→developer)'}`)
    console.log(`  runner:           ${RUNNER}`)
    console.log(`  runtime:          ${RUNTIME}`)
    console.log(`  pollInterval:     ${POLL_INTERVAL_MS}ms`)
    console.log(`  pollTimeout:      ${POLL_TIMEOUT_MS}ms`)
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
        body: JSON.stringify({ name: `orchestrated-smoke-${Date.now()}` }),
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

    // ── Step 3.5: Set reviewer role binding (triple-run only) ─────
    if (HAS_REVIEWER) {
        logStep('Step 3.5: Set reviewer role binding')
        const reviewerBinding = await fetchJson<RoleBinding>(
            `/api/agent-room/sessions/${session.id}/role-bindings/reviewer`,
            { method: 'PUT', body: JSON.stringify({ profileName: REVIEWER_PROFILE }) },
        )
        log(`  reviewer.profileName = ${reviewerBinding.profileName}`)
        assert(reviewerBinding.profileName === REVIEWER_PROFILE, 'reviewer profileName matches')
        assert(reviewerBinding.role === 'reviewer', 'reviewer role is "reviewer"')
    } else {
        logStep('Step 3.5: Reviewer role binding (skipped — no REVIEWER_PROFILE)')
    }

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
    log(`  run.errorMessage = ${completedRun.errorMessage || '(none)'}`)
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
    // In triple-run mode with reviewer auto-accept, status may be "review_passed";
    // in dual-run mode (no reviewer), status is "submitted_for_review".
    // Both are valid success outcomes.
    assert(
        finalTaskFromList.status === 'submitted_for_review' || finalTaskFromList.status === 'review_passed',
        `final task status is "submitted_for_review" or "review_passed" (got: ${finalTaskFromList.status})`,
    )

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

    // Check for reviewer _agentRole (triple-run only, orchestrated/gateway runtime)
    const reviewerEvents = runEvents.filter(e => {
        const payload = e.payload as Record<string, unknown> | undefined
        return payload?._agentRole === 'reviewer'
    })
    log(`  reviewer _agentRole events: ${reviewerEvents.length}`)
    if (HAS_REVIEWER && producesAgentRoleEvents) {
        assert(reviewerEvents.length > 0, 'at least one reviewer _agentRole event exists (triple-run)')
    } else if (!HAS_REVIEWER) {
        log('  (skipped: no reviewer profile — dual-run mode)')
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

        // Print all run IDs (no secrets)
        log(`  plannerRunId:   ${meta.plannerRunId}`)
        log(`  developerRunId: ${meta.developerRunId}`)
        if (meta.reviewerRunId) {
            log(`  reviewerRunId:  ${meta.reviewerRunId}`)
        }

        // In triple-run mode, reviewerRunId should be present
        if (HAS_REVIEWER && producesArtifacts) {
            assert(!!meta.reviewerRunId, 'code_output has reviewerRunId (triple-run)')
        }

        // Allow both old dual-run and new triple-run source values
        const validSources = ['orchestrated-dual-run', 'orchestrated-triple-run', 'mock', 'deterministic']
        assert(
            validSources.includes(meta.source as string),
            `code_output source is valid (got: ${meta.source}, expected one of: ${validSources.join(', ')})`,
        )

        assert(!!meta.plannerProfileName, 'code_output has plannerProfileName')
        assert(!!meta.developerProfileName, 'code_output has developerProfileName')
        if (HAS_REVIEWER && producesArtifacts) {
            assert(!!meta.reviewerProfileName, 'code_output has reviewerProfileName (triple-run)')
        }

        // Verify planner/developer profile names match bindings
        if (RUNNER === 'mock' || RUNTIME === 'deterministic') {
            // In mock/deterministic mode, profile names come from role bindings
            verbose(`  mock mode: skipping profile name exact match (mock uses defaults)`)
        } else {
            assert(meta.plannerProfileName === PLANNER_PROFILE, 'plannerProfileName matches binding')
            assert(meta.developerProfileName === DEVELOPER_PROFILE, 'developerProfileName matches binding')
            if (HAS_REVIEWER) {
                assert(meta.reviewerProfileName === REVIEWER_PROFILE, 'reviewerProfileName matches binding')
            }
        }
    }

    // ── Step 10: Verify upstreamRunId semantics ───────────────────
    logStep('Step 10: Verify upstreamRunId semantics')
    if (completedRun.upstreamRunId) {
        log(`  run.upstreamRunId = ${completedRun.upstreamRunId}`)
        // In triple-run mode, upstreamRunId should be the reviewer's run ID (last-wins).
        // In dual-run mode, upstreamRunId should be the developer's run ID.
        const meta = codeOutput?.metadata || {}
        if (HAS_REVIEWER && meta.reviewerRunId) {
            assert(
                completedRun.upstreamRunId === meta.reviewerRunId,
                'upstreamRunId matches reviewerRunId (reviewer-last semantics in triple-run)',
            )
        } else if (meta.developerRunId) {
            assert(
                completedRun.upstreamRunId === meta.developerRunId,
                'upstreamRunId matches developerRunId (developer-last semantics in dual-run)',
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
    const reviewerWfEvents = taskEvents.filter(e => e.agentRole === 'reviewer')
    log(`  planner workflow events: ${plannerWfEvents.length}`)
    log(`  developer workflow events: ${developerWfEvents.length}`)
    log(`  reviewer workflow events: ${reviewerWfEvents.length}`)
    assert(plannerWfEvents.length > 0, 'at least one planner workflow event')
    assert(developerWfEvents.length > 0, 'at least one developer workflow event')
    if (HAS_REVIEWER) {
        assert(reviewerWfEvents.length > 0, 'at least one reviewer workflow event (triple-run)')
    }

    // ── Summary ───────────────────────────────────────────────────
    const modeLabel = HAS_REVIEWER ? 'triple-run' : 'dual-run'
    console.log(`\n─── Smoke Result (${modeLabel}) ───`)
    if (errors.length > 0) {
        console.error(`❌ ${errors.length} assertion(s) failed:`)
        for (const e of errors) console.error(`  - ${e}`)
        process.exit(1)
    } else {
        console.log(`✅ All assertions passed — orchestrated ${modeLabel} smoke passed`)
        console.log()
        console.log('Validated:')
        console.log('  ✓ Session creation')
        console.log('  ✓ Planner role binding')
        console.log('  ✓ Developer role binding')
        if (HAS_REVIEWER) console.log('  ✓ Reviewer role binding')
        console.log('  ✓ Task creation')
        console.log('  ✓ Async workflow start')
        console.log('  ✓ Run completion via polling')
        console.log(`  ✓ Final task status (${finalTaskFromList.status})`)
        if (producesAgentRoleEvents) {
            console.log('  ✓ Planner _agentRole in run events')
            console.log('  ✓ Developer _agentRole in run events')
            if (HAS_REVIEWER) console.log('  ✓ Reviewer _agentRole in run events')
        } else {
            console.log('  ⊘ Planner/developer/reviewer _agentRole (skipped: mock/deterministic mode)')
        }
        if (producesArtifacts && codeOutput) {
            console.log('  ✓ plannerRunId + developerRunId' + (HAS_REVIEWER ? ' + reviewerRunId' : '') + ' in artifact metadata')
            console.log('  ✓ code_output artifact with valid source')
        } else {
            console.log('  ⊘ Artifact metadata (skipped: mock/deterministic mode)')
        }
        if (completedRun.upstreamRunId) {
            console.log(`  ✓ upstreamRunId ${HAS_REVIEWER ? 'reviewer' : 'developer'}-last semantics`)
        } else {
            console.log('  ⊘ upstreamRunId (skipped: not set in mock/deterministic mode)')
        }
        console.log(`  ✓ Workflow events with planner + developer${HAS_REVIEWER ? ' + reviewer' : ''} agent roles`)
    }
}

main().catch((err: unknown) => {
    console.error('❌ Smoke helper failed with error:')
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
})
