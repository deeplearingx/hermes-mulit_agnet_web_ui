/**
 * P5.1: Role-Aware Hook + role_run Binding Tests
 *
 * Verifies that buildRunHooks() correctly binds upstream run_id to role_runs
 * by role name (via context parameter) instead of sequential index.
 *
 * Test matrix:
 * 1. Reversed role binding creation order (reviewer → developer → planner)
 * 2. Developer failure: developer role_run failed, planner failed (still running when failure occurred), reviewer skipped
 * 3. Reviewer failure: all role_runs failed (all were running when failure occurred)
 * 4. Retry path (developer → reviewer): planner role_run stays skipped
 * 5. gateway_sse run_events.role_run_id maps to correct role_run via _agentRole
 * 6. Legacy callers without role context fall back to sequential index
 * 7. createRoleTaggedHooks injects role context into onUpstreamRunCreated
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../packages/server/src/services/hermes/gateway-run-client', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../packages/server/src/services/hermes/gateway-run-client')>()
    return { ...actual, runHermesGatewayTask: vi.fn() }
})

vi.mock('../../packages/server/src/config', () => ({
    config: { upstream: 'http://127.0.0.1:8642' },
}))

function quoteIdentifier(identifier: string): string {
    return `"${identifier.replace(/"/g, '""')}"`
}

function ensureTableForTest(db: any, tableName: string, schema: Record<string, string>): void {
    const colDefs = Object.entries(schema)
        .map(([col, def]) => `${quoteIdentifier(col)} ${def}`)
        .join(', ')
    db.exec(`CREATE TABLE IF NOT EXISTS ${quoteIdentifier(tableName)} (${colDefs})`)

    const rows = db.prepare(`PRAGMA table_info(${quoteIdentifier(tableName)})`).all() as Array<{ name: string }>
    const existingCols = new Set(rows.map(row => row.name))
    for (const [col, def] of Object.entries(schema)) {
        if (!existingCols.has(col)) {
            db.exec(`ALTER TABLE ${quoteIdentifier(tableName)} ADD COLUMN ${quoteIdentifier(col)} ${def}`)
        }
    }
}

/**
 * Valid steps that satisfy the state machine: created → planned → assigned → in_progress → submitted_for_review
 */
function validOrchestratedSteps() {
    return [
        { status: 'planned' as const, activeRole: 'planner' as const, events: [{ type: 'task_planned', agentRole: 'planner' as const }], messages: [{ senderRole: 'planner' as const, content: 'Plan created' }] },
        { status: 'assigned' as const, activeRole: 'developer' as const, events: [{ type: 'task_assigned', agentRole: 'developer' as const }] },
        { status: 'in_progress' as const, activeRole: 'developer' as const, events: [{ type: 'task_started', agentRole: 'developer' as const }] },
        { status: 'submitted_for_review' as const, activeRole: 'developer' as const, events: [{ type: 'task_submitted', agentRole: 'developer' as const }] },
        { status: 'review_passed' as const, activeRole: 'reviewer' as const, events: [{ type: 'review_passed', agentRole: 'reviewer' as const }], messages: [{ senderRole: 'reviewer' as const, content: 'Approved' }] },
    ]
}

