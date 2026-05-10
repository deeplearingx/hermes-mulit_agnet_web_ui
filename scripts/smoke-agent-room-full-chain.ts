// ─── Agent Room Full-Chain Smoke Test ──────────────────────────
// Validates the complete Agent Room lifecycle through four distinct paths:
//   A. Manual delivery:  create → workflow → review passed → deliver → completed
//   B. Auto delivery:    create (autoDelivery) → workflow → review passed → auto-completed
//   C. Retry after rejection: create → workflow → reject → workflow(start) → pass → deliver
//   D. need_user_decision: create (maxRounds=1) → workflow → reject → need_user_decision → retry OK
//
// Usage:
//   npm run smoke:full-chain
//
// Optional env vars:
//   AGENT_ROOM_API          — server base URL (default: http://127.0.0.1:8648)
//   AUTH_TOKEN              — Bearer token for server auth (optional)
//   PLANNER_PROFILE         — planner profile name (default: mock-planner)
//   DEVELOPER_PROFILE       — developer profile name (default: mock-developer)
//   REVIEWER_PROFILE        — reviewer profile name (default: mock-reviewer)
//   AGENT_ROOM_RUNNER       — runner mode: mock | real (default: mock)
//   AGENT_ROOM_RUNTIME      — runtime mode: deterministic | orchestrated (default: deterministic)
//   VERBOSE                 — '1' for detailed output (default: '0')

const API = (process.env.AGENT_ROOM_API || 'http://127.0.0.1:8648').replace(/\/$/, '')
const AUTH_TOKEN = process.env.AUTH_TOKEN || ''
const PLANNER_PROFILE = process.env.PLANNER_PROFILE || 'mock-planner'
const DEVELOPER_PROFILE = process.env.DEVELOPER_PROFILE || 'mock-developer'
const REVIEWER_PROFILE = process.env.REVIEWER_PROFILE || 'mock-reviewer'
const RUNNER = process.env.AGENT_ROOM_RUNNER || 'mock'
const RUNTIME = process.env.AGENT_ROOM_RUNTIME || 'deterministic'
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
interface WorkflowEvent { id: string; sessionId: string; taskId: string; type: string; agentId: string; agentRole: string; payload?: Record<string, unknown>; createdAt: string }
interface Review { id: string; sessionId: string; taskId: string; reviewerAgentId: string; status: 'passed' | 'rejected'; comment: string; createdAt: string }

// ─── Helpers ────────────────────────────────────────────────────

const errors: string[] = []
const pathErrors: Map<string, number> = new Map()
let totalPassed = 0
let totalFailed = 0

