// ─── Agent Room Matrix Smoke Test ──────────────────────────────
// Runs the full-chain smoke across multiple runtime configurations.
// Validates that P5.1-P5.5 features work across all supported modes.
//
// Each matrix config spawns an independent server subprocess with its own
// PORT, AGENT_ROOM_RUNNER, and HERMES_AGENT_RUNTIME — no in-process env
// mutation that would fail to affect the already-initialized server.
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
//   AUTH_TOKEN              — Bearer token for server auth (optional)
//   PLANNER_PROFILE         — planner profile name (default: mock-planner)
//   DEVELOPER_PROFILE       — developer profile name (default: mock-developer)
//   REVIEWER_PROFILE        — reviewer profile name (default: mock-reviewer)
//   SKIP_REAL_GATEWAY           — '1' to skip real Gateway tests (default: '0')
//   SKIP_REVIEWER_BRANCH_SMOKE — '1' to skip reviewer branch smoke (default: '0')
//   VERBOSE                     — '1' for detailed output (default: '0')
//   BASE_PORT                   — starting port for matrix configs (default: 18748)

import { spawn, type ChildProcess } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { randomUUID } from 'node:crypto'

const AUTH_TOKEN = process.env.AUTH_TOKEN || ''
const PLANNER_PROFILE = process.env.PLANNER_PROFILE || 'mock-planner'
const DEVELOPER_PROFILE = process.env.DEVELOPER_PROFILE || 'mock-developer'
const REVIEWER_PROFILE = process.env.REVIEWER_PROFILE || 'mock-reviewer'
const SKIP_REAL_GATEWAY = process.env.SKIP_REAL_GATEWAY === '1'
const SKIP_REVIEWER_BRANCH_SMOKE = process.env.SKIP_REVIEWER_BRANCH_SMOKE === '1'
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 1000)
const POLL_TIMEOUT_MS = Number(process.env.POLL_TIMEOUT_MS || 120_000)
const VERBOSE = process.env.VERBOSE === '1'
const BASE_PORT = Number(process.env.BASE_PORT || 18748)
const DEFAULT_UPSTREAM = process.env.UPSTREAM || 'http://127.0.0.1:8642'
const SERVER_READY_TIMEOUT_MS = Number(process.env.SERVER_READY_TIMEOUT_MS || 30_000)

// ─── Types ──────────────────────────────────────────────────────

interface Session { id: string; name: string; autoDeliveryEnabled: boolean; createdAt: string; updatedAt: string }
interface Task { id: string; sessionId: string; title: string; description: string; status: string; revisionRound: number; maxRevisionRounds: number; createdAt: string; updatedAt: string }
interface Run { id: string; sessionId: string; taskId: string; status: string; upstreamRunId?: string; runnerName: string; errorMessage?: string; startedAt?: string; finishedAt?: string; createdAt: string; updatedAt: string }
interface RunEvent { id: string; runId: string; sessionId: string; taskId: string; upstreamRunId?: string; roleRunId?: string; source: string; sequence: number; eventType: string; payload?: Record<string, unknown>; createdAt: string }
interface Artifact { id: string; sessionId: string; taskId: string; name: string; type: string; content?: string; metadata?: Record<string, unknown>; createdAt: string }
interface RoleBinding { id: string; sessionId: string; role: string; profileName: string; createdAt: string }
interface RoleRun { id: string; runId: string; role: string; status: string; profileName: string; upstreamRunId?: string; createdAt: string }
interface Review { id: string; sessionId: string; taskId: string; reviewerAgentId: string; reviewerRunId?: string; reviewerProfileName?: string; reviewDecision?: 'approved' | 'revision_required' | 'need_user_decision'; reviewFeedback?: string; metadata?: Record<string, unknown>; status: 'passed' | 'rejected'; comment: string; createdAt: string }
interface Message { id: string; sessionId: string; senderId: string; senderName: string; senderRole: string; type: string; content: string; metadata?: Record<string, unknown>; createdAt: string }
interface WorkflowEvent { id: string; sessionId: string; taskId: string; type: string; agentId: string; agentRole: string; payload?: Record<string, unknown>; createdAt: string }

// ─── P6.5: Reviewer Branch Smoke Types ─────────────────────────

interface ReviewerBranch {
    decision: 'approved' | 'revision_required' | 'need_user_decision'
    expectedTaskStatus: 'review_passed' | 'revision_required' | 'need_user_decision'
    expectedReviewStatus: 'passed' | 'rejected'
    feedback: string
    fakeOutput: string
}

const REVIEWER_BRANCHES: ReviewerBranch[] = [
    {
        decision: 'approved',
        expectedTaskStatus: 'review_passed',
        expectedReviewStatus: 'passed',
        feedback: 'Branch approved',
        fakeOutput: '{"decision":"approved","feedback":"Branch approved","issues":[],"confidence":0.98}',
    },
    {
        decision: 'revision_required',
        expectedTaskStatus: 'revision_required',
        expectedReviewStatus: 'rejected',
        feedback: 'Branch requires revision',
        fakeOutput: '{"decision":"revision_required","feedback":"Branch requires revision","issues":["Missing error handling"],"confidence":0.77}',
    },
    {
        decision: 'need_user_decision',
        expectedTaskStatus: 'need_user_decision',
        expectedReviewStatus: 'rejected',
        feedback: 'Branch needs user decision',
        fakeOutput: '{"decision":"need_user_decision","feedback":"Branch needs user decision","issues":["Ambiguous requirement"],"confidence":0.66}',
    },
]

// ─── Matrix Configuration ──────────────────────────────────────

interface MatrixConfig {
    name: string
    runner: string
    runtime: string
    port: number
    upstream?: string
    skipIfUnavailable: boolean
}

