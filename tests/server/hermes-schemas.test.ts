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

describe('Hermes schema migrations', () => {
  let db: any = null

  beforeEach(async () => {
    vi.resetModules()
    const { DatabaseSync } = await import('node:sqlite')
    db = new DatabaseSync(':memory:')
    vi.doMock('../../packages/server/src/db/index', () => ({
      getDb: () => db,
      ensureTable: (tableName: string, schema: Record<string, string>) => ensureTableForTest(db, tableName, schema),
    }))
  })

  afterEach(() => {
    db?.close()
    db = null
    vi.doUnmock('../../packages/server/src/db/index')
    vi.resetModules()
  })

  it('migrates legacy session_usage rows with SQL-safe defaults', async () => {
    const updatedAt = Date.UTC(2026, 3, 29)
    db.exec(`CREATE TABLE "session_usage" (
      "session_id" TEXT PRIMARY KEY,
      "input_tokens" INTEGER NOT NULL DEFAULT 0,
      "output_tokens" INTEGER NOT NULL DEFAULT 0,
      "updated_at" INTEGER NOT NULL
    )`)
    db.prepare(
      `INSERT INTO "session_usage" (session_id, input_tokens, output_tokens, updated_at) VALUES (?, ?, ?, ?)`,
    ).run('legacy-session', 123, 45, updatedAt)

    const { initAllHermesTables } = await import('../../packages/server/src/db/hermes/schemas')

    expect(() => initAllHermesTables()).not.toThrow()

    const row = db.prepare(
      `SELECT session_id, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
              reasoning_tokens, model, profile, created_at
       FROM "session_usage"`,
    ).get() as any
    expect(row).toMatchObject({
      session_id: 'legacy-session',
      input_tokens: 123,
      output_tokens: 45,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      model: '',
      profile: 'default',
      created_at: updatedAt,
    })
    expect(db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='session_usage_old'`).get()).toBeUndefined()
  })

  it('recovers rows left in session_usage_old by a failed previous migration', async () => {
    const updatedAt = Date.UTC(2026, 3, 30)
    db.exec(`CREATE TABLE "session_usage" (
      "id" INTEGER PRIMARY KEY AUTOINCREMENT,
      "session_id" TEXT NOT NULL,
      "input_tokens" INTEGER NOT NULL DEFAULT 0,
      "output_tokens" INTEGER NOT NULL DEFAULT 0,
      "cache_read_tokens" INTEGER NOT NULL DEFAULT 0,
      "cache_write_tokens" INTEGER NOT NULL DEFAULT 0,
      "reasoning_tokens" INTEGER NOT NULL DEFAULT 0,
      "model" TEXT NOT NULL DEFAULT '',
      "profile" TEXT NOT NULL DEFAULT 'default',
      "created_at" INTEGER NOT NULL
    )`)
    db.exec(`CREATE TABLE "session_usage_old" (
      "session_id" TEXT PRIMARY KEY,
      "input_tokens" INTEGER NOT NULL DEFAULT 0,
      "output_tokens" INTEGER NOT NULL DEFAULT 0,
      "updated_at" INTEGER NOT NULL
    )`)
    db.prepare(
      `INSERT INTO "session_usage_old" (session_id, input_tokens, output_tokens, updated_at) VALUES (?, ?, ?, ?)`,
    ).run('stranded-session', 200, 80, updatedAt)

    const { initAllHermesTables } = await import('../../packages/server/src/db/hermes/schemas')

    expect(() => initAllHermesTables()).not.toThrow()

    const row = db.prepare(
      `SELECT session_id, input_tokens, output_tokens, model, profile, created_at FROM "session_usage"`,
    ).get() as any
    expect(row).toMatchObject({
      session_id: 'stranded-session',
      input_tokens: 200,
      output_tokens: 80,
      model: '',
      profile: 'default',
      created_at: updatedAt,
    })
    expect(db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='session_usage_old'`).get()).toBeUndefined()
  })

  it('initAllHermesTables creates all agent_room tables and indexes', async () => {
    const { initAllHermesTables } = await import('../../packages/server/src/db/hermes/schemas')

    expect(() => initAllHermesTables()).not.toThrow()

    // Verify all 6 agent_room tables exist
    const tables = [
      'agent_room_sessions',
      'agent_room_tasks',
      'agent_room_reviews',
      'agent_room_messages',
      'agent_room_workflow_events',
      'agent_room_artifacts',
    ]
    for (const table of tables) {
      const row = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(table) as any
      expect(row, `Table ${table} should exist`).toBeDefined()
      expect(row.name).toBe(table)
    }

    // Verify all idx_ar_* indexes exist
    const indexes = [
      'idx_ar_tasks_session',
      'idx_ar_tasks_status',
      'idx_ar_reviews_session',
      'idx_ar_reviews_task',
      'idx_ar_messages_session',
      'idx_ar_events_session',
      'idx_ar_events_task',
      'idx_ar_artifacts_session',
      'idx_ar_artifacts_task',
    ]
    for (const idx of indexes) {
      const row = db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name=?`).get(idx) as any
      expect(row, `Index ${idx} should exist`).toBeDefined()
      expect(row.name).toBe(idx)
    }
  })

  it('initAllHermesTables is idempotent (no error on second call)', async () => {
    const { initAllHermesTables } = await import('../../packages/server/src/db/hermes/schemas')

    expect(() => initAllHermesTables()).not.toThrow()
    expect(() => initAllHermesTables()).not.toThrow()

    // Tables still exist
    const row = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='agent_room_sessions'`).get() as any
    expect(row).toBeDefined()
  })
})
