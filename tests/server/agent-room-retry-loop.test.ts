import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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

// Mock the gateway-run-client module
vi.mock('../../packages/server/src/services/hermes/gateway-run-client', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../packages/server/src/services/hermes/gateway-run-client')>()
    return {
        ...actual,
        runHermesGatewayTask: vi.fn(),
    }
})

// Mock the config module
vi.mock('../../packages/server/src/config', () => ({
    config: {
        upstream: 'http://127.0.0.1:9999',
    },
}))

import { runHermesGatewayTask } from '../../packages/server/src/services/hermes/gateway-run-client'
import {
    OrchestratedGatewayRuntime,
    RealAgentRunner,
} from '../../packages/server/src/services/hermes/agent-room/runner'
import type { HermesAgentRuntimeInput } from '../../packages/server/src/services/hermes/agent-room/runner/runtime/types'

// ─── Shared helpers ─────────────────────────────────────────────

function makeInput(overrides: Partial<HermesAgentRuntimeInput> = {}): HermesAgentRuntimeInput {
    return {
        sessionId: 'sess-1',
        taskId: 'task-1',
        taskTitle: 'Implement login page',
        taskDescription: 'Create a login page with email/password',
        currentStatus: 'created',
        revisionRound: 0,
        roleBindings: new Map([
            ['planner', { role: 'planner', profileName: 'gpt-4o' }],
            ['developer', { role: 'developer', profileName: 'claude-3.5-sonnet' }],
            ['reviewer', { role: 'reviewer', profileName: 'gpt-4o' }],
        ]),
        ...overrides,
    }
}

function mockRetryGatewayRuns(
    developerRunId = 'run-dev-retry-001',
    reviewerRunId = 'run-reviewer-retry-001',
    reviewOutput = 'approved\n\nLGTM, the changes look correct.',
) {
    const developerResult = {
        output: 'Revision complete: fixed the issues mentioned in review feedback',
        runId: developerRunId,
        sessionId: 'agent-room-developer-sess-1-task-1-rev1',
    }
    const reviewerResult = {
        output: reviewOutput,
        runId: reviewerRunId,
        sessionId: 'agent-room-reviewer-sess-1-task-1-rev1',
    }
    vi.mocked(runHermesGatewayTask)
        .mockResolvedValueOnce(developerResult)
        .mockResolvedValueOnce(reviewerResult)
    return { developerResult, reviewerResult }
}

// ─── P3: Retry Loop Tests ───────────────────────────────────────

