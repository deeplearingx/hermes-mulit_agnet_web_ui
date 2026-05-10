/**
 * Centralized schema definitions for all Hermes SQLite tables.
 * All table schemas are defined here for unified management and migration.
 */

// ============================================================================
// Usage Store (usage-store.ts)
// ============================================================================

export const USAGE_TABLE = 'session_usage'

export const USAGE_SCHEMA: Record<string, string> = {
  id: 'INTEGER PRIMARY KEY AUTOINCREMENT',
  session_id: 'TEXT NOT NULL',
  input_tokens: 'INTEGER NOT NULL DEFAULT 0',
  output_tokens: 'INTEGER NOT NULL DEFAULT 0',
  cache_read_tokens: 'INTEGER NOT NULL DEFAULT 0',
  cache_write_tokens: 'INTEGER NOT NULL DEFAULT 0',
  reasoning_tokens: 'INTEGER NOT NULL DEFAULT 0',
  model: "TEXT NOT NULL DEFAULT ''",
  profile: "TEXT NOT NULL DEFAULT 'default'",
  created_at: 'INTEGER NOT NULL',
}

// ============================================================================
// Session Store (session-store.ts)
// ============================================================================

export const SESSIONS_TABLE = 'sessions'

export const SESSIONS_SCHEMA: Record<string, string> = {
  id: 'TEXT PRIMARY KEY',
  profile: 'TEXT NOT NULL DEFAULT \'default\'',
  source: 'TEXT NOT NULL DEFAULT \'api_server\'',
  user_id: 'TEXT',
  model: 'TEXT NOT NULL DEFAULT \'\'',
  title: 'TEXT',
  started_at: 'INTEGER NOT NULL',
  ended_at: 'INTEGER',
  end_reason: 'TEXT',
  message_count: 'INTEGER NOT NULL DEFAULT 0',
  tool_call_count: 'INTEGER NOT NULL DEFAULT 0',
  input_tokens: 'INTEGER NOT NULL DEFAULT 0',
  output_tokens: 'INTEGER NOT NULL DEFAULT 0',
  cache_read_tokens: 'INTEGER NOT NULL DEFAULT 0',
  cache_write_tokens: 'INTEGER NOT NULL DEFAULT 0',
  reasoning_tokens: 'INTEGER NOT NULL DEFAULT 0',
  billing_provider: 'TEXT',
  estimated_cost_usd: 'REAL NOT NULL DEFAULT 0',
  actual_cost_usd: 'REAL',
  cost_status: 'TEXT NOT NULL DEFAULT \'\'',
  preview: 'TEXT NOT NULL DEFAULT \'\'',
  last_active: 'INTEGER NOT NULL',
  workspace: 'TEXT',
}

export const MESSAGES_TABLE = 'messages'

export const MESSAGES_SCHEMA: Record<string, string> = {
  id: 'INTEGER PRIMARY KEY AUTOINCREMENT',
  session_id: 'TEXT NOT NULL',
  role: 'TEXT NOT NULL',
  content: 'TEXT NOT NULL DEFAULT \'\'',
  tool_call_id: 'TEXT',
  tool_calls: 'TEXT',
  tool_name: 'TEXT',
  timestamp: 'INTEGER NOT NULL',
  token_count: 'INTEGER',
  finish_reason: 'TEXT',
  reasoning: 'TEXT',
  reasoning_details: 'TEXT',
  reasoning_content: 'TEXT',
  codex_reasoning_items: 'TEXT',
}

export const MESSAGES_INDEX = 'CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id)'

// ============================================================================
// Compression Snapshot (compression-snapshot.ts)
// ============================================================================

export const COMPRESSION_SNAPSHOT_TABLE = 'chat_compression_snapshots'

export const COMPRESSION_SNAPSHOT_SCHEMA: Record<string, string> = {
  session_id: 'TEXT PRIMARY KEY',
  summary: 'TEXT NOT NULL DEFAULT \'\'',
  last_message_index: 'INTEGER NOT NULL DEFAULT 0',
  message_count_at_time: 'INTEGER NOT NULL DEFAULT 0',
  updated_at: 'INTEGER NOT NULL',
}

// ============================================================================
// Group Chat (services/hermes/group-chat/index.ts)
// ============================================================================

export const GC_ROOMS_TABLE = 'gc_rooms'

