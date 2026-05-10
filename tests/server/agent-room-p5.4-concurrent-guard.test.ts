import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock gateway-run-client at module level so it's available for all tests
vi.mock('../../packages/server/src/services/hermes/gateway-run-client', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../packages/server/src/services/hermes/gateway-run-client')>()
    return {
        ...actual,
        runHermesGatewayTask: vi.fn(),
    }
})

// Mock config at module level
vi.mock('../../packages/server/src/config', () => ({
    config: {
        upstream: 'http://127.0.0.1:8642',
    },
}))

function ensureTableForTest(db: any, tableName: string, schema: Record<string, string>): void {
    const cols = Object.entries(schema).map(([col, type]) => `${col} ${type}`).join(', ')
    db.exec(`CREATE TABLE IF NOT EXISTS ${tableName} (${cols})`)
}

describe('Agent Room — P5.4 Concurrent Guard (DB-level)', () => {
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

    // ── hasActiveRunForTask (store-level) ────────────────────────

    it('hasActiveRunForTask returns false when no active runs', async () => {
        const store = await import('../../packages/server/src/db/hermes/agent-room-store')
        expect(store.hasActiveRunForTask('nonexistent-task')).toBe(false)
    })

    it('hasActiveRunForTask returns true when a queued run exists', async () => {
        const store = await import('../../packages/server/src/db/hermes/agent-room-store')
        const svc = await import('../../packages/server/src/services/hermes/agent-room/index')

        const session = svc.createSession('Test')
        const task = svc.createTask(session.id, 'Task', '')

        // Create a run record directly in the DB with 'queued' status
        const now = new Date().toISOString()
        store.createRun({
            id: 'run-queued-test',
            sessionId: session.id,
            taskId: task.id,
            status: 'queued',
            runnerName: 'test',
            errorMessage: undefined,
            upstreamRunId: undefined,
            createdAt: now,
            updatedAt: now,
        })

        expect(store.hasActiveRunForTask(task.id)).toBe(true)
    })

    it('hasActiveRunForTask returns true when a running run exists', async () => {
        const store = await import('../../packages/server/src/db/hermes/agent-room-store')
        const svc = await import('../../packages/server/src/services/hermes/agent-room/index')

        const session = svc.createSession('Test')
        const task = svc.createTask(session.id, 'Task', '')

        const now = new Date().toISOString()
        store.createRun({
            id: 'run-running-test',
            sessionId: session.id,
            taskId: task.id,
            status: 'running',
            runnerName: 'test',
            errorMessage: undefined,
            upstreamRunId: undefined,
            createdAt: now,
            updatedAt: now,
        })

        expect(store.hasActiveRunForTask(task.id)).toBe(true)
    })

    it('hasActiveRunForTask returns false when all runs are completed/failed', async () => {
        const store = await import('../../packages/server/src/db/hermes/agent-room-store')
        const svc = await import('../../packages/server/src/services/hermes/agent-room/index')

        const session = svc.createSession('Test')
        const task = svc.createTask(session.id, 'Task', '')

        // Create completed and failed runs
        const now = new Date().toISOString()
        store.createRun({
            id: 'run-completed-test',
            sessionId: session.id,
            taskId: task.id,
            status: 'completed',
            runnerName: 'test',
            errorMessage: undefined,
            upstreamRunId: undefined,
            createdAt: now,
            updatedAt: now,
        })
        store.createRun({
            id: 'run-failed-test',
            sessionId: session.id,
            taskId: task.id,
            status: 'failed',
            runnerName: 'test',
            errorMessage: 'some error',
            upstreamRunId: undefined,
            createdAt: now,
            updatedAt: now,
        })

        expect(store.hasActiveRunForTask(task.id)).toBe(false)
    })

    // ── startWorkflow DB-level guard ─────────────────────────────

    it('startWorkflow throws when DB has active run (even if in-memory lock is cleared)', async () => {
        const store = await import('../../packages/server/src/db/hermes/agent-room-store')
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

        // Start the first workflow
        svc.startWorkflow(session.id, task.id)

        // Clear the in-memory lock manually (simulating a crash/restart scenario)
        // We can't directly access runningWorkflows, but we can manipulate the DB
        // by inserting another queued run. The point is: even if the in-memory lock
        // is somehow cleared, the DB guard should still catch it.
        // For this test, we'll verify the DB guard is hit first by inserting
        // a run directly into the DB that bypasses the in-memory check.
        // The in-memory check will already catch this, so we test the DB guard
        // by verifying it's checked AFTER the in-memory check.

        // The first start already added to runningWorkflows, so second call
        // will be caught by in-memory guard. Let's release and verify DB guard.
        resolveRunner!()
        await vi.waitFor(() => {
            const runs = svc.listRuns(session.id)
            expect(runs.some(r => r.status === 'completed')).toBe(true)
        }, { timeout: 5000 })

        // Now simulate: in-memory lock is cleared (after completion), but DB has
        // a stale 'running' run that wasn't cleaned up (simulating a crash)
        const now = new Date().toISOString()
        store.createRun({
            id: 'run-stale',
            sessionId: session.id,
            taskId: task.id,
            status: 'running',
            runnerName: 'test',
            errorMessage: undefined,
            upstreamRunId: undefined,
            createdAt: now,
            updatedAt: now,
        })

        // startWorkflow should now be blocked by the DB-level guard
        expect(() => svc.startWorkflow(session.id, task.id)).toThrow('Workflow is already running')

        resetActiveRunnerForTest()
    })

    it('startWorkflow allows starting after previous run completes (DB guard clears)', async () => {
        const svc = await import('../../packages/server/src/services/hermes/agent-room/index')

        const session = svc.createSession('Test')
        const task = svc.createTask(session.id, 'Task', '')

        // First workflow completes normally
        await svc.runWorkflow(session.id, task.id)

        const updatedTask = svc.listTasks(session.id).find(t => t.id === task.id)!
        expect(updatedTask.status).toBe('submitted_for_review')

        // Reset task status to allow starting again
        // (In real usage, review rejection would set it back to a startable status)
        // We simulate by fetching the task, changing status, and updating via store
        const store = await import('../../packages/server/src/db/hermes/agent-room-store')
        const dbTask = store.getTask(task.id)!
        store.updateTask({ ...dbTask, status: 'created', updatedAt: new Date().toISOString() })

        // Should be able to start a new workflow since previous run is completed
        const run = svc.startWorkflow(session.id, task.id)
        expect(run).toBeDefined()
        expect(run.id).toBeDefined()
        expect(['queued', 'running']).toContain(run.status)

        // Wait for it to complete
        await vi.waitFor(() => {
            const updatedRun = svc.getRun(run.id)!
            expect(updatedRun.status).toBe('completed')
        }, { timeout: 5000 })
    })

    it('startWorkflow prevents concurrent startWorkflow calls on same task (in-memory + DB)', async () => {
        const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
        const { setActiveRunnerForTest, resetActiveRunnerForTest } = await import(
            '../../packages/server/src/services/hermes/agent-room/runner'
        )

        const session = svc.createSession('Test')
        const task = svc.createTask(session.id, 'Task', '')

        // Slow runner
        let resolveRunner: () => void
        const runnerPromise = new Promise<void>(resolve => { resolveRunner = resolve })
        setActiveRunnerForTest({
            name: 'real',
            run: async () => {
                await runnerPromise
                return { status: 'planned' as const }
            },
        })

        // First start succeeds
        svc.startWorkflow(session.id, task.id)

        // Concurrent second start should fail (in-memory guard catches it)
        expect(() => svc.startWorkflow(session.id, task.id)).toThrow('Workflow is already running')
        // Third attempt also fails
        expect(() => svc.startWorkflow(session.id, task.id)).toThrow('Workflow is already running')

        // Release
        resolveRunner!()
        await vi.waitFor(() => {
            const runs = svc.listRuns(session.id)
            expect(runs.some(r => r.status === 'completed')).toBe(true)
        }, { timeout: 5000 })

        resetActiveRunnerForTest()
    })

    it('runWorkflow also respects DB-level guard', async () => {
        const store = await import('../../packages/server/src/db/hermes/agent-room-store')
        const svc = await import('../../packages/server/src/services/hermes/agent-room/index')

        const session = svc.createSession('Test')
        const task = svc.createTask(session.id, 'Task', '')

        // Insert a stale running run directly in DB
        const now = new Date().toISOString()
        store.createRun({
            id: 'run-stale-for-run',
            sessionId: session.id,
            taskId: task.id,
            status: 'running',
            runnerName: 'test',
            errorMessage: undefined,
            upstreamRunId: undefined,
            createdAt: now,
            updatedAt: now,
        })

        // runWorkflow should also be blocked by the DB-level guard
        await expect(svc.runWorkflow(session.id, task.id)).rejects.toThrow('Workflow is already running')
    })

    it('different tasks can run concurrently (guard is per-task)', async () => {
        const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
        const { setActiveRunnerForTest, resetActiveRunnerForTest } = await import(
            '../../packages/server/src/services/hermes/agent-room/runner'
        )

        const session = svc.createSession('Test')
        const task1 = svc.createTask(session.id, 'Task 1', '')
        const task2 = svc.createTask(session.id, 'Task 2', '')

        // Slow runner
        let resolveRunner: () => void
        const runnerPromise = new Promise<void>(resolve => { resolveRunner = resolve })
        setActiveRunnerForTest({
            name: 'real',
            run: async () => {
                await runnerPromise
                return { status: 'planned' as const }
            },
        })

        // Both tasks should be able to start concurrently
        const run1 = svc.startWorkflow(session.id, task1.id)
        const run2 = svc.startWorkflow(session.id, task2.id)

        expect(run1).toBeDefined()
        expect(run2).toBeDefined()
        expect(run1.taskId).not.toBe(run2.taskId)
        expect(['queued', 'running']).toContain(run1.status)
        expect(['queued', 'running']).toContain(run2.status)

        // Release
        resolveRunner!()
        await vi.waitFor(() => {
            const runs1 = svc.listRuns(session.id).filter(r => r.taskId === task1.id)
            const runs2 = svc.listRuns(session.id).filter(r => r.taskId === task2.id)
            expect(runs1.some(r => r.status === 'completed')).toBe(true)
            expect(runs2.some(r => r.status === 'completed')).toBe(true)
        }, { timeout: 5000 })

        resetActiveRunnerForTest()
    })
})