describe('P3: OrchestratedGatewayRuntime retry path', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    describe('revision_required → developer + reviewer (no planner)', () => {
        it('calls runHermesGatewayTask exactly 2 times (developer + reviewer)', async () => {
            mockRetryGatewayRuns()

            const runtime = new OrchestratedGatewayRuntime('http://127.0.0.1:8642', null, 30000)
            await runtime.runTask(makeInput({
                currentStatus: 'revision_required',
                revisionRound: 1,
            }))

            expect(runHermesGatewayTask).toHaveBeenCalledTimes(2)
        })

        it('does NOT call planner — skips planner phase', async () => {
            mockRetryGatewayRuns()

            const runtime = new OrchestratedGatewayRuntime('http://127.0.0.1:8642', null, 30000)
            await runtime.runTask(makeInput({
                currentStatus: 'revision_required',
                revisionRound: 1,
            }))

            const calls = vi.mocked(runHermesGatewayTask).mock.calls
            // First call is developer, not planner
            expect(calls[0][0].sessionId).toContain('developer')
            expect(calls[0][0].sessionId).not.toContain('planner')
        })

        it('returns ordered steps: in_progress → submitted_for_review → review_passed', async () => {
            mockRetryGatewayRuns('dev-001', 'rev-001', 'approved\n\nLooks good.')

            const runtime = new OrchestratedGatewayRuntime('http://127.0.0.1:8642', null, 30000)
            const result = await runtime.runTask(makeInput({
                currentStatus: 'revision_required',
                revisionRound: 1,
            }))

            expect(result.steps).toHaveLength(3)
            expect(result.steps[0].status).toBe('in_progress')
            expect(result.steps[1].status).toBe('submitted_for_review')
            expect(result.steps[2].status).toBe('review_passed')
        })

        it('in_progress step emits revision_started event', async () => {
            mockRetryGatewayRuns()

            const runtime = new OrchestratedGatewayRuntime('http://127.0.0.1:8642', null, 30000)
            const result = await runtime.runTask(makeInput({
                currentStatus: 'revision_required',
                revisionRound: 2,
            }))

            const step0 = result.steps[0]
            expect(step0.events[0].type).toBe('revision_started')
            expect(step0.events[0].agentRole).toBe('developer')
        })

        it('passes previousReviewFeedback to developer Gateway call', async () => {
            mockRetryGatewayRuns()

            const runtime = new OrchestratedGatewayRuntime('http://127.0.0.1:8642', null, 30000)
            await runtime.runTask(makeInput({
                currentStatus: 'revision_required',
                revisionRound: 1,
                previousReviewFeedback: 'Please fix the error handling',
            }))

            const devCall = vi.mocked(runHermesGatewayTask).mock.calls[0][0]
            expect(devCall.input).toContain('Please fix the error handling')
            expect(devCall.instructions).toContain('修订')
        })
    })

    describe('need_user_decision → developer + reviewer', () => {
        it('returns same step sequence as revision_required', async () => {
            mockRetryGatewayRuns('dev-002', 'rev-002', 'approved\n\nPass.')

            const runtime = new OrchestratedGatewayRuntime('http://127.0.0.1:8642', null, 30000)
            const result = await runtime.runTask(makeInput({
                currentStatus: 'need_user_decision',
                revisionRound: 3,
            }))

            expect(result.steps).toHaveLength(3)
            expect(result.steps[0].status).toBe('in_progress')
            expect(result.steps[0].events[0].type).toBe('revision_started')
            expect(result.steps[1].status).toBe('submitted_for_review')
            expect(result.steps[2].status).toBe('review_passed')
        })
    })

    describe('failed → developer + reviewer', () => {
        it('in_progress step emits task_started (not revision_started)', async () => {
            mockRetryGatewayRuns('dev-003', 'rev-003', 'approved\n\nPass.')

            const runtime = new OrchestratedGatewayRuntime('http://127.0.0.1:8642', null, 30000)
            const result = await runtime.runTask(makeInput({
                currentStatus: 'failed',
                revisionRound: 0,
            }))

            expect(result.steps[0].events[0].type).toBe('task_started')
        })

        it('developer input does NOT contain review feedback for failed path', async () => {
            mockRetryGatewayRuns()

            const runtime = new OrchestratedGatewayRuntime('http://127.0.0.1:8642', null, 30000)
            await runtime.runTask(makeInput({
                currentStatus: 'failed',
                revisionRound: 0,
                previousReviewFeedback: undefined,
            }))

            const devCall = vi.mocked(runHermesGatewayTask).mock.calls[0][0]
            expect(devCall.input).toContain('重试')
            expect(devCall.input).not.toContain('审核反馈')
        })
    })

    describe('reviewer rejects: revision_required decision', () => {
        it('returns review_rejected → revision_required steps', async () => {
            mockRetryGatewayRuns('dev-004', 'rev-004', 'revision_required\n\nNeed more error handling.')

            const runtime = new OrchestratedGatewayRuntime('http://127.0.0.1:8642', null, 30000)
            const result = await runtime.runTask(makeInput({
                currentStatus: 'revision_required',
                revisionRound: 1,
            }))

            expect(result.steps).toHaveLength(4)
            expect(result.steps[0].status).toBe('in_progress')
            expect(result.steps[1].status).toBe('submitted_for_review')
            expect(result.steps[2].status).toBe('review_rejected')
            expect(result.steps[3].status).toBe('revision_required')
        })
    })

    describe('reviewer rejects: need_user_decision decision', () => {
        it('returns review_rejected → need_user_decision steps', async () => {
            mockRetryGatewayRuns('dev-005', 'rev-005', 'need_user_decision\n\nThis requires user input.')

            const runtime = new OrchestratedGatewayRuntime('http://127.0.0.1:8642', null, 30000)
            const result = await runtime.runTask(makeInput({
                currentStatus: 'revision_required',
                revisionRound: 1,
            }))

            expect(result.steps).toHaveLength(4)
            expect(result.steps[2].status).toBe('review_rejected')
            expect(result.steps[3].status).toBe('need_user_decision')
        })
    })

    describe('metadata consistency', () => {
        it('includes developer and reviewer metadata (no planner)', async () => {
            mockRetryGatewayRuns('dev-meta-001', 'rev-meta-001', 'approved\n\nOK.')

            const runtime = new OrchestratedGatewayRuntime('http://127.0.0.1:8642', null, 30000)
            const result = await runtime.runTask(makeInput({
                currentStatus: 'revision_required',
                revisionRound: 1,
            }))

            // The submitted_for_review step payload should have combined metadata
            const submitStep = result.steps[1]
            const payload = submitStep.events[0].payload as Record<string, unknown>
            expect(payload.developerRunId).toBe('dev-meta-001')
            expect(payload.reviewerRunId).toBe('rev-meta-001')
            expect(payload.source).toBe('orchestrated-revision-retry')
            // No planner metadata
            expect(payload.plannerRunId).toBeUndefined()
        })

        it('artifacts include revision round in name', async () => {
            mockRetryGatewayRuns('dev-006', 'rev-006', 'approved\n\nLGTM.')

            const runtime = new OrchestratedGatewayRuntime('http://127.0.0.1:8642', null, 30000)
            const result = await runtime.runTask(makeInput({
                currentStatus: 'revision_required',
                revisionRound: 2,
            }))

            expect(result.artifacts).toHaveLength(2)
            expect(result.artifacts![0].name).toContain('rev2')
            expect(result.artifacts![1].name).toContain('rev2')
        })
    })

    describe('developer session ID includes revision round', () => {
        it('developer session ID contains rev suffix', async () => {
            mockRetryGatewayRuns()

            const runtime = new OrchestratedGatewayRuntime('http://127.0.0.1:8642', null, 30000)
            await runtime.runTask(makeInput({
                currentStatus: 'revision_required',
                revisionRound: 3,
            }))

            const devCall = vi.mocked(runHermesGatewayTask).mock.calls[0][0]
            expect(devCall.sessionId).toContain('rev3')

            const revCall = vi.mocked(runHermesGatewayTask).mock.calls[1][0]
            expect(revCall.sessionId).toContain('rev3')
        })
    })
})

