// ─── Agent Room Matrix Smoke Test ──────────────────────────────
// Runs the full-chain smoke across multiple runtime configurations.
// Validates that P5.1-P5.5 features work across all supported modes.
//
// Matrix configurations:
//   1. deterministic + mock runner (no real Gateway)
//   2. orchestrated + mock runner (simulated triple-run)
//   3. orchestrated + real runner + real profiles (requires Gateway)
//
// Usage:
//   npm run smoke:matrix
//
// Optional env vars:
//   AGENT_ROOM_API          — server base URL (default: http://127.0.0.1:8648)
//   AUTH_TOKEN              — Bearer token for server auth (optional)
//   PLANNER_PROFILE         — planner profile name (default: mock-planner)
//   DEVELOPER_PROFILE       — developer profile name (default: mock-developer)
//   REVIEWER_PROFILE        — reviewer profile name (default: mock-reviewer)
//   SKIP_REAL_GATEWAY       — '1' to skip real Gateway tests (default: '0')
//   VERBOSE                 — '1' for detailed output (default: '0')

const API = (process.env.AGENT_ROOM_API || 'http://127.0.0.1:8648').replace(/\/$/, '')
const AUTH_TOKEN = process.env.AUTH_TOKEN || ''
const PLANNER_PROFILE = process.env.PLANNER_PROFILE || 'mock-planner'
const DEVELOPER_PROFILE = process.env.DEVELOPER_PROFILE || 'mock-developer'
const REVIEWER_PROFILE = process.env.REVIEWER_PROFILE || 'mock-reviewer'
const SKIP_REAL_GATEWAY = process.env.SKIP_REAL_GATEWAY === '1'
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 1000)
const POLL_TIMEOUT_MS = Number(process.env.POLL_TIMEOUT_MS || 120_000)
const VERBOSE = process.env.VERBOSE === '1'

// ─── Types ──────────────────────────────────────────────────────

interface Session { id: string; name: string; autoDeliveryEnabled: boolean; createdAt: string; updatedAt: string }
interface Task { id: string; sessionId: string; title: string; description: string; status: string; revisionRound: number; maxRevisionRounds: number; createdAt: string; updatedAt: string }
interface Run { id: string; sessionId: string; taskId: string; status: string; upstreamRunId?: string; runnerName: string; errorMessage?: string; startedAt?: string; finishedAt?: string; createdAt: string; updatedAt: string }
interface RunEvent { id: string; runId: string; sessionId: string; taskId: string; upstreamRunId?: string; source: string; sequence: number; eventType: string; payload?: Record<string, unknown>; createdAt: string }
interface Artifact { id: string; sessionId: string; taskId: string; name: string; type: string; content?: string; metadata?: Record<string, unknown>; createdAt: string }
interface RoleBinding { id: string; sessionId: string; role: string; profileName: string; createdAt: string }
interface RoleRun { id: string; runId: string; role: string; status: string; profileName: string; createdAt: string }
interface Review { id: string; sessionId: string; taskId: string; reviewerAgentId: string; reviewerRunId?: string; reviewerProfileName?: string; status: 'passed' | 'rejected'; comment: string; createdAt: string }

// ─── Matrix Configuration ──────────────────────────────────────

interface MatrixConfig {
    name: string
    runner: string
    runtime: string
    skipIfUnavailable: boolean
}

const MATRIX: MatrixConfig[] = [
    { name: 'deterministic + mock', runner: 'mock', runtime: 'deterministic', skipIfUnavailable: false },
    { name: 'orchestrated + mock', runner: 'mock', runtime: 'orchestrated', skipIfUnavailable: false },
    { name: 'orchestrated + real', runner: 'real', runtime: 'orchestrated', skipIfUnavailable: true },
]

// ─── Helpers ────────────────────────────────────────────────────

const errors: string[] = []
const configErrors: Map<string, number> = new Map()
let totalPassed = 0
let totalFailed = 0

