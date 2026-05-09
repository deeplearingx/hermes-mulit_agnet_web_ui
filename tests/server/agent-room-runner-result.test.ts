import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock gateway-run-client for the GatewayHermesRuntime integration test.
// Other tests in this file use DeterministicHermesRuntime or fake runners,
// so this mock does not affect them.
vi.mock('../../packages/server/src/services/hermes/gateway-run-client', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../packages/server/src/services/hermes/gateway-run-client')>()
    return {
        ...actual,
        runHermesGatewayTask: vi.fn(),
    }
})

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
        const { RealAgentRunner, DeterministicHermesRuntime, setActiveRunnerForTest, resetActiveRunnerForTest } = await import(
            '../../packages/server/src/services/hermes/agent-room/runner'
        )

        const session = svc.createSession('Test')
        const task = svc.createTask(session.id, 'Build Login Page', '')

        // Use the real RealAgentRunner with deterministic runtime
        setActiveRunnerForTest(new RealAgentRunner(new DeterministicHermesRuntime()))

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

    it('RealAgentRunner messages have explicit senderId/senderName', async () => {
        const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
        const { RealAgentRunner, DeterministicHermesRuntime, setActiveRunnerForTest, resetActiveRunnerForTest } = await import(
            '../../packages/server/src/services/hermes/agent-room/runner'
        )

        const session = svc.createSession('Test')
        const task = svc.createTask(session.id, 'Test Task', '')

        setActiveRunnerForTest(new RealAgentRunner(new DeterministicHermesRuntime()))

        await svc.runWorkflow(session.id, task.id)

        // Direct messages from RealAgentRunner have explicit senderId/senderName
        const messages = svc.listMessages(session.id)
        const directPlannerMsg = messages.find(
            m => m.senderRole === 'planner' && m.type === 'agent_message' && m.content.includes('已完成任务'),
        )
        expect(directPlannerMsg).toBeDefined()
        expect(directPlannerMsg!.senderId).toBe('planner')
        expect(directPlannerMsg!.senderName).toBe('规划 Agent')

        const directDevMsg = messages.find(
            m => m.senderRole === 'developer' && m.type === 'agent_message' && m.content.includes('开始执行任务'),
        )
        expect(directDevMsg).toBeDefined()
        expect(directDevMsg!.senderId).toBe('developer')
        expect(directDevMsg!.senderName).toBe('开发 Agent')

        // Event-produced message also uses AGENT_META mapping
        const eventPlannerMsg = messages.find(
            m => m.senderRole === 'planner' && m.type === 'agent_message' && m.content.includes('制定执行计划'),
        )
        expect(eventPlannerMsg).toBeDefined()
        expect(eventPlannerMsg!.senderName).toBe('规划 Agent')

        resetActiveRunnerForTest()
    })

    it('RealAgentRunner from revision_required returns revision steps', async () => {
        const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
        const { RealAgentRunner, DeterministicHermesRuntime, setActiveRunnerForTest, resetActiveRunnerForTest } = await import(
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
        setActiveRunnerForTest(new RealAgentRunner(new DeterministicHermesRuntime()))
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
        const { RealAgentRunner, DeterministicHermesRuntime, setActiveRunnerForTest, resetActiveRunnerForTest } = await import(
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
        setActiveRunnerForTest(new RealAgentRunner(new DeterministicHermesRuntime()))
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
        const { RealAgentRunner, DeterministicHermesRuntime, setActiveRunnerForTest, resetActiveRunnerForTest } = await import(
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
        setActiveRunnerForTest(new RealAgentRunner(new DeterministicHermesRuntime()))
        await svc.runWorkflow(session.id, task.id)

        const finalTask = svc.listTasks(session.id).find(t => t.id === task.id)!
        expect(finalTask.status).toBe('submitted_for_review')

        const events = svc.listWorkflowEvents(session.id)
        expect(events.some(e => e.type === 'revision_started')).toBe(true)

        resetActiveRunnerForTest()
    })

    it('RealAgentRunner + RealHermesRuntime end-to-end: HTTP → runWorkflow → state machine → DB', async () => {
        const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
        const { RealAgentRunner } = await import(
            '../../packages/server/src/services/hermes/agent-room/runner'
        )
        const { RealHermesRuntime } = await import(
            '../../packages/server/src/services/hermes/agent-room/runner/runtime'
        )
        const { setActiveRunnerForTest, resetActiveRunnerForTest } = await import(
            '../../packages/server/src/services/hermes/agent-room/runner'
        )

        // Mock fetch to return a full created → submitted_for_review workflow
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            new Response(JSON.stringify({
                steps: [
                    {
                        status: 'planned',
                        events: [{ type: 'task_planned', agentRole: 'planner' }],
                        messages: [{ senderRole: 'planner', senderId: 'planner', senderName: '规划 Agent', content: '已完成任务「Test Task」的规划' }],
                    },
                    {
                        status: 'assigned',
                        events: [{ type: 'task_assigned', agentRole: 'developer' }],
                    },
                    {
                        status: 'in_progress',
                        events: [{ type: 'task_started', agentRole: 'developer' }],
                        messages: [{ senderRole: 'developer', senderId: 'developer', senderName: '开发 Agent', content: '开始执行任务「Test Task」' }],
                    },
                    {
                        status: 'submitted_for_review',
                        events: [{ type: 'task_submitted', agentRole: 'developer' }],
                        messages: [{ senderRole: 'developer', senderId: 'developer', senderName: '开发 Agent', content: '任务「Test Task」已提交审核' }],
                    },
                ],
                artifacts: [{ name: 'output.md', type: 'code_output', content: '# Output' }],
            }), { status: 200 }),
        )

        // Wire up RealAgentRunner with RealHermesRuntime
        const runtime = new RealHermesRuntime('https://agent.example.com')
        setActiveRunnerForTest(new RealAgentRunner(runtime))

        const session = svc.createSession('Integration Test')
        const task = svc.createTask(session.id, 'Test Task', 'A test task')

        await svc.runWorkflow(session.id, task.id)

        // 1. Final status
        const finalTask = svc.listTasks(session.id).find(t => t.id === task.id)!
        expect(finalTask.status).toBe('submitted_for_review')

        // 2. Events
        const events = svc.listWorkflowEvents(session.id)
        expect(events.some(e => e.type === 'task_planned')).toBe(true)
        expect(events.some(e => e.type === 'task_assigned')).toBe(true)
        expect(events.some(e => e.type === 'task_started')).toBe(true)
        expect(events.some(e => e.type === 'task_submitted')).toBe(true)

        // 3. Messages persisted
        const messages = svc.listMessages(session.id)
        const directMessages = messages.filter(m => m.type === 'agent_message')
        expect(directMessages.length).toBeGreaterThanOrEqual(3)
        expect(directMessages.some(m => m.content.includes('规划'))).toBe(true)
        expect(directMessages.some(m => m.content.includes('开始执行'))).toBe(true)
        expect(directMessages.some(m => m.content.includes('已提交审核'))).toBe(true)

        // 4. Artifacts persisted
        const artifacts = svc.listTaskArtifacts(session.id, task.id)
        expect(artifacts).toHaveLength(1)
        expect(artifacts[0].name).toBe('output.md')
        expect(artifacts[0].type).toBe('code_output')

        resetActiveRunnerForTest()
    })

    // ── P4.7.1: GatewayHermesRuntime service-level regression ───

    it('RealAgentRunner + GatewayHermesRuntime + runWorkflow: full chain → DB', async () => {
        const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
        const { RealAgentRunner, setActiveRunnerForTest, resetActiveRunnerForTest } = await import(
            '../../packages/server/src/services/hermes/agent-room/runner'
        )
        const { GatewayHermesRuntime } = await import(
            '../../packages/server/src/services/hermes/agent-room/runner/runtime/gateway-hermes-runtime'
        )

        // Configure the hoisted mock for this test
        const { runHermesGatewayTask } = await import('../../packages/server/src/services/hermes/gateway-run-client')
        vi.mocked(runHermesGatewayTask).mockResolvedValue({
            output: 'Login page implemented with OAuth2 support',
            runId: 'run-gw-001',
            sessionId: 'agent-room-sess-1-task-1',
        })

        // Wire up RealAgentRunner with GatewayHermesRuntime
        const runtime = new GatewayHermesRuntime('http://127.0.0.1:8642', null, 30000)
        setActiveRunnerForTest(new RealAgentRunner(runtime))

        const session = svc.createSession('Gateway Integration Test')
        const task = svc.createTask(session.id, 'Build Login Page', 'Create a login page with OAuth2')

        await svc.runWorkflow(session.id, task.id)

        // 1. Final status should be submitted_for_review
        const finalTask = svc.listTasks(session.id).find(t => t.id === task.id)!
        expect(finalTask.status).toBe('submitted_for_review')

        // 2. Workflow events: task_planned → task_assigned → task_started → task_submitted
        const events = svc.listWorkflowEvents(session.id)
        expect(events.some(e => e.type === 'task_planned')).toBe(true)
        expect(events.some(e => e.type === 'task_assigned')).toBe(true)
        expect(events.some(e => e.type === 'task_started')).toBe(true)
        expect(events.some(e => e.type === 'task_submitted')).toBe(true)

        // 3. Messages include Gateway final output
        const messages = svc.listMessages(session.id)
        const agentMessages = messages.filter(m => m.type === 'agent_message')
        expect(agentMessages.some(m => m.content.includes('Login page implemented with OAuth2 support'))).toBe(true)

        // 4. Artifacts: code_output with runId metadata
        const artifacts = svc.listTaskArtifacts(session.id, task.id)
        expect(artifacts).toHaveLength(1)
        expect(artifacts[0].type).toBe('code_output')
        expect(artifacts[0].content).toBe('Login page implemented with OAuth2 support')
        // Verify metadata is persisted through runWorkflow → applyRunnerResult → DB
        expect(artifacts[0].metadata).toBeDefined()
        expect(artifacts[0].metadata?.runId).toBe('run-gw-001')
        expect(artifacts[0].metadata?.source).toBe('hermes-gateway')

        resetActiveRunnerForTest()
    })

    it('GatewayHermesRuntime + role binding: artifact metadata includes profileName/bindingSource/transportSource', async () => {
        const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
        const { RealAgentRunner, setActiveRunnerForTest, resetActiveRunnerForTest } = await import(
            '../../packages/server/src/services/hermes/agent-room/runner'
        )
        const { GatewayHermesRuntime } = await import(
            '../../packages/server/src/services/hermes/agent-room/runner/runtime/gateway-hermes-runtime'
        )

        const { runHermesGatewayTask } = await import('../../packages/server/src/services/hermes/gateway-run-client')
        vi.mocked(runHermesGatewayTask).mockResolvedValue({
            output: 'Feature implemented',
            runId: 'run-rb-001',
            sessionId: 'agent-room-sess-1-task-1',
        })

        const runtime = new GatewayHermesRuntime('http://127.0.0.1:8642', null, 30000)
        setActiveRunnerForTest(new RealAgentRunner(runtime))

        const session = svc.createSession('Role Binding Metadata Test')
        const task = svc.createTask(session.id, 'Build Feature', 'Implement feature X')

        // Create a role binding so the resolver picks it up
        svc.createRoleBinding(session.id, 'developer', 'my-custom-profile')

        await svc.runWorkflow(session.id, task.id)

        const artifacts = svc.listTaskArtifacts(session.id, task.id)
        expect(artifacts).toHaveLength(1)

        // Full metadata assertion
        const meta = artifacts[0].metadata!
        expect(meta.runId).toBe('run-rb-001')
        expect(meta.source).toBe('hermes-gateway')
        expect(meta.profileName).toBe('my-custom-profile')
        expect(meta.bindingSource).toBe('role-binding')
        expect(meta.transportSource).toBe('constructor-fallback')

        resetActiveRunnerForTest()
    })

    it('GatewayHermesRuntime without role binding: metadata shows bindingSource=none', async () => {
        const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
        const { RealAgentRunner, setActiveRunnerForTest, resetActiveRunnerForTest } = await import(
            '../../packages/server/src/services/hermes/agent-room/runner'
        )
        const { GatewayHermesRuntime } = await import(
            '../../packages/server/src/services/hermes/agent-room/runner/runtime/gateway-hermes-runtime'
        )

        const { runHermesGatewayTask } = await import('../../packages/server/src/services/hermes/gateway-run-client')
        vi.mocked(runHermesGatewayTask).mockResolvedValue({
            output: 'Done',
            runId: 'run-norb-001',
            sessionId: 'agent-room-sess-1-task-1',
        })

        const runtime = new GatewayHermesRuntime('http://127.0.0.1:8642', null, 30000)
        setActiveRunnerForTest(new RealAgentRunner(runtime))

        const session = svc.createSession('No Role Binding Test')
        const task = svc.createTask(session.id, 'Simple Task', 'Do something')

        // No role binding created — resolver falls through to assignedAgentId or none
        await svc.runWorkflow(session.id, task.id)

        const artifacts = svc.listTaskArtifacts(session.id, task.id)
        expect(artifacts).toHaveLength(1)

        const meta = artifacts[0].metadata!
        expect(meta.runId).toBe('run-norb-001')
        expect(meta.source).toBe('hermes-gateway')
        // No role binding and no assignedAgentId → bindingSource is 'none'
        expect(meta.bindingSource).toBe('none')
        expect(meta.transportSource).toBe('constructor-fallback')

        resetActiveRunnerForTest()
    })
})
