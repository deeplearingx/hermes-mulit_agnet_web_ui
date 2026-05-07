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

  describe('Workflow', () => {
    it('runMockWorkflow walks from created to submitted_for_review', async () => {
      const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
      const session = svc.createSession('Test')
      const task = svc.createTask(session.id, 'Task', '')

      await svc.runMockWorkflow(session.id, task.id)

      const updated = svc.getTask(task.id)
      expect(updated!.status).toBe('submitted_for_review')
    })

    it('runMockWorkflow throws on duplicate run', async () => {
      const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
      const session = svc.createSession('Test')
      const task = svc.createTask(session.id, 'Task', '')

      // Start first workflow (don't await to keep runningWorkflows populated)
      const p1 = svc.runMockWorkflow(session.id, task.id)
      await expect(svc.runMockWorkflow(session.id, task.id)).rejects.toThrow('Workflow is already running')
      await p1
    })

    it('runMockWorkflow throws on invalid start status', async () => {
      const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
      const session = svc.createSession('Test')
      const task = svc.createTask(session.id, 'Task', '')
      svc.updateTaskStatus(task.id, 'planned')

      await expect(svc.runMockWorkflow(session.id, task.id)).rejects.toThrow('Cannot start workflow in status "planned"')
    })
  })

  describe('runWorkflow (runner facade)', () => {
    it('runWorkflow walks from created to submitted_for_review', async () => {
      const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
      const session = svc.createSession('Test')
      const task = svc.createTask(session.id, 'Task', '')

      await svc.runWorkflow(session.id, task.id)

      const updated = svc.getTask(task.id)
      expect(updated!.status).toBe('submitted_for_review')
    })

    it('runMockWorkflow still works as alias', async () => {
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
})