export const GC_ROOMS_SCHEMA: Record<string, string> = {
  id: 'TEXT PRIMARY KEY',
  name: 'TEXT NOT NULL',
  inviteCode: 'TEXT UNIQUE',
  triggerTokens: 'INTEGER NOT NULL DEFAULT 100000',
  maxHistoryTokens: 'INTEGER NOT NULL DEFAULT 32000',
  tailMessageCount: 'INTEGER NOT NULL DEFAULT 20',
  totalTokens: 'INTEGER NOT NULL DEFAULT 0',
}

export const GC_MESSAGES_TABLE = 'gc_messages'

export const GC_MESSAGES_SCHEMA: Record<string, string> = {
  id: 'TEXT PRIMARY KEY',
  roomId: 'TEXT NOT NULL',
  senderId: 'TEXT NOT NULL',
  senderName: 'TEXT NOT NULL',
  content: 'TEXT NOT NULL',
  timestamp: 'INTEGER NOT NULL',
}

export const GC_ROOM_AGENTS_TABLE = 'gc_room_agents'

export const GC_ROOM_AGENTS_SCHEMA: Record<string, string> = {
  id: 'TEXT PRIMARY KEY',
  roomId: 'TEXT NOT NULL',
  agentId: 'TEXT NOT NULL',
  profile: 'TEXT NOT NULL',
  name: 'TEXT NOT NULL',
  description: "TEXT NOT NULL DEFAULT ''",
  invited: 'INTEGER NOT NULL DEFAULT 0',
  role_type: "TEXT NOT NULL DEFAULT 'observer'",
}

export const GC_AGENT_OVERRIDES_TABLE = 'gc_agent_overrides'

export const GC_AGENT_OVERRIDES_SCHEMA: Record<string, string> = {
  id: 'TEXT PRIMARY KEY',
  roomId: 'TEXT NOT NULL',
  agentId: 'TEXT NOT NULL',
  model: 'TEXT',
  provider: 'TEXT',
  systemPrompt: 'TEXT',
  skillsAllowList: 'TEXT',
  contextEnabled: 'INTEGER',
  triggerTokens: 'INTEGER',
  maxHistoryTokens: 'INTEGER',
  tailMessageCount: 'INTEGER',
  updatedAt: 'INTEGER NOT NULL',
}

export const GC_CONTEXT_SNAPSHOTS_TABLE = 'gc_context_snapshots'

export const GC_CONTEXT_SNAPSHOTS_SCHEMA: Record<string, string> = {
  roomId: 'TEXT PRIMARY KEY',
  summary: 'TEXT NOT NULL DEFAULT \'\'',
  lastMessageId: 'TEXT NOT NULL',
  lastMessageTimestamp: 'INTEGER NOT NULL',
  updatedAt: 'INTEGER NOT NULL',
}

export const GC_ROOM_MEMBERS_TABLE = 'gc_room_members'

export const GC_ROOM_MEMBERS_SCHEMA: Record<string, string> = {
  id: 'TEXT PRIMARY KEY',
  roomId: 'TEXT NOT NULL',
  userId: 'TEXT NOT NULL',
  userName: 'TEXT NOT NULL',
  description: "TEXT NOT NULL DEFAULT ''",
  joinedAt: 'INTEGER NOT NULL',
  updatedAt: 'INTEGER NOT NULL',
}

export const GC_PENDING_SESSION_DELETES_TABLE = 'gc_pending_session_deletes'

export const GC_PENDING_SESSION_DELETES_SCHEMA: Record<string, string> = {
  session_id: 'TEXT PRIMARY KEY',
  profile_name: 'TEXT NOT NULL',
  status: "TEXT NOT NULL DEFAULT 'pending'",
  attempt_count: 'INTEGER NOT NULL DEFAULT 0',
  last_error: 'TEXT',
  created_at: 'INTEGER NOT NULL',
  updated_at: 'INTEGER NOT NULL',
  next_attempt_at: 'INTEGER NOT NULL DEFAULT 0',
}

export const GC_SESSION_PROFILES_TABLE = 'gc_session_profiles'

export const GC_SESSION_PROFILES_SCHEMA: Record<string, string> = {
  session_id: 'TEXT PRIMARY KEY',
  room_id: 'TEXT NOT NULL',
  agent_id: 'TEXT NOT NULL',
  profile_name: 'TEXT NOT NULL',
  created_at: 'INTEGER NOT NULL',
}

