import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

function ensureTableForTest(db: any, tableName: string, schema: Record<string, string>): void {
    const cols = Object.entries(schema).map(([col, type]) => `${col} ${type}`).join(', ')
    db.exec(`CREATE TABLE IF NOT EXISTS ${tableName} (${cols})`)
}

describe('Agent Room — Async Start (P4.10)', () => {
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

    // ── startWorkflow basic behavior ─────────────────────────────

    it('startWorkflow returns run record immediately (status may already be running)', async () => {
        const svc = await import('../../packages/server/src/services/hermes/agent-room/index')

        const session = svc.createSession('Test')
        const task = svc.createTask(session.id, 'Task', '')

        const run = svc.startWorkflow(session.id, task.id)

        // startWorkflow returns the run object by reference.
        // executeWorkflowInBackground synchronously mutates status to 'running',
        // so the returned object may already be 'running' (not 'queued').
        expect(run).toBeDefined()
        expect(run.id).toBeDefined()
        expect(['queued', 'running']).toContain(run.status)
        expect(run.sessionId).toBe(session.id)
        expect(run.taskId).toBe(task.id)
        expect(run.runnerName).toBeDefined()
    })

    it('startWorkflow background execution completes and run transitions to completed', async () => {
        const svc = await import('../../packages/server/src/services/hermes/agent-room/index')

        const session = svc.createSession('Test')
        const task = svc.createTask(session.id, 'Task', '')

        const run = svc.startWorkflow(session.id, task.id)
        // run.status may already be 'running' due to synchronous mutation
        expect(['queued', 'running']).toContain(run.status)

        // Wait for background execution to complete
        await vi.waitFor(() => {
            const updatedRun = svc.getRun(run.id)!
            expect(updatedRun.status).toBe('completed')
        }, { timeout: 5000 })

        // Verify task was updated by the workflow
        const updatedTask = svc.listTasks(session.id).find(t => t.id === task.id)!
        expect(updatedTask.status).toBe('submitted_for_review')
    })

    it('startWorkflow background execution failure marks run as failed', async () => {
        const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
        const { setActiveRunnerForTest, resetActiveRunnerForTest } = await import(
            '../../packages/server/src/services/hermes/agent-room/runner'
        )

        const session = svc.createSession('Test')
        const task = svc.createTask(session.id, 'Task', '')

        // Runner that throws
        setActiveRunnerForTest({
            name: 'real',
            run: async () => {
                throw new Error('Runner exploded')
            },
        })

        const run = svc.startWorkflow(session.id, task.id)
        // run.status may already be 'running' due to synchronous mutation
        expect(['queued', 'running']).toContain(run.status)

        // Wait for background execution to fail
        await vi.waitFor(() => {
            const updatedRun = svc.getRun(run.id)!
            expect(updatedRun.status).toBe('failed')
        }, { timeout: 5000 })

        const failedRun = svc.getRun(run.id)!
        expect(failedRun.errorMessage).toBe('Runner exploded')

        resetActiveRunnerForTest()
    })

    // ── startWorkflow guards ─────────────────────────────────────

    it('startWorkflow prevents duplicate runs (runningWorkflows lock)', async () => {
        const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
        const { setActiveRunnerForTest, resetActiveRunnerForTest } = await import(
            '../../packages/server/src/services/hermes/agent-room/runner'
        )

        const session = svc.createSession('Test')
        const task = svc.createTask(session.id, 'Task', '')

        // Slow runner to keep the workflow "running"
        let resolveRunner: () => void
        const runnerPromise = new Promise<void>(resolve => { resolveRunner = resolve })
        setActiveRunnerForTest({
            name: 'real',
            run: async () => {
                await runnerPromise
                return { status: 'planned' as const }
            },
        })

        // First start should succeed
        svc.startWorkflow(session.id, task.id)

        // Second start should throw because the workflow is already running
        expect(() => svc.startWorkflow(session.id, task.id)).toThrow('Workflow is already running')

        // Release the runner
        resolveRunner!()
        // Wait for background to finish
        await vi.waitFor(() => {
            const runs = svc.listRuns(session.id)
            expect(runs.some(r => r.status === 'completed')).toBe(true)
        }, { timeout: 5000 })

        resetActiveRunnerForTest()
    })

    it('startWorkflow throws on non-startable task status', async () => {
        const svc = await import('../../packages/server/src/services/hermes/agent-room/index')

        const session = svc.createSession('Test')
        const task = svc.createTask(session.id, 'Task', '')

        // Move task to submitted_for_review (not startable)
        await svc.runWorkflow(session.id, task.id)

        const updatedTask = svc.listTasks(session.id).find(t => t.id === task.id)!
        expect(updatedTask.status).toBe('submitted_for_review')

        expect(() => svc.startWorkflow(session.id, task.id)).toThrow(/Cannot start workflow in status/)
    })

    // ── buildRunHooks ────────────────────────────────────────────

    it('buildRunHooks onUpstreamRunCreated calls updateRunUpstreamId', async () => {
        const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
        const { setActiveRunnerForTest, resetActiveRunnerForTest } = await import(
            '../../packages/server/src/services/hermes/agent-room/runner'
        )

        const session = svc.createSession('Test')
        const task = svc.createTask(session.id, 'Task', '')

        let capturedHooks: any = null
        setActiveRunnerForTest({
            name: 'real',
            run: async (ctx: any) => {
                capturedHooks = ctx.hooks
                return { status: 'planned' as const }
            },
        })

        const run = svc.startWorkflow(session.id, task.id)

        // Wait for runner to execute
        await vi.waitFor(() => {
            expect(capturedHooks).not.toBeNull()
        }, { timeout: 5000 })

        // Simulate upstream run_id callback
        capturedHooks.onUpstreamRunCreated('upstream-run-123')

        const updatedRun = svc.getRun(run.id)!
        expect(updatedRun.upstreamRunId).toBe('upstream-run-123')

        resetActiveRunnerForTest()
    })

    it('buildRunHooks onRawEvent persists event as run_event', async () => {
        const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
        const { setActiveRunnerForTest, resetActiveRunnerForTest } = await import(
            '../../packages/server/src/services/hermes/agent-room/runner'
        )

        const session = svc.createSession('Test')
        const task = svc.createTask(session.id, 'Task', '')

        let capturedHooks: any = null
        setActiveRunnerForTest({
            name: 'real',
            run: async (ctx: any) => {
                capturedHooks = ctx.hooks
                return { status: 'planned' as const }
            },
        })

        const run = svc.startWorkflow(session.id, task.id)

        await vi.waitFor(() => {
            expect(capturedHooks).not.toBeNull()
        }, { timeout: 5000 })

        // Simulate raw SSE event
        capturedHooks.onRawEvent({ event: 'run.created', data: { id: 'upstream-1' } })
        capturedHooks.onRawEvent({ event: 'step.completed', data: { step: 'planning' } })

        // Wait for background to complete
        await vi.waitFor(() => {
            const updatedRun = svc.getRun(run.id)!
            expect(updatedRun.status).toBe('completed')
        }, { timeout: 5000 })

        const runEvents = svc.listRunEventsByRun(run.id)
        const gatewayEvents = runEvents.filter(e => e.source === 'gateway_sse')
        expect(gatewayEvents.length).toBeGreaterThanOrEqual(2)
        expect(gatewayEvents.some(e => e.eventType === 'run.created')).toBe(true)
        expect(gatewayEvents.some(e => e.eventType === 'step.completed')).toBe(true)

        resetActiveRunnerForTest()
    })

    it('runner step events have source=runner and gateway raw events have source=gateway_sse', async () => {
        const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
        const { setActiveRunnerForTest, resetActiveRunnerForTest } = await import(
            '../../packages/server/src/services/hermes/agent-room/runner'
        )

        const session = svc.createSession('Source Test')
        const task = svc.createTask(session.id, 'Task', '')

        let capturedHooks: any = null
        setActiveRunnerForTest({
            name: 'real',
            run: async (ctx: any) => {
                capturedHooks = ctx.hooks
                // Return structured steps — these produce runner-sourced run_events
                return {
                    steps: [
                        { status: 'planned' as const, activeRole: 'planner' as const, events: [{ type: 'task_planned', agentRole: 'planner' as const }], messages: [] },
                        { status: 'assigned' as const, activeRole: 'developer' as const, events: [{ type: 'task_assigned', agentRole: 'developer' as const }] },
                        { status: 'in_progress' as const, activeRole: 'developer' as const, events: [{ type: 'task_started', agentRole: 'developer' as const }], messages: [] },
                        { status: 'submitted_for_review' as const, activeRole: 'developer' as const, events: [{ type: 'task_submitted', agentRole: 'developer' as const }], messages: [] },
                    ],
                    artifacts: [],
                }
            },
        })

        const run = svc.startWorkflow(session.id, task.id)

        await vi.waitFor(() => {
            expect(capturedHooks).not.toBeNull()
        }, { timeout: 5000 })

        // Simulate raw SSE events (gateway_sse source)
        capturedHooks.onRawEvent({ event: 'run.created', data: { id: 'upstream-1' } })
        capturedHooks.onRawEvent({ event: 'step.completed', data: { step: 'planning' } })

        await vi.waitFor(() => {
            const updatedRun = svc.getRun(run.id)!
            expect(updatedRun.status).toBe('completed')
        }, { timeout: 5000 })

        const runEvents = svc.listRunEventsByRun(run.id)

        // Gateway raw events should have source=gateway_sse
        const gatewayEvents = runEvents.filter(e => e.source === 'gateway_sse')
        expect(gatewayEvents.length).toBeGreaterThanOrEqual(2)
        expect(gatewayEvents.some(e => e.eventType === 'run.created')).toBe(true)
        expect(gatewayEvents.some(e => e.eventType === 'step.completed')).toBe(true)

        // Runner step events should have source=runner
        const runnerEvents = runEvents.filter(e => e.source === 'runner')
        expect(runnerEvents.length).toBeGreaterThanOrEqual(4) // planned, assigned, in_progress, submitted_for_review
        expect(runnerEvents.some(e => e.eventType === 'step:planned')).toBe(true)
        expect(runnerEvents.some(e => e.eventType === 'step:assigned')).toBe(true)
        expect(runnerEvents.some(e => e.eventType === 'step:in_progress')).toBe(true)
        expect(runnerEvents.some(e => e.eventType === 'step:submitted_for_review')).toBe(true)

        // No events should have source='gateway' (old name)
        const oldGatewayEvents = runEvents.filter(e => e.source === 'gateway')
        expect(oldGatewayEvents.length).toBe(0)

        resetActiveRunnerForTest()
    })

    it('buildRunHooks hook errors do not break main flow', async () => {
        const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
        const { setActiveRunnerForTest, resetActiveRunnerForTest } = await import(
            '../../packages/server/src/services/hermes/agent-room/runner'
        )

        const session = svc.createSession('Test')
        const task = svc.createTask(session.id, 'Task', '')

        let capturedHooks: any = null
        setActiveRunnerForTest({
            name: 'real',
            run: async (ctx: any) => {
                capturedHooks = ctx.hooks
                // Call hooks with data that might cause errors (e.g. invalid run id)
                // The hooks should swallow errors
                ctx.hooks.onUpstreamRunCreated?.('upstream-ok')
                ctx.hooks.onRawEvent?.({ event: 'test' })
                return { status: 'planned' as const }
            },
        })

        const run = svc.startWorkflow(session.id, task.id)

        // Wait for background to complete successfully despite any hook issues
        await vi.waitFor(() => {
            const updatedRun = svc.getRun(run.id)!
            expect(updatedRun.status).toBe('completed')
        }, { timeout: 5000 })

        // Task should have been updated
        const updatedTask = svc.listTasks(session.id).find(t => t.id === task.id)!
        expect(updatedTask.status).toBe('planned')

        resetActiveRunnerForTest()
    })

    // ── Route tests ──────────────────────────────────────────────

    it('POST /workflow/start route returns run record', async () => {
        const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
        const { agentRoomRoutes } = await import('../../packages/server/src/routes/hermes/agent-room')

        const session = svc.createSession('Test')
        const task = svc.createTask(session.id, 'Task', '')

        const startRoute = agentRoomRoutes.stack.find((r: any) =>
            r.path === '/api/agent-room/sessions/:sessionId/tasks/:taskId/workflow/start' &&
            r.methods.includes('POST')
        )
        expect(startRoute).toBeDefined()

        const ctx = {
            params: { sessionId: session.id, taskId: task.id },
            status: 200,
            body: null,
        } as any

        await startRoute!.stack[0](ctx, async () => {})

        expect(ctx.body).toHaveProperty('success', true)
        expect(ctx.body).toHaveProperty('run')
        // run.status may already be 'running' due to synchronous mutation
        expect(['queued', 'running']).toContain(ctx.body.run.status)
        expect(ctx.body.run.sessionId).toBe(session.id)
        expect(ctx.body.run.taskId).toBe(task.id)
    })

    it('POST /workflow/run-sync route behaves same as POST /workflow', async () => {
        const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
        const { agentRoomRoutes } = await import('../../packages/server/src/routes/hermes/agent-room')

        const session = svc.createSession('Test')
        const task = svc.createTask(session.id, 'Task', '')

        const runSyncRoute = agentRoomRoutes.stack.find((r: any) =>
            r.path === '/api/agent-room/sessions/:sessionId/tasks/:taskId/workflow/run-sync' &&
            r.methods.includes('POST')
        )
        expect(runSyncRoute).toBeDefined()

        const ctx = {
            params: { sessionId: session.id, taskId: task.id },
            status: 200,
            body: null,
        } as any

        await runSyncRoute!.stack[0](ctx, async () => {})

        expect(ctx.body).toHaveProperty('success', true)
        expect(ctx.body).toHaveProperty('run')
        // run-sync is synchronous, so the run should be completed
        expect(ctx.body.run.status).toBe('completed')
    })
})