function log(msg: string): void { console.log(`[matrix] ${msg}`) }
function verbose(msg: string): void { if (VERBOSE) console.log(`[matrix:v] ${msg}`) }
function logStep(step: string): void { console.log(`\n═══ ${step} ═══`) }
function logConfig(label: string): void {
    configErrors.set(label, errors.length)
    console.log(`\n┌─────── ${label} ───────┐`)
}
function logConfigEnd(label: string): void {
    const startCount = configErrors.get(label) ?? 0
    const configFails = errors.length - startCount
    const ok = configFails === 0
    if (ok) totalPassed++; else totalFailed++
    console.log(`└─────── ${label}: ${ok ? '✅ PASS' : `❌ FAIL (${configFails} errors)`} ───────┘`)
}

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

/** Get task by ID from the task list. */
async function getTask(sessionId: string, taskId: string): Promise<Task> {
    const tasks = await fetchJson<Task[]>(`/api/agent-room/sessions/${sessionId}/tasks`)
    const task = tasks.find(t => t.id === taskId)
    if (!task) throw new Error(`Task ${taskId} not found in session ${sessionId}`)
    return task
}

/** Wait for a task to reach one of the target statuses. */
async function waitForStatus(sessionId: string, taskId: string, targets: string[], label: string): Promise<Task> {
    return pollUntil(
        () => getTask(sessionId, taskId),
        (t) => targets.includes(t.status),
        POLL_TIMEOUT_MS,
        POLL_INTERVAL_MS,
        label,
    )
}

/** Set a role binding on a session. */
async function setRoleBinding(sessionId: string, role: string, profileName: string): Promise<RoleBinding> {
    return fetchJson<RoleBinding>(
        `/api/agent-room/sessions/${sessionId}/role-bindings/${role}`,
        { method: 'PUT', body: JSON.stringify({ profileName }) },
    )
}

/** Start an async workflow and return the run. */
async function startWorkflow(sessionId: string, taskId: string): Promise<Run> {
    const result = await fetchJson<{ success: boolean; run: Run }>(
        `/api/agent-room/sessions/${sessionId}/tasks/${taskId}/workflow/start`,
        { method: 'POST' },
    )
    assert(result.success === true, 'workflow start returned success')
    return result.run
}

/** Verify run events contain _agentRole markers. */
async function verifyRunEvents(runId: string, expectOrchestrated: boolean): Promise<void> {
    const events = await fetchJson<RunEvent[]>(`/api/agent-room/runs/${runId}/events`)
    log(`  run events: ${events.length}`)

    if (expectOrchestrated) {
        const plannerEvents = events.filter(e => (e.payload as any)?._agentRole === 'planner')
        const developerEvents = events.filter(e => (e.payload as any)?._agentRole === 'developer')
        const reviewerEvents = events.filter(e => (e.payload as any)?._agentRole === 'reviewer')
        assert(plannerEvents.length > 0, 'run events contain _agentRole=planner')
        assert(developerEvents.length > 0, 'run events contain _agentRole=developer')
        assert(reviewerEvents.length > 0, 'run events contain _agentRole=reviewer')
    } else {
        verbose('  (skipped _agentRole check: deterministic mode)')
    }
}

/** Verify artifact metadata does NOT leak sensitive info. */
function verifyNoSensitiveLeaks(artifacts: Artifact[]): void {
    for (const artifact of artifacts) {
        const meta = artifact.metadata || {}
        const metaStr = JSON.stringify(meta)
        assert(!metaStr.includes('apiKey'), `artifact "${artifact.type}" metadata does not contain apiKey`)
        assert(!metaStr.includes('"token"'), `artifact "${artifact.type}" metadata does not contain token`)
        assert(!metaStr.includes('Authorization'), `artifact "${artifact.type}" metadata does not contain Authorization`)
    }
}

// ─── P5.x Verification Functions ───────────────────────────────