export const GC_WORKSPACE_LAYOUTS_TABLE = 'gc_workspace_layouts'
export const GC_WORKSPACE_LAYOUTS_SCHEMA: Record<string, string> = {
  id: 'TEXT PRIMARY KEY',
  roomId: 'TEXT NOT NULL',
  agentId: 'TEXT NOT NULL',
  x: 'INTEGER NOT NULL DEFAULT 0',
  y: 'INTEGER NOT NULL DEFAULT 0',
  zone: "TEXT NOT NULL DEFAULT 'coding'",
  pinned: 'INTEGER NOT NULL DEFAULT 0',  // P9-3: 用户固定位置
  updatedAt: 'INTEGER NOT NULL',
}

export const GC_TASKS_TABLE = 'gc_tasks'
export const GC_TASKS_SCHEMA: Record<string, string> = {
  id: 'TEXT PRIMARY KEY',
  roomId: 'TEXT NOT NULL',
  title: 'TEXT NOT NULL',
  description: "TEXT NOT NULL DEFAULT ''",
  status: "TEXT NOT NULL DEFAULT 'draft'",
  phase: "TEXT NOT NULL DEFAULT 'requirement'",
  assigneeAgentId: 'TEXT',
  createdAt: 'INTEGER NOT NULL',
  updatedAt: 'INTEGER NOT NULL',
}

export const GC_ARTIFACTS_TABLE = 'gc_artifacts'
export const GC_ARTIFACTS_SCHEMA: Record<string, string> = {
  id: 'TEXT PRIMARY KEY',
  roomId: 'TEXT NOT NULL',
  taskId: 'TEXT',
  agentId: 'TEXT',
  name: 'TEXT NOT NULL',
  type: 'TEXT NOT NULL',
  path: 'TEXT',
  contentPreview: 'TEXT',
  createdAt: 'INTEGER NOT NULL',
}

// ============================================================================
// Agent Room (services/hermes/agent-room/index.ts)
// ============================================================================

export const AR_SESSIONS_TABLE = 'agent_room_sessions'
export const AR_SESSIONS_SCHEMA: Record<string, string> = {
    id: 'TEXT PRIMARY KEY',
    name: 'TEXT NOT NULL',
    auto_delivery_enabled: 'INTEGER NOT NULL DEFAULT 0',
    created_at: 'TEXT NOT NULL',
    updated_at: 'TEXT NOT NULL',
}

export const AR_TASKS_TABLE = 'agent_room_tasks'
export const AR_TASKS_SCHEMA: Record<string, string> = {
    id: 'TEXT PRIMARY KEY',
    session_id: 'TEXT NOT NULL',
    title: 'TEXT NOT NULL',
    description: "TEXT NOT NULL DEFAULT ''",
    assigned_agent_id: 'TEXT',
    status: "TEXT NOT NULL DEFAULT 'created'",
    parent_task_id: 'TEXT',
    revision_round: 'INTEGER NOT NULL DEFAULT 0',
    max_revision_rounds: 'INTEGER NOT NULL DEFAULT 3',
    created_at: 'TEXT NOT NULL',
    updated_at: 'TEXT NOT NULL',
}

export const AR_REVIEWS_TABLE = 'agent_room_reviews'
export const AR_REVIEWS_SCHEMA: Record<string, string> = {
    id: 'TEXT PRIMARY KEY',
    session_id: 'TEXT NOT NULL',
    task_id: 'TEXT NOT NULL',
    reviewer_agent_id: 'TEXT NOT NULL',
    status: "TEXT NOT NULL DEFAULT 'passed'",
    comment: "TEXT NOT NULL DEFAULT ''",
    created_at: 'TEXT NOT NULL',
}

export const AR_MESSAGES_TABLE = 'agent_room_messages'
export const AR_MESSAGES_SCHEMA: Record<string, string> = {
    id: 'TEXT PRIMARY KEY',
    session_id: 'TEXT NOT NULL',
    sender_id: 'TEXT NOT NULL',
    sender_name: 'TEXT NOT NULL',
    sender_role: 'TEXT NOT NULL',
    type: 'TEXT NOT NULL',
    content: 'TEXT NOT NULL',
    metadata: 'TEXT',
    created_at: 'TEXT NOT NULL',
}

