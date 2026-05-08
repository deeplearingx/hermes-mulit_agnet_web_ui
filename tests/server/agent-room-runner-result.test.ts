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

    it('ordered steps drive full created → submitted_for_review workflow', async () => {
        const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
        const { setActiveRunnerForTest, resetActiveRunnerForTest } = await import(
            '../../packages/server/src/services/hermes/agent-room/runner'
        )

        const session = svc.createSession('Test')
        const task = svc.createTask(session.id, 'Task', '')

        // Fake runner that returns ordered steps matching the mock workflow
        setActiveRunnerForTest({
            name: 'real',
            run: async () => ({
                steps: [
                    { status: 'planned' as const, events: [{ type: 'task_planned' as const, agentRole: 'planner' as const }] },
                    { status: 'assigned' as const, events: [{ type: 'task_assigned' as const, agentRole: 'developer' as const }] },
                    { status: 'in_progress' as const, events: [{ type: 'task_started' as const, agentRole: 'developer' as const }] },
                    { status: 'submitted_for_review' as const, events: [{ type: 'task_submitted' as const, agentRole: 'developer' as const }] },
                ],
            }),
        })

        await svc.runWorkflow(session.id, task.id)

        // Verify final status
        const updatedTask = svc.listTasks(session.id).find(t => t.id === task.id)!
        expect(updatedTask.status).toBe('submitted_for_review')

        // Verify all events were emitted
        const events = svc.listWorkflowEvents(session.id)
        expect(events.some(e => e.type === 'task_planned')).toBe(true)
        expect(events.some(e => e.type === 'task_assigned')).toBe(true)
        expect(events.some(e => e.type === 'task_started')).toBe(true)
        expect(events.some(e => e.type === 'task_submitted')).toBe(true)

        resetActiveRunnerForTest()
    })

    it('ordered steps with artifacts creates artifacts after all steps', async () => {
        const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
        const { setActiveRunnerForTest, resetActiveRunnerForTest } = await import(
            '../../packages/server/src/services/hermes/agent-room/runner'
        )

        const session = svc.createSession('Test')
        const task = svc.createTask(session.id, 'Task', '')

        setActiveRunnerForTest({
            name: 'real',
            run: async () => ({
                steps: [
                    { status: 'planned' as const },
                    { status: 'assigned' as const },
                    { status: 'in_progress' as const },
                    { status: 'submitted_for_review' as const },
                ],
                artifacts: [
                    { name: 'Final Output', type: 'final_delivery' as const, content: 'Done' },
                ],
            }),
        })

        await svc.runWorkflow(session.id, task.id)

        const updatedTask = svc.listTasks(session.id).find(t => t.id === task.id)!
        expect(updatedTask.status).toBe('submitted_for_review')

        const artifacts = svc.listTaskArtifacts(session.id, task.id)
        expect(artifacts.length).toBe(1)
        expect(artifacts[0].name).toBe('Final Output')

        resetActiveRunnerForTest()
    })

    // ── P4.3: Protocol Hardening Tests ──────────────────────────

    it('ordered steps illegal migration throws and rolls back all changes', async () => {
        const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
        const { setActiveRunnerForTest, resetActiveRunnerForTest } = await import(
            '../../packages/server/src/services/hermes/agent-room/runner'
        )

        const session = svc.createSession('Test')
        const task = svc.createTask(session.id, 'Task', '')

        // Fake runner: step 1 valid (created→planned), step 2 invalid (planned→completed)
        // Includes messages and artifacts to verify full rollback
        setActiveRunnerForTest({
            name: 'real',
            run: async () => ({
                steps: [
                    {
                        status: 'planned' as const,
                        events: [{ type: 'task_planned' as const, agentRole: 'planner' as const }],
                        messages: [{ senderRole: 'planner', content: 'should rollback message' }],
                    },
                    {
                        status: 'completed' as const,
                        events: [{ type: 'delivery_completed' as const, agentRole: 'delivery' as const }],
                    },
                ],
                artifacts: [
                    { name: 'Should Not Exist', type: 'log' as const, content: 'rollback artifact' },
                ],
            }),
        })

        await expect(svc.runWorkflow(session.id, task.id)).rejects.toThrow(/Invalid step transition/)

        // Verify rollback: task should remain at 'created' (no partial state)
        const updatedTask = svc.listTasks(session.id).find(t => t.id === task.id)!
        expect(updatedTask.status).toBe('created')

        // Verify rollback: only the initial task_created event from createTask() should exist
        const events = svc.listWorkflowEvents(session.id)
        const taskEvents = events.filter(e => e.taskId === task.id)
        expect(taskEvents.length).toBe(1)
        expect(taskEvents[0].type).toBe('task_created')

        // Verify rollback: no step messages persisted
        const messages = svc.listMessages(session.id)
        expect(messages.some(m => m.content.includes('should rollback message'))).toBe(false)

        // Verify rollback: no artifacts persisted
        const artifacts = svc.listTaskArtifacts(session.id, task.id)
        expect(artifacts).toHaveLength(0)

        resetActiveRunnerForTest()
    })

    it('ordered steps event/status mismatch throws and rolls back', async () => {
        const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
        const { setActiveRunnerForTest, resetActiveRunnerForTest } = await import(
            '../../packages/server/src/services/hermes/agent-room/runner'
        )

        const session = svc.createSession('Test')
        const task = svc.createTask(session.id, 'Task', '')

        // Fake runner: valid transition but wrong event type for that status
        setActiveRunnerForTest({
            name: 'real',
            run: async () => ({
                steps: [
                    {
                        status: 'planned' as const,
                        events: [{ type: 'task_started' as const, agentRole: 'developer' as const }],
                    },
                ],
            }),
        })

        await expect(svc.runWorkflow(session.id, task.id)).rejects.toThrow(/not expected for status/)

        // Verify rollback: task should remain at 'created'
        const updatedTask = svc.listTasks(session.id).find(t => t.id === task.id)!
        expect(updatedTask.status).toBe('created')

        // Verify rollback: only the initial task_created event from createTask() should exist
        const events = svc.listWorkflowEvents(session.id)
        const taskEvents = events.filter(e => e.taskId === task.id)
        expect(taskEvents.length).toBe(1)
        expect(taskEvents[0].type).toBe('task_created')

        resetActiveRunnerForTest()
    })

    it('ordered steps with events but no status throws and rolls back', async () => {
        const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
        const { setActiveRunnerForTest, resetActiveRunnerForTest } = await import(
            '../../packages/server/src/services/hermes/agent-room/runner'
        )

        const session = svc.createSession('Test')
        const task = svc.createTask(session.id, 'Task', '')

        // Ordered steps with events but no status — must throw
        setActiveRunnerForTest({
            name: 'real',
            run: async () => ({
                steps: [
                    { events: [{ type: 'task_started' as const, agentRole: 'developer' as const }] },
                ],
            }),
        })

        await expect(svc.runWorkflow(session.id, task.id)).rejects.toThrow(/events require status/)

        // Verify rollback: task should remain at 'created'
        const updatedTask = svc.listTasks(session.id).find(t => t.id === task.id)!
        expect(updatedTask.status).toBe('created')

        // Verify rollback: no events persisted (only task_created from createTask)
        const events = svc.listWorkflowEvents(session.id)
        const taskEvents = events.filter(e => e.taskId === task.id)
        expect(taskEvents.length).toBe(1)
        expect(taskEvents[0].type).toBe('task_created')

        resetActiveRunnerForTest()
    })

    it('RealAgentRunner adapter returns deterministic ordered steps', async () => {
        const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
        const { RealAgentRunner, setActiveRunnerForTest, resetActiveRunnerForTest } = await import(
            '../../packages/server/src/services/hermes/agent-room/runner'
        )

        const session = svc.createSession('Test')
        const task = svc.createTask(session.id, 'Build Login Page', '')

        // Use the real RealAgentRunner (adapter skeleton, no LLM)
        setActiveRunnerForTest(new RealAgentRunner())

        await svc.runWorkflow(session.id, task.id)

        // Verify final status
        const updatedTask = svc.listTasks(session.id).find(t => t.id === task.id)!
        expect(updatedTask.status).toBe('submitted_for_review')

        // Verify all 4 expected events were emitted
        const events = svc.listWorkflowEvents(session.id)
        expect(events.some(e => e.type === 'task_planned')).toBe(true)
        expect(events.some(e => e.type === 'task_assigned')).toBe(true)
        expect(events.some(e => e.type === 'task_started')).toBe(true)
        expect(events.some(e => e.type === 'task_submitted')).toBe(true)

        // Verify messages reference task.title
        const messages = svc.listMessages(session.id)
        const agentMessages = messages.filter(m => m.type === 'agent_message')
        expect(agentMessages.some(m => m.content.includes('Build Login Page'))).toBe(true)

        resetActiveRunnerForTest()
    })

    it('RealAgentRunner message senderId/senderName default to senderRole', async () => {
        const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
        const { RealAgentRunner, setActiveRunnerForTest, resetActiveRunnerForTest } = await import(
            '../../packages/server/src/services/hermes/agent-room/runner'
        )

        const session = svc.createSession('Test')
        const task = svc.createTask(session.id, 'Test Task', '')

        setActiveRunnerForTest(new RealAgentRunner())

        await svc.runWorkflow(session.id, task.id)

        // Verify that direct messages (not event-produced) have senderId/senderName defaulting to senderRole
        // Event-produced messages use AGENT_META mapping (e.g. '规划 Agent'), direct messages default to senderRole
        const messages = svc.listMessages(session.id)
        const directPlannerMsg = messages.find(
            m => m.senderRole === 'planner' && m.type === 'agent_message' && m.content.includes('已完成任务'),
        )
        expect(directPlannerMsg).toBeDefined()
        expect(directPlannerMsg!.senderId).toBe('planner')
        expect(directPlannerMsg!.senderName).toBe('planner')

        // Event-produced message uses AGENT_META mapping
        const eventPlannerMsg = messages.find(
            m => m.senderRole === 'planner' && m.type === 'agent_message' && m.content.includes('制定执行计划'),
        )
        expect(eventPlannerMsg).toBeDefined()
        expect(eventPlannerMsg!.senderName).toBe('规划 Agent')

        resetActiveRunnerForTest()
    })

    it('RealAgentRunner from revision_required returns revision steps', async () => {
        const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
        const { RealAgentRunner, setActiveRunnerForTest, resetActiveRunnerForTest } = await import(
            '../../packages/server/src/services/hermes/agent-room/runner'
        )

        const session = svc.createSession('Test')
        const task = svc.createTask(session.id, 'Fix Bug', '')

        // Drive task to revision_required: created → planned → assigned → in_progress → submitted_for_review → review_rejected → revision_required
        setActiveRunnerForTest({
            name: 'real',
            run: async () => ({
                steps: [
                    { status: 'planned' as const },
                    { status: 'assigned' as const },
                    { status: 'in_progress' as const },
                    { status: 'submitted_for_review' as const },
                ],
            }),
        })
        await svc.runWorkflow(session.id, task.id)

        // Submit rejected review → revision_required
        svc.submitReview(session.id, task.id, 'reviewer', 'rejected', 'needs changes')
        const afterReview = svc.listTasks(session.id).find(t => t.id === task.id)!
        expect(afterReview.status).toBe('revision_required')

        // Now use RealAgentRunner for retry path
        setActiveRunnerForTest(new RealAgentRunner())
        await svc.runWorkflow(session.id, task.id)

        const finalTask = svc.listTasks(session.id).find(t => t.id === task.id)!
        expect(finalTask.status).toBe('submitted_for_review')

        const events = svc.listWorkflowEvents(session.id)
        expect(events.some(e => e.type === 'revision_started')).toBe(true)
        expect(events.some(e => e.type === 'task_submitted')).toBe(true)

        // Verify messages reference task title
        const messages = svc.listMessages(session.id)
        expect(messages.some(m => m.content.includes('Fix Bug') && m.content.includes('反馈修改'))).toBe(true)

        resetActiveRunnerForTest()
    })

    it('RealAgentRunner from failed returns retry steps', async () => {
        const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
        const { RealAgentRunner, setActiveRunnerForTest, resetActiveRunnerForTest } = await import(
            '../../packages/server/src/services/hermes/agent-room/runner'
        )

        const session = svc.createSession('Test')
        const task = svc.createTask(session.id, 'Deploy App', '')

        // Drive task to failed: created → planned → assigned → in_progress → failed
        setActiveRunnerForTest({
            name: 'real',
            run: async () => ({
                steps: [
                    { status: 'planned' as const },
                    { status: 'assigned' as const },
                    { status: 'in_progress' as const },
                    { status: 'failed' as const, events: [{ type: 'task_failed' as const, agentRole: 'developer' as const }] },
                ],
            }),
        })
        await svc.runWorkflow(session.id, task.id)

        const afterFail = svc.listTasks(session.id).find(t => t.id === task.id)!
        expect(afterFail.status).toBe('failed')

        // Now use RealAgentRunner for retry path
        setActiveRunnerForTest(new RealAgentRunner())
        await svc.runWorkflow(session.id, task.id)

        const finalTask = svc.listTasks(session.id).find(t => t.id === task.id)!
        expect(finalTask.status).toBe('submitted_for_review')

        const events = svc.listWorkflowEvents(session.id)
        expect(events.some(e => e.type === 'task_started')).toBe(true)
        expect(events.some(e => e.type === 'task_submitted')).toBe(true)

        // Verify messages reference task title
        const messages = svc.listMessages(session.id)
        expect(messages.some(m => m.content.includes('Deploy App') && m.content.includes('重新执行'))).toBe(true)

        resetActiveRunnerForTest()
    })

    it('RealAgentRunner from need_user_decision returns revision steps', async () => {
        const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
        const { RealAgentRunner, setActiveRunnerForTest, resetActiveRunnerForTest } = await import(
            '../../packages/server/src/services/hermes/agent-room/runner'
        )

        const session = svc.createSession('Test')
        const task = svc.createTask(session.id, 'Refactor Code', '')

        // Drive task to submitted_for_review
        setActiveRunnerForTest({
            name: 'real',
            run: async () => ({
                steps: [
                    { status: 'planned' as const },
                    { status: 'assigned' as const },
                    { status: 'in_progress' as const },
                    { status: 'submitted_for_review' as const },
                ],
            }),
        })
        await svc.runWorkflow(session.id, task.id)

        // Reject 3 times to reach need_user_decision (maxRevisionRounds = 3)
        svc.submitReview(session.id, task.id, 'reviewer', 'rejected', 'round 1')
        // retry → in_progress → submitted_for_review
        svc.retryTask(session.id, task.id)
        svc.updateTaskStatusInSession(session.id, task.id, 'submitted_for_review')
        svc.submitReview(session.id, task.id, 'reviewer', 'rejected', 'round 2')
        svc.retryTask(session.id, task.id)
        svc.updateTaskStatusInSession(session.id, task.id, 'submitted_for_review')
        svc.submitReview(session.id, task.id, 'reviewer', 'rejected', 'round 3')

        const afterReview = svc.listTasks(session.id).find(t => t.id === task.id)!
        expect(afterReview.status).toBe('need_user_decision')

        // Now use RealAgentRunner for retry path
        setActiveRunnerForTest(new RealAgentRunner())
        await svc.runWorkflow(session.id, task.id)

        const finalTask = svc.listTasks(session.id).find(t => t.id === task.id)!
        expect(finalTask.status).toBe('submitted_for_review')

        const events = svc.listWorkflowEvents(session.id)
        expect(events.some(e => e.type === 'revision_started')).toBe(true)

        resetActiveRunnerForTest()
    })
})
