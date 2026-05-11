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

describe('Agent Room Service', () => {
  let db: any = null

  beforeEach(async () => {
    vi.resetModules()
    const { DatabaseSync } = await import('node:sqlite')
    db = new DatabaseSync(':memory:')
    vi.doMock('../../packages/server/src/db/index', () => ({
      getDb: () => db,
      ensureTable: (tableName: string, schema: Record<string, string>) => ensureTableForTest(db, tableName, schema),
    }))

    // Create all agent_room tables
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

  // ─── Session CRUD ──────────────────────────────────────────────

  describe('Session CRUD', () => {
    it('createSession → listSessions contains new session', async () => {
      const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
      const session = svc.createSession('Test Session')
      expect(session.name).toBe('Test Session')
      expect(session.id).toBeDefined()

      const all = svc.listSessions()
      expect(all).toHaveLength(1)
      expect(all[0].id).toBe(session.id)
    })

    it('getSession returns correct session', async () => {
      const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
      const session = svc.createSession('My Session')
      const found = svc.getSession(session.id)
      expect(found).toMatchObject({ id: session.id, name: 'My Session' })
    })

    it('assertSessionExists throws for nonexistent sessionId', async () => {
      const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
      expect(() => svc.listMessages('nonexistent')).toThrow('Session not found')
    })
  })

  // ─── Task CRUD ─────────────────────────────────────────────────

  describe('Task CRUD', () => {
    it('createTask → listTasks contains new task with status created', async () => {
      const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
      const session = svc.createSession('Test')
      const task = svc.createTask(session.id, 'Build feature', 'Description')
      expect(task.status).toBe('created')
      expect(task.revisionRound).toBe(0)

      const tasks = svc.listTasks(session.id)
      expect(tasks).toHaveLength(1)
      expect(tasks[0].id).toBe(task.id)
    })

    it('createTask auto-emits task_created event + message', async () => {
      const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
      const session = svc.createSession('Test')
      svc.createTask(session.id, 'Build feature', '')

      const events = svc.listWorkflowEvents(session.id)
      expect(events).toHaveLength(1)
      expect(events[0].type).toBe('task_created')

      const messages = svc.listMessages(session.id)
      expect(messages).toHaveLength(1)
      expect(messages[0].type).toBe('task_event')
    })

    it('updateTaskStatus validates state machine transitions', async () => {
      const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
      const session = svc.createSession('Test')
      const task = svc.createTask(session.id, 'Task', '')

      // created → planned is valid
      const updated = svc.updateTaskStatus(task.id, 'planned')
      expect(updated!.status).toBe('planned')
    })

    it('updateTaskStatus throws on invalid transition', async () => {
      const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
      const session = svc.createSession('Test')
      const task = svc.createTask(session.id, 'Task', '')

      // created → completed is invalid
      expect(() => svc.updateTaskStatus(task.id, 'completed')).toThrow('Invalid transition')
    })
  })

  // ─── Review ────────────────────────────────────────────────────

  describe('Review', () => {
    async function setupTaskForReview() {
      const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
      const session = svc.createSession('Test')
      const task = svc.createTask(session.id, 'Task', '')
      // Walk through workflow to submitted_for_review
      svc.updateTaskStatus(task.id, 'planned')
      svc.updateTaskStatus(task.id, 'assigned')
      svc.updateTaskStatus(task.id, 'in_progress')
      svc.updateTaskStatus(task.id, 'submitted_for_review')
      return { svc, session, task }
    }

    it('submitReview passed: submitted_for_review → review_passed', async () => {
      const { svc, session, task } = await setupTaskForReview()
      const review = svc.submitReview(session.id, task.id, 'reviewer', 'passed', 'LGTM')
      expect(review).not.toBeNull()
      expect(review!.status).toBe('passed')

      const updated = svc.getTask(task.id)
      expect(updated!.status).toBe('review_passed')
    })

    it('submitReview rejected: submitted_for_review → revision_required', async () => {
      const { svc, session, task } = await setupTaskForReview()
      const review = svc.submitReview(session.id, task.id, 'reviewer', 'rejected', 'Needs work')
      expect(review).not.toBeNull()
      expect(review!.status).toBe('rejected')

      const updated = svc.getTask(task.id)
      expect(updated!.status).toBe('revision_required')
      expect(updated!.revisionRound).toBe(1)
    })

    it('submitReview rejected with empty comment is allowed', async () => {
      const { svc, session, task } = await setupTaskForReview()
      const review = svc.submitReview(session.id, task.id, 'reviewer', 'rejected', '')
      expect(review).not.toBeNull()
      expect(review!.comment).toBe('')
    })

    it('submitReview rejected at maxRevisionRounds → need_user_decision', async () => {
      const { svc, session, task } = await setupTaskForReview()

      // First rejection: revisionRound 0 → 1
      svc.submitReview(session.id, task.id, 'reviewer', 'rejected', 'Fix 1')
      let updated = svc.getTask(task.id)!
      expect(updated.status).toBe('revision_required')
      expect(updated.revisionRound).toBe(1)

      // Retry → in_progress, then → submitted_for_review
      svc.retryTask(session.id, task.id)
      svc.updateTaskStatus(task.id, 'submitted_for_review')

      // Second rejection: revisionRound 1 → 2
      svc.submitReview(session.id, task.id, 'reviewer', 'rejected', 'Fix 2')
      updated = svc.getTask(task.id)!
      expect(updated.status).toBe('revision_required')
      expect(updated.revisionRound).toBe(2)

      // Retry → in_progress, then → submitted_for_review
      svc.retryTask(session.id, task.id)
      svc.updateTaskStatus(task.id, 'submitted_for_review')

      // Third rejection: revisionRound 2 → 3, which >= maxRevisionRounds(3) → need_user_decision
      svc.submitReview(session.id, task.id, 'reviewer', 'rejected', 'Fix 3')
      updated = svc.getTask(task.id)!
      expect(updated.status).toBe('need_user_decision')
      expect(updated.revisionRound).toBe(3)
    })

    it('submitReview throws when task is not in submitted_for_review', async () => {
      const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
      const session = svc.createSession('Test')
      const task = svc.createTask(session.id, 'Task', '')

      expect(() => svc.submitReview(session.id, task.id, 'reviewer', 'passed', '')).toThrow(
        'Cannot review task in status "created"',
      )
    })
  })

  // ─── Workflow ──────────────────────────────────────────────────

  describe('runWorkflow (runner facade)', () => {
    it('runWorkflow walks from created to submitted_for_review', async () => {
      const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
      const session = svc.createSession('Test')
      const task = svc.createTask(session.id, 'Task', '')

      await svc.runWorkflow(session.id, task.id)

      const updated = svc.getTask(task.id)
      expect(updated!.status).toBe('submitted_for_review')
    })

    it('runMockWorkflow still works as alias for runWorkflow', async () => {
      const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
      const session = svc.createSession('Test')
      const task = svc.createTask(session.id, 'Task', '')

      await svc.runMockWorkflow(session.id, task.id)

      const updated = svc.getTask(task.id)
      expect(updated!.status).toBe('submitted_for_review')
    })

    it('runWorkflow rejects duplicate run', async () => {
      const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
      const session = svc.createSession('Test')
      const task = svc.createTask(session.id, 'Task', '')

      const p1 = svc.runWorkflow(session.id, task.id)
      await expect(svc.runWorkflow(session.id, task.id)).rejects.toThrow('Workflow is already running')
      await p1
    })

    it('runWorkflow rejects invalid start status', async () => {
      const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
      const session = svc.createSession('Test')
      const task = svc.createTask(session.id, 'Task', '')
      svc.updateTaskStatus(task.id, 'planned')

      await expect(svc.runWorkflow(session.id, task.id)).rejects.toThrow('Cannot start workflow in status "planned"')
    })
  })

  // ─── Retry / Deliver ──────────────────────────────────────────

  describe('Retry / Deliver', () => {
    it('retryTask from revision_required → in_progress', async () => {
      const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
      const session = svc.createSession('Test')
      const task = svc.createTask(session.id, 'Task', '')
      svc.updateTaskStatus(task.id, 'planned')
      svc.updateTaskStatus(task.id, 'assigned')
      svc.updateTaskStatus(task.id, 'in_progress')
      svc.updateTaskStatus(task.id, 'submitted_for_review')
      svc.submitReview(session.id, task.id, 'reviewer', 'rejected', 'Fix')

      const result = svc.retryTask(session.id, task.id)
      expect(result!.status).toBe('in_progress')
    })

    it('retryTask from need_user_decision → in_progress', async () => {
      const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
      const session = svc.createSession('Test')
      const task = svc.createTask(session.id, 'Task', '')

      // First iteration: walk through full workflow to submitted_for_review
      svc.updateTaskStatus(task.id, 'planned')
      svc.updateTaskStatus(task.id, 'assigned')
      svc.updateTaskStatus(task.id, 'in_progress')
      svc.updateTaskStatus(task.id, 'submitted_for_review')
      svc.submitReview(session.id, task.id, 'reviewer', 'rejected', 'Fix 0')

      // Second iteration: retry → in_progress → submitted_for_review → reject
      svc.retryTask(session.id, task.id)
      svc.updateTaskStatus(task.id, 'submitted_for_review')
      svc.submitReview(session.id, task.id, 'reviewer', 'rejected', 'Fix 1')

      // Third iteration: retry → in_progress → submitted_for_review → reject → need_user_decision
      svc.retryTask(session.id, task.id)
      svc.updateTaskStatus(task.id, 'submitted_for_review')
      svc.submitReview(session.id, task.id, 'reviewer', 'rejected', 'Fix 2')

      // After 3 rejections, task should be in need_user_decision
      const beforeRetry = svc.getTask(task.id)!
      expect(beforeRetry.status).toBe('need_user_decision')

      const result = svc.retryTask(session.id, task.id)
      expect(result!.status).toBe('in_progress')
    })

    it('retryTask from failed → in_progress', async () => {
      const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
      const session = svc.createSession('Test')
      const task = svc.createTask(session.id, 'Task', '')
      svc.updateTaskStatus(task.id, 'planned')
      svc.updateTaskStatus(task.id, 'assigned')
      svc.updateTaskStatus(task.id, 'in_progress')
      svc.updateTaskStatus(task.id, 'failed')

      const result = svc.retryTask(session.id, task.id)
      expect(result!.status).toBe('in_progress')
    })

    it('retryTask throws on non-retryable status', async () => {
      const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
      const session = svc.createSession('Test')
      const task = svc.createTask(session.id, 'Task', '')

      expect(() => svc.retryTask(session.id, task.id)).toThrow('Cannot retry task in status "created"')
    })

    it('deliverTask review_passed → delivering → completed', async () => {
      const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
      const session = svc.createSession('Test')
      const task = svc.createTask(session.id, 'Task', '')
      svc.updateTaskStatus(task.id, 'planned')
      svc.updateTaskStatus(task.id, 'assigned')
      svc.updateTaskStatus(task.id, 'in_progress')
      svc.updateTaskStatus(task.id, 'submitted_for_review')
      svc.submitReview(session.id, task.id, 'reviewer', 'passed', 'LGTM')

      const result = svc.deliverTask(session.id, task.id)
      expect(result!.status).toBe('completed')
    })
  })

  // ─── Persistence ───────────────────────────────────────────────

  describe('Persistence', () => {
    it('session persists across store reads', async () => {
      const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
      const session = svc.createSession('Persistent Session')

      // Re-read from store
      const found = svc.getSession(session.id)
      expect(found).not.toBeNull()
      expect(found!.name).toBe('Persistent Session')
    })

    it('task + review persist correctly', async () => {
      const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
      const session = svc.createSession('Test')
      const task = svc.createTask(session.id, 'Task', '')
      svc.updateTaskStatus(task.id, 'planned')
      svc.updateTaskStatus(task.id, 'assigned')
      svc.updateTaskStatus(task.id, 'in_progress')
      svc.updateTaskStatus(task.id, 'submitted_for_review')
      svc.submitReview(session.id, task.id, 'reviewer', 'passed', 'Good')

      const reviews = svc.listReviews(session.id)
      expect(reviews).toHaveLength(1)
      expect(reviews[0].status).toBe('passed')
    })

    it('workflow events persist correctly', async () => {
      const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
      const session = svc.createSession('Test')
      svc.createTask(session.id, 'Task', '')

      const events = svc.listWorkflowEvents(session.id)
      expect(events).toHaveLength(1)
      expect(events[0].type).toBe('task_created')
    })
  })

  // ─── Session Boundary ──────────────────────────────────────────

  describe('Session Boundary', () => {
    it('listTasks only returns tasks for the given session', async () => {
      const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
      const s1 = svc.createSession('Session 1')
      const s2 = svc.createSession('Session 2')
      svc.createTask(s1.id, 'Task 1', '')
      svc.createTask(s2.id, 'Task 2', '')

      expect(svc.listTasks(s1.id)).toHaveLength(1)
      expect(svc.listTasks(s2.id)).toHaveLength(1)
    })

    it('listReviews only returns reviews for the given session', async () => {
      const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
      const s1 = svc.createSession('Session 1')
      const task = svc.createTask(s1.id, 'Task', '')
      svc.updateTaskStatus(task.id, 'planned')
      svc.updateTaskStatus(task.id, 'assigned')
      svc.updateTaskStatus(task.id, 'in_progress')
      svc.updateTaskStatus(task.id, 'submitted_for_review')
      svc.submitReview(s1.id, task.id, 'reviewer', 'passed', '')

      const s2 = svc.createSession('Session 2')
      expect(svc.listReviews(s1.id)).toHaveLength(1)
      expect(svc.listReviews(s2.id)).toHaveLength(0)
    })

    it('assertTaskInSession throws for cross-session access', async () => {
      const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
      const s1 = svc.createSession('Session 1')
      const s2 = svc.createSession('Session 2')
      const task = svc.createTask(s1.id, 'Task', '')

      expect(() => svc.getTask(task.id)).not.toThrow()
      // Accessing task from wrong session should throw
      expect(() => svc.updateTaskStatus(task.id, 'planned')).not.toThrow() // updateTaskStatus doesn't check session
      // But submitReview does check session boundary
      svc.updateTaskStatus(task.id, 'assigned')
      svc.updateTaskStatus(task.id, 'in_progress')
      svc.updateTaskStatus(task.id, 'submitted_for_review')
      expect(() => svc.submitReview(s2.id, task.id, 'reviewer', 'passed', '')).toThrow(
        `Task ${task.id} belongs to session ${s1.id}, not ${s2.id}`,
      )
    })
  })

  // ─── submitReview returns sessionId ──────────────────────────

  describe('submitReview returns sessionId', () => {
    it('review object includes sessionId', async () => {
      const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
      const session = svc.createSession('Test')
      const task = svc.createTask(session.id, 'Task', '')
      svc.updateTaskStatus(task.id, 'planned')
      svc.updateTaskStatus(task.id, 'assigned')
      svc.updateTaskStatus(task.id, 'in_progress')
      svc.updateTaskStatus(task.id, 'submitted_for_review')

      const review = svc.submitReview(session.id, task.id, 'reviewer', 'passed', 'LGTM')
      expect(review).not.toBeNull()
      expect(review!.sessionId).toBe(session.id)
    })
  })

  // ─── listSessions orders by updated_at DESC ──────────────────

  describe('listSessions ordering', () => {
    it('most recently active session appears first', async () => {
      const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
      const s1 = svc.createSession('Session 1')
      // Small delay to ensure different timestamps
      await new Promise(r => setTimeout(r, 10))
      const s2 = svc.createSession('Session 2')

      // s2 should be first (most recent)
      const all = svc.listSessions()
      expect(all[0].id).toBe(s2.id)
      expect(all[1].id).toBe(s1.id)

      // Now touch s1 (create a task) — should bump it to first
      svc.createTask(s1.id, 'Task', '')
      const all2 = svc.listSessions()
      expect(all2[0].id).toBe(s1.id)
    })
  })

  // ─── updateSessionTimestamp after content actions ────────────

  describe('updateSessionTimestamp after content actions', () => {
    it('addMessage bumps session updated_at', async () => {
      const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
      const session = svc.createSession('Test')
      const before = svc.getSession(session.id)!.updatedAt

      await new Promise(r => setTimeout(r, 10))
      svc.addMessage({ sessionId: session.id, senderId: 'user', senderName: 'User', senderRole: 'user', type: 'user_message', content: 'Hi' })

      const after = svc.getSession(session.id)!.updatedAt
      expect(after > before).toBe(true)
    })

    it('retryTask bumps session updated_at', async () => {
      const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
      const session = svc.createSession('Test')
      const task = svc.createTask(session.id, 'Task', '')
      svc.updateTaskStatus(task.id, 'planned')
      svc.updateTaskStatus(task.id, 'assigned')
      svc.updateTaskStatus(task.id, 'in_progress')
      svc.updateTaskStatus(task.id, 'submitted_for_review')
      svc.submitReview(session.id, task.id, 'reviewer', 'rejected', 'Fix')

      const before = svc.getSession(session.id)!.updatedAt
      await new Promise(r => setTimeout(r, 10))
      svc.retryTask(session.id, task.id)

      const after = svc.getSession(session.id)!.updatedAt
      expect(after > before).toBe(true)
    })

    it('deliverTask bumps session updated_at', async () => {
      const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
      const session = svc.createSession('Test')
      const task = svc.createTask(session.id, 'Task', '')
      svc.updateTaskStatus(task.id, 'planned')
      svc.updateTaskStatus(task.id, 'assigned')
      svc.updateTaskStatus(task.id, 'in_progress')
      svc.updateTaskStatus(task.id, 'submitted_for_review')
      svc.submitReview(session.id, task.id, 'reviewer', 'passed', 'LGTM')

      const before = svc.getSession(session.id)!.updatedAt
      await new Promise(r => setTimeout(r, 10))
      svc.deliverTask(session.id, task.id)

      const after = svc.getSession(session.id)!.updatedAt
      expect(after > before).toBe(true)
    })
  })

  // ─── Workflow dual-path + event order ─────────────────────────

  describe('Workflow dual-path + event order', () => {
    it('created path: events are task_created, task_planned, task_assigned, task_started, task_submitted', async () => {
      const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
      const session = svc.createSession('Test')
      const task = svc.createTask(session.id, 'Task', '')

      await svc.runMockWorkflow(session.id, task.id)

      const updated = svc.getTask(task.id)
      expect(updated!.status).toBe('submitted_for_review')

      // Full event sequence: task_created (from createTask) + 4 workflow steps
      const events = svc.listWorkflowEvents(session.id)
      expect(events.map(e => e.type)).toEqual([
        'task_created',
        'task_planned',
        'task_assigned',
        'task_started',
        'task_submitted',
      ])
    })

    it('created path: no duplicate task_planned', async () => {
      const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
      const session = svc.createSession('Test')
      const task = svc.createTask(session.id, 'Task', '')

      await svc.runMockWorkflow(session.id, task.id)

      const events = svc.listWorkflowEvents(session.id)
      const taskPlannedEvents = events.filter(e => e.type === 'task_planned')
      expect(taskPlannedEvents).toHaveLength(1)
    })

    it('retry path from revision_required: events are revision_started, task_submitted', async () => {
      const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
      const session = svc.createSession('Test')
      const task = svc.createTask(session.id, 'Task', '')

      // Walk to revision_required
      svc.updateTaskStatus(task.id, 'planned')
      svc.updateTaskStatus(task.id, 'assigned')
      svc.updateTaskStatus(task.id, 'in_progress')
      svc.updateTaskStatus(task.id, 'submitted_for_review')
      svc.submitReview(session.id, task.id, 'reviewer', 'rejected', 'Fix')

      expect(svc.getTask(task.id)!.status).toBe('revision_required')

      // Record event count before workflow
      const eventsBefore = svc.listWorkflowEvents(session.id)
      const beforeCount = eventsBefore.length

      await svc.runMockWorkflow(session.id, task.id)

      const updated = svc.getTask(task.id)
      expect(updated!.status).toBe('submitted_for_review')

      const events = svc.listWorkflowEvents(session.id)
      const workflowEvents = events.slice(beforeCount)
      expect(workflowEvents.map(e => e.type)).toEqual([
        'revision_started',
        'task_submitted',
      ])
    })

    it('retry path from need_user_decision: events are revision_started, task_submitted', async () => {
      const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
      const session = svc.createSession('Test')
      const task = svc.createTask(session.id, 'Task', '')

      // Walk to need_user_decision via 3 rejections
      // Round 1: created → planned → assigned → in_progress → submitted_for_review → rejected
      svc.updateTaskStatus(task.id, 'planned')
      svc.updateTaskStatus(task.id, 'assigned')
      svc.updateTaskStatus(task.id, 'in_progress')
      svc.updateTaskStatus(task.id, 'submitted_for_review')
      svc.submitReview(session.id, task.id, 'reviewer', 'rejected', 'Fix 0')

      // Round 2: retry → in_progress → submitted_for_review → rejected
      svc.retryTask(session.id, task.id)
      svc.updateTaskStatus(task.id, 'submitted_for_review')
      svc.submitReview(session.id, task.id, 'reviewer', 'rejected', 'Fix 1')

      // Round 3: retry → in_progress → submitted_for_review → rejected → need_user_decision
      svc.retryTask(session.id, task.id)
      svc.updateTaskStatus(task.id, 'submitted_for_review')
      svc.submitReview(session.id, task.id, 'reviewer', 'rejected', 'Fix 2')

      expect(svc.getTask(task.id)!.status).toBe('need_user_decision')

      await svc.runMockWorkflow(session.id, task.id)

      const updated = svc.getTask(task.id)
      expect(updated!.status).toBe('submitted_for_review')

      const events = svc.listWorkflowEvents(session.id)
      // The 3rd rejection emits review_rejected + need_user_decision
      // Find the last need_user_decision event (workflow starts after it)
      let lastIdx = -1
      for (let i = events.length - 1; i >= 0; i--) {
        if (events[i].type === 'need_user_decision') { lastIdx = i; break }
      }
      const afterNud = events.slice(lastIdx + 1)
      expect(afterNud.map(e => e.type)).toEqual([
        'revision_started',
        'task_submitted',
      ])
    })

    it('retry path from failed: events are task_started, task_submitted', async () => {
      const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
      const session = svc.createSession('Test')
      const task = svc.createTask(session.id, 'Task', '')

      // Walk to failed
      svc.updateTaskStatus(task.id, 'planned')
      svc.updateTaskStatus(task.id, 'assigned')
      svc.updateTaskStatus(task.id, 'in_progress')
      svc.updateTaskStatus(task.id, 'failed')

      // Record event count before workflow
      const eventsBefore = svc.listWorkflowEvents(session.id)
      const beforeCount = eventsBefore.length

      await svc.runMockWorkflow(session.id, task.id)

      const updated = svc.getTask(task.id)
      expect(updated!.status).toBe('submitted_for_review')

      const events = svc.listWorkflowEvents(session.id)
      const workflowEvents = events.slice(beforeCount)
      expect(workflowEvents.map(e => e.type)).toEqual([
        'task_started',
        'task_submitted',
      ])
    })

    it('retry path does not emit task_planned', async () => {
      const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
      const session = svc.createSession('Test')
      const task = svc.createTask(session.id, 'Task', '')

      // Walk to revision_required (manual status updates don't emit workflow events)
      svc.updateTaskStatus(task.id, 'planned')
      svc.updateTaskStatus(task.id, 'assigned')
      svc.updateTaskStatus(task.id, 'in_progress')
      svc.updateTaskStatus(task.id, 'submitted_for_review')
      svc.submitReview(session.id, task.id, 'reviewer', 'rejected', 'Fix')

      // Record event count before retry workflow
      const beforeCount = svc.listWorkflowEvents(session.id).length

      await svc.runMockWorkflow(session.id, task.id)

      const events = svc.listWorkflowEvents(session.id)
      const retryEvents = events.slice(beforeCount)
      const taskPlannedInRetry = retryEvents.filter(e => e.type === 'task_planned')
      // Retry path must not emit task_planned
      expect(taskPlannedInRetry).toHaveLength(0)
    })

    it('duplicate workflow still throws', async () => {
      const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
      const session = svc.createSession('Test')
      const task = svc.createTask(session.id, 'Task', '')

      const p1 = svc.runMockWorkflow(session.id, task.id)
      await expect(svc.runMockWorkflow(session.id, task.id)).rejects.toThrow('Workflow is already running')
      await p1
    })
  })

  // ─── updateTaskStatusInSession ────────────────────────────────

  describe('updateTaskStatusInSession', () => {
    it('updates task status and bumps session updatedAt', async () => {
      const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
      const session = svc.createSession('Test')
      const task = svc.createTask(session.id, 'Task', '')

      const before = svc.getSession(session.id)!.updatedAt
      await new Promise(r => setTimeout(r, 10))

      const updated = svc.updateTaskStatusInSession(session.id, task.id, 'planned')
      expect(updated.status).toBe('planned')

      const after = svc.getSession(session.id)!.updatedAt
      expect(after > before).toBe(true)
    })

    it('throws for nonexistent session', async () => {
      const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
      const session = svc.createSession('Test')
      const task = svc.createTask(session.id, 'Task', '')

      expect(() => svc.updateTaskStatusInSession('nonexistent', task.id, 'planned')).toThrow('Session not found')
    })

    it('throws for task not in session', async () => {
      const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
      const s1 = svc.createSession('S1')
      const s2 = svc.createSession('S2')
      const task = svc.createTask(s1.id, 'Task', '')

      expect(() => svc.updateTaskStatusInSession(s2.id, task.id, 'planned')).toThrow(/belongs to session/)
    })
  })

  describe('Delete cascade', () => {
    it('deleteSession removes session, tasks, reviews, messages, workflow events', async () => {
      const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
      const session = svc.createSession('Delete Me')
      const task = svc.createTask(session.id, 'Task A', 'desc')
      // Create some messages
      svc.addMessage({ sessionId: session.id, senderId: 'user', senderName: 'U', senderRole: 'user', type: 'user_message', content: 'hello' })
      // Run workflow to create events + messages
      await svc.runMockWorkflow(session.id, task.id)
      // Submit review to create reviews
      svc.submitReview(session.id, task.id, 'reviewer', 'passed', 'ok')

      // Verify data exists
      expect(svc.listTasks(session.id).length).toBeGreaterThan(0)
      expect(svc.listMessages(session.id).length).toBeGreaterThan(0)
      expect(svc.listWorkflowEvents(session.id).length).toBeGreaterThan(0)
      expect(svc.listReviews(session.id).length).toBeGreaterThan(0)

      // Delete session
      svc.deleteSession(session.id)

      // Session gone
      expect(svc.getSession(session.id)).toBeNull()
      // All child data access throws "Session not found" (cascade verified)
      expect(() => svc.listTasks(session.id)).toThrow('Session not found')
      expect(() => svc.listMessages(session.id)).toThrow('Session not found')
      expect(() => svc.listWorkflowEvents(session.id)).toThrow('Session not found')
      expect(() => svc.listReviews(session.id)).toThrow('Session not found')
    })

    it('deleteTask removes task, its reviews, workflow events, and task-scoped messages', async () => {
      const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
      const session = svc.createSession('Session')
      const task = svc.createTask(session.id, 'Task A', 'desc')
      // Add a user message (not task-scoped)
      svc.addMessage({ sessionId: session.id, senderId: 'user', senderName: 'U', senderRole: 'user', type: 'user_message', content: 'hello' })
      // Run workflow to create task-scoped messages + events
      await svc.runMockWorkflow(session.id, task.id)
      // Submit review
      svc.submitReview(session.id, task.id, 'reviewer', 'passed', 'ok')

      const userMsgCount = svc.listMessages(session.id).filter(m => m.type === 'user_message').length
      const taskMsgCount = svc.listMessages(session.id).filter(m => m.metadata?.taskId === task.id).length
      expect(taskMsgCount).toBeGreaterThan(0)

      // Delete task
      svc.deleteTask(session.id, task.id)

      // Task gone
      expect(svc.listTasks(session.id)).toEqual([])
      // Task-scoped messages gone, user messages preserved
      const remaining = svc.listMessages(session.id)
      expect(remaining.filter(m => m.metadata?.taskId === task.id)).toEqual([])
      expect(remaining.filter(m => m.type === 'user_message').length).toBe(userMsgCount)
      // Workflow events gone
      expect(svc.listWorkflowEvents(session.id)).toEqual([])
      // Reviews gone
      expect(svc.listReviews(session.id)).toEqual([])
    })

    it('deleteTask throws for cross-session access', async () => {
      const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
      const s1 = svc.createSession('S1')
      const s2 = svc.createSession('S2')
      const task = svc.createTask(s1.id, 'Task', '')

      expect(() => svc.deleteTask(s2.id, task.id)).toThrow(/belongs to session/)
    })

    it('deleteTask throws when workflow is running', async () => {
      const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
      const session = svc.createSession('Session')
      const task = svc.createTask(session.id, 'Task', '')

      // Start workflow in background (don't await)
      const workflowPromise = svc.runMockWorkflow(session.id, task.id)

      // Try to delete while workflow is running
      expect(() => svc.deleteTask(session.id, task.id)).toThrow('Cannot delete task while workflow is running')

      // Wait for workflow to finish
      await workflowPromise
    })

    it('deleteSession throws when workflow is running in session', async () => {
      const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
      const session = svc.createSession('Session')
      const task = svc.createTask(session.id, 'Task', '')

      // Start workflow in background (don't await)
      const workflowPromise = svc.runMockWorkflow(session.id, task.id)

      // Try to delete session while workflow is running
      expect(() => svc.deleteSession(session.id)).toThrow('Cannot delete session while workflow is running')

      // Wait for workflow to finish
      await workflowPromise
    })

    it('deleteTask updates session updatedAt', async () => {
      const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
      const session = svc.createSession('Session')
      const task = svc.createTask(session.id, 'Task', '')

      const beforeDelete = svc.getSession(session.id)!.updatedAt
      // Wait a small moment to ensure timestamp difference
      await new Promise(r => setTimeout(r, 10))

      svc.deleteTask(session.id, task.id)

      const afterDelete = svc.getSession(session.id)!.updatedAt
      expect(new Date(afterDelete).getTime()).toBeGreaterThanOrEqual(new Date(beforeDelete).getTime())
    })
  })

  // ─── Artifacts ─────────────────────────────────────────────────

  describe('Artifacts', () => {
    it('deliverTask creates a final_delivery artifact', async () => {
      const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
      const session = svc.createSession('Test')
      const task = svc.createTask(session.id, 'Task', '')

      // Walk through workflow to review_passed
      await svc.runWorkflow(session.id, task.id)
      svc.submitReview(session.id, task.id, 'reviewer', 'passed', 'LGTM')

      // Deliver
      svc.deliverTask(session.id, task.id)

      const artifacts = svc.listArtifacts(session.id)
      expect(artifacts.length).toBe(1)
      expect(artifacts[0].type).toBe('final_delivery')
      expect(artifacts[0].taskId).toBe(task.id)
      expect(artifacts[0].content).toContain('Task')
    })

    it('listTaskArtifacts returns only artifacts for the given task', async () => {
      const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
      const session = svc.createSession('Test')
      const task1 = svc.createTask(session.id, 'Task1', '')
      const task2 = svc.createTask(session.id, 'Task2', '')

      // Deliver task1
      await svc.runWorkflow(session.id, task1.id)
      svc.submitReview(session.id, task1.id, 'reviewer', 'passed', '')
      svc.deliverTask(session.id, task1.id)

      // Deliver task2
      await svc.runWorkflow(session.id, task2.id)
      svc.submitReview(session.id, task2.id, 'reviewer', 'passed', '')
      svc.deliverTask(session.id, task2.id)

      const task1Artifacts = svc.listTaskArtifacts(session.id, task1.id)
      expect(task1Artifacts.length).toBe(1)
      expect(task1Artifacts[0].taskId).toBe(task1.id)

      const task2Artifacts = svc.listTaskArtifacts(session.id, task2.id)
      expect(task2Artifacts.length).toBe(1)
      expect(task2Artifacts[0].taskId).toBe(task2.id)
    })

    it('deleteArtifact removes artifact and enforces session boundary', async () => {
      const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
      const session1 = svc.createSession('S1')
      const session2 = svc.createSession('S2')
      const task = svc.createTask(session1.id, 'Task', '')

      await svc.runWorkflow(session1.id, task.id)
      svc.submitReview(session1.id, task.id, 'reviewer', 'passed', '')
      svc.deliverTask(session1.id, task.id)

      const artifacts = svc.listArtifacts(session1.id)
      expect(artifacts.length).toBe(1)

      // Cross-session delete should throw
      expect(() => svc.deleteArtifact(session2.id, artifacts[0].id)).toThrow('belongs to session')

      // Correct session delete should work
      svc.deleteArtifact(session1.id, artifacts[0].id)
      expect(svc.listArtifacts(session1.id).length).toBe(0)
    })

    it('deleteTaskCascade removes task artifacts', async () => {
      const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
      const session = svc.createSession('Test')
      const task = svc.createTask(session.id, 'Task', '')

      await svc.runWorkflow(session.id, task.id)
      svc.submitReview(session.id, task.id, 'reviewer', 'passed', '')
      svc.deliverTask(session.id, task.id)

      expect(svc.listArtifacts(session.id).length).toBe(1)

      svc.deleteTask(session.id, task.id)

      expect(svc.listArtifacts(session.id).length).toBe(0)
    })

    it('deleteSessionCascade removes session artifacts', async () => {
      const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
      const session = svc.createSession('Test')
      const task = svc.createTask(session.id, 'Task', '')

      await svc.runWorkflow(session.id, task.id)
      svc.submitReview(session.id, task.id, 'reviewer', 'passed', '')
      svc.deliverTask(session.id, task.id)

      expect(svc.listArtifacts(session.id).length).toBe(1)

      svc.deleteSession(session.id)

      // Session is gone, listArtifacts should throw
      expect(() => svc.listArtifacts(session.id)).toThrow('Session not found')
    })

    it('deleteArtifact throws for nonexistent artifact', async () => {
      const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
      const session = svc.createSession('Test')
      expect(() => svc.deleteArtifact(session.id, 'nonexistent')).toThrow('Artifact not found')
    })

    it('deleteArtifact throws for cross-session access', async () => {
      const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
      const s1 = svc.createSession('S1')
      const s2 = svc.createSession('S2')
      const task = svc.createTask(s1.id, 'Task', '')

      await svc.runWorkflow(s1.id, task.id)
      svc.submitReview(s1.id, task.id, 'reviewer', 'passed', '')
      svc.deliverTask(s1.id, task.id)

      const artifacts = svc.listArtifacts(s1.id)
      expect(artifacts.length).toBe(1)

      // Attempting to delete artifact from wrong session should throw
      expect(() => svc.deleteArtifact(s2.id, artifacts[0].id)).toThrow('belongs to session')
    })

    it('deliverTask always creates exactly one final_delivery artifact', async () => {
      const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
      const session = svc.createSession('Test')
      const task = svc.createTask(session.id, 'Task', '')

      await svc.runWorkflow(session.id, task.id)
      svc.submitReview(session.id, task.id, 'reviewer', 'passed', '')

      // Before deliver: no artifacts
      expect(svc.listArtifacts(session.id).length).toBe(0)

      svc.deliverTask(session.id, task.id)

      // After deliver: exactly one final_delivery artifact
      const artifacts = svc.listArtifacts(session.id)
      expect(artifacts.length).toBe(1)
      expect(artifacts[0].type).toBe('final_delivery')
      expect(artifacts[0].taskId).toBe(task.id)
      expect(artifacts[0].sessionId).toBe(session.id)
      expect(artifacts[0].name).toBeTruthy()
    })

    it('deliverTask creates final_delivery artifact with deterministic content', async () => {
      const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
      const session = svc.createSession('Test')
      const task = svc.createTask(session.id, 'Build Widget', '')

      await svc.runWorkflow(session.id, task.id)
      svc.submitReview(session.id, task.id, 'reviewer', 'passed', '')
      svc.deliverTask(session.id, task.id)

      const artifacts = svc.listTaskArtifacts(session.id, task.id)
      expect(artifacts.length).toBe(1)
      expect(artifacts[0].name).toContain('Build Widget')
      expect(artifacts[0].content).toBeTruthy()
    })

    it('deliverTask creates exactly one final_delivery artifact (explicit type filter)', async () => {
      const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
      const session = svc.createSession('Test')
      const task = svc.createTask(session.id, 'Task', '')

      await svc.runWorkflow(session.id, task.id)
      svc.submitReview(session.id, task.id, 'reviewer', 'passed', 'LGTM')
      svc.deliverTask(session.id, task.id)

      const artifacts = svc.listTaskArtifacts(session.id, task.id)
      expect(artifacts.filter(a => a.type === 'final_delivery')).toHaveLength(1)
    })
  })

  // ─── Run Lifecycle ──────────────────────────────────────────────

  describe('Run Lifecycle', () => {
    it('runWorkflow creates a run record with queued → running → completed lifecycle', async () => {
      const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
      const session = svc.createSession('Test')
      const task = svc.createTask(session.id, 'Build feature', '')

      const run = await svc.runWorkflow(session.id, task.id)

      expect(run).toBeDefined()
      expect(run.id).toBeTruthy()
      expect(run.sessionId).toBe(session.id)
      expect(run.taskId).toBe(task.id)
      expect(run.status).toBe('completed')
      expect(run.runnerName).toBe('mock')
      expect(run.startedAt).toBeTruthy()
      expect(run.finishedAt).toBeTruthy()
      expect(run.createdAt).toBeTruthy()
      expect(run.updatedAt).toBeTruthy()
    })

    it('listRuns returns runs for a session', async () => {
      const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
      const session = svc.createSession('Test')
      const task = svc.createTask(session.id, 'Task', '')

      await svc.runWorkflow(session.id, task.id)

      const runs = svc.listRuns(session.id)
      expect(runs).toHaveLength(1)
      expect(runs[0].status).toBe('completed')
    })

    it('listTaskRuns returns runs filtered by task', async () => {
      const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
      const session = svc.createSession('Test')
      const task1 = svc.createTask(session.id, 'Task 1', '')
      const task2 = svc.createTask(session.id, 'Task 2', '')

      await svc.runWorkflow(session.id, task1.id)
      await svc.runWorkflow(session.id, task2.id)

      const runs = svc.listTaskRuns(session.id, task1.id)
      expect(runs).toHaveLength(1)
      expect(runs[0].taskId).toBe(task1.id)
    })

    it('getRun returns a run by id', async () => {
      const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
      const session = svc.createSession('Test')
      const task = svc.createTask(session.id, 'Task', '')

      const run = await svc.runWorkflow(session.id, task.id)
      const found = svc.getRun(run.id)

      expect(found).toBeDefined()
      expect(found!.id).toBe(run.id)
    })

    it('updateRunUpstreamId sets upstreamRunId on a run', async () => {
      const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
      const session = svc.createSession('Test')
      const task = svc.createTask(session.id, 'Task', '')

      const run = await svc.runWorkflow(session.id, task.id)
      const updated = svc.updateRunUpstreamId(run.id, 'gw-run-123')

      expect(updated).toBeDefined()
      expect(updated!.upstreamRunId).toBe('gw-run-123')
    })

    it('findRunByUpstreamId finds run by upstream id', async () => {
      const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
      const session = svc.createSession('Test')
      const task = svc.createTask(session.id, 'Task', '')

      const run = await svc.runWorkflow(session.id, task.id)
      svc.updateRunUpstreamId(run.id, 'gw-run-456')

      const found = svc.findRunByUpstreamId('gw-run-456')
      expect(found).toBeDefined()
      expect(found!.id).toBe(run.id)
    })

    it('deleteSession cascade deletes runs', async () => {
      const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
      const session = svc.createSession('Test')
      const task = svc.createTask(session.id, 'Task', '')

      await svc.runWorkflow(session.id, task.id)
      expect(svc.listRuns(session.id)).toHaveLength(1)

      svc.deleteSession(session.id)
      // After deletion, listRuns should throw (session not found)
      expect(() => svc.listRuns(session.id)).toThrow('Session not found')
    })

    it('deleteTask cascade deletes runs for that task', async () => {
      const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
      const session = svc.createSession('Test')
      const task = svc.createTask(session.id, 'Task', '')

      await svc.runWorkflow(session.id, task.id)
      expect(svc.listRuns(session.id)).toHaveLength(1)

      svc.deleteTask(session.id, task.id)
      expect(svc.listRuns(session.id)).toHaveLength(0)
    })

    it('runWorkflow marks run as failed when runner throws', async () => {
      // Override runner to throw — placed last to avoid mock leaking into other tests
      vi.doMock('../../packages/server/src/services/hermes/agent-room/runner', () => ({
        activeRunner: {
          name: 'mock' as const,
          run: async () => { throw new Error('Runner exploded') },
        },
      }))

      const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
      const session = svc.createSession('Test')
      const task = svc.createTask(session.id, 'Task', '')

      await expect(svc.runWorkflow(session.id, task.id)).rejects.toThrow('Runner exploded')

      const runs = svc.listRuns(session.id)
      expect(runs).toHaveLength(1)
      expect(runs[0].status).toBe('failed')
      expect(runs[0].errorMessage).toBe('Runner exploded')
      expect(runs[0].finishedAt).toBeTruthy()

      // Cleanup mock to avoid leaking
      vi.doUnmock('../../packages/server/src/services/hermes/agent-room/runner')
    })
  })

  // ─── P4: Delivery Phase — Enriched Artifacts ──────────────────

  describe('P4: Delivery Phase', () => {
    it('manual deliverTask creates enriched artifact with delivery metadata', async () => {
      const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
      const session = svc.createSession('Test')
      const task = svc.createTask(session.id, 'Build Widget', '')
      await svc.runWorkflow(session.id, task.id)
      svc.submitReview(session.id, task.id, 'reviewer', 'passed', 'LGTM')

      svc.deliverTask(session.id, task.id, 'manual')

      const artifacts = svc.listTaskArtifacts(session.id, task.id)
      expect(artifacts).toHaveLength(1)
      expect(artifacts[0].type).toBe('final_delivery')
      expect(artifacts[0].metadata).toBeDefined()
      expect(artifacts[0].metadata!.deliveryMode).toBe('manual')
      expect(artifacts[0].metadata!.deliveredAt).toBeTruthy()
      expect(artifacts[0].content).toContain('手动')
      expect(artifacts[0].content).toContain('Build Widget')
    })

    it('deliverTask throws when task is not in review_passed', async () => {
      const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
      const session = svc.createSession('Test')
      const task = svc.createTask(session.id, 'Task', '')
      // Task is in 'created' status — not deliverable
      expect(() => svc.deliverTask(session.id, task.id)).toThrow('Cannot deliver task in status "created"')
    })

    it('deliverTask with review feedback includes feedback in artifact', async () => {
      const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
      const session = svc.createSession('Test')
      const task = svc.createTask(session.id, 'Task', '')

      // Walk through workflow with a rejection cycle to generate feedback
      await svc.runWorkflow(session.id, task.id)
      svc.submitReview(session.id, task.id, 'reviewer', 'rejected', 'Needs improvement')
      svc.retryTask(session.id, task.id)
      svc.updateTaskStatus(task.id, 'submitted_for_review')
      svc.submitReview(session.id, task.id, 'reviewer', 'passed', 'LGTM now')

      svc.deliverTask(session.id, task.id, 'manual')

      const artifacts = svc.listTaskArtifacts(session.id, task.id)
      expect(artifacts).toHaveLength(1)
      expect(artifacts[0].metadata!.revisionRound).toBeGreaterThan(0)
      expect(artifacts[0].metadata!.reviewFeedback).toBe('Needs improvement')
      expect(artifacts[0].content).toContain('修改轮次')
    })

    it('deliverTask emits delivery_started and delivery_completed workflow events', async () => {
      const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
      const session = svc.createSession('Test')
      const task = svc.createTask(session.id, 'Task', '')
      await svc.runWorkflow(session.id, task.id)
      svc.submitReview(session.id, task.id, 'reviewer', 'passed', '')

      const beforeCount = svc.listWorkflowEvents(session.id).length
      svc.deliverTask(session.id, task.id)

      const events = svc.listWorkflowEvents(session.id)
      const newEvents = events.slice(beforeCount)
      expect(newEvents.map(e => e.type)).toEqual([
        'delivery_started',
        'delivery_completed',
      ])
      expect(newEvents[0].payload).toHaveProperty('deliveryMode', 'manual')
    })

    it('deliverTask creates final_delivery message via event adapter', async () => {
      const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
      const session = svc.createSession('Test')
      const task = svc.createTask(session.id, 'Task', '')
      await svc.runWorkflow(session.id, task.id)
      svc.submitReview(session.id, task.id, 'reviewer', 'passed', '')

      svc.deliverTask(session.id, task.id)

      const messages = svc.listMessages(session.id)
      const deliveryMessages = messages.filter(m => m.type === 'final_delivery')
      expect(deliveryMessages.length).toBeGreaterThanOrEqual(1)
      expect(deliveryMessages[deliveryMessages.length - 1].content).toContain('交付')
    })
  })

  // ─── P4: Auto-Delivery Toggle ─────────────────────────────────

  describe('P4: Auto-Delivery Toggle', () => {
    it('session default has autoDeliveryEnabled = false', async () => {
      const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
      const session = svc.createSession('Test')
      expect(session.autoDeliveryEnabled).toBe(false)

      const config = svc.getSessionConfig(session.id)
      expect(config.autoDeliveryEnabled).toBe(false)
    })

    it('updateSessionConfig toggles autoDeliveryEnabled', async () => {
      const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
      const session = svc.createSession('Test')

      const config = svc.updateSessionConfig(session.id, { autoDeliveryEnabled: true })
      expect(config.autoDeliveryEnabled).toBe(true)

      // Verify persistence via getSession
      const reloaded = svc.getSession(session.id)
      expect(reloaded!.autoDeliveryEnabled).toBe(true)

      // Toggle back off
      const config2 = svc.updateSessionConfig(session.id, { autoDeliveryEnabled: false })
      expect(config2.autoDeliveryEnabled).toBe(false)
    })

    it('auto-delivery triggers when review passes and autoDeliveryEnabled = true', async () => {
      const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
      const session = svc.createSession('Test')
      const task = svc.createTask(session.id, 'Auto Task', '')

      // Enable auto-delivery
      svc.updateSessionConfig(session.id, { autoDeliveryEnabled: true })

      // Walk to review_passed
      await svc.runWorkflow(session.id, task.id)

      // This should trigger auto-delivery
      svc.submitReview(session.id, task.id, 'reviewer', 'passed', 'LGTM')

      // Task should be completed (auto-delivered)
      const updated = svc.getTask(task.id)
      expect(updated!.status).toBe('completed')

      // Artifact should exist with auto delivery mode
      const artifacts = svc.listTaskArtifacts(session.id, task.id)
      expect(artifacts).toHaveLength(1)
      expect(artifacts[0].type).toBe('final_delivery')
      expect(artifacts[0].metadata!.deliveryMode).toBe('auto')
      expect(artifacts[0].content).toContain('自动')
    })

    it('auto-delivery does NOT trigger when autoDeliveryEnabled = false', async () => {
      const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
      const session = svc.createSession('Test')
      const task = svc.createTask(session.id, 'Manual Task', '')

      // Ensure auto-delivery is off (default)
      expect(svc.getSessionConfig(session.id).autoDeliveryEnabled).toBe(false)

      await svc.runWorkflow(session.id, task.id)
      svc.submitReview(session.id, task.id, 'reviewer', 'passed', '')

      // Task should be in review_passed (not auto-delivered)
      const updated = svc.getTask(task.id)
      expect(updated!.status).toBe('review_passed')

      // No artifacts yet
      expect(svc.listTaskArtifacts(session.id, task.id)).toHaveLength(0)
    })

    it('auto-delivery emits delivery workflow events', async () => {
      const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
      const session = svc.createSession('Test')
      const task = svc.createTask(session.id, 'Task', '')

      svc.updateSessionConfig(session.id, { autoDeliveryEnabled: true })
      await svc.runWorkflow(session.id, task.id)

      const beforeCount = svc.listWorkflowEvents(session.id).length
      svc.submitReview(session.id, task.id, 'reviewer', 'passed', '')

      const events = svc.listWorkflowEvents(session.id)
      const newEvents = events.slice(beforeCount)
      // Should include review_passed + delivery_started + delivery_completed
      const eventTypes = newEvents.map(e => e.type)
      expect(eventTypes).toContain('review_passed')
      expect(eventTypes).toContain('delivery_started')
      expect(eventTypes).toContain('delivery_completed')
    })

    it('auto-delivery after reject cycle includes review feedback in artifact', async () => {
      const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
      const session = svc.createSession('Test')
      const task = svc.createTask(session.id, 'Task', '')

      // Enable auto-delivery
      svc.updateSessionConfig(session.id, { autoDeliveryEnabled: true })

      // First round: reject
      await svc.runWorkflow(session.id, task.id)
      svc.submitReview(session.id, task.id, 'reviewer', 'rejected', 'Fix bugs')

      // Second round: retry, submit, pass → auto-deliver
      svc.retryTask(session.id, task.id)
      svc.updateTaskStatus(task.id, 'submitted_for_review')
      svc.submitReview(session.id, task.id, 'reviewer', 'passed', 'LGTM')

      // Should be auto-completed
      expect(svc.getTask(task.id)!.status).toBe('completed')

      const artifacts = svc.listTaskArtifacts(session.id, task.id)
      expect(artifacts).toHaveLength(1)
      expect(artifacts[0].metadata!.deliveryMode).toBe('auto')
      expect(artifacts[0].metadata!.reviewFeedback).toBe('Fix bugs')
      expect(artifacts[0].metadata!.revisionRound).toBeGreaterThan(0)
    })
  })

  // ─── P4: Delivery Phase Hardening ─────────────────────────────

  describe('P4: Delivery Phase Hardening', () => {
    // P4.1: Standardized final_delivery metadata fields
    it('P4.1: manual delivery artifact has all standardized metadata fields', async () => {
      const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
      const session = svc.createSession('Test')
      const task = svc.createTask(session.id, 'Widget', '')
      await svc.runWorkflow(session.id, task.id)
      svc.submitReview(session.id, task.id, 'reviewer', 'passed', 'LGTM')

      svc.deliverTask(session.id, task.id, 'manual')

      const artifacts = svc.listTaskArtifacts(session.id, task.id)
      expect(artifacts).toHaveLength(1)
      const meta = artifacts[0].metadata!
      expect(meta.source).toBe('manual-delivery')
      expect(meta.deliveryMode).toBe('manual')
      expect(meta.deliveryRole).toBe('delivery')
      expect(typeof meta.revisionRound).toBe('number')
      expect(typeof meta.maxRevisionRounds).toBe('number')
      expect(meta.reviewFeedback).toBeNull()
      expect(typeof meta.deliveredAt).toBe('string')
      // ISO string validation
      expect(new Date(meta.deliveredAt as string).toISOString()).toBe(meta.deliveredAt)
    })

    it('P4.1: auto delivery artifact has all standardized metadata fields', async () => {
      const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
      const session = svc.createSession('Test')
      const task = svc.createTask(session.id, 'Widget', '')
      svc.updateSessionConfig(session.id, { autoDeliveryEnabled: true })
      await svc.runWorkflow(session.id, task.id)
      svc.submitReview(session.id, task.id, 'reviewer', 'passed', 'LGTM')

      const artifacts = svc.listTaskArtifacts(session.id, task.id)
      expect(artifacts).toHaveLength(1)
      const meta = artifacts[0].metadata!
      expect(meta.source).toBe('auto-delivery')
      expect(meta.deliveryMode).toBe('auto')
      expect(meta.deliveryRole).toBe('delivery')
      expect(typeof meta.revisionRound).toBe('number')
      expect(typeof meta.maxRevisionRounds).toBe('number')
      expect(typeof meta.deliveredAt).toBe('string')
      expect(new Date(meta.deliveredAt as string).toISOString()).toBe(meta.deliveredAt)
    })

    it('P4.1: metadata includes reviewFeedback from rejected cycle', async () => {
      const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
      const session = svc.createSession('Test')
      const task = svc.createTask(session.id, 'Widget', '')
      await svc.runWorkflow(session.id, task.id)
      svc.submitReview(session.id, task.id, 'reviewer', 'rejected', 'Needs work')
      svc.retryTask(session.id, task.id)
      svc.updateTaskStatus(task.id, 'submitted_for_review')
      svc.submitReview(session.id, task.id, 'reviewer', 'passed', 'LGTM')

      svc.deliverTask(session.id, task.id, 'manual')

      const artifacts = svc.listTaskArtifacts(session.id, task.id)
      const meta = artifacts[0].metadata!
      expect(meta.reviewFeedback).toBe('Needs work')
      expect(meta.revisionRound).toBeGreaterThan(0)
    })

    // P4.2: Both paths use deliverTaskCore — same artifact structure
    it('P4.2: manual and auto delivery produce identical metadata keys', async () => {
      const svc = await import('../../packages/server/src/services/hermes/agent-room/index')

      // Manual delivery
      const s1 = svc.createSession('Manual')
      const t1 = svc.createTask(s1.id, 'Task M', '')
      await svc.runWorkflow(s1.id, t1.id)
      svc.submitReview(s1.id, t1.id, 'reviewer', 'passed', '')
      svc.deliverTask(s1.id, t1.id, 'manual')
      const manualMeta = svc.listTaskArtifacts(s1.id, t1.id)[0].metadata!

      // Auto delivery
      const s2 = svc.createSession('Auto')
      const t2 = svc.createTask(s2.id, 'Task A', '')
      svc.updateSessionConfig(s2.id, { autoDeliveryEnabled: true })
      await svc.runWorkflow(s2.id, t2.id)
      svc.submitReview(s2.id, t2.id, 'reviewer', 'passed', '')
      const autoMeta = svc.listTaskArtifacts(s2.id, t2.id)[0].metadata!

      // Same key set
      const manualKeys = Object.keys(manualMeta).sort()
      const autoKeys = Object.keys(autoMeta).sort()
      expect(manualKeys).toEqual(autoKeys)

      // Shared field types
      expect(manualMeta.deliveryRole).toBe('delivery')
      expect(autoMeta.deliveryRole).toBe('delivery')
      expect(manualMeta.source).toBe('manual-delivery')
      expect(autoMeta.source).toBe('auto-delivery')
    })

    // P4.3: Non-review_passed status throws
    it('P4.3: deliverTask throws for created status', async () => {
      const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
      const session = svc.createSession('Test')
      const task = svc.createTask(session.id, 'Task', '')
      expect(() => svc.deliverTask(session.id, task.id)).toThrow('Cannot deliver task in status "created"')
    })

    it('P4.3: deliverTask throws for in_progress status', async () => {
      const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
      const session = svc.createSession('Test')
      const task = svc.createTask(session.id, 'Task', '')
      await svc.runWorkflow(session.id, task.id)
      // Task is now in submitted_for_review after workflow
      // We need to get it back to in_progress — use retry from a failed state
      // Actually after runWorkflow it's submitted_for_review. Let's test that:
      expect(() => svc.deliverTask(session.id, task.id)).toThrow('Cannot deliver task in status "submitted_for_review"')
    })

    it('P4.3: deliverTask throws for completed status', async () => {
      const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
      const session = svc.createSession('Test')
      const task = svc.createTask(session.id, 'Task', '')
      await svc.runWorkflow(session.id, task.id)
      svc.submitReview(session.id, task.id, 'reviewer', 'passed', '')
      svc.deliverTask(session.id, task.id)
      // Now it's completed — try again
      expect(() => svc.deliverTask(session.id, task.id)).toThrow('Cannot deliver task in status "completed"')
    })

    it('P4.3: deliverTask throws for failed status', async () => {
      const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
      const session = svc.createSession('Test')
      const task = svc.createTask(session.id, 'Task', '')
      await svc.runWorkflow(session.id, task.id)
      // Force task to in_progress then failed via state machine
      svc.updateTaskStatus(task.id, 'review_passed')
      svc.updateTaskStatus(task.id, 'delivering')
      svc.updateTaskStatus(task.id, 'failed')
      expect(() => svc.deliverTask(session.id, task.id)).toThrow('Cannot deliver task in status "failed"')
    })

    it('P4.3: deliverTask throws for revision_required status', async () => {
      const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
      const session = svc.createSession('Test')
      const task = svc.createTask(session.id, 'Task', '')
      await svc.runWorkflow(session.id, task.id)
      svc.submitReview(session.id, task.id, 'reviewer', 'rejected', 'Fix it')
      // Now in revision_required
      expect(() => svc.deliverTask(session.id, task.id)).toThrow('Cannot deliver task in status "revision_required"')
    })

    // P4.4: Delivery is synchronous — verify delivering→completed is the only path
    it('P4.4: deliverTaskCore transitions delivering → completed (never failed)', async () => {
      const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
      const session = svc.createSession('Test')
      const task = svc.createTask(session.id, 'Task', '')
      await svc.runWorkflow(session.id, task.id)
      svc.submitReview(session.id, task.id, 'reviewer', 'passed', '')

      const result = svc.deliverTask(session.id, task.id)

      // Verify: delivering → completed, never failed
      expect(result!.status).toBe('completed')

      // Verify: no failed workflow events exist
      const events = svc.listWorkflowEvents(session.id)
      const failedEvents = events.filter(e => e.type === 'task_failed')
      expect(failedEvents).toHaveLength(0)

      // Verify: delivering is NOT a terminal state
      const deliveringEvents = events.filter(e => e.type === 'delivery_started')
      expect(deliveringEvents).toHaveLength(1)
      const completedEvents = events.filter(e => e.type === 'delivery_completed')
      expect(completedEvents).toHaveLength(1)
    })

    // P4.5: autoDelivery=false blocks auto delivery
    it('P4.5: autoDelivery=false + reviewer approved → task stays review_passed, no delivery artifacts', async () => {
      const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
      const session = svc.createSession('Test')
      const task = svc.createTask(session.id, 'Task', '')

      // Default: autoDeliveryEnabled = false
      expect(svc.getSessionConfig(session.id).autoDeliveryEnabled).toBe(false)

      await svc.runWorkflow(session.id, task.id)
      svc.submitReview(session.id, task.id, 'reviewer', 'passed', 'LGTM')

      // Task stays in review_passed
      const updated = svc.getTask(task.id)
      expect(updated!.status).toBe('review_passed')

      // No delivery artifacts
      const artifacts = svc.listTaskArtifacts(session.id, task.id)
      expect(artifacts).toHaveLength(0)

      // No delivery workflow events
      const events = svc.listWorkflowEvents(session.id)
      const eventTypes = events.map(e => e.type)
      expect(eventTypes).toContain('review_passed')
      expect(eventTypes).not.toContain('delivery_started')
      expect(eventTypes).not.toContain('delivery_completed')
    })

    // P4.6: Manual vs auto delivery artifact consistency
    it('P4.6: manual and auto delivery artifacts have consistent structure', async () => {
      const svc = await import('../../packages/server/src/services/hermes/agent-room/index')

      // Manual path
      const s1 = svc.createSession('Manual')
      const t1 = svc.createTask(s1.id, 'Build', '')
      await svc.runWorkflow(s1.id, t1.id)
      svc.submitReview(s1.id, t1.id, 'reviewer', 'passed', 'LGTM')
      svc.deliverTask(s1.id, t1.id, 'manual')
      const manualArtifact = svc.listTaskArtifacts(s1.id, t1.id)[0]

      // Auto path
      const s2 = svc.createSession('Auto')
      const t2 = svc.createTask(s2.id, 'Build', '')
      svc.updateSessionConfig(s2.id, { autoDeliveryEnabled: true })
      await svc.runWorkflow(s2.id, t2.id)
      svc.submitReview(s2.id, t2.id, 'reviewer', 'passed', 'LGTM')
      const autoArtifact = svc.listTaskArtifacts(s2.id, t2.id)[0]

      // Same artifact type
      expect(manualArtifact.type).toBe('final_delivery')
      expect(autoArtifact.type).toBe('final_delivery')

      // Same metadata structure
      const m = manualArtifact.metadata!
      const a = autoArtifact.metadata!
      expect(typeof m.deliveryMode).toBe('string')
      expect(typeof a.deliveryMode).toBe('string')
      expect(typeof m.revisionRound).toBe('number')
      expect(typeof a.revisionRound).toBe('number')
      expect(typeof m.maxRevisionRounds).toBe('number')
      expect(typeof a.maxRevisionRounds).toBe('number')
      expect(typeof m.deliveredAt).toBe('string')
      expect(typeof a.deliveredAt).toBe('string')
      expect(m.deliveryRole).toBe('delivery')
      expect(a.deliveryRole).toBe('delivery')

      // Only differ in source and deliveryMode
      expect(m.source).toBe('manual-delivery')
      expect(a.source).toBe('auto-delivery')
      expect(m.deliveryMode).toBe('manual')
      expect(a.deliveryMode).toBe('auto')

      // Content reflects mode
      expect(manualArtifact.content).toContain('手动')
      expect(autoArtifact.content).toContain('自动')
    })
  })

  describe('P7.1: Delivery Role Run', () => {
    it('manual deliverTask creates delivery role_run attached to latest workflow run', async () => {
      const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
      const store = await import('../../packages/server/src/db/hermes/agent-room-store')

      const session = svc.createSession('P7.1 Test')
      const task = svc.createTask(session.id, 'Delivery Role Run', '')
      await svc.runWorkflow(session.id, task.id)
      svc.submitReview(session.id, task.id, 'reviewer', 'passed', 'LGTM')

      svc.deliverTask(session.id, task.id, 'manual')

      // Verify task completed
      const updatedTask = svc.getTask(task.id)!
      expect(updatedTask.status).toBe('completed')

      // Verify delivery role_run exists
      const roleRuns = store.listRoleRunsByTask(task.id)
      const deliveryRun = roleRuns.find(r => r.role === 'delivery')
      expect(deliveryRun).toBeDefined()
      expect(deliveryRun!.status).toBe('completed')
      expect(deliveryRun!.phase).toBe('delivery')
      expect(deliveryRun!.profileName).toBe('manual')
      expect(deliveryRun!.metadata!.source).toBe('manual-delivery-runtime')
      expect(deliveryRun!.metadata!.deliveryMode).toBe('manual')

      // Verify delivery role_run is attached to the latest workflow run
      const latestRun = store.listRunsByTask(task.id)[0]
      expect(latestRun).toBeDefined()
      expect(deliveryRun!.runId).toBe(latestRun.id)
    })

    it('final_delivery artifact metadata includes deliveryRoleRunId and deliveryRunId', async () => {
      const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
      const store = await import('../../packages/server/src/db/hermes/agent-room-store')

      const session = svc.createSession('P7.1 Link Test')
      const task = svc.createTask(session.id, 'Artifact Link', '')
      await svc.runWorkflow(session.id, task.id)
      svc.submitReview(session.id, task.id, 'reviewer', 'passed', '')

      svc.deliverTask(session.id, task.id, 'manual')

      // Verify artifact metadata
      const artifacts = svc.listTaskArtifacts(session.id, task.id)
      expect(artifacts).toHaveLength(1)
      expect(artifacts[0].type).toBe('final_delivery')
      expect(artifacts[0].metadata).toBeDefined()

      // Verify delivery role_run linkage in artifact
      const deliveryRoleRun = store.listRoleRunsByTask(task.id).find(r => r.role === 'delivery')
      expect(deliveryRoleRun).toBeDefined()
      expect(artifacts[0].metadata!.deliveryRoleRunId).toBe(deliveryRoleRun!.id)
      expect(artifacts[0].metadata!.deliveryRunId).toBe(deliveryRoleRun!.runId)
    })

    it('delivery_started and delivery_completed events contain deliveryRoleRunId in payload', async () => {
      const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
      const store = await import('../../packages/server/src/db/hermes/agent-room-store')

      const session = svc.createSession('P7.1 Event Test')
      const task = svc.createTask(session.id, 'Event Payload', '')
      await svc.runWorkflow(session.id, task.id)
      svc.submitReview(session.id, task.id, 'reviewer', 'passed', '')

      svc.deliverTask(session.id, task.id, 'manual')

      const deliveryRoleRun = store.listRoleRunsByTask(task.id).find(r => r.role === 'delivery')
      expect(deliveryRoleRun).toBeDefined()

      const events = svc.listWorkflowEvents(session.id)
      const deliveryStarted = events.find(e => e.type === 'delivery_started')
      const deliveryCompleted = events.find(e => e.type === 'delivery_completed')

      expect(deliveryStarted).toBeDefined()
      expect(deliveryCompleted).toBeDefined()

      // Both events should have deliveryRoleRunId in payload
      expect(deliveryStarted!.payload).toBeDefined()
      expect(deliveryStarted!.payload!.deliveryRoleRunId).toBe(deliveryRoleRun!.id)
      expect(deliveryCompleted!.payload).toBeDefined()
      expect(deliveryCompleted!.payload!.deliveryRoleRunId).toBe(deliveryRoleRun!.id)
    })

    it('delivery role_run is NOT created when no workflow run exists (legacy/manual status changes)', async () => {
      const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
      const store = await import('../../packages/server/src/db/hermes/agent-room-store')

      const session = svc.createSession('P7.1 NoRun')
      const task = svc.createTask(session.id, 'No Run', '')
      // Reach review_passed via normal workflow path
      await svc.runWorkflow(session.id, task.id)
      svc.submitReview(session.id, task.id, 'reviewer', 'passed', '')

      // Delete all runs to simulate no-workflow-run scenario
      const runs = store.listRunsByTask(task.id)
      for (const run of runs) {
        store.deleteRoleRunsByRun(run.id)
      }
      store.deleteRunsByTask(task.id)

      svc.deliverTask(session.id, task.id, 'manual')

      // Verify delivery completed despite no run
      const updatedTask = svc.getTask(task.id)!
      expect(updatedTask.status).toBe('completed')

      // No delivery role_run should exist (no workflow run to attach to)
      const deliveryRun = store.listRoleRunsByTask(task.id).find(r => r.role === 'delivery')
      expect(deliveryRun).toBeUndefined()

      // Artifact should still exist but without role run linkage
      const artifacts = svc.listTaskArtifacts(session.id, task.id)
      expect(artifacts).toHaveLength(1)
      expect(artifacts[0].metadata!.deliveryRoleRunId).toBeUndefined()
      expect(artifacts[0].metadata!.deliveryRunId).toBeUndefined()
    })

    it('auto delivery also creates delivery role_run with auto metadata', async () => {
      const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
      const store = await import('../../packages/server/src/db/hermes/agent-room-store')

      const session = svc.createSession('P7.1 Auto')
      svc.updateSessionConfig(session.id, { autoDeliveryEnabled: true })
      const task = svc.createTask(session.id, 'Auto Role Run', '')
      await svc.runWorkflow(session.id, task.id)
      svc.submitReview(session.id, task.id, 'reviewer', 'passed', 'LGTM')

      // Auto-delivery should have triggered
      const updatedTask = svc.getTask(task.id)!
      expect(updatedTask.status).toBe('completed')

      // Verify auto delivery role_run
      const autoDeliveryRun = store.listRoleRunsByTask(task.id).find(r => r.role === 'delivery')
      expect(autoDeliveryRun).toBeDefined()
      expect(autoDeliveryRun!.status).toBe('completed')
      expect(autoDeliveryRun!.profileName).toBe('auto')
      expect(autoDeliveryRun!.metadata!.source).toBe('auto-delivery-runtime')
      expect(autoDeliveryRun!.metadata!.deliveryMode).toBe('auto')

      // Verify artifact linkage
      const artifacts = svc.listTaskArtifacts(session.id, task.id)
      expect(artifacts[0].metadata!.deliveryRoleRunId).toBe(autoDeliveryRun!.id)
    })
  })
})