export const AR_WORKFLOW_EVENTS_TABLE = 'agent_room_workflow_events'
export const AR_WORKFLOW_EVENTS_SCHEMA: Record<string, string> = {
    id: 'TEXT PRIMARY KEY',
    session_id: 'TEXT NOT NULL',
    task_id: 'TEXT NOT NULL',
    type: 'TEXT NOT NULL',
    agent_id: 'TEXT NOT NULL',
    agent_role: 'TEXT NOT NULL',
    payload: 'TEXT',
    created_at: 'TEXT NOT NULL',
}

export const AR_ARTIFACTS_TABLE = 'agent_room_artifacts'
export const AR_ARTIFACTS_SCHEMA: Record<string, string> = {
    id: 'TEXT PRIMARY KEY',
    session_id: 'TEXT NOT NULL',
    task_id: 'TEXT NOT NULL',
    name: 'TEXT NOT NULL',
    type: 'TEXT NOT NULL',
    content: 'TEXT',
    metadata: 'TEXT',
    created_at: 'TEXT NOT NULL',
}

export const AR_ROLE_BINDINGS_TABLE = 'agent_room_role_bindings'
export const AR_ROLE_BINDINGS_SCHEMA: Record<string, string> = {
    id: 'TEXT PRIMARY KEY',
    session_id: 'TEXT NOT NULL',
    role: 'TEXT NOT NULL',
    agent_id: 'TEXT NOT NULL',
    created_at: 'TEXT NOT NULL',
}

export const AR_RUNS_TABLE = 'agent_room_runs'
export const AR_RUNS_SCHEMA: Record<string, string> = {
    id: 'TEXT PRIMARY KEY',
    session_id: 'TEXT NOT NULL',
    task_id: 'TEXT NOT NULL',
    status: "TEXT NOT NULL DEFAULT 'queued'",
    upstream_run_id: 'TEXT',
    runner_name: "TEXT NOT NULL DEFAULT 'mock'",
    error_message: 'TEXT',
    started_at: 'TEXT',
    finished_at: 'TEXT',
    created_at: 'TEXT NOT NULL',
    updated_at: 'TEXT NOT NULL',
}

// ─── Role-Level Run (P3.1) ────────────────────────────────────────
// Tracks per-role execution within a workflow-level run.
// Each role (planner/developer/reviewer/delivery) gets its own row
// with lifecycle timestamps and optional upstream_run_id correlation.

export const AR_ROLE_RUNS_TABLE = 'agent_room_role_runs'
export const AR_ROLE_RUNS_SCHEMA: Record<string, string> = {
    id: 'TEXT PRIMARY KEY',
    run_id: 'TEXT NOT NULL',
    session_id: 'TEXT NOT NULL',
    task_id: 'TEXT NOT NULL',
    role: 'TEXT NOT NULL',
    phase: 'TEXT NOT NULL',
    profile_name: 'TEXT',
    upstream_run_id: 'TEXT',
    status: "TEXT NOT NULL DEFAULT 'queued'",
    started_at: 'TEXT',
    finished_at: 'TEXT',
    error_message: 'TEXT',
    metadata: 'TEXT',
    created_at: 'TEXT NOT NULL',
    updated_at: 'TEXT NOT NULL',
}

// P3.4: role_run_id column added to run_events for optional role-level correlation
export const AR_RUN_EVENTS_TABLE = 'agent_room_run_events'
export const AR_RUN_EVENTS_SCHEMA: Record<string, string> = {
    id: 'TEXT PRIMARY KEY',
    run_id: 'TEXT NOT NULL',
    session_id: 'TEXT NOT NULL',
    task_id: 'TEXT NOT NULL',
    upstream_run_id: 'TEXT',
    role_run_id: 'TEXT',
    source: "TEXT NOT NULL DEFAULT 'gateway_sse'",
    sequence: 'INTEGER NOT NULL DEFAULT 0',
    event_type: 'TEXT NOT NULL',
    payload: 'TEXT',
    created_at: 'TEXT NOT NULL',
}

