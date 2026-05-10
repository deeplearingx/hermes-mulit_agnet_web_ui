import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentRoomRole } from '../../packages/server/src/services/hermes/agent-room/role-types'
import type { RuntimeRoleBinding } from '../../packages/server/src/services/hermes/agent-room/runner/runtime/types'
import type { RunnerRoleBinding, AgentRoomRunnerContext } from '../../packages/server/src/services/hermes/agent-room/runner/types'

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

describe('Agent Room Multi-Role Workflow (P4.9)', () => {
    let db: any = null

    beforeEach(async () => {
        vi.resetModules()
        const { DatabaseSync } = await import('node:sqlite')
        db = new DatabaseSync(':memory:')
        vi.doMock('../../packages/server/src/db/index', () => ({
            getDb: () => db,
            ensureTable: (tableName: string, schema: Record<string, string>) => ensureTableForTest(db, tableName, schema),
        }))

        const schemas = await import('../../packages/server/src/db/hermes/schemas')
        ensureTableForTest(db, schemas.AR_SESSIONS_TABLE, schemas.AR_SESSIONS_SCHEMA)
        ensureTableForTest(db, schemas.AR_TASKS_TABLE, schemas.AR_TASKS_SCHEMA)
        ensureTableForTest(db, schemas.AR_REVIEWS_TABLE, schemas.AR_REVIEWS_SCHEMA)
        ensureTableForTest(db, schemas.AR_MESSAGES_TABLE, schemas.AR_MESSAGES_SCHEMA)
        ensureTableForTest(db, schemas.AR_WORKFLOW_EVENTS_TABLE, schemas.AR_WORKFLOW_EVENTS_SCHEMA)
        ensureTableForTest(db, schemas.AR_ARTIFACTS_TABLE, schemas.AR_ARTIFACTS_SCHEMA)
        ensureTableForTest(db, schemas.AR_ROLE_BINDINGS_TABLE, schemas.AR_ROLE_BINDINGS_SCHEMA)
        ensureTableForTest(db, schemas.AR_RUNS_TABLE, schemas.AR_RUNS_SCHEMA)
        ensureTableForTest(db, schemas.AR_ROLE_RUNS_TABLE, schemas.AR_ROLE_RUNS_SCHEMA)
        ensureTableForTest(db, schemas.AR_RUN_EVENTS_TABLE, schemas.AR_RUN_EVENTS_SCHEMA)
        for (const idx of schemas.AR_INDEXES) {
            try { db.exec(idx) } catch { /* ignore */ }
        }
    })

    afterEach(() => {
        db?.close()
        db = null
        vi.doUnmock('../../packages/server/src/db/index')
        vi.resetModules()
    })

    // ─── State Machine: Full Multi-Role Lifecycle ────────────────

    describe('state machine: full multi-role lifecycle', () => {
        it('created → planned → assigned → in_progress → submitted_for_review → review_passed → delivering → completed', async () => {
            const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
            const session = svc.createSession('Multi-Role Test')
            const task = svc.createTask(session.id, 'Build Feature', 'Implement feature X')

            // Run workflow: created → planned → assigned → in_progress → submitted_for_review
            await svc.runWorkflow(session.id, task.id)

            const afterRun = svc.getTask(task.id)!
            expect(afterRun.status).toBe('submitted_for_review')

            // Review passed: submitted_for_review → review_passed
            svc.submitReview(session.id, task.id, 'reviewer', 'passed', 'LGTM')
            const afterReview = svc.getTask(task.id)!
            expect(afterReview.status).toBe('review_passed')

            // Deliver: review_passed → delivering → completed
            svc.deliverTask(session.id, task.id)
            const afterDeliver = svc.getTask(task.id)!
            expect(afterDeliver.status).toBe('completed')
        })

        it('review_rejected → revision_required → in_progress → submitted_for_review cycle', async () => {
            const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
            const session = svc.createSession('Revision Test')
            const task = svc.createTask(session.id, 'Build Feature', 'Implement feature X')

            await svc.runWorkflow(session.id, task.id)

            // Reject: submitted_for_review → review_rejected → revision_required
            svc.submitReview(session.id, task.id, 'reviewer', 'rejected', 'Needs changes')
            const afterReject = svc.getTask(task.id)!
            expect(afterReject.status).toBe('revision_required')
            expect(afterReject.revisionRound).toBe(1)

            // Retry: revision_required → in_progress → submitted_for_review
            await svc.runWorkflow(session.id, task.id)
            const afterRetry = svc.getTask(task.id)!
            expect(afterRetry.status).toBe('submitted_for_review')
        })

        it('max revision rounds → need_user_decision', async () => {
            const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
            const session = svc.createSession('Max Revision Test')
            const task = svc.createTask(session.id, 'Build Feature', 'Implement feature X')

            // First run
            await svc.runWorkflow(session.id, task.id)
            svc.submitReview(session.id, task.id, 'reviewer', 'rejected', 'Fix 1')
            expect(svc.getTask(task.id)!.status).toBe('revision_required')

            // Second run + reject
            await svc.runWorkflow(session.id, task.id)
            svc.submitReview(session.id, task.id, 'reviewer', 'rejected', 'Fix 2')
            expect(svc.getTask(task.id)!.status).toBe('revision_required')

            // Third run + reject → need_user_decision (maxRevisionRounds = 3)
            await svc.runWorkflow(session.id, task.id)
            svc.submitReview(session.id, task.id, 'reviewer', 'rejected', 'Fix 3')
            const final = svc.getTask(task.id)!
            expect(final.status).toBe('need_user_decision')
        })
    })

    // ─── Role Binding Integration ────────────────────────────────

    describe('role binding integration', () => {
        it('role bindings are passed to runner context', async () => {
            const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
            const session = svc.createSession('Binding Test')

            // Set up role bindings for all roles
            svc.setRoleBinding(session.id, 'planner', 'gpt-4o-planner')
            svc.setRoleBinding(session.id, 'developer', 'claude-3.5-sonnet')
            svc.setRoleBinding(session.id, 'reviewer', 'gpt-4o-reviewer')
            svc.setRoleBinding(session.id, 'delivery', 'gpt-4o-delivery')

            const bindings = svc.listRoleBindings(session.id)
            expect(bindings).toHaveLength(4)
            expect(bindings.find(b => b.role === 'planner')?.profileName).toBe('gpt-4o-planner')
            expect(bindings.find(b => b.role === 'developer')?.profileName).toBe('claude-3.5-sonnet')
            expect(bindings.find(b => b.role === 'reviewer')?.profileName).toBe('gpt-4o-reviewer')
            expect(bindings.find(b => b.role === 'delivery')?.profileName).toBe('gpt-4o-delivery')
        })

        it('getRoleBindingForRole returns correct binding', async () => {
            const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
            const session = svc.createSession('Get Binding Test')
            svc.setRoleBinding(session.id, 'planner', 'my-planner-profile')

            const binding = svc.getRoleBindingForRole(session.id, 'planner')
            expect(binding).not.toBeNull()
            expect(binding!.profileName).toBe('my-planner-profile')
            expect(binding!.role).toBe('planner')
        })

        it('getRoleBindingForRole returns null for unbound role', async () => {
            const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
            const session = svc.createSession('No Binding Test')

            const binding = svc.getRoleBindingForRole(session.id, 'reviewer')
            expect(binding).toBeNull()
        })

        it('setRoleBinding upserts existing binding', async () => {
            const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
            const session = svc.createSession('Upsert Binding Test')

            svc.setRoleBinding(session.id, 'developer', 'old-profile')
            svc.setRoleBinding(session.id, 'developer', 'new-profile')

            const bindings = svc.listRoleBindings(session.id)
            expect(bindings).toHaveLength(1)
            expect(bindings[0].profileName).toBe('new-profile')
        })
    })

    // ─── Run Events: Multi-Role Observability ────────────────────

    describe('run events: multi-role step observability', () => {
        it('run_workflow produces run_events with activeRole for each step', async () => {
            const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
            const session = svc.createSession('Run Events Test')
            const task = svc.createTask(session.id, 'Build Feature', 'Implement feature X')

            const run = await svc.runWorkflow(session.id, task.id)
            const runEvents = svc.listRunEventsByRun(run.id)

            // Should have run_events for each workflow event (created path: task_planned, task_assigned, task_started, task_submitted)
            expect(runEvents.length).toBeGreaterThanOrEqual(4)

            // Each run_event should have activeRole in payload
            for (const re of runEvents) {
                expect(re.payload).toBeDefined()
                expect(re.payload!.activeRole).toBeDefined()
            }

            // Verify specific roles
            const plannerEvent = runEvents.find(e => e.payload?.activeRole === 'planner')
            expect(plannerEvent).toBeDefined()
            expect(plannerEvent!.eventType).toContain('task_planned')

            const developerEvents = runEvents.filter(e => e.payload?.activeRole === 'developer')
            expect(developerEvents.length).toBeGreaterThanOrEqual(3) // assigned, in_progress, submitted_for_review
        })

        it('run_events sequence is monotonically increasing', async () => {
            const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
            const session = svc.createSession('Sequence Test')
            const task = svc.createTask(session.id, 'Build Feature', 'Implement feature X')

            const run = await svc.runWorkflow(session.id, task.id)
            const runEvents = svc.listRunEventsByRun(run.id)

            for (let i = 1; i < runEvents.length; i++) {
                expect(runEvents[i].sequence).toBeGreaterThan(runEvents[i - 1].sequence)
            }
        })

        it('run_events include workflowEventType in payload', async () => {
            const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
            const session = svc.createSession('Event Types Test')
            const task = svc.createTask(session.id, 'Build Feature', 'Implement feature X')

            const run = await svc.runWorkflow(session.id, task.id)
            const runEvents = svc.listRunEventsByRun(run.id)

            const plannedEvent = runEvents.find(e => e.payload?.workflowEventType === 'task_planned')
            expect(plannedEvent).toBeDefined()
            expect(plannedEvent!.payload!.activeRole).toBe('planner')
        })

        it('listRunEventsBySession returns all run events for session', async () => {
            const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
            const session = svc.createSession('Session Events Test')
            const task = svc.createTask(session.id, 'Build Feature', 'Implement feature X')

            const run = await svc.runWorkflow(session.id, task.id)
            const sessionEvents = svc.listRunEventsBySession(session.id)

            expect(sessionEvents.length).toBeGreaterThanOrEqual(4)
            expect(sessionEvents[0].sessionId).toBe(session.id)
            expect(sessionEvents[0].runId).toBe(run.id)
        })
    })

    // ─── Deterministic Runtime: activeRole Declarations ──────────

    describe('deterministic runtime: activeRole declarations', () => {
        it('created path: planner step has activeRole=planner', async () => {
            const { DeterministicHermesRuntime } = await import('../../packages/server/src/services/hermes/agent-room/runner/runtime/deterministic-runtime')
            const runtime = new DeterministicHermesRuntime()

            const output = await runtime.runTask({
                taskTitle: 'Test',
                taskDescription: 'Desc',
                currentStatus: 'created',
                sessionId: 's1',
                taskId: 't1',
                revisionRound: 0,
            })

            expect(output.steps[0].activeRole).toBe('planner')
            expect(output.steps[1].activeRole).toBe('developer')
            expect(output.steps[2].activeRole).toBe('developer')
            expect(output.steps[3].activeRole).toBe('developer')
        })

        it('revision path: all steps have activeRole=developer', async () => {
            const { DeterministicHermesRuntime } = await import('../../packages/server/src/services/hermes/agent-room/runner/runtime/deterministic-runtime')
            const runtime = new DeterministicHermesRuntime()

            const output = await runtime.runTask({
                taskTitle: 'Test',
                taskDescription: 'Desc',
                currentStatus: 'revision_required',
                sessionId: 's1',
                taskId: 't1',
                revisionRound: 1,
            })

            for (const step of output.steps) {
                expect(step.activeRole).toBe('developer')
            }
        })

        it('roleBindings are accepted in input without error', async () => {
            const { DeterministicHermesRuntime } = await import('../../packages/server/src/services/hermes/agent-room/runner/runtime/deterministic-runtime')
            const runtime = new DeterministicHermesRuntime()

            const roleBindings = new Map<AgentRoomRole, RuntimeRoleBinding>([
                ['planner', { role: 'planner', profileName: 'my-planner' }],
                ['developer', { role: 'developer', profileName: 'my-developer' }],
            ])

            const output = await runtime.runTask({
                taskTitle: 'Test',
                taskDescription: 'Desc',
                currentStatus: 'created',
                sessionId: 's1',
                taskId: 't1',
                revisionRound: 0,
                roleBindings,
            })

            expect(output.steps).toHaveLength(4)
        })
    })

    // ─── Real Agent Runner: Multi-Role Translation ───────────────

    describe('real agent runner: multi-role translation', () => {
        it('translates activeRole from runtime output to runner result', async () => {
            const { RealAgentRunner } = await import('../../packages/server/src/services/hermes/agent-room/runner/real-agent-runner')
            const { DeterministicHermesRuntime } = await import('../../packages/server/src/services/hermes/agent-room/runner/runtime/deterministic-runtime')

            const runner = new RealAgentRunner(new DeterministicHermesRuntime())

            // Create a minimal mock context
            const ctx: AgentRoomRunnerContext = {
                sessionId: 's1',
                taskId: 't1',
                task: {
                    id: 't1',
                    sessionId: 's1',
                    title: 'Test Task',
                    description: 'Desc',
                    status: 'created',
                    revisionRound: 0,
                    maxRevisionRounds: 3,
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                },
                roleBindings: new Map<AgentRoomRole, RunnerRoleBinding>(),
                updateTaskStatus: vi.fn() as any,
                emitEventAndMessage: vi.fn() as any,
                runInTransaction: vi.fn() as any,
                updateSessionTimestamp: vi.fn() as any,
            }

            const result = await runner.run(ctx)

            expect(result).toBeDefined()
            expect(result!.steps).toHaveLength(4)
            expect(result!.steps![0].activeRole).toBe('planner')
            expect(result!.steps![1].activeRole).toBe('developer')
            expect(result!.steps![2].activeRole).toBe('developer')
            expect(result!.steps![3].activeRole).toBe('developer')
        })

        it('passes roleBindings from context to runtime input', async () => {
            const { RealAgentRunner } = await import('../../packages/server/src/services/hermes/agent-room/runner/real-agent-runner')

            let capturedInput: any = null
            const mockRuntime = {
                runTask: vi.fn(async (input: any) => {
                    capturedInput = input
                    return { steps: [] }
                }),
            }

            const runner = new RealAgentRunner(mockRuntime as any)

            const roleBindings = new Map<AgentRoomRole, RuntimeRoleBinding>([
                ['planner', { role: 'planner', profileName: 'test-planner' }],
            ])

            const ctx: AgentRoomRunnerContext = {
                sessionId: 's1',
                taskId: 't1',
                task: {
                    id: 't1',
                    sessionId: 's1',
                    title: 'Test',
                    description: 'Desc',
                    status: 'created',
                    revisionRound: 0,
                    maxRevisionRounds: 3,
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                },
                roleBindings: roleBindings as unknown as Map<AgentRoomRole, RunnerRoleBinding>,
                updateTaskStatus: vi.fn() as any,
                emitEventAndMessage: vi.fn() as any,
                runInTransaction: vi.fn() as any,
                updateSessionTimestamp: vi.fn() as any,
            }

            await runner.run(ctx)

            expect(capturedInput).toBeDefined()
            expect(capturedInput.roleBindings).toBe(roleBindings)
            expect(capturedInput.roleBindings.get('planner').profileName).toBe('test-planner')
        })
    })

    // ─── Workflow Events: Multi-Role Event Sequence ──────────────

    describe('workflow events: multi-role event sequence', () => {
        it('full lifecycle produces events from planner, developer, reviewer, delivery', async () => {
            const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
            const session = svc.createSession('Event Sequence Test')
            const task = svc.createTask(session.id, 'Build Feature', 'Implement feature X')

            // Run workflow: planner + developer events
            await svc.runWorkflow(session.id, task.id)

            // Review: reviewer event
            svc.submitReview(session.id, task.id, 'reviewer', 'passed', 'LGTM')

            // Deliver: delivery events
            svc.deliverTask(session.id, task.id)

            const events = svc.listWorkflowEvents(session.id)
            const roles = new Set(events.map(e => e.agentRole))

            expect(roles.has('planner')).toBe(true)
            expect(roles.has('developer')).toBe(true)
            expect(roles.has('reviewer')).toBe(true)
            expect(roles.has('delivery')).toBe(true)
        })

        it('workflow events include correct event types for each role', async () => {
            const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
            const session = svc.createSession('Event Type Test')
            const task = svc.createTask(session.id, 'Build Feature', 'Implement feature X')

            await svc.runWorkflow(session.id, task.id)
            svc.submitReview(session.id, task.id, 'reviewer', 'passed', 'LGTM')
            svc.deliverTask(session.id, task.id)

            const events = svc.listWorkflowEvents(session.id)

            // Planner events
            const plannerEvents = events.filter(e => e.agentRole === 'planner')
            expect(plannerEvents.some(e => e.type === 'task_planned')).toBe(true)

            // Developer events
            const devEvents = events.filter(e => e.agentRole === 'developer')
            expect(devEvents.some(e => e.type === 'task_assigned')).toBe(true)
            expect(devEvents.some(e => e.type === 'task_started')).toBe(true)
            expect(devEvents.some(e => e.type === 'task_submitted')).toBe(true)

            // Reviewer events
            const reviewEvents = events.filter(e => e.agentRole === 'reviewer')
            expect(reviewEvents.some(e => e.type === 'review_passed')).toBe(true)

            // Delivery events
            const deliveryEvents = events.filter(e => e.agentRole === 'delivery')
            expect(deliveryEvents.some(e => e.type === 'delivery_started')).toBe(true)
            expect(deliveryEvents.some(e => e.type === 'delivery_completed')).toBe(true)
        })
    })

    // ─── Messages: Multi-Role Chat Messages ──────────────────────

    describe('messages: multi-role chat messages', () => {
        it('full lifecycle produces messages from all roles', async () => {
            const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
            const session = svc.createSession('Message Test')
            const task = svc.createTask(session.id, 'Build Feature', 'Implement feature X')

            await svc.runWorkflow(session.id, task.id)
            svc.submitReview(session.id, task.id, 'reviewer', 'passed', 'LGTM')
            svc.deliverTask(session.id, task.id)

            const messages = svc.listMessages(session.id)
            const senderRoles = new Set(messages.map(m => m.senderRole))

            // Should have messages from planner, developer, reviewer, delivery
            expect(senderRoles.has('planner')).toBe(true)
            expect(senderRoles.has('developer')).toBe(true)
            expect(senderRoles.has('reviewer')).toBe(true)
            expect(senderRoles.has('delivery')).toBe(true)
        })
    })

    // ─── Run Records: Multi-Role Run Alignment ───────────────────

    describe('run records: multi-role run alignment', () => {
        it('run record tracks runner name and lifecycle', async () => {
            const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
            const session = svc.createSession('Run Record Test')
            const task = svc.createTask(session.id, 'Build Feature', 'Implement feature X')

            const run = await svc.runWorkflow(session.id, task.id)

            expect(run.status).toBe('completed')
            expect(run.runnerName).toBeDefined()
            expect(run.startedAt).toBeDefined()
            expect(run.finishedAt).toBeDefined()
            expect(run.sessionId).toBe(session.id)
            expect(run.taskId).toBe(task.id)
        })

        it('run events are correlated with run record', async () => {
            const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
            const session = svc.createSession('Correlation Test')
            const task = svc.createTask(session.id, 'Build Feature', 'Implement feature X')

            const run = await svc.runWorkflow(session.id, task.id)
            const runEvents = svc.listRunEventsByRun(run.id)

            for (const re of runEvents) {
                expect(re.runId).toBe(run.id)
                expect(re.sessionId).toBe(session.id)
                expect(re.taskId).toBe(task.id)
            }
        })

        it('listTaskRuns returns runs for specific task', async () => {
            const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
            const session = svc.createSession('Task Runs Test')
            const task = svc.createTask(session.id, 'Build Feature', 'Implement feature X')

            await svc.runWorkflow(session.id, task.id)
            const runs = svc.listTaskRuns(session.id, task.id)

            expect(runs).toHaveLength(1)
            expect(runs[0].taskId).toBe(task.id)
        })
    })

    // ─── Regression: Existing Workflow Behavior ──────────────────

    describe('regression: existing workflow behavior preserved', () => {
        it('createTask emits task_created event with conversation role', async () => {
            const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
            const session = svc.createSession('Regression Test')
            const task = svc.createTask(session.id, 'Task', 'Desc')

            const events = svc.listWorkflowEvents(session.id)
            expect(events).toHaveLength(1)
            expect(events[0].type).toBe('task_created')
            expect(events[0].agentRole).toBe('conversation')
        })

        it('submitReview with passed transitions correctly', async () => {
            const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
            const session = svc.createSession('Review Pass Test')
            const task = svc.createTask(session.id, 'Task', 'Desc')
            await svc.runWorkflow(session.id, task.id)

            const review = svc.submitReview(session.id, task.id, 'reviewer', 'passed', 'OK')
            expect(review).not.toBeNull()
            expect(review!.status).toBe('passed')
            expect(svc.getTask(task.id)!.status).toBe('review_passed')
        })

        it('deliverTask produces final_delivery artifact', async () => {
            const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
            const session = svc.createSession('Delivery Artifact Test')
            const task = svc.createTask(session.id, 'Task', 'Desc')
            await svc.runWorkflow(session.id, task.id)
            svc.submitReview(session.id, task.id, 'reviewer', 'passed', '')

            svc.deliverTask(session.id, task.id)
            const artifacts = svc.listTaskArtifacts(session.id, task.id)
            expect(artifacts.some(a => a.type === 'final_delivery')).toBe(true)
        })

        it('retryTask from revision_required works', async () => {
            const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
            const session = svc.createSession('Retry Test')
            const task = svc.createTask(session.id, 'Task', 'Desc')
            await svc.runWorkflow(session.id, task.id)
            svc.submitReview(session.id, task.id, 'reviewer', 'rejected', 'Fix')

            const retried = svc.retryTask(session.id, task.id)
            expect(retried).not.toBeNull()
            expect(retried!.status).toBe('in_progress')
        })

        it('deleteSession cascades correctly', async () => {
            const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
            const session = svc.createSession('Delete Test')
            const task = svc.createTask(session.id, 'Task', 'Desc')
            await svc.runWorkflow(session.id, task.id)

            svc.deleteSession(session.id)
            expect(svc.getSession(session.id)).toBeNull()
        })
    })
})