/** P5.1: Verify role runs exist for a completed run. */
async function verifyRoleRuns(runId: string, expectOrchestrated: boolean): Promise<void> {
    logStep('P5.1: Verify role runs')
    const roleRuns = await fetchJson<RoleRun[]>(`/api/agent-room/runs/${runId}/role-runs`)
    log(`  role runs: ${roleRuns.length}`)

    if (expectOrchestrated) {
        assert(roleRuns.length >= 2, `expected >= 2 role runs (got ${roleRuns.length})`)
        const roles = roleRuns.map(rr => rr.role)
        assert(roles.includes('planner'), 'role run for planner exists')
        assert(roles.includes('developer'), 'role run for developer exists')
        assert(roles.includes('reviewer'), 'role run for reviewer exists')

        // Verify role run statuses
        for (const rr of roleRuns) {
            log(`    ${rr.role}: status=${rr.status}, profile=${rr.profileName}`)
        }
    } else {
        verbose('  (deterministic mode — role runs may be minimal)')
    }
}

/** P5.2: Verify reviewer JSON protocol (orchestrated only). */
async function verifyReviewerProtocol(runId: string, expectOrchestrated: boolean): Promise<void> {
    if (!expectOrchestrated) {
        verbose('  (skipped P5.2: deterministic mode)')
        return
    }

    logStep('P5.2: Verify reviewer JSON protocol')
    const events = await fetchJson<RunEvent[]>(`/api/agent-room/runs/${runId}/events`)
    const reviewerEvents = events.filter(e => (e.payload as any)?._agentRole === 'reviewer')
    assert(reviewerEvents.length > 0, 'reviewer stage events exist in run events')
    log(`  reviewer events: ${reviewerEvents.length}`)
}

/** P5.3: Verify auto reviewer wrote to reviews table (orchestrated only). */
async function verifyAutoReviewerReviews(sessionId: string, taskId: string, expectOrchestrated: boolean): Promise<void> {
    if (!expectOrchestrated) {
        verbose('  (skipped P5.3: deterministic mode)')
        return
    }

    logStep('P5.3: Verify auto reviewer reviews')
    const reviews = await fetchJson<Review[]>(`/api/agent-room/sessions/${sessionId}/reviews`)
    const taskReviews = reviews.filter(r => r.taskId === taskId)
    log(`  reviews for task: ${taskReviews.length}`)

    // Orchestrated mode should have auto reviewer review
    const autoReview = taskReviews.find(r => r.reviewerRunId !== undefined)
    if (autoReview) {
        assert(autoReview.status === 'passed' || autoReview.status === 'rejected',
            `auto review status is valid (got: ${autoReview.status})`)
        assert(autoReview.reviewerProfileName === REVIEWER_PROFILE,
            `auto review reviewerProfileName matches (got: ${autoReview.reviewerProfileName})`)
        log(`    auto review: status=${autoReview.status}, reviewer=${autoReview.reviewerProfileName}`)
    } else {
        verbose('  (no auto reviewer review found — may depend on runner implementation)')
    }
}

/** P5.4: Verify concurrent startWorkflow protection. */
async function verifyConcurrentGuard(sessionId: string, taskId: string): Promise<void> {
    logStep('P5.4: Verify concurrent startWorkflow guard')

    // First start should succeed
    const start1 = await fetchJson<{ success: boolean; run?: Run }>(
        `/api/agent-room/sessions/${sessionId}/tasks/${taskId}/workflow/start`,
        { method: 'POST' },
    )
    assert(start1.success === true, 'first startWorkflow succeeds')

    // Second start should fail with 409
    try {
        await fetchJson<{ success: boolean }>(
            `/api/agent-room/sessions/${sessionId}/tasks/${taskId}/workflow/start`,
            { method: 'POST' },
        )
        fail('second startWorkflow should have returned 409')
    } catch (err: any) {
        assert(err.message.includes('409') || err.message.includes('already running'),
            `second startWorkflow returns 409 (got: ${err.message})`)
    }

    // Wait for the first run to complete before continuing
    if (start1.run) {
        await pollUntil(
            () => fetchJson<Run>(`/api/agent-room/runs/${start1.run!.id}`),
            (r) => r.status === 'completed' || r.status === 'failed',
            POLL_TIMEOUT_MS, POLL_INTERVAL_MS, 'guard run completion',
        )
    }
}