const MATRIX: MatrixConfig[] = [
    { name: 'deterministic + mock', runner: 'mock', runtime: 'deterministic', port: BASE_PORT, skipIfUnavailable: false },
    { name: 'orchestrated + mock', runner: 'mock', runtime: 'orchestrated', port: BASE_PORT + 1, skipIfUnavailable: false },
    { name: 'orchestrated + real', runner: 'real', runtime: 'orchestrated', port: BASE_PORT + 2, skipIfUnavailable: true },
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

// ─── Per-config API helpers ─────────────────────────────────────

async function fetchJson<T>(apiBase: string, path: string, init?: RequestInit): Promise<T> {
    const url = `${apiBase}${path}`
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
async function getTask(apiBase: string, sessionId: string, taskId: string): Promise<Task> {
    const tasks = await fetchJson<Task[]>(apiBase, `/api/agent-room/sessions/${sessionId}/tasks`)
    const task = tasks.find(t => t.id === taskId)
    if (!task) throw new Error(`Task ${taskId} not found in session ${sessionId}`)
    return task
}

/** Wait for a task to reach one of the target statuses. */
async function waitForStatus(apiBase: string, sessionId: string, taskId: string, targets: string[], label: string): Promise<Task> {
    return pollUntil(
        () => getTask(apiBase, sessionId, taskId),
        (t) => targets.includes(t.status),
        POLL_TIMEOUT_MS,
        POLL_INTERVAL_MS,
        label,
    )
}

/** Set a role binding on a session. */
async function setRoleBinding(apiBase: string, sessionId: string, role: string, profileName: string): Promise<RoleBinding> {
    return fetchJson<RoleBinding>(
        apiBase,
        `/api/agent-room/sessions/${sessionId}/role-bindings/${role}`,
        { method: 'PUT', body: JSON.stringify({ profileName }) },
    )
}

/** Start an async workflow and return the run. */
async function startWorkflow(apiBase: string, sessionId: string, taskId: string): Promise<Run> {
    const result = await fetchJson<{ success: boolean; run: Run }>(
        apiBase,
        `/api/agent-room/sessions/${sessionId}/tasks/${taskId}/workflow/start`,
        { method: 'POST' },
    )
    assert(result.success === true, 'workflow start returned success')
    return result.run
}

/** Manually deliver a task that is in review_passed status. */
async function manualDeliverTask(apiBase: string, sessionId: string, taskId: string): Promise<Task> {
    return fetchJson<Task>(
        apiBase,
        `/api/agent-room/sessions/${sessionId}/tasks/${taskId}/deliver`,
        { method: 'POST' },
    )
}

/** P7.1: Verify manual delivery runtime assertions — role_run, artifact linkage, event payload. */
async function verifyManualDeliveryRuntime(
    apiBase: string,
    sessionId: string,
    taskId: string,
    runId: string,
    branchName: string,
): Promise<void> {
    // Get delivery role_run
    const roleRuns = await fetchJson<RoleRun[]>(apiBase, `/api/agent-room/runs/${runId}/role-runs`)
    const deliveryRoleRun = roleRuns.find(rr => rr.role === 'delivery')
    assert(deliveryRoleRun !== undefined, `${branchName}: delivery role_run exists`)
    if (deliveryRoleRun) {
        assert(deliveryRoleRun.status === 'completed',
            `${branchName}: delivery role_run.status === 'completed' (got: '${deliveryRoleRun.status}')`)
        log(`    delivery role_run: id=${deliveryRoleRun.id}, status=${deliveryRoleRun.status}`)
    }

    // Get final_delivery artifact
    const artifacts = await fetchJson<Artifact[]>(
        apiBase,
        `/api/agent-room/sessions/${sessionId}/tasks/${taskId}/artifacts`,
    )
    const finalDelivery = artifacts.find(a => a.type === 'final_delivery')
    assert(finalDelivery !== undefined, `${branchName}: final_delivery artifact exists`)
    if (finalDelivery && deliveryRoleRun) {
        assert(finalDelivery.metadata?.deliveryRoleRunId === deliveryRoleRun.id,
            `${branchName}: artifact metadata.deliveryRoleRunId matches delivery role_run id`)
        assert(finalDelivery.metadata?.deliveryRunId === deliveryRoleRun.runId,
            `${branchName}: artifact metadata.deliveryRunId matches delivery role_run runId`)
    }

    // Check messages for final_delivery
    const messages = await fetchJson<Message[]>(apiBase, `/api/agent-room/sessions/${sessionId}/messages`)
    const deliveryMsgs = messages.filter(m => m.type === 'final_delivery')
    assert(deliveryMsgs.length > 0, `${branchName}: final_delivery message exists`)

    // Check workflow events for delivery_started / delivery_completed
    const workflowEvents = await fetchJson<WorkflowEvent[]>(
        apiBase,
        `/api/agent-room/sessions/${sessionId}/events`,
    )
    const eventTypes = workflowEvents.map(e => e.type)
    assert(eventTypes.includes('delivery_started'), `${branchName}: delivery_started workflow event exists`)
    assert(eventTypes.includes('delivery_completed'), `${branchName}: delivery_completed workflow event exists`)

    // Check delivery event payloads have deliveryRoleRunId
    if (deliveryRoleRun) {
        const deliveryStarted = workflowEvents.find(e => e.type === 'delivery_started')
        const deliveryCompleted = workflowEvents.find(e => e.type === 'delivery_completed')
        if (deliveryStarted?.payload) {
            assert(deliveryStarted.payload.deliveryRoleRunId === deliveryRoleRun.id,
                `${branchName}: delivery_started payload.deliveryRoleRunId matches`)
        }
        if (deliveryCompleted?.payload) {
            assert(deliveryCompleted.payload.deliveryRoleRunId === deliveryRoleRun.id,
                `${branchName}: delivery_completed payload.deliveryRoleRunId matches`)
        }
    }
}

/** Verify run events contain _agentRole markers (only when real runner + orchestrated runtime). */
async function verifyRunEvents(apiBase: string, runId: string, expectRealOrchestrated: boolean): Promise<void> {
    const events = await fetchJson<RunEvent[]>(apiBase, `/api/agent-room/runs/${runId}/events`)
    log(`  run events: ${events.length}`)

    if (expectRealOrchestrated) {
        // _agentRole markers are only set by orchestrated gateway runtime hooks
        // which require the real runner to actually execute the multi-role pipeline
        const plannerEvents = events.filter(e => (e.payload as any)?._agentRole === 'planner')
        const developerEvents = events.filter(e => (e.payload as any)?._agentRole === 'developer')
        const reviewerEvents = events.filter(e => (e.payload as any)?._agentRole === 'reviewer')
        assert(plannerEvents.length > 0, 'run events contain _agentRole=planner')
        assert(developerEvents.length > 0, 'run events contain _agentRole=developer')
        assert(reviewerEvents.length > 0, 'run events contain _agentRole=reviewer')
    } else {
        verbose('  (skipped _agentRole check: mock runner does not set _agentRole markers)')
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

// ─── Server lifecycle ──────────────────────────────────────────

/** Spawn a server subprocess for a specific matrix config. */
function startServer(config: MatrixConfig): ChildProcess {
    const serverEnv: Record<string, string> = {
        ...process.env as Record<string, string>,
        PORT: String(config.port),
        AGENT_ROOM_RUNNER: config.runner,
        HERMES_AGENT_RUNTIME: config.runtime,
        UPSTREAM: config.upstream ?? DEFAULT_UPSTREAM,
        TS_NODE_PROJECT: 'packages/server/tsconfig.json',
        AUTH_DISABLED: '1',
    }

    log(`  Starting server: PORT=${config.port}, AGENT_ROOM_RUNNER=${config.runner}, HERMES_AGENT_RUNTIME=${config.runtime}, UPSTREAM=${serverEnv.UPSTREAM}`)

    const child = spawn(process.execPath, [
        '-r', 'ts-node/register',
        'packages/server/src/index.ts',
    ], {
        cwd: process.cwd(),
        env: serverEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
    })

    child.stdout.on('data', (data: Buffer) => {
        if (VERBOSE) process.stdout.write(`  [server:${config.port}] ${data}`)
    })
    child.stderr.on('data', (data: Buffer) => {
        process.stderr.write(`  [server:${config.port}:err] ${data}`)
    })

    return child
}

/** Wait for the server to respond to GET /api/agent-room/sessions. */
async function waitForServerReady(apiBase: string, timeoutMs: number): Promise<void> {
    const start = Date.now()
    let lastErr: unknown
    while (Date.now() - start < timeoutMs) {
        try {
            await fetchJson<unknown>(apiBase, '/api/agent-room/sessions')
            log(`  Server ready at ${apiBase} (${Date.now() - start}ms)`)
            return
        } catch (err) {
            lastErr = err
            await new Promise(r => setTimeout(r, 500))
        }
    }
    throw new Error(`Server at ${apiBase} not ready after ${timeoutMs}ms. Last error: ${lastErr}`)
}

/** Stop a server subprocess gracefully (SIGTERM → SIGKILL fallback). */
async function stopServer(proc: ChildProcess, label: string): Promise<void> {
    return new Promise<void>((resolve) => {
        if (proc.exitCode !== null) {
            verbose(`  Server ${label} already exited (code=${proc.exitCode})`)
            resolve()
            return
        }

        const killTimeout = setTimeout(() => {
            verbose(`  Server ${label} did not exit after SIGTERM, sending SIGKILL`)
            proc.kill('SIGKILL')
        }, 5000)

        proc.on('exit', (code, signal) => {
            clearTimeout(killTimeout)
            verbose(`  Server ${label} exited (code=${code}, signal=${signal})`)
            resolve()
        })

        proc.kill('SIGTERM')
    })
}

// ─── P5.x Verification Functions ───────────────────────────────

/** P5.1: Verify role runs exist for a completed run. */
async function verifyRoleRuns(apiBase: string, runId: string, config: MatrixConfig): Promise<void> {
    logStep('P5.1: Verify role runs')
    const roleRuns = await fetchJson<RoleRun[]>(apiBase, `/api/agent-room/runs/${runId}/role-runs`)
    log(`  role runs: ${roleRuns.length}`)

    const isRealOrchestrated = config.runner === 'real' && (config.runtime === 'orchestrated' || config.runtime === 'gateway-multi-role')

    if (isRealOrchestrated) {
        // Real orchestrated: role runs should be actively executed (not skipped)
        assert(roleRuns.length >= 2, `expected >= 2 role runs (got ${roleRuns.length})`)
        const roles = roleRuns.map(rr => rr.role)
        assert(roles.includes('planner'), 'role run for planner exists')
        assert(roles.includes('developer'), 'role run for developer exists')
        assert(roles.includes('reviewer'), 'role run for reviewer exists')
        for (const rr of roleRuns) {
            assert(rr.status !== 'skipped', `role run ${rr.role} should not be skipped in real orchestrated mode`)
            log(`    ${rr.role}: status=${rr.status}, profile=${rr.profileName}`)
        }
    } else if (config.runtime === 'orchestrated') {
        // Orchestrated + mock: role runs are created but skipped (mock runner doesn't execute them)
        log(`  orchestrated + mock: role runs exist with skipped status (expected)`)
        for (const rr of roleRuns) {
            log(`    ${rr.role}: status=${rr.status}, profile=${rr.profileName}`)
        }
        if (roleRuns.length > 0) {
            const roles = roleRuns.map(rr => rr.role)
            assert(roles.includes('planner'), 'role run for planner exists')
            assert(roles.includes('developer'), 'role run for developer exists')
            assert(roles.includes('reviewer'), 'role run for reviewer exists')
        }
    } else {
        // Deterministic + mock: role runs may be created with skipped status when bindings exist
        verbose(`  deterministic mode: role runs=${roleRuns.length} (created from bindings, status=skipped)`)
        for (const rr of roleRuns) {
            verbose(`    ${rr.role}: status=${rr.status}, profile=${rr.profileName}`)
        }
    }
}

/** P5.2: Verify reviewer JSON protocol (orchestrated only). */
async function verifyReviewerProtocol(apiBase: string, runId: string, expectOrchestrated: boolean): Promise<void> {
    if (!expectOrchestrated) {
        verbose('  (skipped P5.2: deterministic mode)')
        return
    }

    logStep('P5.2: Verify reviewer JSON protocol')
    const events = await fetchJson<RunEvent[]>(apiBase, `/api/agent-room/runs/${runId}/events`)
    const reviewerEvents = events.filter(e => (e.payload as any)?._agentRole === 'reviewer')
    assert(reviewerEvents.length > 0, 'reviewer stage events exist in run events')
    log(`  reviewer events: ${reviewerEvents.length}`)
}

/** P5.3: Verify auto reviewer wrote to reviews table (orchestrated only). */
async function verifyAutoReviewerReviews(apiBase: string, sessionId: string, taskId: string, expectOrchestrated: boolean): Promise<void> {
    if (!expectOrchestrated) {
        verbose('  (skipped P5.3: deterministic mode)')
        return
    }

    logStep('P5.3: Verify auto reviewer reviews')
    const reviews = await fetchJson<Review[]>(apiBase, `/api/agent-room/sessions/${sessionId}/reviews`)
    const taskReviews = reviews.filter(r => r.taskId === taskId)
    log(`  reviews for task: ${taskReviews.length}`)

    // Orchestrated mode should have auto reviewer review
    const autoReview = taskReviews.find(r => r.reviewerRunId !== undefined)
    if (autoReview) {
        assert(autoReview.status === 'passed' || autoReview.status === 'rejected',
            `auto review status is valid (got: ${autoReview.status})`)
        // P6.2: Top-level flattened fields
        assert(autoReview.reviewerRunId !== undefined, 'auto review reviewerRunId is readable at top level')
        assert(autoReview.reviewerProfileName === REVIEWER_PROFILE,
            `auto review reviewerProfileName matches (got: ${autoReview.reviewerProfileName})`)
        assert(autoReview.reviewDecision !== undefined, 'auto review reviewDecision is readable at top level')
        assert(autoReview.reviewFeedback !== undefined, 'auto review reviewFeedback is readable at top level')
        // metadata still preserved
        assert(autoReview.metadata !== undefined, 'auto review metadata still preserved')
        assert(autoReview.metadata?.reviewerRunId === autoReview.reviewerRunId, 'metadata.reviewerRunId matches top-level')
        assert(autoReview.metadata?.reviewDecision === autoReview.reviewDecision, 'metadata.reviewDecision matches top-level')
        log(`    auto review: status=${autoReview.status}, reviewer=${autoReview.reviewerProfileName}, decision=${autoReview.reviewDecision}`)
    } else {
        verbose('  (no auto reviewer review found — may depend on runner implementation)')
    }
}

/** P5.4: Verify concurrent startWorkflow protection. */
async function verifyConcurrentGuard(apiBase: string, sessionId: string, taskId: string): Promise<void> {
    logStep('P5.4: Verify concurrent startWorkflow guard')

    // First start should succeed
    const start1 = await fetchJson<{ success: boolean; run?: Run }>(
        apiBase,
        `/api/agent-room/sessions/${sessionId}/tasks/${taskId}/workflow/start`,
        { method: 'POST' },
    )
    assert(start1.success === true, 'first startWorkflow succeeds')

    // Second start should fail with 409
    try {
        await fetchJson<{ success: boolean }>(
            apiBase,
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
            () => fetchJson<Run>(apiBase, `/api/agent-room/runs/${start1.run!.id}`),
            (r) => r.status === 'completed' || r.status === 'failed',
            POLL_TIMEOUT_MS, POLL_INTERVAL_MS, 'guard run completion',
        )
    }
}

// ─── P6.5: Fake Gateway Helper ──────────────────────────────────
// Lightweight HTTP server that implements the Hermes Gateway protocol
// (POST /v1/runs + GET /v1/runs/:run_id/events SSE) with deterministic
// reviewer outputs. Used by reviewer branch smoke to control the three
// reviewer decision branches without external LLM dependencies.

interface FakeGatewayHandle {
    server: Server
    port: number
}

/**
 * Start a fake Gateway server that returns controllable reviewer outputs.
 *
 * The server inspects the session_id in POST /v1/runs to determine the role:
 *   - session_id contains "planner"  → plain planner text
 *   - session_id contains "developer" → plain developer text
 *   - session_id contains "reviewer"  → the branch's JSON reviewer output
 *
 * For planner/developer, a simple text response is returned.
 * For the reviewer, the branch's fakeOutput JSON is returned.
 *
 * SSE events emitted per run:
 *   run.created  → { id: runId }
 *   run.completed → { output: <text> }
 */
function startFakeGateway(branch: ReviewerBranch, port: number): FakeGatewayHandle {
    // Track run_id → { sessionId, output } for SSE retrieval
    const runStore = new Map<string, { sessionId: string; output: string }>()

    const server = createServer((req, res) => {
        const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)

        // ── POST /v1/runs ────────────────────────────────────────
        if (req.method === 'POST' && url.pathname === '/v1/runs') {
            let body = ''
            req.on('data', (chunk: Buffer) => { body += chunk.toString() })
            req.on('end', () => {
                try {
                    const parsed = JSON.parse(body) as Record<string, unknown>
                    const sessionId = String(parsed.session_id || '')
                    const runId = `fake-${randomUUID().slice(0, 8)}`

                    let output: string
                    if (sessionId.includes('reviewer')) {
                        output = branch.fakeOutput
                    } else if (sessionId.includes('planner')) {
                        output = `Planner output for task (fake gateway, branch=${branch.decision})`
                    } else {
                        output = `Developer output for task (fake gateway, branch=${branch.decision})`
                    }

                    runStore.set(runId, { sessionId, output })

                    res.writeHead(200, { 'Content-Type': 'application/json' })
                    res.end(JSON.stringify({ run_id: runId }))
                } catch {
                    res.writeHead(400, { 'Content-Type': 'application/json' })
                    res.end(JSON.stringify({ error: 'Invalid JSON body' }))
                }
            })
            return
        }

        // ── GET /v1/runs/:run_id/events (SSE) ────────────────────
        const eventsMatch = url.pathname.match(/^\/v1\/runs\/([^/]+)\/events$/)
        if (req.method === 'GET' && eventsMatch) {
            const runId = eventsMatch[1]
            const entry = runStore.get(runId)

            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive',
            })

            res.write(`data: ${JSON.stringify({ event: 'run.created', data: { id: runId } })}\n\n`)
            res.write(`data: ${JSON.stringify({ event: 'run.completed', output: entry?.output ?? 'no output' })}\n\n`)
            res.end()
            return
        }

        // ── Fallback ─────────────────────────────────────────────
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Not found' }))
    })

    server.listen(port, '127.0.0.1')
    return { server, port }
}

/** Stop a fake Gateway server gracefully. */
function stopFakeGateway(handle: FakeGatewayHandle): Promise<void> {
    return new Promise<void>((resolve) => {
        handle.server.close(() => resolve())
    })
}

// ─── P6.5: Reviewer Branch Smoke ────────────────────────────────
// Each branch spawns its own Agent Room server + fake Gateway subprocess.
// Validates: task.status, reviews table, reviewer role_run, run_events,
// and review_result messages.

/** Unique port counter for reviewer branch smoke (avoids collisions with matrix). */
const REVIEWER_BRANCH_BASE_PORT = BASE_PORT + 100

/**
 * Run a single reviewer branch smoke test.
 * Returns true if all assertions pass, false otherwise.
 */
async function runSingleReviewerBranch(
    branch: ReviewerBranch,
    branchIndex: number,
): Promise<boolean> {
    const branchName = `reviewer-branch: ${branch.decision}`
    const serverPort = REVIEWER_BRANCH_BASE_PORT + branchIndex * 2
    const fakeGwPort = REVIEWER_BRANCH_BASE_PORT + branchIndex * 2 + 1
    const apiBase = `http://127.0.0.1:${serverPort}`

    logConfig(branchName)
    log(`  decision           = ${branch.decision}`)
    log(`  expectedTaskStatus = ${branch.expectedTaskStatus}`)
    log(`  serverPort         = ${serverPort}`)
    log(`  fakeGwPort         = ${fakeGwPort}`)

    let fakeGw: FakeGatewayHandle | null = null
    let serverProc: ChildProcess | null = null

    try {
        // 1. Start fake Gateway
        logStep('Fake Gateway: start')
        fakeGw = startFakeGateway(branch, fakeGwPort)
        log(`  Fake Gateway listening on port ${fakeGwPort}`)

        // 2. Start Agent Room server with real runner + orchestrated runtime
        logStep('Server: spawn')
        const serverEnv: Record<string, string> = {
            ...process.env as Record<string, string>,
            PORT: String(serverPort),
            AGENT_ROOM_RUNNER: 'real',
            HERMES_AGENT_RUNTIME: 'orchestrated',
            UPSTREAM: `http://127.0.0.1:${fakeGwPort}`,
            TS_NODE_PROJECT: 'packages/server/tsconfig.json',
            AUTH_DISABLED: '1',
            GATEWAY_MANAGER_DISABLED: '1',
        }
        serverProc = spawn(process.execPath, [
            '-r', 'ts-node/register',
            'packages/server/src/index.ts',
        ], {
            cwd: process.cwd(),
            env: serverEnv,
            stdio: ['ignore', 'pipe', 'pipe'],
        })
        serverProc.stderr?.on('data', (data: Buffer) => {
            process.stderr.write(`  [server:${serverPort}:err] ${data}`)
        })
        if (VERBOSE) {
            serverProc.stdout?.on('data', (data: Buffer) => {
                process.stdout.write(`  [server:${serverPort}] ${data}`)
            })
        }

        // 3. Wait for server ready
        logStep('Server: wait for ready')
        await waitForServerReady(apiBase, SERVER_READY_TIMEOUT_MS)

        // 4. Create session + task + bindings
        logStep('Create session + task + bindings')
        const session = await fetchJson<Session>(apiBase, '/api/agent-room/sessions', {
            method: 'POST',
            body: JSON.stringify({ name: `branch-${branch.decision}-${Date.now()}` }),
        })
        log(`  session.id = ${session.id}`)

        const task = await fetchJson<Task>(apiBase, `/api/agent-room/sessions/${session.id}/tasks`, {
            method: 'POST',
            body: JSON.stringify({
                title: `branch-${branch.decision}`,
                description: `Reviewer branch smoke for ${branch.decision}`,
            }),
        })
        log(`  task.id = ${task.id}, status = ${task.status}`)

        await setRoleBinding(apiBase, session.id, 'planner', PLANNER_PROFILE)
        await setRoleBinding(apiBase, session.id, 'developer', DEVELOPER_PROFILE)
        await setRoleBinding(apiBase, session.id, 'reviewer', REVIEWER_PROFILE)

        // 5. Start workflow
        logStep('Start workflow')
        const run = await startWorkflow(apiBase, session.id, task.id)
        log(`  run.id = ${run.id}`)

        // 6. Wait for run completion
        logStep('Wait for run completion')
        const completedRun = await pollUntil(
            () => fetchJson<Run>(apiBase, `/api/agent-room/runs/${run.id}`),
            (r) => r.status === 'completed' || r.status === 'failed',
            POLL_TIMEOUT_MS, POLL_INTERVAL_MS, `${branchName} run completion`,
        )
        assert(completedRun.status === 'completed', `${branchName}: run completed successfully`)
        log(`  run.status = ${completedRun.status}`)

        // 7. Wait for task to reach expected status
        logStep('Wait for task status')
        const finalTask = await waitForStatus(
            apiBase, session.id, task.id,
            [branch.expectedTaskStatus, 'failed'],
            `${branchName} task status`,
        )
        assert(finalTask.status === branch.expectedTaskStatus,
            `${branchName}: task.status === '${branch.expectedTaskStatus}' (got: '${finalTask.status}')`)
        log(`  task.status = ${finalTask.status}`)

        // 8. Assert reviews table
        logStep('Assert reviews table')
        const reviews = await fetchJson<Review[]>(apiBase, `/api/agent-room/sessions/${session.id}/reviews`)
        const taskReviews = reviews.filter(r => r.taskId === task.id)
        log(`  reviews for task: ${taskReviews.length}`)
        assert(taskReviews.length > 0, `${branchName}: at least one review exists for task`)

        const autoReview = taskReviews.find(r => r.reviewerRunId !== undefined)
        assert(autoReview !== undefined, `${branchName}: auto reviewer review exists`)

        if (autoReview) {
            assert(autoReview.status === branch.expectedReviewStatus,
                `${branchName}: review.status === '${branch.expectedReviewStatus}' (got: '${autoReview.status}')`)
            assert(autoReview.reviewDecision === branch.decision,
                `${branchName}: review.reviewDecision === '${branch.decision}' (got: '${autoReview.reviewDecision}')`)
            assert(autoReview.reviewFeedback === branch.feedback,
                `${branchName}: review.reviewFeedback === '${branch.feedback}' (got: '${autoReview.reviewFeedback}')`)
            assert(!!autoReview.reviewerRunId, `${branchName}: review.reviewerRunId exists`)
            assert(autoReview.reviewerProfileName === REVIEWER_PROFILE,
                `${branchName}: review.reviewerProfileName === '${REVIEWER_PROFILE}' (got: '${autoReview.reviewerProfileName}')`)
            // metadata assertions
            assert(autoReview.metadata?.source === 'orchestrated-reviewer',
                `${branchName}: metadata.source === 'orchestrated-reviewer'`)
            assert(autoReview.metadata?.reviewDecision === branch.decision,
                `${branchName}: metadata.reviewDecision === '${branch.decision}'`)
            assert(autoReview.metadata?.reviewFeedback === branch.feedback,
                `${branchName}: metadata.reviewFeedback === '${branch.feedback}'`)
            log(`    auto review: status=${autoReview.status}, decision=${autoReview.reviewDecision}, feedback=${autoReview.reviewFeedback}`)
        }

        // 9. Assert reviewer role_run completed
        logStep('Assert reviewer role_run')
        const roleRuns = await fetchJson<RoleRun[]>(apiBase, `/api/agent-room/runs/${run.id}/role-runs`)
        const reviewerRoleRun = roleRuns.find(rr => rr.role === 'reviewer')
        assert(reviewerRoleRun !== undefined, `${branchName}: reviewer role_run exists`)
        if (reviewerRoleRun) {
            assert(reviewerRoleRun.status === 'completed',
                `${branchName}: reviewer role_run.status === 'completed' (got: '${reviewerRoleRun.status}')`)
            assert(!!reviewerRoleRun.upstreamRunId,
                `${branchName}: reviewer role_run.upstreamRunId exists`)
            log(`    reviewer role_run: status=${reviewerRoleRun.status}, upstreamRunId=${reviewerRoleRun.upstreamRunId}`)
        }

        // 10. Assert run_events have reviewer role_run_id marker
        logStep('Assert run_events reviewer markers')
        const events = await fetchJson<RunEvent[]>(apiBase, `/api/agent-room/runs/${run.id}/events`)
        const reviewerEvents = events.filter(e => (e.payload as any)?._agentRole === 'reviewer')
        assert(reviewerEvents.length > 0, `${branchName}: run_events contain _agentRole=reviewer markers`)

        // Also check roleRunId on events if available
        if (reviewerRoleRun) {
            const roleRunIdEvents = events.filter(e => e.roleRunId === reviewerRoleRun.id)
            if (roleRunIdEvents.length > 0) {
                verbose(`  ${branchName}: ${roleRunIdEvents.length} events with reviewer roleRunId`)
            } else {
                verbose(`  ${branchName}: no events with explicit roleRunId (using _agentRole marker instead)`)
            }
        }

        // 11. Assert messages have review_result
        logStep('Assert messages review_result')
        const messages = await fetchJson<Message[]>(apiBase, `/api/agent-room/sessions/${session.id}/messages`)
        const taskReviewMessages = messages.filter(
            m => m.type === 'review_result' && (m.metadata?.taskId === task.id || m.sessionId === session.id),
        )
        assert(taskReviewMessages.length > 0, `${branchName}: at least one review_result message exists`)

        const branchReviewMsg = taskReviewMessages.find(m => m.metadata?.reviewDecision === branch.decision)
        assert(branchReviewMsg !== undefined,
            `${branchName}: review_result message with reviewDecision === '${branch.decision}' found`)
        if (branchReviewMsg) {
            log(`    review_result message: decision=${branchReviewMsg.metadata?.reviewDecision}, content="${branchReviewMsg.content.slice(0, 80)}"`)
        }

        // 12. P7.1: Manual delivery runtime smoke (approved branch only)
        if (branch.decision === 'approved') {
            logStep('P7.1: Manual delivery runtime smoke')
            // task.status should be review_passed at this point
            assert(finalTask.status === 'review_passed',
                `P7.1 pre-condition: task.status === 'review_passed' (got: '${finalTask.status}')`)

            // Trigger manual delivery
            const deliveredTask = await manualDeliverTask(apiBase, session.id, task.id)
            assert(deliveredTask.status === 'completed',
                `P7.1: delivered task.status === 'completed' (got: '${deliveredTask.status}')`)

            // Verify delivery runtime assertions
            await verifyManualDeliveryRuntime(apiBase, session.id, task.id, run.id, 'P7.1-manual-delivery')
        }

        log(`${branchName}: all assertions passed ✅`)
    } catch (err: any) {
        fail(`${branchName} failed: ${err.message}`)
    }

    // Always clean up
    if (serverProc) {
        logStep('Server: stop')
        await stopServer(serverProc, `${branchName}:${serverPort}`)
    }
    if (fakeGw) {
        logStep('Fake Gateway: stop')
        await stopFakeGateway(fakeGw)
    }

    logConfigEnd(branchName)
    return (configErrors.get(branchName) ?? 0) === errors.length
}

/**
 * Run all three reviewer branch smoke tests.
 * Each branch gets its own server subprocess + fake Gateway instance.
 */
async function runReviewerBranchSmoke(): Promise<void> {
    logStep('P6.5: Reviewer Branch Smoke (approved / revision_required / need_user_decision)')

    if (SKIP_REVIEWER_BRANCH_SMOKE) {
        console.log('  ⏭ Skipping reviewer branch smoke (SKIP_REVIEWER_BRANCH_SMOKE=1)')
        return
    }

    for (let i = 0; i < REVIEWER_BRANCHES.length; i++) {
        await runSingleReviewerBranch(REVIEWER_BRANCHES[i], i)
    }
}

// ─── Matrix Path ───────────────────────────────────────────────

async function runMatrixPath(config: MatrixConfig, apiBase: string): Promise<void> {
    const isRealOrchestrated = config.runner === 'real' && (config.runtime === 'orchestrated' || config.runtime === 'gateway-multi-role')

    // 1. Create session + task
    logStep('1: Create session + task')
    const session = await fetchJson<Session>(apiBase, '/api/agent-room/sessions', {
        method: 'POST',
        body: JSON.stringify({ name: `matrix-${config.runner}-${config.runtime}-${Date.now()}` }),
    })
    log(`  session.id = ${session.id}`)

    const task = await fetchJson<Task>(apiBase, `/api/agent-room/sessions/${session.id}/tasks`, {
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
    await setRoleBinding(apiBase, session.id, 'planner', PLANNER_PROFILE)
    await setRoleBinding(apiBase, session.id, 'developer', DEVELOPER_PROFILE)
    await setRoleBinding(apiBase, session.id, 'reviewer', REVIEWER_PROFILE)
    log('  planner/developer/reviewer bindings set')

    // 3. Start workflow
    logStep('3: Start workflow')
    const run = await startWorkflow(apiBase, session.id, task.id)
    log(`  run.id = ${run.id}`)

    // 4. Wait for completion
    logStep('4: Wait for run completion')
    const completedRun = await pollUntil(
        () => fetchJson<Run>(apiBase, `/api/agent-room/runs/${run.id}`),
        (r) => r.status === 'completed' || r.status === 'failed',
        POLL_TIMEOUT_MS, POLL_INTERVAL_MS, 'run completion',
    )
    assert(completedRun.status === 'completed', 'run completed successfully')
    log(`  run.status = ${completedRun.status}`)

    // Also wait for task to reach a terminal state
    const finalTask = await waitForStatus(
        apiBase,
        session.id,
        task.id,
        ['submitted_for_review', 'review_passed', 'completed', 'failed', 'need_user_decision'],
        'task terminal state',
    )
    log(`  task.status = ${finalTask.status}`)

    // 5. P5.1: Verify role runs
    await verifyRoleRuns(apiBase, run.id, config)

    // 6. P5.2: Verify reviewer JSON protocol (real orchestrated only)
    await verifyReviewerProtocol(apiBase, run.id, isRealOrchestrated)

    // 7. P5.3: Verify auto reviewer reviews (real orchestrated only)
    if (finalTask.status === 'submitted_for_review' || finalTask.status === 'review_passed' || finalTask.status === 'completed') {
        await verifyAutoReviewerReviews(apiBase, session.id, task.id, isRealOrchestrated)
    } else {
        verbose('  (skipped P5.3: task did not reach review stage)')
    }

    // 8. Verify run events
    await verifyRunEvents(apiBase, run.id, isRealOrchestrated)

    // 9. Verify no sensitive leaks in artifacts
    const artifacts = await fetchJson<Artifact[]>(
        apiBase,
        `/api/agent-room/sessions/${session.id}/tasks/${task.id}/artifacts`,
    )
    verifyNoSensitiveLeaks(artifacts)

    // 10. Config-specific assertions
    logStep('10: Config-specific validation')
    if (config.name === 'deterministic + mock') {
        // deterministic + mock: mock runner uses deterministic path
        // Role runs may exist from bindings but should be skipped
        // upstreamRunId should be empty or not a triple-segment ID
        log('  deterministic + mock: asserting no multi-segment upstreamRunId')
        if (completedRun.upstreamRunId) {
            const segments = completedRun.upstreamRunId.split('/')
            assert(segments.length < 3, `deterministic upstreamRunId should not be triple-segment (got: ${completedRun.upstreamRunId})`)
        }
        // Verify no _agentRole markers (mock runner doesn't set them)
        const events = await fetchJson<RunEvent[]>(apiBase, `/api/agent-room/runs/${run.id}/events`)
        const roleMarkers = events.filter(e => (e.payload as any)?._agentRole)
        assert(roleMarkers.length === 0, `deterministic + mock should have no _agentRole markers (got ${roleMarkers.length})`)
        log('  deterministic + mock assertions passed')
    } else if (config.name === 'orchestrated + mock') {
        // orchestrated + mock: mock runner doesn't actually execute orchestrated pipeline
        // Role runs exist from bindings but are skipped
        // upstreamRunId should be empty (mock runner doesn't produce real gateway runs)
        log('  orchestrated + mock: asserting mock runner behavior')
        const roleRuns = await fetchJson<RoleRun[]>(apiBase, `/api/agent-room/runs/${run.id}/role-runs`)
        log(`    role runs: ${roleRuns.length}`)
        for (const rr of roleRuns) {
            log(`      ${rr.role}: status=${rr.status}`)
        }
        // Mock runner should not produce real upstreamRunId
        if (completedRun.upstreamRunId) {
            verbose(`    upstreamRunId: ${completedRun.upstreamRunId} (may be present from mock)`)
        }
        // Verify no _agentRole markers (mock runner doesn't set them)
        const events = await fetchJson<RunEvent[]>(apiBase, `/api/agent-room/runs/${run.id}/events`)
        const roleMarkers = events.filter(e => (e.payload as any)?._agentRole)
        assert(roleMarkers.length === 0, `orchestrated + mock should have no _agentRole markers (got ${roleMarkers.length})`)
        log('  orchestrated + mock assertions passed')
    } else if (config.name === 'orchestrated + real') {
        // orchestrated + real: must have real upstreamRunId and active role_runs
        log('  orchestrated + real: asserting real upstreamRunId and role runs')
        assert(!!completedRun.upstreamRunId, 'orchestrated + real: upstreamRunId is present')
        const roleRuns = await fetchJson<RoleRun[]>(apiBase, `/api/agent-room/runs/${run.id}/role-runs`)
        const roles = roleRuns.map(rr => rr.role)
        assert(roles.includes('planner'), 'orchestrated + real: planner role run exists')
        assert(roles.includes('developer'), 'orchestrated + real: developer role run exists')
        assert(roles.includes('reviewer'), 'orchestrated + real: reviewer role run exists')
        // All role runs should be actively executed (not skipped)
        for (const rr of roleRuns) {
            assert(rr.status !== 'skipped', `orchestrated + real: role run ${rr.role} should not be skipped`)
        }
        // Must have _agentRole markers in events
        const events = await fetchJson<RunEvent[]>(apiBase, `/api/agent-room/runs/${run.id}/events`)
        const plannerMarkers = events.filter(e => (e.payload as any)?._agentRole === 'planner')
        const developerMarkers = events.filter(e => (e.payload as any)?._agentRole === 'developer')
        const reviewerMarkers = events.filter(e => (e.payload as any)?._agentRole === 'reviewer')
        assert(plannerMarkers.length > 0, 'orchestrated + real: _agentRole=planner markers exist')
        assert(developerMarkers.length > 0, 'orchestrated + real: _agentRole=developer markers exist')
        assert(reviewerMarkers.length > 0, 'orchestrated + real: _agentRole=reviewer markers exist')
        log('  orchestrated + real assertions passed')
    }
}

// ─── Main ───────────────────────────────────────────────────────

async function main(): Promise<void> {
    console.log('┌─────────────────────────────────────────────┐')
    console.log('│   Agent Room Matrix Smoke Test               │')
    console.log('│   (each config spawns independent server)    │')
    console.log('└─────────────────────────────────────────────┘')
    console.log()
    console.log(`  authToken:         ${AUTH_TOKEN ? '(set)' : '(not set)'}`)
    console.log(`  plannerProfile:    ${PLANNER_PROFILE}`)
    console.log(`  developerProfile:  ${DEVELOPER_PROFILE}`)
    console.log(`  reviewerProfile:   ${REVIEWER_PROFILE}`)
    console.log(`  skipRealGateway:   ${SKIP_REAL_GATEWAY}`)
    console.log(`  skipBranchSmoke:   ${SKIP_REVIEWER_BRANCH_SMOKE}`)
    console.log(`  pollInterval:      ${POLL_INTERVAL_MS}ms`)
    console.log(`  pollTimeout:       ${POLL_TIMEOUT_MS}ms`)
    console.log(`  basePort:          ${BASE_PORT}`)
    console.log(`  defaultUpstream:   ${DEFAULT_UPSTREAM}`)
    console.log(`  serverReadyTimeout:${SERVER_READY_TIMEOUT_MS}ms`)
    console.log()

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
        console.log(`    • ${c.name} (runner=${c.runner}, runtime=${c.runtime}, port=${c.port})`)
    }

    // Run each matrix configuration with its own server subprocess
    for (const config of configs) {
        const apiBase = `http://127.0.0.1:${config.port}`
        let serverProc: ChildProcess | null = null

        logConfig(`Matrix: ${config.name}`)
        log(`  config.name          = ${config.name}`)
        log(`  config.port          = ${config.port}`)
        log(`  config.runner        = ${config.runner}`)
        log(`  config.runtime       = ${config.runtime}`)
        log(`  config.upstream      = ${config.upstream ?? DEFAULT_UPSTREAM}`)
        log(`  apiBase              = ${apiBase}`)

        try {
            // 1. Spawn server subprocess
            logStep('Server: spawn')
            serverProc = startServer(config)

            // 2. Wait for server to be ready
            logStep('Server: wait for ready')
            await waitForServerReady(apiBase, SERVER_READY_TIMEOUT_MS)

            // 3. Run the matrix test path
            await runMatrixPath(config, apiBase)

            // 4. Run P5.4 concurrent guard test against this server
            logStep('P5.4: Concurrent startWorkflow guard')
            const guardSession = await fetchJson<Session>(apiBase, '/api/agent-room/sessions', {
                method: 'POST',
                body: JSON.stringify({ name: `matrix-guard-${config.name}-${Date.now()}` }),
            })
            const guardTask = await fetchJson<Task>(apiBase, `/api/agent-room/sessions/${guardSession.id}/tasks`, {
                method: 'POST',
                body: JSON.stringify({
                    title: 'matrix-concurrent-guard',
                    description: `Matrix smoke: concurrent startWorkflow guard (${config.name})`,
                }),
            })
            await setRoleBinding(apiBase, guardSession.id, 'planner', PLANNER_PROFILE)
            await setRoleBinding(apiBase, guardSession.id, 'developer', DEVELOPER_PROFILE)
            await setRoleBinding(apiBase, guardSession.id, 'reviewer', REVIEWER_PROFILE)
            await verifyConcurrentGuard(apiBase, guardSession.id, guardTask.id)
        } catch (err: any) {
            fail(`Matrix "${config.name}" failed: ${err.message}`)
        }

        // 5. Always stop the server
        if (serverProc) {
            logStep('Server: stop')
            await stopServer(serverProc, `${config.name}:${config.port}`)
        }

        logConfigEnd(`Matrix: ${config.name}`)
    }

    // ─── P6.5: Reviewer Branch Smoke ──────────────────────────────
    await runReviewerBranchSmoke()

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
        console.log('  ✓ Each config ran against its own server subprocess')
        console.log('  ✓ Basic workflow lifecycle (create → start → complete)')
        console.log('  ✓ P5.1: role_run records for planner/developer/reviewer (orchestrated)')
        console.log('  ✓ P5.2: reviewer JSON protocol (orchestrated mode)')
        console.log('  ✓ P5.3: auto reviewer reviews table (orchestrated mode)')
        console.log('  ✓ P5.4: concurrent startWorkflow returns 409')
        console.log('  ✓ Artifact metadata has no sensitive leaks')
        console.log('  ✓ Config-specific assertions (deterministic vs orchestrated)')
        if (!SKIP_REVIEWER_BRANCH_SMOKE) {
            console.log('  ✓ P6.5: reviewer branch smoke — approved / revision_required / need_user_decision')
            console.log('  ✓ P7.1: manual delivery runtime smoke — role_run / artifact / event / message linkage')
        }
    }
}

main().catch((err: unknown) => {
    console.error('❌ Matrix smoke failed with error:')
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
})