export const AR_INDEXES = [
    'CREATE INDEX IF NOT EXISTS idx_ar_tasks_session ON agent_room_tasks(session_id)',
    'CREATE INDEX IF NOT EXISTS idx_ar_tasks_status ON agent_room_tasks(session_id, status)',
    'CREATE INDEX IF NOT EXISTS idx_ar_reviews_session ON agent_room_reviews(session_id, created_at)',
    'CREATE INDEX IF NOT EXISTS idx_ar_reviews_task ON agent_room_reviews(task_id)',
    'CREATE INDEX IF NOT EXISTS idx_ar_messages_session ON agent_room_messages(session_id, created_at)',
    'CREATE INDEX IF NOT EXISTS idx_ar_events_session ON agent_room_workflow_events(session_id, created_at)',
    'CREATE INDEX IF NOT EXISTS idx_ar_events_task ON agent_room_workflow_events(task_id)',
    'CREATE INDEX IF NOT EXISTS idx_ar_artifacts_session ON agent_room_artifacts(session_id, created_at)',
    'CREATE INDEX IF NOT EXISTS idx_ar_artifacts_task ON agent_room_artifacts(task_id, created_at)',
    'CREATE INDEX IF NOT EXISTS idx_ar_role_bindings_session ON agent_room_role_bindings(session_id)',
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_ar_role_bindings_session_role ON agent_room_role_bindings(session_id, role)',
    'CREATE INDEX IF NOT EXISTS idx_ar_runs_session ON agent_room_runs(session_id, created_at)',
    'CREATE INDEX IF NOT EXISTS idx_ar_runs_task ON agent_room_runs(task_id, created_at)',
    'CREATE INDEX IF NOT EXISTS idx_ar_runs_upstream ON agent_room_runs(upstream_run_id)',
    // P3.1: role_runs indexes
    'CREATE INDEX IF NOT EXISTS idx_ar_role_runs_run ON agent_room_role_runs(run_id)',
    'CREATE INDEX IF NOT EXISTS idx_ar_role_runs_session ON agent_room_role_runs(session_id, created_at)',
    'CREATE INDEX IF NOT EXISTS idx_ar_role_runs_task ON agent_room_role_runs(task_id)',
    'CREATE INDEX IF NOT EXISTS idx_ar_role_runs_upstream ON agent_room_role_runs(upstream_run_id)',
    'CREATE INDEX IF NOT EXISTS idx_ar_role_runs_role ON agent_room_role_runs(run_id, role)',
    // P3.4: run_events indexes (role_run_id added)
    'CREATE INDEX IF NOT EXISTS idx_ar_run_events_run ON agent_room_run_events(run_id, sequence)',
    'CREATE INDEX IF NOT EXISTS idx_ar_run_events_session ON agent_room_run_events(session_id, created_at)',
    'CREATE INDEX IF NOT EXISTS idx_ar_run_events_upstream ON agent_room_run_events(upstream_run_id)',
    'CREATE INDEX IF NOT EXISTS idx_ar_run_events_type ON agent_room_run_events(event_type)',
    'CREATE INDEX IF NOT EXISTS idx_ar_run_events_role_run ON agent_room_run_events(role_run_id)',
]

// ============================================================================
// Unified Initializer
// ============================================================================

import { ensureTable, getDb } from '../index'

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`
}

function sqlLiteral(value: string | number): string {
  if (typeof value === 'number') return String(value)
  return `'${value.replace(/'/g, "''")}'`
}

function usageSchemaDefinitionSql(): string {
  return Object.entries(USAGE_SCHEMA)
    .map(([col, def]) => `${quoteIdentifier(col)} ${def}`)
    .join(', ')
}

function sqliteTableExists(db: NonNullable<ReturnType<typeof getDb>>, tableName: string): boolean {
  return Boolean(db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(tableName))
}