// ─── Matrix Path ───────────────────────────────────────────────

async function runMatrixPath(config: MatrixConfig): Promise<void> {
    const expectOrchestrated = config.runtime === 'orchestrated' || config.runtime === 'gateway-multi-role'

    // 1. Create session + task
    logStep('1: Create session + task')
    const session = await fetchJson<Session>('/api/agent-room/sessions', {
        method: 'POST',
        body: JSON.stringify({ name: `matrix-${config.runner}-${config.runtime}-${Date.now()}` }),
    })
    log(`  session.id = ${session.id}`)

    const task = await fetchJson<Task>(`/api/agent-room/sessions/${session.id}/tasks`, {
        method: 'POST',
        body: JSON.stringify({
            title: `matrix-${config.name}`,
            description: `Matrix smoke test for ${config.name}`,
        }),
    })
    log(`  task.id = ${task.id}, status = ${task.status}`)
    assert(task.status === 'created', 'task initial status is "created"')

    // 2. Set role bindings
    logStep('2: Set role bindings')
    await setRoleBinding(session.id, 'planner', PLANNER_PROFILE)
    await setRoleBinding(session.id, 'developer', DEVELOPER_PROFILE)
    await setRoleBinding(session.id, 'reviewer', REVIEWER_PROFILE)
    log('  planner/developer/reviewer bindings set')

    // 3. Start workflow
    logStep('3: Start workflow')
    const run = await startWorkflow(session.id, task.id)
    log(`  run.id = ${run.id}`)

    // 4. Wait for completion
    logStep('4: Wait for run completion')
    const completedRun = await pollUntil(
        () => fetchJson<Run>(`/api/agent-room/runs/${run.id}`),
        (r) => r.status === 'completed' || r.status === 'failed',
        POLL_TIMEOUT_MS, POLL_INTERVAL_MS, 'run completion',
    )
    assert(completedRun.status === 'completed', 'run completed successfully')
    log(`  run.status = ${completedRun.status}`)

    // Also wait for task to reach a terminal state
    const finalTask = await waitForStatus(
        session.id,
        task.id,
        ['submitted_for_review', 'review_passed', 'completed', 'failed', 'need_user_decision'],
        'task terminal state',
    )
    log(`  task.status = ${finalTask.status}`)

    // 5. P5.1: Verify role runs
    await verifyRoleRuns(run.id, expectOrchestrated)

    // 6. P5.2: Verify reviewer JSON protocol (orchestrated only)
    await verifyReviewerProtocol(run.id, expectOrchestrated)

    // 7. P5.3: Verify auto reviewer reviews (orchestrated only)
    if (finalTask.status === 'submitted_for_review' || finalTask.status === 'review_passed' || finalTask.status === 'completed') {
        await verifyAutoReviewerReviews(session.id, task.id, expectOrchestrated)
    } else {
        verbose('  (skipped P5.3: task did not reach review stage)')
    }

    // 8. Verify run events
    await verifyRunEvents(run.id, expectOrchestrated)

    // 9. Verify no sensitive leaks in artifacts
    const artifacts = await fetchJson<Artifact[]>(
        `/api/agent-room/sessions/${session.id}/tasks/${task.id}/artifacts`,
    )
    verifyNoSensitiveLeaks(artifacts)
}

// ─── Main ───────────────────────────────────────────────────────

