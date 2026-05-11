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

describe('Agent Room Store', () => {
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

  it('createSession / getSession / listSessions', async () => {
    const store = await import('../../packages/server/src/db/hermes/agent-room-store')
    const now = new Date().toISOString()
    store.createSession({ id: 's1', name: 'Test Session', createdAt: now, updatedAt: now })

    const session = store.getSession('s1')
    expect(session).toMatchObject({ id: 's1', name: 'Test Session' })

    const all = store.listSessions()
    expect(all).toHaveLength(1)
    expect(all[0].id).toBe('s1')
  })

  it('getSession returns null for nonexistent id', async () => {
    const store = await import('../../packages/server/src/db/hermes/agent-room-store')
    expect(store.getSession('nonexistent')).toBeNull()
  })

  it('updateSessionTimestamp updates updated_at', async () => {
    const store = await import('../../packages/server/src/db/hermes/agent-room-store')
    const past = '2020-01-01T00:00:00.000Z'
    store.createSession({ id: 's1', name: 'Test', createdAt: past, updatedAt: past })

    store.updateSessionTimestamp('s1')
    const updated = store.getSession('s1')!
    expect(updated.updatedAt).not.toBe(past)
  })

  it('createTask / getTask / listTasksBySession / updateTask', async () => {
    const store = await import('../../packages/server/src/db/hermes/agent-room-store')
    const now = new Date().toISOString()
    store.createSession({ id: 's1', name: 'Test', createdAt: now, updatedAt: now })

    const task = {
      id: 't1', sessionId: 's1', title: 'Build feature', description: 'desc',
      status: 'created', revisionRound: 0, maxRevisionRounds: 3,
      createdAt: now, updatedAt: now,
    }
    store.createTask(task)

    expect(store.getTask('t1')).toMatchObject({ id: 't1', title: 'Build feature', status: 'created' })
    expect(store.listTasksBySession('s1')).toHaveLength(1)

    // Update task
    store.updateTask({ ...task, status: 'in_progress', updatedAt: new Date().toISOString() })
    expect(store.getTask('t1')!.status).toBe('in_progress')
  })

  it('createReview / listReviewsByTask / listReviewsBySession', async () => {
    const store = await import('../../packages/server/src/db/hermes/agent-room-store')
    const now = new Date().toISOString()
    store.createSession({ id: 's1', name: 'Test', createdAt: now, updatedAt: now })
    store.createTask({
      id: 't1', sessionId: 's1', title: 'Task', description: '',
      status: 'submitted_for_review', revisionRound: 0, maxRevisionRounds: 3,
      createdAt: now, updatedAt: now,
    })

    store.createReview({
      id: 'r1', sessionId: 's1', taskId: 't1', reviewerAgentId: 'reviewer',
      status: 'passed', comment: 'LGTM', createdAt: now,
    })

    expect(store.listReviewsByTask('t1')).toHaveLength(1)
    expect(store.listReviewsByTask('t1')[0].comment).toBe('LGTM')
    expect(store.listReviewsBySession('s1')).toHaveLength(1)
  })

  it('mapReviewRow flattens metadata fields to top-level (P6.2)', async () => {
    const store = await import('../../packages/server/src/db/hermes/agent-room-store')
    const now = new Date().toISOString()
    store.createSession({ id: 's1', name: 'Test', createdAt: now, updatedAt: now })
    store.createTask({
      id: 't1', sessionId: 's1', title: 'Task', description: '',
      status: 'submitted_for_review', revisionRound: 0, maxRevisionRounds: 3,
      createdAt: now, updatedAt: now,
    })

    store.createReview({
      id: 'r1', sessionId: 's1', taskId: 't1', reviewerAgentId: 'reviewer-profile',
      status: 'rejected', comment: 'Needs changes',
      metadata: {
        source: 'orchestrated-reviewer',
        reviewerRunId: 'run-abc-001',
        reviewerProfileName: 'reviewer-profile',
        reviewDecision: 'revision_required',
        reviewFeedback: 'Needs changes',
        reviewIssues: ['Missing tests'],
        reviewConfidence: 0.8,
      },
      createdAt: now,
    })

    // listReviewsByTask returns flattened top-level fields
    const taskReviews = store.listReviewsByTask('t1')
    expect(taskReviews).toHaveLength(1)
    const review = taskReviews[0]
    expect(review.reviewerRunId).toBe('run-abc-001')
    expect(review.reviewerProfileName).toBe('reviewer-profile')
    expect(review.reviewDecision).toBe('revision_required')
    expect(review.reviewFeedback).toBe('Needs changes')
    // metadata still preserved
    expect(review.metadata).toBeDefined()
    expect(review.metadata!.source).toBe('orchestrated-reviewer')
    expect(review.metadata!.reviewerRunId).toBe('run-abc-001')

    // listReviewsBySession also returns flattened fields
    const sessionReviews = store.listReviewsBySession('s1')
    expect(sessionReviews[0].reviewerRunId).toBe('run-abc-001')
    expect(sessionReviews[0].reviewDecision).toBe('revision_required')
  })

  it('mapReviewRow handles missing metadata gracefully (P6.2)', async () => {
    const store = await import('../../packages/server/src/db/hermes/agent-room-store')
    const now = new Date().toISOString()
    store.createSession({ id: 's1', name: 'Test', createdAt: now, updatedAt: now })
    store.createTask({
      id: 't1', sessionId: 's1', title: 'Task', description: '',
      status: 'submitted_for_review', revisionRound: 0, maxRevisionRounds: 3,
      createdAt: now, updatedAt: now,
    })

    store.createReview({
      id: 'r2', sessionId: 's1', taskId: 't1', reviewerAgentId: 'human',
      status: 'passed', comment: 'LGTM', createdAt: now,
    })

    const review = store.listReviewsByTask('t1')[0]
    expect(review.reviewerRunId).toBeUndefined()
    expect(review.reviewerProfileName).toBeUndefined()
    expect(review.reviewDecision).toBeUndefined()
    expect(review.reviewFeedback).toBeUndefined()
    expect(review.metadata).toBeUndefined()
  })

  it('mapReviewRow validates reviewDecision values (P6.2)', async () => {
    const store = await import('../../packages/server/src/db/hermes/agent-room-store')
    const now = new Date().toISOString()
    store.createSession({ id: 's1', name: 'Test', createdAt: now, updatedAt: now })
    store.createTask({
      id: 't1', sessionId: 's1', title: 'Task', description: '',
      status: 'submitted_for_review', revisionRound: 0, maxRevisionRounds: 3,
      createdAt: now, updatedAt: now,
    })

    // Invalid reviewDecision should be filtered to undefined
    store.createReview({
      id: 'r3', sessionId: 's1', taskId: 't1', reviewerAgentId: 'reviewer',
      status: 'rejected', comment: 'bad',
      metadata: {
        reviewDecision: 'invalid_value',
        reviewerRunId: 12345,  // non-string, should be filtered
        reviewerProfileName: 'valid-profile',
        reviewFeedback: 42,    // non-string, should be filtered
      },
      createdAt: now,
    })

    const review = store.listReviewsByTask('t1')[0]
    expect(review.reviewDecision).toBeUndefined()   // invalid value rejected
    expect(review.reviewerRunId).toBeUndefined()     // non-string rejected
    expect(review.reviewerProfileName).toBe('valid-profile')  // string accepted
    expect(review.reviewFeedback).toBeUndefined()    // non-string rejected
  })

  it('createMessage / listMessagesBySession with metadata JSON decode', async () => {
    const store = await import('../../packages/server/src/db/hermes/agent-room-store')
    const now = new Date().toISOString()
    store.createSession({ id: 's1', name: 'Test', createdAt: now, updatedAt: now })

    store.createMessage({
      id: 'm1', sessionId: 's1', senderId: 'agent', senderName: 'Agent',
      senderRole: 'developer', type: 'task_event', content: 'Hello',
      metadata: { taskId: 't1', event: 'task_created' },
      createdAt: now,
    })

    const msgs = store.listMessagesBySession('s1')
    expect(msgs).toHaveLength(1)
    expect(msgs[0].metadata).toEqual({ taskId: 't1', event: 'task_created' })
  })

  it('createMessage without metadata stores null', async () => {
    const store = await import('../../packages/server/src/db/hermes/agent-room-store')
    const now = new Date().toISOString()
    store.createSession({ id: 's1', name: 'Test', createdAt: now, updatedAt: now })

    store.createMessage({
      id: 'm1', sessionId: 's1', senderId: 'user', senderName: 'User',
      senderRole: 'user', type: 'user_message', content: 'Hi',
      createdAt: now,
    })

    const msgs = store.listMessagesBySession('s1')
    expect(msgs[0].metadata).toBeUndefined()
  })

  it('createWorkflowEvent / listWorkflowEventsBySession with payload JSON decode', async () => {
    const store = await import('../../packages/server/src/db/hermes/agent-room-store')
    const now = new Date().toISOString()
    store.createSession({ id: 's1', name: 'Test', createdAt: now, updatedAt: now })

    store.createWorkflowEvent({
      id: 'e1', sessionId: 's1', taskId: 't1', type: 'task_created',
      agentId: 'conversation', agentRole: 'conversation',
      payload: { comment: 'test' },
      createdAt: now,
    })

    const events = store.listWorkflowEventsBySession('s1')
    expect(events).toHaveLength(1)
    expect(events[0].payload).toEqual({ comment: 'test' })
  })

  it('runInTransaction commits on success', async () => {
    const store = await import('../../packages/server/src/db/hermes/agent-room-store')
    const now = new Date().toISOString()

    store.runInTransaction(() => {
      store.createSession({ id: 's1', name: 'Test', createdAt: now, updatedAt: now })
      store.createTask({
        id: 't1', sessionId: 's1', title: 'Task', description: '',
        status: 'created', revisionRound: 0, maxRevisionRounds: 3,
        createdAt: now, updatedAt: now,
      })
    })

    expect(store.getSession('s1')).not.toBeNull()
    expect(store.getTask('t1')).not.toBeNull()
  })

  it('runInTransaction rolls back on error', async () => {
    const store = await import('../../packages/server/src/db/hermes/agent-room-store')
    const now = new Date().toISOString()

    expect(() => {
      store.runInTransaction(() => {
        store.createSession({ id: 's1', name: 'Test', createdAt: now, updatedAt: now })
        throw new Error('boom')
      })
    }).toThrow('boom')

    // Session should NOT exist after rollback
    expect(store.getSession('s1')).toBeNull()
  })

  it('listTasksBySession returns empty for session with no tasks', async () => {
    const store = await import('../../packages/server/src/db/hermes/agent-room-store')
    const now = new Date().toISOString()
    store.createSession({ id: 's1', name: 'Test', createdAt: now, updatedAt: now })
    expect(store.listTasksBySession('s1')).toEqual([])
  })

  it('listReviewsBySession returns empty for session with no reviews', async () => {
    const store = await import('../../packages/server/src/db/hermes/agent-room-store')
    const now = new Date().toISOString()
    store.createSession({ id: 's1', name: 'Test', createdAt: now, updatedAt: now })
    expect(store.listReviewsBySession('s1')).toEqual([])
  })

  // ─── Artifact CRUD ──────────────────────────────────────────
  it('createArtifact / getArtifact / listArtifactsBySession / listArtifactsByTask', async () => {
    const store = await import('../../packages/server/src/db/hermes/agent-room-store')
    const now = new Date().toISOString()
    store.createSession({ id: 's1', name: 'Test', createdAt: now, updatedAt: now })
    store.createTask({ id: 't1', sessionId: 's1', title: 'Task', description: '', status: 'created', assignedAgentId: undefined, revisionRound: 0, maxRevisionRounds: 3, createdAt: now, updatedAt: now })

    const artifact = { id: 'a1', sessionId: 's1', taskId: 't1', name: 'Output', type: 'code_output', content: 'hello', metadata: { key: 'val' }, createdAt: now }
    store.createArtifact(artifact)

    expect(store.getArtifact('a1')).toMatchObject({ id: 'a1', name: 'Output', type: 'code_output', content: 'hello', metadata: { key: 'val' } })
    expect(store.listArtifactsBySession('s1')).toHaveLength(1)
    expect(store.listArtifactsByTask('t1')).toHaveLength(1)
  })

  it('getArtifact returns null for nonexistent id', async () => {
    const store = await import('../../packages/server/src/db/hermes/agent-room-store')
    expect(store.getArtifact('nonexistent')).toBeNull()
  })

  it('deleteArtifact removes artifact', async () => {
    const store = await import('../../packages/server/src/db/hermes/agent-room-store')
    const now = new Date().toISOString()
    store.createSession({ id: 's1', name: 'Test', createdAt: now, updatedAt: now })
    store.createTask({ id: 't1', sessionId: 's1', title: 'Task', description: '', status: 'created', assignedAgentId: undefined, revisionRound: 0, maxRevisionRounds: 3, createdAt: now, updatedAt: now })
    store.createArtifact({ id: 'a1', sessionId: 's1', taskId: 't1', name: 'X', type: 'log', createdAt: now })

    store.deleteArtifact('a1')
    expect(store.getArtifact('a1')).toBeNull()
    expect(store.listArtifactsBySession('s1')).toHaveLength(0)
  })

  it('deleteArtifactsByTask removes all artifacts for a task', async () => {
    const store = await import('../../packages/server/src/db/hermes/agent-room-store')
    const now = new Date().toISOString()
    store.createSession({ id: 's1', name: 'Test', createdAt: now, updatedAt: now })
    store.createTask({ id: 't1', sessionId: 's1', title: 'Task', description: '', status: 'created', assignedAgentId: undefined, revisionRound: 0, maxRevisionRounds: 3, createdAt: now, updatedAt: now })
    store.createArtifact({ id: 'a1', sessionId: 's1', taskId: 't1', name: 'X', type: 'log', createdAt: now })
    store.createArtifact({ id: 'a2', sessionId: 's1', taskId: 't1', name: 'Y', type: 'code_output', createdAt: now })

    store.deleteArtifactsByTask('t1')
    expect(store.listArtifactsByTask('t1')).toHaveLength(0)
  })

  it('deleteTaskCascade removes task artifacts', async () => {
    const store = await import('../../packages/server/src/db/hermes/agent-room-store')
    const now = new Date().toISOString()
    store.createSession({ id: 's1', name: 'Test', createdAt: now, updatedAt: now })
    store.createTask({ id: 't1', sessionId: 's1', title: 'Task', description: '', status: 'created', assignedAgentId: undefined, revisionRound: 0, maxRevisionRounds: 3, createdAt: now, updatedAt: now })
    store.createArtifact({ id: 'a1', sessionId: 's1', taskId: 't1', name: 'X', type: 'log', createdAt: now })

    store.deleteTaskCascade('s1', 't1')
    expect(store.getArtifact('a1')).toBeNull()
  })

  it('deleteSessionCascade removes session artifacts', async () => {
    const store = await import('../../packages/server/src/db/hermes/agent-room-store')
    const now = new Date().toISOString()
    store.createSession({ id: 's1', name: 'Test', createdAt: now, updatedAt: now })
    store.createTask({ id: 't1', sessionId: 's1', title: 'Task', description: '', status: 'created', assignedAgentId: undefined, revisionRound: 0, maxRevisionRounds: 3, createdAt: now, updatedAt: now })
    store.createArtifact({ id: 'a1', sessionId: 's1', taskId: 't1', name: 'X', type: 'log', createdAt: now })

    store.deleteSessionCascade('s1')
    expect(store.getArtifact('a1')).toBeNull()
  })

  // ─── Artifact storageUrl flatten (P6.4) ─────────────────────────

  it('mapArtifactRow flattens metadata.storageUrl to top-level (P6.4)', async () => {
    const store = await import('../../packages/server/src/db/hermes/agent-room-store')
    const now = new Date().toISOString()
    store.createSession({ id: 's1', name: 'Test', createdAt: now, updatedAt: now })
    store.createTask({ id: 't1', sessionId: 's1', title: 'Task', description: '', status: 'created', assignedAgentId: undefined, revisionRound: 0, maxRevisionRounds: 3, createdAt: now, updatedAt: now })

    store.createArtifact({
      id: 'a1', sessionId: 's1', taskId: 't1', name: 'Deliverable', type: 'final_delivery',
      metadata: { storageUrl: 'https://example.com/a.zip', format: 'zip', size: 1024 },
      createdAt: now,
    })

    // getArtifact returns flattened storageUrl
    const artifact = store.getArtifact('a1')!
    expect(artifact.storageUrl).toBe('https://example.com/a.zip')
    // metadata still preserved
    expect(artifact.metadata).toBeDefined()
    expect(artifact.metadata!.storageUrl).toBe('https://example.com/a.zip')
    expect(artifact.metadata!.format).toBe('zip')

    // listArtifactsBySession also returns flattened storageUrl
    const sessionArtifacts = store.listArtifactsBySession('s1')
    expect(sessionArtifacts[0].storageUrl).toBe('https://example.com/a.zip')

    // listArtifactsByTask also returns flattened storageUrl
    const taskArtifacts = store.listArtifactsByTask('t1')
    expect(taskArtifacts[0].storageUrl).toBe('https://example.com/a.zip')
  })

  it('mapArtifactRow handles missing metadata.storageUrl gracefully (P6.4)', async () => {
    const store = await import('../../packages/server/src/db/hermes/agent-room-store')
    const now = new Date().toISOString()
    store.createSession({ id: 's1', name: 'Test', createdAt: now, updatedAt: now })
    store.createTask({ id: 't1', sessionId: 's1', title: 'Task', description: '', status: 'created', assignedAgentId: undefined, revisionRound: 0, maxRevisionRounds: 3, createdAt: now, updatedAt: now })

    store.createArtifact({ id: 'a1', sessionId: 's1', taskId: 't1', name: 'X', type: 'log', createdAt: now })

    const artifact = store.getArtifact('a1')!
    expect(artifact.storageUrl).toBeUndefined()
    expect(artifact.metadata).toBeUndefined()
  })

  it('mapArtifactRow does not map non-string metadata.storageUrl (P6.4)', async () => {
    const store = await import('../../packages/server/src/db/hermes/agent-room-store')
    const now = new Date().toISOString()
    store.createSession({ id: 's1', name: 'Test', createdAt: now, updatedAt: now })
    store.createTask({ id: 't1', sessionId: 's1', title: 'Task', description: '', status: 'created', assignedAgentId: undefined, revisionRound: 0, maxRevisionRounds: 3, createdAt: now, updatedAt: now })

    // numeric storageUrl should not be flattened
    store.createArtifact({
      id: 'a1', sessionId: 's1', taskId: 't1', name: 'X', type: 'code_output',
      metadata: { storageUrl: 12345 },
      createdAt: now,
    })
    expect(store.getArtifact('a1')!.storageUrl).toBeUndefined()

    // boolean storageUrl should not be flattened
    store.createArtifact({
      id: 'a2', sessionId: 's1', taskId: 't1', name: 'Y', type: 'code_output',
      metadata: { storageUrl: true },
      createdAt: now,
    })
    expect(store.getArtifact('a2')!.storageUrl).toBeUndefined()

    // object storageUrl should not be flattened
    store.createArtifact({
      id: 'a3', sessionId: 's1', taskId: 't1', name: 'Z', type: 'code_output',
      metadata: { storageUrl: { url: 'https://example.com' } },
      createdAt: now,
    })
    expect(store.getArtifact('a3')!.storageUrl).toBeUndefined()
  })

  // ─── Role Run CRUD (P3.2) ──────────────────────────────────────

  it('createRoleRun / getRoleRun / updateRoleRun', async () => {
    const store = await import('../../packages/server/src/db/hermes/agent-room-store')
    const now = new Date().toISOString()
    store.createSession({ id: 's1', name: 'Test', createdAt: now, updatedAt: now })
    store.createTask({ id: 't1', sessionId: 's1', title: 'Task', description: '', status: 'created', assignedAgentId: undefined, revisionRound: 0, maxRevisionRounds: 3, createdAt: now, updatedAt: now })
    store.createRun({ id: 'r1', sessionId: 's1', taskId: 't1', status: 'running', runnerName: 'mock', createdAt: now, updatedAt: now })

    const roleRun = {
      id: 'rr1', runId: 'r1', sessionId: 's1', taskId: 't1',
      role: 'planner', phase: 'planning', profileName: 'gpt-4o',
      status: 'queued' as const, createdAt: now, updatedAt: now,
    }
    store.createRoleRun(roleRun)

    const fetched = store.getRoleRun('rr1')
    expect(fetched).toMatchObject({ id: 'rr1', role: 'planner', phase: 'planning', status: 'queued', profileName: 'gpt-4o' })

    // Update to running
    store.updateRoleRun({ ...roleRun, status: 'running', startedAt: now, updatedAt: now })
    const updated = store.getRoleRun('rr1')!
    expect(updated.status).toBe('running')
    expect(updated.startedAt).toBe(now)
  })

  it('getRoleRunByRunAndRole returns correct role run', async () => {
    const store = await import('../../packages/server/src/db/hermes/agent-room-store')
    const now = new Date().toISOString()
    store.createSession({ id: 's1', name: 'Test', createdAt: now, updatedAt: now })
    store.createTask({ id: 't1', sessionId: 's1', title: 'Task', description: '', status: 'created', assignedAgentId: undefined, revisionRound: 0, maxRevisionRounds: 3, createdAt: now, updatedAt: now })
    store.createRun({ id: 'r1', sessionId: 's1', taskId: 't1', status: 'running', runnerName: 'mock', createdAt: now, updatedAt: now })
    store.createRoleRun({ id: 'rr1', runId: 'r1', sessionId: 's1', taskId: 't1', role: 'planner', phase: 'planning', status: 'queued', createdAt: now, updatedAt: now })
    store.createRoleRun({ id: 'rr2', runId: 'r1', sessionId: 's1', taskId: 't1', role: 'developer', phase: 'development', status: 'queued', createdAt: now, updatedAt: now })

    const dev = store.getRoleRunByRunAndRole('r1', 'developer')
    expect(dev).toMatchObject({ id: 'rr2', role: 'developer' })

    expect(store.getRoleRunByRunAndRole('r1', 'reviewer')).toBeNull()
  })

  it('listRoleRunsByRun / listRoleRunsByTask', async () => {
    const store = await import('../../packages/server/src/db/hermes/agent-room-store')
    const now = new Date().toISOString()
    store.createSession({ id: 's1', name: 'Test', createdAt: now, updatedAt: now })
    store.createTask({ id: 't1', sessionId: 's1', title: 'Task', description: '', status: 'created', assignedAgentId: undefined, revisionRound: 0, maxRevisionRounds: 3, createdAt: now, updatedAt: now })
    store.createRun({ id: 'r1', sessionId: 's1', taskId: 't1', status: 'running', runnerName: 'mock', createdAt: now, updatedAt: now })
    store.createRoleRun({ id: 'rr1', runId: 'r1', sessionId: 's1', taskId: 't1', role: 'planner', phase: 'planning', status: 'completed', createdAt: now, updatedAt: now })
    store.createRoleRun({ id: 'rr2', runId: 'r1', sessionId: 's1', taskId: 't1', role: 'developer', phase: 'development', status: 'running', createdAt: now, updatedAt: now })

    expect(store.listRoleRunsByRun('r1')).toHaveLength(2)
    expect(store.listRoleRunsByTask('t1')).toHaveLength(2)
    expect(store.listRoleRunsByRun('nonexistent')).toHaveLength(0)
  })

  it('deleteRoleRunsByRun / deleteRoleRunsBySession', async () => {
    const store = await import('../../packages/server/src/db/hermes/agent-room-store')
    const now = new Date().toISOString()
    store.createSession({ id: 's1', name: 'Test', createdAt: now, updatedAt: now })
    store.createTask({ id: 't1', sessionId: 's1', title: 'Task', description: '', status: 'created', assignedAgentId: undefined, revisionRound: 0, maxRevisionRounds: 3, createdAt: now, updatedAt: now })
    store.createRun({ id: 'r1', sessionId: 's1', taskId: 't1', status: 'running', runnerName: 'mock', createdAt: now, updatedAt: now })
    store.createRoleRun({ id: 'rr1', runId: 'r1', sessionId: 's1', taskId: 't1', role: 'planner', phase: 'planning', status: 'completed', createdAt: now, updatedAt: now })
    store.createRoleRun({ id: 'rr2', runId: 'r1', sessionId: 's1', taskId: 't1', role: 'developer', phase: 'development', status: 'completed', createdAt: now, updatedAt: now })

    store.deleteRoleRunsByRun('r1')
    expect(store.listRoleRunsByRun('r1')).toHaveLength(0)

    // Re-create for session delete test
    store.createRoleRun({ id: 'rr3', runId: 'r1', sessionId: 's1', taskId: 't1', role: 'reviewer', phase: 'review', status: 'queued', createdAt: now, updatedAt: now })
    store.deleteRoleRunsBySession('s1')
    expect(store.listRoleRunsByRun('r1')).toHaveLength(0)
  })

  // ─── Run Event with role_run_id (P3.4) ─────────────────────────

  it('createRunEvent with roleRunId persists and queries correctly', async () => {
    const store = await import('../../packages/server/src/db/hermes/agent-room-store')
    const now = new Date().toISOString()
    store.createSession({ id: 's1', name: 'Test', createdAt: now, updatedAt: now })
    store.createTask({ id: 't1', sessionId: 's1', title: 'Task', description: '', status: 'created', assignedAgentId: undefined, revisionRound: 0, maxRevisionRounds: 3, createdAt: now, updatedAt: now })
    store.createRun({ id: 'r1', sessionId: 's1', taskId: 't1', status: 'running', runnerName: 'mock', createdAt: now, updatedAt: now })

    const evt = {
      id: 'evt1', runId: 'r1', sessionId: 's1', taskId: 't1',
      roleRunId: 'rr1', source: 'gateway_sse', sequence: 1,
      eventType: 'run.created', payload: { _agentRole: 'planner' }, createdAt: now,
    }
    store.createRunEvent(evt)

    const fetched = store.listRunEventsByRun('r1')
    expect(fetched).toHaveLength(1)
    expect(fetched[0].roleRunId).toBe('rr1')
    expect(fetched[0].payload).toMatchObject({ _agentRole: 'planner' })
  })

  it('deleteSessionCascade removes role runs', async () => {
    const store = await import('../../packages/server/src/db/hermes/agent-room-store')
    const now = new Date().toISOString()
    store.createSession({ id: 's1', name: 'Test', createdAt: now, updatedAt: now })
    store.createTask({ id: 't1', sessionId: 's1', title: 'Task', description: '', status: 'created', assignedAgentId: undefined, revisionRound: 0, maxRevisionRounds: 3, createdAt: now, updatedAt: now })
    store.createRun({ id: 'r1', sessionId: 's1', taskId: 't1', status: 'running', runnerName: 'mock', createdAt: now, updatedAt: now })
    store.createRoleRun({ id: 'rr1', runId: 'r1', sessionId: 's1', taskId: 't1', role: 'planner', phase: 'planning', status: 'completed', createdAt: now, updatedAt: now })

    store.deleteSessionCascade('s1')
    expect(store.getRoleRun('rr1')).toBeNull()
  })

  it('deleteTaskCascade removes role runs for the task', async () => {
    const store = await import('../../packages/server/src/db/hermes/agent-room-store')
    const now = new Date().toISOString()
    store.createSession({ id: 's1', name: 'Test', createdAt: now, updatedAt: now })
    store.createTask({ id: 't1', sessionId: 's1', title: 'Task', description: '', status: 'created', assignedAgentId: undefined, revisionRound: 0, maxRevisionRounds: 3, createdAt: now, updatedAt: now })
    store.createRun({ id: 'r1', sessionId: 's1', taskId: 't1', status: 'running', runnerName: 'mock', createdAt: now, updatedAt: now })
    store.createRoleRun({ id: 'rr1', runId: 'r1', sessionId: 's1', taskId: 't1', role: 'planner', phase: 'planning', status: 'completed', createdAt: now, updatedAt: now })

    store.deleteTaskCascade('s1', 't1')
    expect(store.getRoleRun('rr1')).toBeNull()
  })
})