function sqliteTableColumns(db: NonNullable<ReturnType<typeof getDb>>, tableName: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${quoteIdentifier(tableName)})`).all() as Array<{ name: string }>
  return new Set(rows.map(row => row.name))
}

function legacyUsageValueSql(
  sourceAlias: string,
  oldCols: Set<string>,
  col: string,
  defaults: Record<string, string | number>,
): string {
  const sourceColumn = (sourceCol: string) => `${quoteIdentifier(sourceAlias)}.${quoteIdentifier(sourceCol)}`

  if (col === 'created_at' && oldCols.has('updated_at')) {
    return `COALESCE(${sourceColumn('updated_at')}, ${sqlLiteral(defaults.created_at)})`
  }

  if (oldCols.has(col)) {
    return `COALESCE(${sourceColumn(col)}, ${sqlLiteral(defaults[col] ?? 0)})`
  }

  return sqlLiteral(defaults[col] ?? 0)
}

function insertUsageRowsFromLegacyTable(
  db: NonNullable<ReturnType<typeof getDb>>,
  oldTableName: string,
  oldCols: Set<string>,
  skipExistingSessionIds = false,
): void {
  const defaults: Record<string, string | number> = {
    session_id: '',
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    reasoning_tokens: 0,
    created_at: Date.now(),
    model: '',
    profile: 'default',
  }
  const sourceAlias = 'old_usage'
  const sourceColumn = (col: string) => `${quoteIdentifier(sourceAlias)}.${quoteIdentifier(col)}`
  const insertValues: string[] = []
  const selectValues: string[] = []

  for (const col of Object.keys(USAGE_SCHEMA)) {
    if (col === 'id') continue

    insertValues.push(quoteIdentifier(col))
    selectValues.push(legacyUsageValueSql(sourceAlias, oldCols, col, defaults))
  }

  const skipExistingWhere = skipExistingSessionIds && oldCols.has('session_id')
    ? ` WHERE NOT EXISTS (SELECT 1 FROM ${quoteIdentifier(USAGE_TABLE)} WHERE ${quoteIdentifier(USAGE_TABLE)}.${quoteIdentifier('session_id')} = ${sourceColumn('session_id')})`
    : ''

  db.exec(
    `INSERT INTO ${quoteIdentifier(USAGE_TABLE)} (${insertValues.join(', ')}) ` +
    `SELECT ${selectValues.join(', ')} FROM ${quoteIdentifier(oldTableName)} AS ${quoteIdentifier(sourceAlias)}` +
    skipExistingWhere,
  )
}

function recoverInterruptedUsageMigration(db: NonNullable<ReturnType<typeof getDb>>): void {
  const oldUsageTable = `${USAGE_TABLE}_old`
  if (!sqliteTableExists(db, oldUsageTable)) return

  const oldCols = sqliteTableColumns(db, oldUsageTable)
  db.exec('BEGIN')
  try {
    insertUsageRowsFromLegacyTable(db, oldUsageTable, oldCols, true)
    db.exec(`DROP TABLE ${quoteIdentifier(oldUsageTable)}`)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

/**
 * Initialize all Hermes SQLite tables with proper schemas.
 * This function creates tables and adds missing columns if schemas change.
 * Call this once at application bootstrap.
 */
export function initAllHermesTables(): void {
  const db = getDb()
  if (!db) return

  // Usage store - with special migration logic
  const tableExists = sqliteTableExists(db, USAGE_TABLE)
  const cols = tableExists
    ? db.prepare(`PRAGMA table_info(${quoteIdentifier(USAGE_TABLE)})`).all() as Array<{ name: string; pk: number }>
    : []
  const hasId = cols.some(c => c.name === 'id')
  if (!hasId && tableExists) {
    // Migration: if session_id is still PRIMARY KEY (no separate id column), recreate table
    const oldCols = new Set(cols.map(c => c.name))
    const oldUsageTable = `${USAGE_TABLE}_old`

    db.exec('BEGIN')
    try {
      db.exec(`ALTER TABLE ${quoteIdentifier(USAGE_TABLE)} RENAME TO ${quoteIdentifier(oldUsageTable)}`)
      db.exec(`CREATE TABLE ${quoteIdentifier(USAGE_TABLE)} (${usageSchemaDefinitionSql()})`)
      insertUsageRowsFromLegacyTable(db, oldUsageTable, oldCols)
      db.exec(`DROP TABLE ${quoteIdentifier(oldUsageTable)}`)
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  } else if (hasId) {
    recoverInterruptedUsageMigration(db)
  }
  ensureTable(USAGE_TABLE, USAGE_SCHEMA)

  // Session store
  ensureTable(SESSIONS_TABLE, SESSIONS_SCHEMA)
  ensureTable(MESSAGES_TABLE, MESSAGES_SCHEMA)
  db.exec(MESSAGES_INDEX)

  // Compression snapshot
  ensureTable(COMPRESSION_SNAPSHOT_TABLE, COMPRESSION_SNAPSHOT_SCHEMA)

  // Group chat - basic tables
  ensureTable(GC_ROOMS_TABLE, GC_ROOMS_SCHEMA)
  ensureTable(GC_MESSAGES_TABLE, GC_MESSAGES_SCHEMA)
  ensureTable(GC_CONTEXT_SNAPSHOTS_TABLE, GC_CONTEXT_SNAPSHOTS_SCHEMA)
  ensureTable(GC_PENDING_SESSION_DELETES_TABLE, GC_PENDING_SESSION_DELETES_SCHEMA)
  ensureTable(GC_SESSION_PROFILES_TABLE, GC_SESSION_PROFILES_SCHEMA)
  ensureTable(GC_AGENT_OVERRIDES_TABLE, GC_AGENT_OVERRIDES_SCHEMA)

  // Group chat - composite primary key tables
  // Create without PK first, then add PK constraint
  ensureTable(GC_ROOM_AGENTS_TABLE, GC_ROOM_AGENTS_SCHEMA)
  ensureTable(GC_ROOM_MEMBERS_TABLE, GC_ROOM_MEMBERS_SCHEMA)

  // Workspace tables
  ensureTable(GC_WORKSPACE_LAYOUTS_TABLE, GC_WORKSPACE_LAYOUTS_SCHEMA)
  ensureTable(GC_TASKS_TABLE, GC_TASKS_SCHEMA)
  ensureTable(GC_ARTIFACTS_TABLE, GC_ARTIFACTS_SCHEMA)

  // Add composite primary keys (SQLite doesn't support ADD PK, so we recreate if needed)
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS ${GC_ROOM_AGENTS_TABLE}_new (${Object.entries(GC_ROOM_AGENTS_SCHEMA).map(([k, v]) => `"${k}" ${v}`).join(', ')}, PRIMARY KEY (room_id, agent_id))`)
    db.exec(`INSERT OR IGNORE INTO ${GC_ROOM_AGENTS_TABLE}_new SELECT * FROM ${GC_ROOM_AGENTS_TABLE}`)
    db.exec(`DROP TABLE IF EXISTS ${GC_ROOM_AGENTS_TABLE}`)
    db.exec(`ALTER TABLE ${GC_ROOM_AGENTS_TABLE}_new RENAME TO ${GC_ROOM_AGENTS_TABLE}`)
  } catch {
    // Table already has correct schema or migration failed
  }

  try {
    db.exec(`CREATE TABLE IF NOT EXISTS ${GC_ROOM_MEMBERS_TABLE}_new (${Object.entries(GC_ROOM_MEMBERS_SCHEMA).map(([k, v]) => `"${k}" ${v}`).join(', ')}, PRIMARY KEY (room_id, user_id))`)
    db.exec(`INSERT OR IGNORE INTO ${GC_ROOM_MEMBERS_TABLE}_new SELECT * FROM ${GC_ROOM_MEMBERS_TABLE}`)
    db.exec(`DROP TABLE IF EXISTS ${GC_ROOM_MEMBERS_TABLE}`)
    db.exec(`ALTER TABLE ${GC_ROOM_MEMBERS_TABLE}_new RENAME TO ${GC_ROOM_MEMBERS_TABLE}`)
  } catch {
    // Table already has correct schema or migration failed
  }

  // Agent Room tables
  ensureTable(AR_SESSIONS_TABLE, AR_SESSIONS_SCHEMA)
  ensureTable(AR_TASKS_TABLE, AR_TASKS_SCHEMA)
  ensureTable(AR_REVIEWS_TABLE, AR_REVIEWS_SCHEMA)
  ensureTable(AR_MESSAGES_TABLE, AR_MESSAGES_SCHEMA)
  ensureTable(AR_WORKFLOW_EVENTS_TABLE, AR_WORKFLOW_EVENTS_SCHEMA)
  ensureTable(AR_ARTIFACTS_TABLE, AR_ARTIFACTS_SCHEMA)
  ensureTable(AR_ROLE_BINDINGS_TABLE, AR_ROLE_BINDINGS_SCHEMA)
  ensureTable(AR_RUNS_TABLE, AR_RUNS_SCHEMA)
  ensureTable(AR_ROLE_RUNS_TABLE, AR_ROLE_RUNS_SCHEMA)
  ensureTable(AR_RUN_EVENTS_TABLE, AR_RUN_EVENTS_SCHEMA)
  for (const idx of AR_INDEXES) {
    try { db.exec(idx) } catch { /* ignore */ }
  }
}
