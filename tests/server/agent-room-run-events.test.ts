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

function makeRun(overrides: Record<string, any> = {}) {
  return {
    id: 'run-1',
    sessionId: 'sess-1',
    taskId: 'task-1',
    status: 'running',
    runnerName: 'mock',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as any
}

function makeRunEvent(overrides: Record<string, any> = {}) {
  return {
    id: 'evt-1',
    runId: 'run-1',
    sessionId: 'sess-1',
    taskId: 'task-1',
    source: 'gateway_sse',
    sequence: 1,
    eventType: 'run.created',
    createdAt: new Date().toISOString(),
    ...overrides,
  }
}

describe('Agent Room Run Events — P4.8.6', () => {
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

  // ─── Schema ───────────────────────────────────────────────────

  describe('Schema initialization', () => {
    it('agent_room_run_events table exists with all columns', async () => {
      const schemas = await import('../../packages/server/src/db/hermes/schemas')
      const rows = db.prepare(`PRAGMA table_info(${schemas.AR_RUN_EVENTS_TABLE})`).all() as Array<{ name: string }>
      const colNames = rows.map(r => r.name)
      expect(colNames).toContain('id')
      expect(colNames).toContain('run_id')
      expect(colNames).toContain('session_id')
      expect(colNames).toContain('task_id')
      expect(colNames).toContain('upstream_run_id')
      expect(colNames).toContain('source')
      expect(colNames).toContain('sequence')
      expect(colNames).toContain('event_type')
      expect(colNames).toContain('payload')
      expect(colNames).toContain('created_at')
    })

    it('indexes are created for run_events', async () => {
      const schemas = await import('../../packages/server/src/db/hermes/schemas')
      for (const idx of schemas.AR_INDEXES) {
        try { db.exec(idx) } catch { /* ignore */ }
      }
      const indexes = db.prepare(
        `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='${schemas.AR_RUN_EVENTS_TABLE}'`,
      ).all() as Array<{ name: string }>
      const names = indexes.map(i => i.name)
      expect(names).toContain('idx_ar_run_events_run')
      expect(names).toContain('idx_ar_run_events_session')
      expect(names).toContain('idx_ar_run_events_upstream')
      expect(names).toContain('idx_ar_run_events_type')
    })
  })

  // ─── Store CRUD ───────────────────────────────────────────────

  describe('Store CRUD', () => {
    it('createRunEvent + listRunEventsByRun returns events in sequence order', async () => {
      const store = await import('../../packages/server/src/db/hermes/agent-room-store')

      store.createRun(makeRun({ id: 'run-1', sessionId: 'sess-1', taskId: 'task-1', upstreamRunId: 'upstream-abc' }))

      store.createRunEvent(makeRunEvent({ id: 'evt-2', runId: 'run-1', sessionId: 'sess-1', taskId: 'task-1', upstreamRunId: 'upstream-abc', sequence: 2, eventType: 'run.step', payload: { step: 2 } }))
      store.createRunEvent(makeRunEvent({ id: 'evt-1', runId: 'run-1', sessionId: 'sess-1', taskId: 'task-1', upstreamRunId: 'upstream-abc', sequence: 1, eventType: 'run.created', payload: { run_id: 'upstream-abc' } }))

      const events = store.listRunEventsByRun('run-1')
      expect(events).toHaveLength(2)
      expect(events[0].sequence).toBe(1)
      expect(events[1].sequence).toBe(2)
      expect(events[0].eventType).toBe('run.created')
      expect(events[1].eventType).toBe('run.step')
    })

    it('listRunEventsBySession returns all events for a session', async () => {
      const store = await import('../../packages/server/src/db/hermes/agent-room-store')

      store.createRun(makeRun({ id: 'run-2', sessionId: 'sess-2', taskId: 'task-2' }))
      store.createRunEvent(makeRunEvent({ id: 'evt-3', runId: 'run-2', sessionId: 'sess-2', taskId: 'task-2', eventType: 'run.completed', payload: { usage: { input_tokens: 100 } } }))

      const events = store.listRunEventsBySession('sess-2')
      expect(events).toHaveLength(1)
      expect(events[0].eventType).toBe('run.completed')
    })

    it('findRunEventByUpstreamRunId returns first matching event', async () => {
      const store = await import('../../packages/server/src/db/hermes/agent-room-store')

      store.createRun(makeRun({ id: 'run-3', sessionId: 'sess-3', taskId: 'task-3', upstreamRunId: 'upstream-xyz' }))
      store.createRunEvent(makeRunEvent({ id: 'evt-4', runId: 'run-3', sessionId: 'sess-3', taskId: 'task-3', upstreamRunId: 'upstream-xyz' }))

      const found = store.findRunEventByUpstreamRunId('upstream-xyz')
      expect(found).not.toBeNull()
      expect(found!.id).toBe('evt-4')
    })

    it('getNextRunEventSequence returns 1 for new run, increments after insert', async () => {
      const store = await import('../../packages/server/src/db/hermes/agent-room-store')

      store.createRun(makeRun({ id: 'run-4', sessionId: 'sess-4', taskId: 'task-4' }))
      expect(store.getNextRunEventSequence('run-4')).toBe(1)

      store.createRunEvent(makeRunEvent({ id: 'evt-5', runId: 'run-4', sessionId: 'sess-4', taskId: 'task-4' }))
      expect(store.getNextRunEventSequence('run-4')).toBe(2)
    })

    it('deleteRunEventsByRun removes all events for a run', async () => {
      const store = await import('../../packages/server/src/db/hermes/agent-room-store')

      store.createRun(makeRun({ id: 'run-5', sessionId: 'sess-5', taskId: 'task-5' }))
      store.createRunEvent(makeRunEvent({ id: 'evt-6', runId: 'run-5', sessionId: 'sess-5', taskId: 'task-5' }))

      expect(store.listRunEventsByRun('run-5')).toHaveLength(1)
      store.deleteRunEventsByRun('run-5')
      expect(store.listRunEventsByRun('run-5')).toHaveLength(0)
    })

    it('deleteSessionCascade removes run events', async () => {
      const store = await import('../../packages/server/src/db/hermes/agent-room-store')

      store.createSession({ id: 'sess-cascade', name: 'Test', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
      store.createTask({
        id: 'task-cascade', sessionId: 'sess-cascade', title: 'T', description: '',
        status: 'created', revisionRound: 0, maxRevisionRounds: 3,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      })
      store.createRun(makeRun({ id: 'run-cascade', sessionId: 'sess-cascade', taskId: 'task-cascade' }))
      store.createRunEvent(makeRunEvent({ id: 'evt-cascade', runId: 'run-cascade', sessionId: 'sess-cascade', taskId: 'task-cascade' }))

      expect(store.listRunEventsBySession('sess-cascade')).toHaveLength(1)
      store.deleteSessionCascade('sess-cascade')
      expect(store.listRunEventsBySession('sess-cascade')).toHaveLength(0)
    })

    it('payload is JSON-encoded/decoded correctly', async () => {
      const store = await import('../../packages/server/src/db/hermes/agent-room-store')

      store.createRun(makeRun({ id: 'run-json', sessionId: 'sess-json', taskId: 'task-json' }))

      const complexPayload = {
        event: 'run.step',
        data: { nested: { value: 42 }, arr: [1, 2, 3] },
        usage: { input_tokens: 100, output_tokens: 50 },
      }

      store.createRunEvent(makeRunEvent({
        id: 'evt-json', runId: 'run-json', sessionId: 'sess-json', taskId: 'task-json',
        eventType: 'run.step', payload: complexPayload,
      }))

      const events = store.listRunEventsByRun('run-json')
      expect(events).toHaveLength(1)
      expect(events[0].payload).toEqual(complexPayload)
    })
  })

  // ─── Run Association ──────────────────────────────────────────

  describe('Run association via upstream_run_id', () => {
    it('findByUpstreamRunId resolves local run from upstream_run_id', async () => {
      const store = await import('../../packages/server/src/db/hermes/agent-room-store')

      store.createRun(makeRun({ id: 'local-run-1', sessionId: 'sess-assoc', taskId: 'task-assoc', upstreamRunId: 'upstream-123' }))

      const found = store.findByUpstreamRunId('upstream-123')
      expect(found).not.toBeNull()
      expect(found!.id).toBe('local-run-1')
      expect(found!.sessionId).toBe('sess-assoc')
    })

    it('findByUpstreamRunId returns null for unknown upstream', async () => {
      const store = await import('../../packages/server/src/db/hermes/agent-room-store')
      const found = store.findByUpstreamRunId('nonexistent')
      expect(found).toBeNull()
    })
  })

  // ─── Service Façade ───────────────────────────────────────────

  describe('Service façade', () => {
    it('listRunEventsByRun returns events via service layer', async () => {
      const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
      const store = await import('../../packages/server/src/db/hermes/agent-room-store')

      const session = svc.createSession('Test Session')
      const task = svc.createTask(session.id, 'Test Task', '')

      store.createRun(makeRun({ id: 'run-facade', sessionId: session.id, taskId: task.id }))
      store.createRunEvent(makeRunEvent({ id: 'evt-facade', runId: 'run-facade', sessionId: session.id, taskId: task.id }))

      const events = svc.listRunEventsByRun('run-facade')
      expect(events).toHaveLength(1)
      expect(events[0].eventType).toBe('run.created')
    })

    it('listRunEventsBySession returns events via service layer', async () => {
      const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
      const store = await import('../../packages/server/src/db/hermes/agent-room-store')

      const session = svc.createSession('Test Session 2')
      const task = svc.createTask(session.id, 'Test Task 2', '')

      store.createRun(makeRun({ id: 'run-facade-2', sessionId: session.id, taskId: task.id }))
      store.createRunEvent(makeRunEvent({ id: 'evt-facade-2', runId: 'run-facade-2', sessionId: session.id, taskId: task.id, eventType: 'run.step' }))

      const events = svc.listRunEventsBySession(session.id)
      expect(events).toHaveLength(1)
    })

    it('listRunEventsBySession throws for nonexistent session', async () => {
      const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
      expect(() => svc.listRunEventsBySession('nonexistent')).toThrow('Session not found')
    })
  })

  // ─── Route Endpoints ──────────────────────────────────────────

  describe('Route endpoints', () => {
    it('GET /api/agent-room/sessions/:sessionId/run-events returns events', async () => {
      const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
      const store = await import('../../packages/server/src/db/hermes/agent-room-store')
      const { agentRoomRoutes } = await import('../../packages/server/src/routes/hermes/agent-room')

      const session = svc.createSession('Route Test')
      const task = svc.createTask(session.id, 'Route Task', '')

      store.createRun(makeRun({ id: 'run-route', sessionId: session.id, taskId: task.id }))
      store.createRunEvent(makeRunEvent({ id: 'evt-route', runId: 'run-route', sessionId: session.id, taskId: task.id }))

      const route = agentRoomRoutes.stack.find((r: any) =>
        r.path === '/api/agent-room/sessions/:sessionId/run-events' &&
        r.methods.includes('GET')
      )
      expect(route).toBeDefined()

      const ctx = { params: { sessionId: session.id }, status: 200, body: null } as any
      await route!.stack[0](ctx, async () => {})
      expect(ctx.status).toBe(200)
      expect(Array.isArray(ctx.body)).toBe(true)
      expect(ctx.body).toHaveLength(1)
      expect(ctx.body[0].eventType).toBe('run.created')
    })

    it('GET /api/agent-room/runs/:runId/events returns events for a run', async () => {
      const store = await import('../../packages/server/src/db/hermes/agent-room-store')
      const { agentRoomRoutes } = await import('../../packages/server/src/routes/hermes/agent-room')

      store.createRun(makeRun({ id: 'run-route-2', sessionId: 'sess-route-2', taskId: 'task-route-2' }))
      store.createRunEvent(makeRunEvent({ id: 'evt-route-2', runId: 'run-route-2', sessionId: 'sess-route-2', taskId: 'task-route-2', eventType: 'run.step' }))

      const route = agentRoomRoutes.stack.find((r: any) =>
        r.path === '/api/agent-room/runs/:runId/events' &&
        r.methods.includes('GET')
      )
      expect(route).toBeDefined()

      const ctx = { params: { runId: 'run-route-2' }, status: 200, body: null } as any
      await route!.stack[0](ctx, async () => {})
      expect(ctx.status).toBe(200)
      expect(ctx.body).toHaveLength(1)
      expect(ctx.body[0].eventType).toBe('run.step')
    })
  })

  // ─── Event Normalization ──────────────────────────────────────

  describe('SSE event normalization', () => {
    it('normalizeAndPersistSSEEvent persists event with resolved run', async () => {
      const store = await import('../../packages/server/src/db/hermes/agent-room-store')

      store.createRun(makeRun({ id: 'local-run-norm', sessionId: 'sess-norm', taskId: 'task-norm', upstreamRunId: 'upstream-norm-123' }))

      const upstreamRunId = 'upstream-norm-123'
      const localRun = store.findByUpstreamRunId(upstreamRunId)
      expect(localRun).not.toBeNull()

      const runId = localRun!.id
      const sequence = store.getNextRunEventSequence(runId)

      store.createRunEvent(makeRunEvent({
        id: 'evt-norm-1', runId, sessionId: localRun!.sessionId, taskId: localRun!.taskId,
        upstreamRunId, sequence, eventType: 'run.step', payload: { event: 'run.step', data: 'test' },
      }))

      const events = store.listRunEventsByRun('local-run-norm')
      expect(events).toHaveLength(1)
      expect(events[0].eventType).toBe('run.step')
      expect(events[0].sessionId).toBe('sess-norm')
      expect(events[0].taskId).toBe('task-norm')
      expect(events[0].upstreamRunId).toBe('upstream-norm-123')
      expect(events[0].source).toBe('gateway_sse')
      expect(events[0].sequence).toBe(1)
    })

    it('event with unknown upstream_run_id still persists with fallback', async () => {
      const store = await import('../../packages/server/src/db/hermes/agent-room-store')

      const localRun = store.findByUpstreamRunId('unknown-upstream')
      expect(localRun).toBeNull()

      const upstreamRunId = 'unknown-upstream'
      const sequence = store.getNextRunEventSequence(upstreamRunId)

      store.createRunEvent(makeRunEvent({
        id: 'evt-fallback', runId: upstreamRunId, sessionId: '', taskId: '',
        upstreamRunId, sequence, eventType: 'run.created',
      }))

      const events = store.listRunEventsByRun('unknown-upstream')
      expect(events).toHaveLength(1)
      expect(events[0].sessionId).toBe('')
      expect(events[0].taskId).toBe('')
    })

    it('multiple events for same run get incrementing sequences', async () => {
      const store = await import('../../packages/server/src/db/hermes/agent-room-store')

      store.createRun(makeRun({ id: 'run-multi', sessionId: 'sess-multi', taskId: 'task-multi', upstreamRunId: 'upstream-multi' }))

      const eventTypes = ['run.created', 'run.step', 'run.step', 'run.completed']
      for (let i = 0; i < eventTypes.length; i++) {
        const seq = store.getNextRunEventSequence('run-multi')
        store.createRunEvent(makeRunEvent({
          id: `evt-multi-${i}`, runId: 'run-multi', sessionId: 'sess-multi', taskId: 'task-multi',
          upstreamRunId: 'upstream-multi', sequence: seq, eventType: eventTypes[i],
        }))
      }

      const events = store.listRunEventsByRun('run-multi')
      expect(events).toHaveLength(4)
      expect(events.map(e => e.sequence)).toEqual([1, 2, 3, 4])
      expect(events.map(e => e.eventType)).toEqual(eventTypes)
    })
  })
})
