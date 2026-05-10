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

describe('Agent Room — P5.5 Stale Run Recovery', () => {
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

    // ── recoverStaleRuns ────────────────────────────────────────

    it('recoverStaleRuns marks queued runs as failed', async () => {
        const store = await import('../../packages/server/src/db/hermes/agent-room-store')
        const svc = await import('../../packages/server/src/services/hermes/agent-room/index')

        const session = svc.createSession('Test')
        const task = svc.createTask(session.id, 'Task', '')

        const now = new Date().toISOString()
        store.createRun({
            id: 'run-queued-1',
            sessionId: session.id,
            taskId: task.id,
            status: 'queued',
            runnerName: 'test',
            errorMessage: undefined,
            upstreamRunId: undefined,
            createdAt: now,
            updatedAt: now,
        })

        const recovered = store.recoverStaleRuns()
        expect(recovered).toBe(1)

        const run = store.getRun('run-queued-1')!
        expect(run.status).toBe('failed')
    })

    it('recoverStaleRuns marks running runs as failed', async () => {
        const store = await import('../../packages/server/src/db/hermes/agent-room-store')
        const svc = await import('../../packages/server/src/services/hermes/agent-room/index')

        const session = svc.createSession('Test')
        const task = svc.createTask(session.id, 'Task', '')

        const now = new Date().toISOString()
        store.createRun({
            id: 'run-running-1',
            sessionId: session.id,
            taskId: task.id,
            status: 'running',
            runnerName: 'test',
            errorMessage: undefined,
            upstreamRunId: undefined,
            createdAt: now,
            updatedAt: now,
        })

        const recovered = store.recoverStaleRuns()
        expect(recovered).toBe(1)

        const run = store.getRun('run-running-1')!
        expect(run.status).toBe('failed')
    })

    it('recoverStaleRuns does not touch completed/failed runs', async () => {
        const store = await import('../../packages/server/src/db/hermes/agent-room-store')
        const svc = await import('../../packages/server/src/services/hermes/agent-room/index')

        const session = svc.createSession('Test')
        const task = svc.createTask(session.id, 'Task', '')

        const now = new Date().toISOString()
        store.createRun({
            id: 'run-completed-1',
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
            id: 'run-failed-1',
            sessionId: session.id,
            taskId: task.id,
            status: 'failed',
            runnerName: 'test',
            errorMessage: 'original error',
            upstreamRunId: undefined,
            createdAt: now,
            updatedAt: now,
        })

        const recovered = store.recoverStaleRuns()
        expect(recovered).toBe(0)

        const completed = store.getRun('run-completed-1')!
        expect(completed.status).toBe('completed')

        const failed = store.getRun('run-failed-1')!
        expect(failed.status).toBe('failed')
        expect(failed.errorMessage).toBe('original error')
    })

    it('recoverStaleRuns returns count of recovered runs', async () => {
        const store = await import('../../packages/server/src/db/hermes/agent-room-store')
        const svc = await import('../../packages/server/src/services/hermes/agent-room/index')

        const session = svc.createSession('Test')
        const task = svc.createTask(session.id, 'Task', '')

        const now = new Date().toISOString()
        store.createRun({
            id: 'run-queued-a',
            sessionId: session.id,
            taskId: task.id,
            status: 'queued',
            runnerName: 'test',
            errorMessage: undefined,
            upstreamRunId: undefined,
            createdAt: now,
            updatedAt: now,
        })
        store.createRun({
            id: 'run-running-b',
            sessionId: session.id,
            taskId: task.id,
            status: 'running',
            runnerName: 'test',
            errorMessage: undefined,
            upstreamRunId: undefined,
            createdAt: now,
            updatedAt: now,
        })
        store.createRun({
            id: 'run-completed-c',
            sessionId: session.id,
            taskId: task.id,
            status: 'completed',
            runnerName: 'test',
            errorMessage: undefined,
            upstreamRunId: undefined,
            createdAt: now,
            updatedAt: now,
        })

        const recovered = store.recoverStaleRuns()
        expect(recovered).toBe(2)
    })

    it('recoverStaleRuns sets error_message to "Server restarted — stale run recovered"', async () => {
        const store = await import('../../packages/server/src/db/hermes/agent-room-store')
        const svc = await import('../../packages/server/src/services/hermes/agent-room/index')

        const session = svc.createSession('Test')
        const task = svc.createTask(session.id, 'Task', '')

        const now = new Date().toISOString()
        store.createRun({
            id: 'run-queued-msg',
            sessionId: session.id,
            taskId: task.id,
            status: 'queued',
            runnerName: 'test',
            errorMessage: undefined,
            upstreamRunId: undefined,
            createdAt: now,
            updatedAt: now,
        })

        store.recoverStaleRuns()

        const run = store.getRun('run-queued-msg')!
        expect(run.errorMessage).toBe('Server restarted — stale run recovered')
    })

    it('recoverStaleRuns sets finished_at and updated_at timestamps', async () => {
        const store = await import('../../packages/server/src/db/hermes/agent-room-store')
        const svc = await import('../../packages/server/src/services/hermes/agent-room/index')

        const session = svc.createSession('Test')
        const task = svc.createTask(session.id, 'Task', '')

        const oldTime = '2020-01-01T00:00:00.000Z'
        store.createRun({
            id: 'run-queued-ts',
            sessionId: session.id,
            taskId: task.id,
            status: 'queued',
            runnerName: 'test',
            errorMessage: undefined,
            upstreamRunId: undefined,
            createdAt: oldTime,
            updatedAt: oldTime,
        })

        store.recoverStaleRuns()

        const run = store.getRun('run-queued-ts')!
        expect(run.finishedAt).toBeDefined()
        expect(run.updatedAt).toBeDefined()
        // Timestamps should be newer than the old time (ISO 8601 strings are lexicographically comparable)
        expect(run.finishedAt! > oldTime).toBe(true)
        expect(run.updatedAt! > oldTime).toBe(true)
    })

    // ── recoverStaleRoleRuns ────────────────────────────────────

    it('recoverStaleRoleRuns marks queued/running role runs as failed', async () => {
        const store = await import('../../packages/server/src/db/hermes/agent-room-store')
        const svc = await import('../../packages/server/src/services/hermes/agent-room/index')

        const session = svc.createSession('Test')
        const task = svc.createTask(session.id, 'Task', '')

        const now = new Date().toISOString()
        // Create a parent run first
        store.createRun({
            id: 'parent-run',
            sessionId: session.id,
            taskId: task.id,
            status: 'completed',
            runnerName: 'test',
            errorMessage: undefined,
            upstreamRunId: undefined,
            createdAt: now,
            updatedAt: now,
        })

        store.createRoleRun({
            id: 'role-run-queued',
            runId: 'parent-run',
            sessionId: session.id,
            taskId: task.id,
            role: 'developer',
            phase: 'execute',
            status: 'queued',
            createdAt: now,
            updatedAt: now,
        })
        store.createRoleRun({
            id: 'role-run-running',
            runId: 'parent-run',
            sessionId: session.id,
            taskId: task.id,
            role: 'reviewer',
            phase: 'review',
            status: 'running',
            createdAt: now,
            updatedAt: now,
        })

        const recovered = store.recoverStaleRoleRuns()
        expect(recovered).toBe(2)

        const queued = store.getRoleRun('role-run-queued')!
        expect(queued.status).toBe('failed')

        const running = store.getRoleRun('role-run-running')!
        expect(running.status).toBe('failed')
    })

    it('recoverStaleRoleRuns does not touch completed/failed role runs', async () => {
        const store = await import('../../packages/server/src/db/hermes/agent-room-store')
        const svc = await import('../../packages/server/src/services/hermes/agent-room/index')

        const session = svc.createSession('Test')
        const task = svc.createTask(session.id, 'Task', '')

        const now = new Date().toISOString()
        store.createRun({
            id: 'parent-run-2',
            sessionId: session.id,
            taskId: task.id,
            status: 'completed',
            runnerName: 'test',
            errorMessage: undefined,
            upstreamRunId: undefined,
            createdAt: now,
            updatedAt: now,
        })

        store.createRoleRun({
            id: 'role-run-completed',
            runId: 'parent-run-2',
            sessionId: session.id,
            taskId: task.id,
            role: 'developer',
            phase: 'execute',
            status: 'completed',
            createdAt: now,
            updatedAt: now,
        })
        store.createRoleRun({
            id: 'role-run-failed',
            runId: 'parent-run-2',
            sessionId: session.id,
            taskId: task.id,
            role: 'reviewer',
            phase: 'review',
            status: 'failed',
            errorMessage: 'original error',
            createdAt: now,
            updatedAt: now,
        })
        store.createRoleRun({
            id: 'role-run-skipped',
            runId: 'parent-run-2',
            sessionId: session.id,
            taskId: task.id,
            role: 'pm',
            phase: 'plan',
            status: 'skipped',
            createdAt: now,
            updatedAt: now,
        })

        const recovered = store.recoverStaleRoleRuns()
        expect(recovered).toBe(0)

        expect(store.getRoleRun('role-run-completed')!.status).toBe('completed')
        expect(store.getRoleRun('role-run-failed')!.status).toBe('failed')
        expect(store.getRoleRun('role-run-failed')!.errorMessage).toBe('original error')
        expect(store.getRoleRun('role-run-skipped')!.status).toBe('skipped')
    })

    it('recoverStaleRoleRuns returns count of recovered role runs', async () => {
        const store = await import('../../packages/server/src/db/hermes/agent-room-store')
        const svc = await import('../../packages/server/src/services/hermes/agent-room/index')

        const session = svc.createSession('Test')
        const task = svc.createTask(session.id, 'Task', '')

        const now = new Date().toISOString()
        store.createRun({
            id: 'parent-run-3',
            sessionId: session.id,
            taskId: task.id,
            status: 'completed',
            runnerName: 'test',
            errorMessage: undefined,
            upstreamRunId: undefined,
            createdAt: now,
            updatedAt: now,
        })

        store.createRoleRun({
            id: 'role-run-q',
            runId: 'parent-run-3',
            sessionId: session.id,
            taskId: task.id,
            role: 'developer',
            phase: 'execute',
            status: 'queued',
            createdAt: now,
            updatedAt: now,
        })

        const recovered = store.recoverStaleRoleRuns()
        expect(recovered).toBe(1)
    })

    // ── Edge cases ──────────────────────────────────────────────

    it('recoverStaleRuns returns 0 when no stale runs exist', async () => {
        const store = await import('../../packages/server/src/db/hermes/agent-room-store')

        const recovered = store.recoverStaleRuns()
        expect(recovered).toBe(0)
    })

    // ── Integration: recovery unblocks workflows ────────────────

    it('after recovery, hasActiveRunForTask returns false for recovered tasks', async () => {
        const store = await import('../../packages/server/src/db/hermes/agent-room-store')
        const svc = await import('../../packages/server/src/services/hermes/agent-room/index')

        const session = svc.createSession('Test')
        const task = svc.createTask(session.id, 'Task', '')

        const now = new Date().toISOString()
        store.createRun({
            id: 'run-stale-check',
            sessionId: session.id,
            taskId: task.id,
            status: 'running',
            runnerName: 'test',
            errorMessage: undefined,
            upstreamRunId: undefined,
            createdAt: now,
            updatedAt: now,
        })

        // Before recovery: active run exists
        expect(store.hasActiveRunForTask(task.id)).toBe(true)

        store.recoverStaleRuns()

        // After recovery: no active runs
        expect(store.hasActiveRunForTask(task.id)).toBe(false)
    })

    it('after recovery, startWorkflow can proceed on previously stuck tasks', async () => {
        const store = await import('../../packages/server/src/db/hermes/agent-room-store')
        const svc = await import('../../packages/server/src/services/hermes/agent-room/index')

        const session = svc.createSession('Test')
        const task = svc.createTask(session.id, 'Task', '')

        // Insert a stale running run
        const oldTime = '2020-01-01T00:00:00.000Z'
        store.createRun({
            id: 'run-stale-unblock',
            sessionId: session.id,
            taskId: task.id,
            status: 'running',
            runnerName: 'test',
            errorMessage: undefined,
            upstreamRunId: undefined,
            createdAt: oldTime,
            updatedAt: oldTime,
        })

        // Before recovery: startWorkflow is blocked
        expect(() => svc.startWorkflow(session.id, task.id)).toThrow('Workflow is already running')

        // Simulate server restart: recover stale runs
        store.recoverStaleRuns()

        // After recovery: startWorkflow should succeed
        const run = svc.startWorkflow(session.id, task.id)
        expect(run).toBeDefined()
        expect(run.id).toBeDefined()
        expect(['queued', 'running']).toContain(run.status)

        // Wait for completion
        await vi.waitFor(() => {
            const updatedRun = store.getRun(run.id)!
            expect(updatedRun.status).toBe('completed')
        }, { timeout: 5000 })
    })

    // ── initAllStores integration ───────────────────────────────

    it('initAllStores calls recoverStaleRuns and recoverStaleRoleRuns', async () => {
        // We test this by verifying the behavior: insert stale runs, then call initAllStores
        const store = await import('../../packages/server/src/db/hermes/agent-room-store')
        const svc = await import('../../packages/server/src/services/hermes/agent-room/index')

        const session = svc.createSession('Test')
        const task = svc.createTask(session.id, 'Task', '')

        const now = new Date().toISOString()
        store.createRun({
            id: 'run-init-test',
            sessionId: session.id,
            taskId: task.id,
            status: 'queued',
            runnerName: 'test',
            errorMessage: undefined,
            upstreamRunId: undefined,
            createdAt: now,
            updatedAt: now,
        })
        store.createRoleRun({
            id: 'role-run-init-test',
            runId: 'run-init-test',
            sessionId: session.id,
            taskId: task.id,
            role: 'developer',
            phase: 'execute',
            status: 'running',
            createdAt: now,
            updatedAt: now,
        })

        // Verify stale state before initAllStores
        expect(store.hasActiveRunForTask(task.id)).toBe(true)

        // Import and call initAllStores
        const { initAllStores } = await import('../../packages/server/src/db/hermes/init')
        initAllStores()

        // After initAllStores: stale runs should be recovered
        const run = store.getRun('run-init-test')!
        expect(run.status).toBe('failed')
        expect(run.errorMessage).toBe('Server restarted — stale run recovered')

        const roleRun = store.getRoleRun('role-run-init-test')!
        expect(roleRun.status).toBe('failed')
        expect(roleRun.errorMessage).toBe('Server restarted — stale role run recovered')

        // hasActiveRunForTask should now return false
        expect(store.hasActiveRunForTask(task.id)).toBe(false)
    })
})