function log(msg: string): void { console.log(`[smoke] ${msg}`) }
function verbose(msg: string): void { if (VERBOSE) console.log(`[smoke:v] ${msg}`) }
function logStep(step: string): void { console.log(`\n═══ ${step} ═══`) }
function logPath(label: string): void {
    pathErrors.set(label, errors.length)
    console.log(`\n┌─────── ${label} ───────┐`)
}
function logPathEnd(label: string): void {
    const startCount = pathErrors.get(label) ?? 0
    const pathFails = errors.length - startCount
    const ok = pathFails === 0
    if (ok) totalPassed++; else totalFailed++
    console.log(`└─────── ${label}: ${ok ? '✅ PASS' : `❌ FAIL (${pathFails} errors)`} ───────┘`)
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

/** Submit a review (pass or reject). */
async function submitReview(sessionId: string, taskId: string, status: 'passed' | 'rejected', comment: string): Promise<Review> {
    return fetchJson<Review>(
        `/api/agent-room/sessions/${sessionId}/tasks/${taskId}/review`,
        {
            method: 'POST',
            body: JSON.stringify({ reviewerAgentId: REVIEWER_PROFILE, status, comment }),
        },
    )
}

/** Deliver a task manually. */
async function deliverTask(sessionId: string, taskId: string): Promise<Task> {
    return fetchJson<Task>(
        `/api/agent-room/sessions/${sessionId}/tasks/${taskId}/deliver`,
        { method: 'POST' },
    )
}

/** Enable auto-delivery on a session. */
async function enableAutoDelivery(sessionId: string): Promise<void> {
    await fetchJson<{ autoDeliveryEnabled: boolean }>(
        `/api/agent-room/sessions/${sessionId}/config`,
        { method: 'PATCH', body: JSON.stringify({ autoDeliveryEnabled: true }) },
    )
}

/** Verify artifacts contain expected types. */
async function verifyArtifacts(
    sessionId: string,
    taskId: string,
    expectedTypes: string[],
): Promise<Artifact[]> {
    const artifacts = await fetchJson<Artifact[]>(
        `/api/agent-room/sessions/${sessionId}/tasks/${taskId}/artifacts`,
    )
    for (const expected of expectedTypes) {
        const found = artifacts.find(a => a.type === expected)
        if (found) {
            verbose(`  ✓ artifact "${expected}" found`)
        } else {
            fail(`Expected artifact "${expected}" not found (total: ${artifacts.length})`)
        }
    }
    return artifacts
}

/** Verify workflow events contain expected agent roles. */
async function verifyWorkflowEventRoles(sessionId: string, taskId: string): Promise<void> {
    const events = await fetchJson<WorkflowEvent[]>(`/api/agent-room/sessions/${sessionId}/events`)
    const taskEvents = events.filter(e => e.taskId === taskId)

    const plannerEvents = taskEvents.filter(e => e.agentRole === 'planner')
    const developerEvents = taskEvents.filter(e => e.agentRole === 'developer')
    const reviewerEvents = taskEvents.filter(e => e.agentRole === 'reviewer')

    assert(plannerEvents.length > 0, 'workflow events contain planner role')
    assert(developerEvents.length > 0, 'workflow events contain developer role')
    verbose(`  planner events: ${plannerEvents.length}, developer events: ${developerEvents.length}, reviewer events: ${reviewerEvents.length}`)
}

/** Verify run events contain _agentRole markers. */
async function verifyRunEvents(runId: string): Promise<void> {
    const events = await fetchJson<RunEvent[]>(`/api/agent-room/runs/${runId}/events`)
    log(`  run events: ${events.length}`)

    const isOrchestrated = RUNTIME === 'orchestrated' || RUNTIME === 'gateway-multi-role'
    if (isOrchestrated) {
        const plannerEvents = events.filter(e => (e.payload as any)?._agentRole === 'planner')
        const developerEvents = events.filter(e => (e.payload as any)?._agentRole === 'developer')
        const reviewerEvents = events.filter(e => (e.payload as any)?._agentRole === 'reviewer')
        assert(plannerEvents.length > 0, 'run events contain _agentRole=planner')
        assert(developerEvents.length > 0, 'run events contain _agentRole=developer')
        assert(reviewerEvents.length > 0, 'run events contain _agentRole=reviewer')
    } else {
        verbose('  (skipped _agentRole check: deterministic/mock mode)')
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

// ─── Path A: Manual Delivery ───────────────────────────────────

async function pathA_ManualDelivery(): Promise<void> {
    const label = 'Path A: Manual Delivery'
    logPath(label)

    // A.1: Create session + task
    logStep('A.1: Create session + task')
    const session = await fetchJson<Session>('/api/agent-room/sessions', {
        method: 'POST',
        body: JSON.stringify({ name: `full-chain-A-${Date.now()}` }),
    })
    log(`  session.id = ${session.id}`)

    const task = await fetchJson<Task>(`/api/agent-room/sessions/${session.id}/tasks`, {
        method: 'POST',
        body: JSON.stringify({
            title: 'path-a-manual-delivery',
            description: 'Full-chain smoke: manual delivery path',
        }),
    })
    log(`  task.id = ${task.id}, status = ${task.status}`)
    assert(task.status === 'created', 'task initial status is "created"')

    // A.2: Set role bindings
    logStep('A.2: Set role bindings')
    await setRoleBinding(session.id, 'planner', PLANNER_PROFILE)
    await setRoleBinding(session.id, 'developer', DEVELOPER_PROFILE)
    await setRoleBinding(session.id, 'reviewer', REVIEWER_PROFILE)
    log('  planner/developer/reviewer bindings set')

    // A.3: Start workflow
    logStep('A.3: Start workflow')
    const run = await startWorkflow(session.id, task.id)
    log(`  run.id = ${run.id}`)

    // A.4: Wait for submitted_for_review
    logStep('A.4: Wait for submitted_for_review')
    const submittedTask = await waitForStatus(session.id, task.id, ['submitted_for_review'], 'submitted_for_review')
    log(`  task.status = ${submittedTask.status}`)

    // A.5: Submit review as passed
    logStep('A.5: Submit review (passed)')
    await submitReview(session.id, task.id, 'passed', 'Looks good!')
    const passedTask = await waitForStatus(session.id, task.id, ['review_passed'], 'review_passed')
    log(`  task.status = ${passedTask.status}`)
    assert(passedTask.status === 'review_passed', 'task reached review_passed')

    // A.6: Manual deliver
    logStep('A.6: Deliver (manual)')
    await deliverTask(session.id, task.id)
    const completedTask = await waitForStatus(session.id, task.id, ['completed'], 'completed')
    log(`  task.status = ${completedTask.status}`)
    assert(completedTask.status === 'completed', 'task status is "completed"')

    // A.7: Verify artifacts
    logStep('A.7: Verify artifacts')
    const artifacts = await verifyArtifacts(session.id, task.id, ['final_delivery'])
    const deliveryArtifact = artifacts.find(a => a.type === 'final_delivery')
    if (deliveryArtifact) {
        assert(deliveryArtifact.metadata?.deliveryMode === 'manual', 'deliveryMode is "manual"')
    }

    // A.8: Verify events
    logStep('A.8: Verify events')
    await verifyRunEvents(run.id)
    await verifyWorkflowEventRoles(session.id, task.id)
    verifyNoSensitiveLeaks(artifacts)

    logPathEnd(label)
}

// ─── Path B: Auto Delivery ─────────────────────────────────────

async function pathB_AutoDelivery(): Promise<void> {
    const label = 'Path B: Auto Delivery'
    logPath(label)

    // B.1: Create session (autoDelivery=true) + task
    logStep('B.1: Create session (autoDelivery=true) + task')
    const session = await fetchJson<Session>('/api/agent-room/sessions', {
        method: 'POST',
        body: JSON.stringify({ name: `full-chain-B-${Date.now()}` }),
    })
    log(`  session.id = ${session.id}`)

    await enableAutoDelivery(session.id)
    log('  autoDelivery enabled')

    const task = await fetchJson<Task>(`/api/agent-room/sessions/${session.id}/tasks`, {
        method: 'POST',
        body: JSON.stringify({
            title: 'path-b-auto-delivery',
            description: 'Full-chain smoke: auto delivery path',
        }),
    })
    log(`  task.id = ${task.id}`)

    // B.2: Set role bindings
    logStep('B.2: Set role bindings')
    await setRoleBinding(session.id, 'planner', PLANNER_PROFILE)
    await setRoleBinding(session.id, 'developer', DEVELOPER_PROFILE)
    await setRoleBinding(session.id, 'reviewer', REVIEWER_PROFILE)
    log('  planner/developer/reviewer bindings set')

    // B.3: Start workflow
    logStep('B.3: Start workflow')
    const run = await startWorkflow(session.id, task.id)
    log(`  run.id = ${run.id}`)

    // B.4: Wait for submitted_for_review
    logStep('B.4: Wait for submitted_for_review')
    await waitForStatus(session.id, task.id, ['submitted_for_review'], 'submitted_for_review')
    log('  task reached submitted_for_review')

    // B.5: Submit review as passed → auto-delivery triggers
    logStep('B.5: Submit review (passed) → auto delivery')
    await submitReview(session.id, task.id, 'passed', 'Auto-delivery test approved')

    // Wait for completed (auto-delivery transitions: review_passed → delivering → completed)
    const completedTask = await waitForStatus(session.id, task.id, ['completed'], 'auto-completed')
    log(`  task.status = ${completedTask.status}`)
    assert(completedTask.status === 'completed', 'task auto-delivered to "completed"')

    // B.6: Verify artifacts
    logStep('B.6: Verify artifacts')
    const artifacts = await verifyArtifacts(session.id, task.id, ['final_delivery'])
    const deliveryArtifact = artifacts.find(a => a.type === 'final_delivery')
    if (deliveryArtifact) {
        assert(deliveryArtifact.metadata?.deliveryMode === 'auto', 'deliveryMode is "auto"')
    }

    // B.7: Verify events
    logStep('B.7: Verify events')
    await verifyRunEvents(run.id)
    await verifyWorkflowEventRoles(session.id, task.id)
    verifyNoSensitiveLeaks(artifacts)

    logPathEnd(label)
}

// ─── Path C: Retry After Rejection ─────────────────────────────

async function pathC_RetryAfterRejection(): Promise<void> {
    const label = 'Path C: Retry After Rejection'
    logPath(label)

    // C.1: Create session + task
    logStep('C.1: Create session + task')
    const session = await fetchJson<Session>('/api/agent-room/sessions', {
        method: 'POST',
        body: JSON.stringify({ name: `full-chain-C-${Date.now()}` }),
    })
    log(`  session.id = ${session.id}`)

    const task = await fetchJson<Task>(`/api/agent-room/sessions/${session.id}/tasks`, {
        method: 'POST',
        body: JSON.stringify({
            title: 'path-c-retry-after-rejection',
            description: 'Full-chain smoke: retry after rejection path',
        }),
    })
    log(`  task.id = ${task.id}`)

    // C.2: Set role bindings
    logStep('C.2: Set role bindings')
    await setRoleBinding(session.id, 'planner', PLANNER_PROFILE)
    await setRoleBinding(session.id, 'developer', DEVELOPER_PROFILE)
    await setRoleBinding(session.id, 'reviewer', REVIEWER_PROFILE)
    log('  planner/developer/reviewer bindings set')

    // C.3: Start workflow (first run)
    logStep('C.3: Start workflow (first run)')
    const run1 = await startWorkflow(session.id, task.id)
    log(`  run1.id = ${run1.id}`)

    // C.4: Wait for submitted_for_review
    logStep('C.4: Wait for submitted_for_review')
    await waitForStatus(session.id, task.id, ['submitted_for_review'], 'submitted_for_review')
    log('  task reached submitted_for_review')

    // C.5: Submit review as rejected
    logStep('C.5: Submit review (rejected)')
    await submitReview(session.id, task.id, 'rejected', 'Needs changes: fix the implementation')
    const rejectedTask = await waitForStatus(session.id, task.id, ['revision_required'], 'revision_required')
    log(`  task.status = ${rejectedTask.status}`)
    assert(rejectedTask.status === 'revision_required', 'task reached revision_required')
    assert(rejectedTask.revisionRound > 0, `revisionRound > 0 (got: ${rejectedTask.revisionRound})`)

    // C.6: Start workflow again (retry via workflow/start from revision_required)
    // Note: revision_required is in WORKFLOW_STARTABLE_STATUSES, so workflow/start works.
    // The mock runner handles the retry path: in_progress → submitted_for_review.
    logStep('C.6: Start workflow (retry run)')
    const run2 = await startWorkflow(session.id, task.id)
    log(`  run2.id = ${run2.id}`)

    // C.7: Wait for submitted_for_review again
    logStep('C.7: Wait for submitted_for_review (round 2)')
    await waitForStatus(session.id, task.id, ['submitted_for_review'], 'resubmitted')
    log('  task reached submitted_for_review (round 2)')

    // C.8: Submit review as passed
    logStep('C.8: Submit review (passed)')
    await submitReview(session.id, task.id, 'passed', 'Looks good now!')
    const passedTask = await waitForStatus(session.id, task.id, ['review_passed'], 'review_passed')
    log(`  task.status = ${passedTask.status}`)

    // C.9: Deliver
    logStep('C.9: Deliver')
    await deliverTask(session.id, task.id)
    const completedTask = await waitForStatus(session.id, task.id, ['completed'], 'completed')
    log(`  task.status = ${completedTask.status}`)
    assert(completedTask.status === 'completed', 'task status is "completed"')

    // C.10: Verify artifacts
    logStep('C.10: Verify artifacts')
    const artifacts = await verifyArtifacts(session.id, task.id, ['final_delivery'])
    const deliveryArtifact = artifacts.find(a => a.type === 'final_delivery')
    if (deliveryArtifact) {
        assert(deliveryArtifact.metadata?.deliveryMode === 'manual', 'deliveryMode is "manual"')
        assert((deliveryArtifact.metadata?.revisionRound as number) > 0, 'revisionRound > 0 in delivery metadata')
    }

    // C.11: Verify events
    logStep('C.11: Verify events')
    await verifyWorkflowEventRoles(session.id, task.id)

    // Verify review_rejected and revision_started events exist
    const events = await fetchJson<WorkflowEvent[]>(`/api/agent-room/sessions/${session.id}/events`)
    const taskEvents = events.filter(e => e.taskId === task.id)
    const rejectedEvents = taskEvents.filter(e => e.type === 'review_rejected')
    assert(rejectedEvents.length > 0, 'workflow events contain review_rejected')
    const revisionStartedEvents = taskEvents.filter(e => e.type === 'revision_started')
    assert(revisionStartedEvents.length > 0, 'workflow events contain revision_started')

    verifyNoSensitiveLeaks(artifacts)

    logPathEnd(label)
}

// ─── Path D: need_user_decision ────────────────────────────────

async function pathD_NeedUserDecision(): Promise<void> {
    const label = 'Path D: need_user_decision'
    logPath(label)

    // D.1: Create session (maxRevisionRounds=1) + task
    // With maxRevisionRounds=1: first rejection → nextRevisionRound=1 >= 1 → need_user_decision
    logStep('D.1: Create session + task (maxRevisionRounds=1)')
    const session = await fetchJson<Session>('/api/agent-room/sessions', {
        method: 'POST',
        body: JSON.stringify({ name: `full-chain-D-${Date.now()}` }),
    })
    log(`  session.id = ${session.id}`)

    const task = await fetchJson<Task>(`/api/agent-room/sessions/${session.id}/tasks`, {
        method: 'POST',
        body: JSON.stringify({
            title: 'path-d-need-user-decision',
            description: 'Full-chain smoke: need_user_decision path',
            maxRevisionRounds: 1,
        }),
    })
    log(`  task.id = ${task.id}, status = ${task.status}, maxRevisionRounds = ${task.maxRevisionRounds}`)
    assert(task.maxRevisionRounds === 1, 'maxRevisionRounds is 1')

    // D.2: Set role bindings
    logStep('D.2: Set role bindings')
    await setRoleBinding(session.id, 'planner', PLANNER_PROFILE)
    await setRoleBinding(session.id, 'developer', DEVELOPER_PROFILE)
    await setRoleBinding(session.id, 'reviewer', REVIEWER_PROFILE)
    log('  planner/developer/reviewer bindings set')

    // D.3: Start workflow
    logStep('D.3: Start workflow')
    const run = await startWorkflow(session.id, task.id)
    log(`  run.id = ${run.id}`)

    // D.4: Wait for submitted_for_review
    logStep('D.4: Wait for submitted_for_review')
    await waitForStatus(session.id, task.id, ['submitted_for_review'], 'submitted_for_review')
    log('  task reached submitted_for_review')

    // D.5: Submit review as rejected → with maxRevisionRounds=1, goes directly to need_user_decision
    logStep('D.5: Submit review (rejected) → need_user_decision')
    await submitReview(session.id, task.id, 'rejected', 'Cannot proceed without user input')

    // With maxRevisionRounds=1 and revisionRound=0:
    // nextRevisionRound = 0 + 1 = 1, 1 >= 1 → need_user_decision
    const nudTask = await waitForStatus(session.id, task.id, ['need_user_decision'], 'need_user_decision')
    log(`  task.status = ${nudTask.status}`)
    assert(nudTask.status === 'need_user_decision', 'task reached need_user_decision')
    assert(nudTask.revisionRound >= 1, `revisionRound >= 1 (got: ${nudTask.revisionRound})`)

    // D.6: Verify task stays at need_user_decision (no auto-transition)
    logStep('D.6: Verify task stays at need_user_decision')
    await new Promise(r => setTimeout(r, 2000))
    const stableTask = await getTask(session.id, task.id)
    assert(stableTask.status === 'need_user_decision', 'task still at need_user_decision after 2s')
    log(`  task.status = ${stableTask.status} (stable)`)

    // D.7: Verify workflow/start works from need_user_decision
    // need_user_decision is in WORKFLOW_STARTABLE_STATUSES, so the runner can handle retry
    logStep('D.7: Verify retry via workflow/start from need_user_decision')
    const retryRun = await startWorkflow(session.id, task.id)
    log(`  retry run.id = ${retryRun.id}`)

    // The mock runner handles need_user_decision in the retry path
    const retriedTask = await waitForStatus(session.id, task.id, ['submitted_for_review', 'in_progress'], 'retry from nud')
    log(`  task.status after retry = ${retriedTask.status}`)
    assert(
        retriedTask.status === 'in_progress' || retriedTask.status === 'submitted_for_review',
        'retry from need_user_decision transitions to in_progress or submitted_for_review',
    )

    // D.8: Verify events
    logStep('D.8: Verify events')
    const events = await fetchJson<WorkflowEvent[]>(`/api/agent-room/sessions/${session.id}/events`)
    const taskEvents = events.filter(e => e.taskId === task.id)
    const nudEvents = taskEvents.filter(e => e.type === 'need_user_decision')
    assert(nudEvents.length > 0, 'workflow events contain need_user_decision')
    await verifyWorkflowEventRoles(session.id, task.id)
    await verifyRunEvents(run.id)

    logPathEnd(label)
}

// ─── Main ───────────────────────────────────────────────────────

async function main(): Promise<void> {
    console.log('┌─────────────────────────────────────────────┐')
    console.log('│   Agent Room Full-Chain Smoke Test           │')
    console.log('└─────────────────────────────────────────────┘')
    console.log()
    console.log(`  API:             ${API}`)
    console.log(`  authToken:       ${AUTH_TOKEN ? '(set)' : '(not set)'}`)
    console.log(`  plannerProfile:  ${PLANNER_PROFILE}`)
    console.log(`  developerProfile:${DEVELOPER_PROFILE}`)
    console.log(`  reviewerProfile: ${REVIEWER_PROFILE}`)
    console.log(`  runner:          ${RUNNER}`)
    console.log(`  runtime:         ${RUNTIME}`)
    console.log(`  pollInterval:    ${POLL_INTERVAL_MS}ms`)
    console.log(`  pollTimeout:     ${POLL_TIMEOUT_MS}ms`)
    console.log()

    // Validate required env vars
    if (!PLANNER_PROFILE) { fail('PLANNER_PROFILE is required'); process.exit(1) }
    if (!DEVELOPER_PROFILE) { fail('DEVELOPER_PROFILE is required'); process.exit(1) }
    if (!REVIEWER_PROFILE) { fail('REVIEWER_PROFILE is required'); process.exit(1) }

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

    // Run all paths
    await pathA_ManualDelivery()
    await pathB_AutoDelivery()
    await pathC_RetryAfterRejection()
    await pathD_NeedUserDecision()

    // ─── Summary ─────────────────────────────────────────────────
    console.log('\n┌─────────────────────────────────────────────┐')
    console.log('│   Full-Chain Smoke Results                   │')
    console.log('└─────────────────────────────────────────────┘')
    console.log()
    console.log(`  Paths passed: ${totalPassed}`)
    console.log(`  Paths failed: ${totalFailed}`)

    if (errors.length > 0) {
        console.error(`\n❌ ${errors.length} assertion(s) failed:`)
        for (const e of errors) console.error(`  - ${e}`)
        process.exit(1)
    } else {
        console.log('\n✅ All 4 paths passed — full-chain smoke passed')
        console.log()
        console.log('Validated:')
        console.log('  ✓ Path A: Manual delivery (create → workflow → review → deliver → completed)')
        console.log('  ✓ Path B: Auto delivery (create → workflow → review → auto-completed)')
        console.log('  ✓ Path C: Retry after rejection (reject → workflow/start → pass → deliver)')
        console.log('  ✓ Path D: need_user_decision (max rounds exceeded → stable → retry OK)')
        console.log('  ✓ Workflow events with planner/developer/reviewer roles')
        console.log('  ✓ Run events with _agentRole markers (orchestrated mode)')
        console.log('  ✓ Artifact metadata has no sensitive leaks')
    }
}

main().catch((err: unknown) => {
    console.error('❌ Full-chain smoke failed with error:')
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
})