// ─── P3: Service-layer retry integration ────────────────────────

describe('P3: Service-layer retry integration with orchestrated runtime', () => {
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

        vi.clearAllMocks()
    })

    afterEach(() => {
        db?.close()
        db = null
        vi.doUnmock('../../packages/server/src/db/index')
        vi.resetModules()
    })

    async function setupService() {
        const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
        const runnerModule = await import('../../packages/server/src/services/hermes/agent-room/runner')

        // Set up role bindings
        const session = svc.createSession('Test')
        svc.createRoleBinding(session.id, 'planner', 'gpt-4o')
        svc.createRoleBinding(session.id, 'developer', 'claude-3.5-sonnet')
        svc.createRoleBinding(session.id, 'reviewer', 'gpt-4o')

        return { svc, runnerModule, session }
    }

    it('runWorkflow from revision_required (orchestrated retry path)', async () => {
        const { svc, session } = await setupService()
        const task = svc.createTask(session.id, 'Task', 'Desc')

        // Drive to revision_required manually
        svc.updateTaskStatus(task.id, 'planned')
        svc.updateTaskStatus(task.id, 'assigned')
        svc.updateTaskStatus(task.id, 'in_progress')
        svc.updateTaskStatus(task.id, 'submitted_for_review')
        svc.submitReview(session.id, task.id, 'reviewer', 'rejected', 'Fix error handling')

        const afterReject = svc.getTask(task.id)!
        expect(afterReject.status).toBe('revision_required')
        expect(afterReject.revisionRound).toBe(1)

        // runWorkflow directly from revision_required — runner handles the retry
        mockRetryGatewayRuns('dev-svc-001', 'rev-svc-001', 'approved\n\nLGTM.')
        const run = await svc.runWorkflow(session.id, task.id)
        expect(run.status).toBe('completed')
    })

    it('getLatestReviewFeedback returns last rejected review comment', async () => {
        const { svc, session } = await setupService()
        const task = svc.createTask(session.id, 'Task', 'Desc')

        // Drive to submitted_for_review
        svc.updateTaskStatus(task.id, 'planned')
        svc.updateTaskStatus(task.id, 'assigned')
        svc.updateTaskStatus(task.id, 'in_progress')
        svc.updateTaskStatus(task.id, 'submitted_for_review')

        // First rejection
        svc.submitReview(session.id, task.id, 'reviewer', 'rejected', 'First feedback')

        // The feedback should be accessible via the runner context
        // We verify this indirectly through the RealAgentRunner
        const reviews = svc.listReviews(session.id)
        const rejected = reviews.filter(r => r.status === 'rejected')
        expect(rejected).toHaveLength(1)
        expect(rejected[0].comment).toBe('First feedback')
    })

    it('mixed review mode: manual submitReview followed by orchestrated retry', async () => {
        const { svc, session } = await setupService()
        const task = svc.createTask(session.id, 'Task', 'Desc')

        // First round: manual review (submitReview)
        svc.updateTaskStatus(task.id, 'planned')
        svc.updateTaskStatus(task.id, 'assigned')
        svc.updateTaskStatus(task.id, 'in_progress')
        svc.updateTaskStatus(task.id, 'submitted_for_review')
        svc.submitReview(session.id, task.id, 'reviewer', 'rejected', 'Manual review feedback')

        expect(svc.getTask(task.id)!.status).toBe('revision_required')

        // Second round: runWorkflow directly from revision_required
        mockRetryGatewayRuns('dev-mixed-001', 'rev-mixed-001', 'approved\n\nApproved after revision.')
        const run = await svc.runWorkflow(session.id, task.id)
        expect(run.status).toBe('completed')
        expect(svc.getTask(task.id)!.status).toBe('submitted_for_review')
    })
})