describe('P5.1: Role-Aware Hook Binding', () => {
    let mockDb: any

    beforeEach(async () => {
        vi.resetModules()
        const { DatabaseSync } = await import('node:sqlite')
        mockDb = new DatabaseSync(':memory:')
        vi.doMock('../../packages/server/src/db/index', () => ({
            getDb: () => mockDb,
            ensureTable: ensureTableForTest.bind(null, mockDb),
        }))
        const { initAllHermesTables } = await import('../../packages/server/src/db/hermes/schemas')
        initAllHermesTables()
    })

    afterEach(() => {
        if (mockDb) mockDb.close()
        vi.restoreAllMocks()
    })

    // ── Test 1: Reversed role binding creation order ──────────────

    it('reversed role creation order (reviewer→developer→planner) binds upstream run_id correctly', async () => {
        const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
        const { setActiveRunnerForTest, resetActiveRunnerForTest } = await import(
            '../../packages/server/src/services/hermes/agent-room/runner'
        )

        const session = svc.createSession('P5.1 Reversed Order')
        // Create bindings in reversed order: reviewer first, then developer, then planner
        svc.createRoleBinding(session.id, 'reviewer', 'gpt-4o')
        svc.createRoleBinding(session.id, 'developer', 'claude-3.5-sonnet')
        svc.createRoleBinding(session.id, 'planner', 'gpt-4o')
        const task = svc.createTask(session.id, 'Test Task', 'Description')

        const plannerRunId = 'upstream-planner-001'
        const developerRunId = 'upstream-developer-001'
        const reviewerRunId = 'upstream-reviewer-001'

        setActiveRunnerForTest({
            name: 'real',
            run: async (ctx: any) => {
                // Simulate orchestrated runtime calling hooks with role context
                ctx.hooks.onUpstreamRunCreated?.(plannerRunId, { role: 'planner' })
                ctx.hooks.onRawEvent?.({ event: 'run.created', _agentRole: 'planner' })

                ctx.hooks.onUpstreamRunCreated?.(developerRunId, { role: 'developer' })
                ctx.hooks.onRawEvent?.({ event: 'step.started', _agentRole: 'developer' })

                ctx.hooks.onUpstreamRunCreated?.(reviewerRunId, { role: 'reviewer' })
                ctx.hooks.onRawEvent?.({ event: 'review.completed', _agentRole: 'reviewer' })

                return { steps: validOrchestratedSteps(), artifacts: [] }
            },
        })

        const run = svc.startWorkflow(session.id, task.id)

        await vi.waitFor(() => {
            const updatedRun = svc.getRun(run.id)!
            expect(updatedRun.status).toBe('completed')
        }, { timeout: 10000 })

        // Verify each role_run has the correct upstream_run_id (not index-based)
        const plannerRR = svc.getRoleRunByRunAndRole(run.id, 'planner')
        const developerRR = svc.getRoleRunByRunAndRole(run.id, 'developer')
        const reviewerRR = svc.getRoleRunByRunAndRole(run.id, 'reviewer')

        expect(plannerRR).not.toBeNull()
        expect(plannerRR!.upstreamRunId).toBe(plannerRunId)
        expect(plannerRR!.status).toBe('completed')

        expect(developerRR).not.toBeNull()
        expect(developerRR!.upstreamRunId).toBe(developerRunId)
        expect(developerRR!.status).toBe('completed')

        expect(reviewerRR).not.toBeNull()
        expect(reviewerRR!.upstreamRunId).toBe(reviewerRunId)
        expect(reviewerRR!.status).toBe('completed')

        // Verify gateway_sse events have correct role_run_id
        const runEvents = svc.listRunEventsByRun(run.id)
        const gatewayEvents = runEvents.filter(e => e.source === 'gateway_sse')

        // Planner event → planner role_run
        const plannerEvt = gatewayEvents.find(e => (e.payload as any)?._agentRole === 'planner')
        expect(plannerEvt).toBeDefined()
        expect(plannerEvt!.roleRunId).toBe(plannerRR!.id)

        // Developer event → developer role_run
        const developerEvt = gatewayEvents.find(e => (e.payload as any)?._agentRole === 'developer')
        expect(developerEvt).toBeDefined()
        expect(developerEvt!.roleRunId).toBe(developerRR!.id)

        // Reviewer event → reviewer role_run
        const reviewerEvt = gatewayEvents.find(e => (e.payload as any)?._agentRole === 'reviewer')
        expect(reviewerEvt).toBeDefined()
        expect(reviewerEvt!.roleRunId).toBe(reviewerRR!.id)

        resetActiveRunnerForTest()
    })

    // ── Test 2: Developer failure ─────────────────────────────────

    it('developer failure: all running role_runs marked failed, unstarted ones skipped', async () => {
        const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
        const { setActiveRunnerForTest, resetActiveRunnerForTest } = await import(
            '../../packages/server/src/services/hermes/agent-room/runner'
        )

        const session = svc.createSession('P5.1 Dev Failure')
        svc.createRoleBinding(session.id, 'planner', 'gpt-4o')
        svc.createRoleBinding(session.id, 'developer', 'claude-3.5-sonnet')
        svc.createRoleBinding(session.id, 'reviewer', 'gpt-4o')
        const task = svc.createTask(session.id, 'Test Task', 'Description')

        setActiveRunnerForTest({
            name: 'real',
            run: async (ctx: any) => {
                // Planner phase starts
                ctx.hooks.onUpstreamRunCreated?.('upstream-planner-002', { role: 'planner' })
                ctx.hooks.onRawEvent?.({ event: 'run.created', _agentRole: 'planner' })

                // Developer phase starts then fails
                ctx.hooks.onUpstreamRunCreated?.('upstream-developer-002', { role: 'developer' })
                ctx.hooks.onRawEvent?.({ event: 'step.started', _agentRole: 'developer' })

                // Developer throws — reviewer phase is never reached
                throw new Error('developer phase failed: LLM timeout')
            },
        })

        // startWorkflow swallows errors in background mode
        const run = svc.startWorkflow(session.id, task.id)

        await vi.waitFor(() => {
            const updatedRun = svc.getRun(run.id)!
            expect(updatedRun.status).toBe('failed')
        }, { timeout: 10000 })

        const plannerRR = svc.getRoleRunByRunAndRole(run.id, 'planner')
        const developerRR = svc.getRoleRunByRunAndRole(run.id, 'developer')
        const reviewerRR = svc.getRoleRunByRunAndRole(run.id, 'reviewer')

        // Planner was 'running' when failure occurred → marked 'failed'
        // (finalizeRoleRuns doesn't distinguish between "successfully completed role" and "in-progress role")
        expect(plannerRR!.status).toBe('failed')

        // Developer was 'running' when failure occurred → marked 'failed'
        expect(developerRR!.status).toBe('failed')

        // finalizeRoleRuns attaches the error to the first running role_run only
        const runningFailed = [plannerRR, developerRR].filter(r => r!.errorMessage)
        expect(runningFailed).toHaveLength(1)
        expect(runningFailed[0]!.errorMessage).toContain('developer phase failed')

        // Reviewer was never started → 'skipped'
        expect(reviewerRR!.status).toBe('skipped')

        // Verify upstream run IDs were correctly bound before failure
        expect(plannerRR!.upstreamRunId).toBe('upstream-planner-002')
        expect(developerRR!.upstreamRunId).toBe('upstream-developer-002')
        expect(reviewerRR!.upstreamRunId).toBeUndefined()

        resetActiveRunnerForTest()
    })

    // ── Test 3: Reviewer failure ──────────────────────────────────

    it('reviewer failure: all running role_runs marked failed', async () => {
        const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
        const { setActiveRunnerForTest, resetActiveRunnerForTest } = await import(
            '../../packages/server/src/services/hermes/agent-room/runner'
        )

        const session = svc.createSession('P5.1 Reviewer Failure')
        svc.createRoleBinding(session.id, 'planner', 'gpt-4o')
        svc.createRoleBinding(session.id, 'developer', 'claude-3.5-sonnet')
        svc.createRoleBinding(session.id, 'reviewer', 'gpt-4o')
        const task = svc.createTask(session.id, 'Test Task', 'Description')

        setActiveRunnerForTest({
            name: 'real',
            run: async (ctx: any) => {
                // Planner phase completes
                ctx.hooks.onUpstreamRunCreated?.('upstream-planner-003', { role: 'planner' })
                ctx.hooks.onRawEvent?.({ event: 'run.created', _agentRole: 'planner' })

                // Developer phase completes
                ctx.hooks.onUpstreamRunCreated?.('upstream-developer-003', { role: 'developer' })
                ctx.hooks.onRawEvent?.({ event: 'step.started', _agentRole: 'developer' })

                // Reviewer phase starts then fails
                ctx.hooks.onUpstreamRunCreated?.('upstream-reviewer-003', { role: 'reviewer' })
                ctx.hooks.onRawEvent?.({ event: 'review.started', _agentRole: 'reviewer' })

                throw new Error('reviewer phase failed: review API error')
            },
        })

        const run = svc.startWorkflow(session.id, task.id)

        await vi.waitFor(() => {
            const updatedRun = svc.getRun(run.id)!
            expect(updatedRun.status).toBe('failed')
        }, { timeout: 10000 })

        const plannerRR = svc.getRoleRunByRunAndRole(run.id, 'planner')
        const developerRR = svc.getRoleRunByRunAndRole(run.id, 'developer')
        const reviewerRR = svc.getRoleRunByRunAndRole(run.id, 'reviewer')

        // All three were 'running' → all marked 'failed'
        // The first non-terminal role_run gets the error message
        expect(plannerRR!.status).toBe('failed')
        expect(developerRR!.status).toBe('failed')
        expect(reviewerRR!.status).toBe('failed')

        // Error message goes to the first non-terminal role_run (planner in iteration order)
        const allFailed = [plannerRR, developerRR, reviewerRR].filter(r => r!.errorMessage)
        expect(allFailed.length).toBeGreaterThanOrEqual(1)
        expect(allFailed[0]!.errorMessage).toContain('reviewer phase failed')

        resetActiveRunnerForTest()
    })

    // ── Test 4: Retry path (developer → reviewer) ─────────────────

    it('retry path developer→reviewer: planner role_run stays skipped', async () => {
        const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
        const { setActiveRunnerForTest, resetActiveRunnerForTest } = await import(
            '../../packages/server/src/services/hermes/agent-room/runner'
        )

        const session = svc.createSession('P5.1 Retry Path')
        svc.createRoleBinding(session.id, 'planner', 'gpt-4o')
        svc.createRoleBinding(session.id, 'developer', 'claude-3.5-sonnet')
        svc.createRoleBinding(session.id, 'reviewer', 'gpt-4o')
        const task = svc.createTask(session.id, 'Test Task', 'Description')

        // Simulate retry: only developer and reviewer calls, no planner
        setActiveRunnerForTest({
            name: 'real',
            run: async (ctx: any) => {
                // Only developer and reviewer phases in retry path
                ctx.hooks.onUpstreamRunCreated?.('upstream-dev-retry-001', { role: 'developer' })
                ctx.hooks.onRawEvent?.({ event: 'step.started', _agentRole: 'developer' })

                ctx.hooks.onUpstreamRunCreated?.('upstream-reviewer-retry-001', { role: 'reviewer' })
                ctx.hooks.onRawEvent?.({ event: 'review.completed', _agentRole: 'reviewer' })

                return { steps: validOrchestratedSteps(), artifacts: [] }
            },
        })

        const run = svc.startWorkflow(session.id, task.id)

        await vi.waitFor(() => {
            const updatedRun = svc.getRun(run.id)!
            expect(updatedRun.status).toBe('completed')
        }, { timeout: 10000 })

        const plannerRR = svc.getRoleRunByRunAndRole(run.id, 'planner')
        const developerRR = svc.getRoleRunByRunAndRole(run.id, 'developer')
        const reviewerRR = svc.getRoleRunByRunAndRole(run.id, 'reviewer')

        // Planner was never called — should be 'skipped' (finalized from 'queued')
        expect(plannerRR!.status).toBe('skipped')
        expect(plannerRR!.upstreamRunId).toBeUndefined()

        // Developer and reviewer should be completed
        expect(developerRR!.status).toBe('completed')
        expect(developerRR!.upstreamRunId).toBe('upstream-dev-retry-001')

        expect(reviewerRR!.status).toBe('completed')
        expect(reviewerRR!.upstreamRunId).toBe('upstream-reviewer-retry-001')

        resetActiveRunnerForTest()
    })

    // ── Test 5: gateway_sse events → correct role_run_id ──────────

    it('gateway_sse events link to correct role_run_id via _agentRole', async () => {
        const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
        const { setActiveRunnerForTest, resetActiveRunnerForTest } = await import(
            '../../packages/server/src/services/hermes/agent-room/runner'
        )

        const session = svc.createSession('P5.1 Event Binding')
        svc.createRoleBinding(session.id, 'planner', 'gpt-4o')
        svc.createRoleBinding(session.id, 'developer', 'claude-3.5-sonnet')
        svc.createRoleBinding(session.id, 'reviewer', 'gpt-4o')
        const task = svc.createTask(session.id, 'Test Task', 'Description')

        setActiveRunnerForTest({
            name: 'real',
            run: async (ctx: any) => {
                // Planner phase
                ctx.hooks.onUpstreamRunCreated?.('upstream-planner-evt', { role: 'planner' })
                ctx.hooks.onRawEvent?.({ event: 'run.created', _agentRole: 'planner' })
                ctx.hooks.onRawEvent?.({ event: 'step.planning', _agentRole: 'planner' })

                // Developer phase
                ctx.hooks.onUpstreamRunCreated?.('upstream-developer-evt', { role: 'developer' })
                ctx.hooks.onRawEvent?.({ event: 'run.created', _agentRole: 'developer' })
                ctx.hooks.onRawEvent?.({ event: 'tool.invoked', _agentRole: 'developer' })
                ctx.hooks.onRawEvent?.({ event: 'step.completed', _agentRole: 'developer' })

                // Reviewer phase
                ctx.hooks.onUpstreamRunCreated?.('upstream-reviewer-evt', { role: 'reviewer' })
                ctx.hooks.onRawEvent?.({ event: 'run.created', _agentRole: 'reviewer' })
                ctx.hooks.onRawEvent?.({ event: 'review.result', _agentRole: 'reviewer' })

                return { steps: validOrchestratedSteps(), artifacts: [] }
            },
        })

        const run = svc.startWorkflow(session.id, task.id)

        await vi.waitFor(() => {
            const updatedRun = svc.getRun(run.id)!
            expect(updatedRun.status).toBe('completed')
        }, { timeout: 10000 })

        const plannerRR = svc.getRoleRunByRunAndRole(run.id, 'planner')
        const developerRR = svc.getRoleRunByRunAndRole(run.id, 'developer')
        const reviewerRR = svc.getRoleRunByRunAndRole(run.id, 'reviewer')

        const gatewayEvents = svc.listRunEventsByRun(run.id).filter(e => e.source === 'gateway_sse')

        // Planner events → planner role_run_id
        const plannerEvents = gatewayEvents.filter(e => (e.payload as any)?._agentRole === 'planner')
        expect(plannerEvents).toHaveLength(2)
        for (const evt of plannerEvents) {
            expect(evt.roleRunId).toBe(plannerRR!.id)
        }

        // Developer events → developer role_run_id
        const developerEvents = gatewayEvents.filter(e => (e.payload as any)?._agentRole === 'developer')
        expect(developerEvents).toHaveLength(3)
        for (const evt of developerEvents) {
            expect(evt.roleRunId).toBe(developerRR!.id)
        }

        // Reviewer events → reviewer role_run_id
        const reviewerEvents = gatewayEvents.filter(e => (e.payload as any)?._agentRole === 'reviewer')
        expect(reviewerEvents).toHaveLength(2)
        for (const evt of reviewerEvents) {
            expect(evt.roleRunId).toBe(reviewerRR!.id)
        }

        // Verify no cross-contamination
        for (const evt of plannerEvents) {
            expect(evt.roleRunId).not.toBe(developerRR!.id)
            expect(evt.roleRunId).not.toBe(reviewerRR!.id)
        }
        for (const evt of developerEvents) {
            expect(evt.roleRunId).not.toBe(plannerRR!.id)
            expect(evt.roleRunId).not.toBe(reviewerRR!.id)
        }

        resetActiveRunnerForTest()
    })

    // ── Test 6: Backward compat — legacy callers without role context ──

    it('legacy callers without role context fall back to sequential index binding', async () => {
        const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
        const { setActiveRunnerForTest, resetActiveRunnerForTest } = await import(
            '../../packages/server/src/services/hermes/agent-room/runner'
        )

        const session = svc.createSession('P5.1 Legacy Compat')
        svc.createRoleBinding(session.id, 'planner', 'gpt-4o')
        svc.createRoleBinding(session.id, 'developer', 'claude-3.5-sonnet')
        svc.createRoleBinding(session.id, 'reviewer', 'gpt-4o')
        const task = svc.createTask(session.id, 'Test Task', 'Description')

        // Simulate legacy runtime that calls onUpstreamRunCreated WITHOUT role context
        setActiveRunnerForTest({
            name: 'real',
            run: async (ctx: any) => {
                // Call without context (legacy behavior)
                ctx.hooks.onUpstreamRunCreated?.('upstream-legacy-001')
                ctx.hooks.onRawEvent?.({ event: 'run.created' })

                ctx.hooks.onUpstreamRunCreated?.('upstream-legacy-002')
                ctx.hooks.onRawEvent?.({ event: 'step.started' })

                ctx.hooks.onUpstreamRunCreated?.('upstream-legacy-003')
                ctx.hooks.onRawEvent?.({ event: 'review.completed' })

                return { steps: validOrchestratedSteps(), artifacts: [] }
            },
        })

        const run = svc.startWorkflow(session.id, task.id)

        await vi.waitFor(() => {
            const updatedRun = svc.getRun(run.id)!
            expect(updatedRun.status).toBe('completed')
        }, { timeout: 10000 })

        // Sequential binding: each upstream ID binds to the next unbound role_run
        // The exact role order depends on DB insertion order, but each role_run
        // should get exactly one upstream ID and all should be completed.
        const plannerRR = svc.getRoleRunByRunAndRole(run.id, 'planner')
        const developerRR = svc.getRoleRunByRunAndRole(run.id, 'developer')
        const reviewerRR = svc.getRoleRunByRunAndRole(run.id, 'reviewer')

        // All three should be completed
        expect(plannerRR!.status).toBe('completed')
        expect(developerRR!.status).toBe('completed')
        expect(reviewerRR!.status).toBe('completed')

        // Each should have a distinct upstream ID (no duplicates)
        const upstreamIds = new Set([
            plannerRR!.upstreamRunId,
            developerRR!.upstreamRunId,
            reviewerRR!.upstreamRunId,
        ])
        expect(upstreamIds.size).toBe(3)
        expect(upstreamIds.has('upstream-legacy-001')).toBe(true)
        expect(upstreamIds.has('upstream-legacy-002')).toBe(true)
        expect(upstreamIds.has('upstream-legacy-003')).toBe(true)

        resetActiveRunnerForTest()
    })

    // ── Test 7: createRoleTaggedHooks wraps onUpstreamRunCreated with role ──

    it('createRoleTaggedHooks injects role context into onUpstreamRunCreated', async () => {
        const { OrchestratedGatewayRuntime } = await import(
            '../../packages/server/src/services/hermes/agent-room/runner/runtime/orchestrated-gateway-runtime'
        )
        const { runHermesGatewayTask } = await import('../../packages/server/src/services/hermes/gateway-run-client')

        vi.mocked(runHermesGatewayTask).mockImplementation(async (params: any) => {
            if (params.onUpstreamRunCreated) {
                params.onUpstreamRunCreated('test-run-id')
            }
            return { output: 'test output', runId: 'test-run-id', sessionId: 'test-session' }
        })

        const onUpstreamRunCreated = vi.fn()
        const runtime = new OrchestratedGatewayRuntime('http://127.0.0.1:8642', null, 30000)

        const roleBindings = new Map([
            ['planner' as const, { role: 'planner' as const, profileName: 'gpt-4o' }],
            ['developer' as const, { role: 'developer' as const, profileName: 'claude-3.5-sonnet' }],
            ['reviewer' as const, { role: 'reviewer' as const, profileName: 'gpt-4o' }],
        ])

        await runtime.runTask({
            sessionId: 'sess-1',
            taskId: 'task-1',
            taskTitle: 'Test',
            taskDescription: 'Test',
            currentStatus: 'created',
            revisionRound: 0,
            roleBindings,
            hooks: { onUpstreamRunCreated, onRawEvent: vi.fn() },
        })

        // onUpstreamRunCreated should have been called 3 times (planner, developer, reviewer)
        expect(onUpstreamRunCreated).toHaveBeenCalledTimes(3)

        // Verify each call has the role context
        const call1 = onUpstreamRunCreated.mock.calls[0]
        expect(call1[0]).toBe('test-run-id')
        expect(call1[1]).toEqual({ role: 'planner' })

        const call2 = onUpstreamRunCreated.mock.calls[1]
        expect(call2[0]).toBe('test-run-id')
        expect(call2[1]).toEqual({ role: 'developer' })

        const call3 = onUpstreamRunCreated.mock.calls[2]
        expect(call3[0]).toBe('test-run-id')
        expect(call3[1]).toEqual({ role: 'reviewer' })
    })
})