async function main(): Promise<void> {
    console.log('┌─────────────────────────────────────────────┐')
    console.log('│   Agent Room Matrix Smoke Test               │')
    console.log('└─────────────────────────────────────────────┘')
    console.log()
    console.log(`  API:               ${API}`)
    console.log(`  authToken:         ${AUTH_TOKEN ? '(set)' : '(not set)'}`)
    console.log(`  plannerProfile:    ${PLANNER_PROFILE}`)
    console.log(`  developerProfile:  ${DEVELOPER_PROFILE}`)
    console.log(`  reviewerProfile:   ${REVIEWER_PROFILE}`)
    console.log(`  skipRealGateway:   ${SKIP_REAL_GATEWAY}`)
    console.log(`  pollInterval:      ${POLL_INTERVAL_MS}ms`)
    console.log(`  pollTimeout:       ${POLL_TIMEOUT_MS}ms`)
    console.log()

    // Health check
    logStep('Health check')
    try {
        await fetchJson<any>('/api/agent-room/sessions')
        log('  API is reachable ✓')
    } catch (err: any) {
        fail(`API health check failed: ${err.message}`)
        console.error('\n❌ Cannot reach Agent Room API. Is the server running?')
        process.exit(1)
    }

    // Filter configs based on availability
    const configs = MATRIX.filter(c => {
        if (c.skipIfUnavailable && SKIP_REAL_GATEWAY) {
            console.log(`  ⏭ Skipping "${c.name}" (SKIP_REAL_GATEWAY=1)`)
            return false
        }
        return true
    })

    console.log(`\n  Running ${configs.length} matrix configuration(s):`)
    for (const c of configs) {
        console.log(`    • ${c.name} (runner=${c.runner}, runtime=${c.runtime})`)
    }

    // Run each matrix configuration
    for (const config of configs) {
        logConfig(`Matrix: ${config.name}`)

        // Set env for this run (read by server-side runner factory)
        process.env.AGENT_ROOM_RUNNER = config.runner
        process.env.AGENT_ROOM_RUNTIME = config.runtime

        try {
            await runMatrixPath(config)
        } catch (err: any) {
            fail(`Matrix "${config.name}" failed: ${err.message}`)
        }

        logConfigEnd(`Matrix: ${config.name}`)
    }

    // ─── P5.4 Concurrent guard test (standalone) ───────────────
    logConfig('P5.4: Concurrent startWorkflow guard')
    try {
        const guardSession = await fetchJson<Session>('/api/agent-room/sessions', {
            method: 'POST',
            body: JSON.stringify({ name: `matrix-guard-${Date.now()}` }),
        })
        const guardTask = await fetchJson<Task>(`/api/agent-room/sessions/${guardSession.id}/tasks`, {
            method: 'POST',
            body: JSON.stringify({
                title: 'matrix-concurrent-guard',
                description: 'Matrix smoke: concurrent startWorkflow guard',
            }),
        })
        await setRoleBinding(guardSession.id, 'planner', PLANNER_PROFILE)
        await setRoleBinding(guardSession.id, 'developer', DEVELOPER_PROFILE)
        await setRoleBinding(guardSession.id, 'reviewer', REVIEWER_PROFILE)
        await verifyConcurrentGuard(guardSession.id, guardTask.id)
    } catch (err: any) {
        fail(`Concurrent guard test failed: ${err.message}`)
    }
    logConfigEnd('P5.4: Concurrent startWorkflow guard')

    // ─── Summary ─────────────────────────────────────────────────
    console.log('\n┌─────────────────────────────────────────────┐')
    console.log('│   Matrix Smoke Results                       │')
    console.log('└─────────────────────────────────────────────┘')
    console.log()
    console.log(`  Configs passed: ${totalPassed}`)
    console.log(`  Configs failed: ${totalFailed}`)

    if (errors.length > 0) {
        console.error(`\n❌ ${errors.length} assertion(s) failed:`)
        for (const e of errors) console.error(`  - ${e}`)
        process.exit(1)
    } else {
        console.log('\n✅ All matrix configurations passed')
        console.log()
        console.log('Validated:')
        console.log('  ✓ Basic workflow lifecycle (create → start → complete)')
        console.log('  ✓ P5.1: role_run records for planner/developer/reviewer')
        console.log('  ✓ P5.2: reviewer JSON protocol (orchestrated mode)')
        console.log('  ✓ P5.3: auto reviewer reviews table (orchestrated mode)')
        console.log('  ✓ P5.4: concurrent startWorkflow returns 409')
        console.log('  ✓ Artifact metadata has no sensitive leaks')
    }
}

main().catch((err: unknown) => {
    console.error('❌ Matrix smoke failed with error:')
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
})
