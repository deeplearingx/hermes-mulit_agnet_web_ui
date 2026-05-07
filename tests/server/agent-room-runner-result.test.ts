import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

function ensureTableForTest(db: any, tableName: string, schema: Record<string, string>): void {
    const cols = Object.entries(schema).map(([col, type]) => `${col} ${type}`).join(', ')
    db.exec(`CREATE TABLE IF NOT EXISTS ${tableName} (${cols})`)
}

describe('Agent Room RunnerResult Protocol', () => {
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

    it('fake runner returning status applies via state machine', async () => {
        const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
        const { setActiveRunnerForTest, resetActiveRunnerForTest } = await import(
            '../../packages/server/src/services/hermes/agent-room/runner'
        )

        const session = svc.createSession('Test')
        const task = svc.createTask(session.id, 'Task', '')

        // Fake runner that returns a valid single-step status transition
        setActiveRunnerForTest({
            name: 'real',
            run: async () => ({
                status: 'planned' as const,
            }),
        })

        await svc.runWorkflow(session.id, task.id)

        const updatedTask = svc.listTasks(session.id).find(t => t.id === task.id)!
        expect(updatedTask.status).toBe('planned')

        resetActiveRunnerForTest()
    })

    it('fake runner returning events creates workflow events', async () => {
        const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
        const { setActiveRunnerForTest, resetActiveRunnerForTest } = await import(
            '../../packages/server/src/services/hermes/agent-room/runner'
        )

        const session = svc.createSession('Test')
        const task = svc.createTask(session.id, 'Task', '')

        // Fake runner that returns events
        setActiveRunnerForTest({
            name: 'real',
            run: async () => ({
                events: [
                    { type: 'task_started' as const, agentRole: 'developer' as const },
                    { type: 'task_submitted' as const, agentRole: 'developer' as const },
                ],
            }),
        })

        await svc.runWorkflow(session.id, task.id)

        const events = svc.listWorkflowEvents(session.id)
        expect(events.length).toBeGreaterThanOrEqual(2)
        expect(events.some(e => e.type === 'task_started')).toBe(true)
        expect(events.some(e => e.type === 'task_submitted')).toBe(true)

        resetActiveRunnerForTest()
    })

    it('fake runner returning artifacts creates task artifacts', async () => {
        const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
        const { setActiveRunnerForTest, resetActiveRunnerForTest } = await import(
            '../../packages/server/src/services/hermes/agent-room/runner'
        )

        const session = svc.createSession('Test')
        const task = svc.createTask(session.id, 'Task', '')

        // Fake runner that returns artifacts
        setActiveRunnerForTest({
            name: 'real',
            run: async () => ({
                artifacts: [
                    {
                        name: 'Build Output',
                        type: 'final_delivery' as const,
                        content: 'Build completed successfully',
                    },
                ],
            }),
        })

        await svc.runWorkflow(session.id, task.id)

        const artifacts = svc.listTaskArtifacts(session.id, task.id)
        expect(artifacts.length).toBe(1)
        expect(artifacts[0].name).toBe('Build Output')
        expect(artifacts[0].type).toBe('final_delivery')
        expect(artifacts[0].content).toBe('Build completed successfully')

        resetActiveRunnerForTest()
    })

    it('fake runner returning combined result applies all fields', async () => {
        const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
        const { setActiveRunnerForTest, resetActiveRunnerForTest } = await import(
            '../../packages/server/src/services/hermes/agent-room/runner'
        )

        const session = svc.createSession('Test')
        const task = svc.createTask(session.id, 'Task', '')

        // Fake runner that returns combined result with valid transition
        setActiveRunnerForTest({
            name: 'real',
            run: async () => ({
                status: 'planned' as const,
                events: [
                    { type: 'task_planned' as const, agentRole: 'planner' as const },
                ],
                artifacts: [
                    {
                        name: 'Code Review',
                        type: 'final_delivery' as const,
                        content: 'Review ready',
                    },
                ],
            }),
        })

        await svc.runWorkflow(session.id, task.id)

        // Verify status
        const updatedTask = svc.listTasks(session.id).find(t => t.id === task.id)!
        expect(updatedTask.status).toBe('planned')

        // Verify events
        const events = svc.listWorkflowEvents(session.id)
        expect(events.some(e => e.type === 'task_planned')).toBe(true)

        // Verify artifacts
        const artifacts = svc.listTaskArtifacts(session.id, task.id)
        expect(artifacts.length).toBe(1)
        expect(artifacts[0].name).toBe('Code Review')

        resetActiveRunnerForTest()
    })

    it('void runner (mock) still works unchanged', async () => {
        const svc = await import('../../packages/server/src/services/hermes/agent-room/index')

        const session = svc.createSession('Test')
        const task = svc.createTask(session.id, 'Task', '')

        // Default mock runner returns void
        await svc.runWorkflow(session.id, task.id)

        const updatedTask = svc.listTasks(session.id).find(t => t.id === task.id)!
        expect(updatedTask.status).toBe('submitted_for_review')

        const events = svc.listWorkflowEvents(session.id)
        expect(events.length).toBeGreaterThanOrEqual(5)
    })
})
