/**
 * Agent Room SQLite persistence layer.
 * Provides CRUD operations for agent_room_* tables with row/domain mapping
 * and JSON field encoding/decoding.
 *
 * Design principles:
 * - Reuses getDb() pattern (reference: session-store.ts)
 * - JSON fields (metadata, payload) are JSON.parse on read, JSON.stringify on write
 * - runInTransaction() is ONLY for top-level business functions
 * - Bottom-level CRUD / helpers do NOT auto-open transactions
 * - No JSON fallback: if getDb() returns null, throws 'SQLite is not available'
 */

import { getDb } from '../index'
import {
    AR_SESSIONS_TABLE,
    AR_TASKS_TABLE,
    AR_REVIEWS_TABLE,
    AR_MESSAGES_TABLE,
    AR_WORKFLOW_EVENTS_TABLE,
    AR_ARTIFACTS_TABLE,
    AR_ROLE_BINDINGS_TABLE,
    AR_RUNS_TABLE,
    AR_ROLE_RUNS_TABLE,
    AR_RUN_EVENTS_TABLE,
} from './schemas'

// ─── Domain Types (mirrored from services/hermes/agent-room/index.ts) ───

export interface AgentRoomSession {
    id: string
    name: string
    autoDeliveryEnabled: boolean
    createdAt: string
    updatedAt: string
}

export interface AgentRoomTask {
    id: string
    sessionId: string
    title: string
    description: string
    assignedAgentId?: string
    status: string
    parentTaskId?: string
    revisionRound: number
    maxRevisionRounds: number
    createdAt: string
    updatedAt: string
}

export interface AgentRoomReview {
    id: string
    sessionId: string
    taskId: string
    reviewerAgentId: string
    status: 'passed' | 'rejected'
    comment: string
    metadata?: Record<string, unknown>
    createdAt: string
}

export interface AgentRoomMessage {
    id: string
    sessionId: string
    senderId: string
    senderName: string
    senderRole: string
    type: string
    content: string
    metadata?: Record<string, unknown>
    createdAt: string
}

export interface AgentRoomWorkflowEvent {
    id: string
    sessionId: string
    taskId: string
    type: string
    agentId: string
    agentRole: string
    payload?: Record<string, unknown>
    createdAt: string
}

export interface AgentRoomArtifact {
    id: string
    sessionId: string
    taskId: string
    name: string
    type: string
    content?: string
    metadata?: Record<string, unknown>
    createdAt: string
}

export interface AgentRoomRoleBinding {
    id: string
    sessionId: string
    role: string
    /** The Hermes profile name used for Gateway resolution. Maps to agent_id column. */
    profileName: string
    createdAt: string
}

export type AgentRoomRunStatus = 'queued' | 'running' | 'completed' | 'failed'

export interface AgentRoomRun {
    id: string
    sessionId: string
    taskId: string
    status: AgentRoomRunStatus
    upstreamRunId?: string
    runnerName: string
    errorMessage?: string
    startedAt?: string
    finishedAt?: string
    createdAt: string
    updatedAt: string
}

// P3.1: Role-level run status — includes 'skipped' for roles that were not executed
export type AgentRoomRoleRunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'skipped'

// P3.1: Per-role execution record within a workflow-level run
export interface AgentRoomRoleRun {
    id: string
    runId: string
    sessionId: string
    taskId: string
    role: string
    phase: string
    profileName?: string
    upstreamRunId?: string
    status: AgentRoomRoleRunStatus
    startedAt?: string
    finishedAt?: string
    errorMessage?: string
    metadata?: Record<string, unknown>
    createdAt: string
    updatedAt: string
}

// ─── JSON Helpers ──────────────────────────────────────────────

function encodeJson(value: unknown): string | null {
    if (value == null) return null
    return JSON.stringify(value)
}

function decodeJson<T>(value: unknown): T | undefined {
    if (value == null || value === '') return undefined
    try { return JSON.parse(String(value)) as T } catch { return undefined }
}

// ─── DB Accessor ───────────────────────────────────────────────

function requireDb() {
    const db = getDb()
    if (!db) throw new Error('SQLite is not available')
    return db
}

// ─── Row → Domain Mappers ──────────────────────────────────────

function mapSessionRow(row: Record<string, unknown>): AgentRoomSession {
    return {
        id: String(row.id),
        name: String(row.name),
        autoDeliveryEnabled: Number(row.auto_delivery_enabled) === 1,
        createdAt: String(row.created_at),
        updatedAt: String(row.updated_at),
    }
}

function mapTaskRow(row: Record<string, unknown>): AgentRoomTask {
    return {
        id: String(row.id),
        sessionId: String(row.session_id),
        title: String(row.title),
        description: String(row.description ?? ''),
        assignedAgentId: row.assigned_agent_id != null ? String(row.assigned_agent_id) : undefined,
        status: String(row.status),
        parentTaskId: row.parent_task_id != null ? String(row.parent_task_id) : undefined,
        revisionRound: Number(row.revision_round),
        maxRevisionRounds: Number(row.max_revision_rounds),
        createdAt: String(row.created_at),
        updatedAt: String(row.updated_at),
    }
}

function mapReviewRow(row: Record<string, unknown>): AgentRoomReview {
    return {
        id: String(row.id),
        sessionId: String(row.session_id),
        taskId: String(row.task_id),
        reviewerAgentId: String(row.reviewer_agent_id),
        status: String(row.status) as 'passed' | 'rejected',
        comment: String(row.comment ?? ''),
        metadata: decodeJson<Record<string, unknown>>(row.metadata),
        createdAt: String(row.created_at),
    }
}

function mapMessageRow(row: Record<string, unknown>): AgentRoomMessage {
    return {
        id: String(row.id),
        sessionId: String(row.session_id),
        senderId: String(row.sender_id),
        senderName: String(row.sender_name),
        senderRole: String(row.sender_role),
        type: String(row.type),
        content: String(row.content),
        metadata: decodeJson<Record<string, unknown>>(row.metadata),
        createdAt: String(row.created_at),
    }
}

function mapEventRow(row: Record<string, unknown>): AgentRoomWorkflowEvent {
    return {
        id: String(row.id),
        sessionId: String(row.session_id),
        taskId: String(row.task_id),
        type: String(row.type),
        agentId: String(row.agent_id),
        agentRole: String(row.agent_role),
        payload: decodeJson<Record<string, unknown>>(row.payload),
        createdAt: String(row.created_at),
    }
}

function mapArtifactRow(row: Record<string, unknown>): AgentRoomArtifact {
    return {
        id: String(row.id),
        sessionId: String(row.session_id),
        taskId: String(row.task_id),
        name: String(row.name),
        type: String(row.type),
        content: row.content != null ? String(row.content) : undefined,
        metadata: decodeJson<Record<string, unknown>>(row.metadata),
        createdAt: String(row.created_at),
    }
}

// ─── Transaction Helper ────────────────────────────────────────

/**
 * Run a function inside a SQLite transaction.
 * Only top-level business functions should call this.
 * Bottom-level CRUD / helpers must NOT auto-open transactions.
 */
export function runInTransaction(fn: () => void): void {
    const db = requireDb()
    db.exec('BEGIN')
    try {
        fn()
        db.exec('COMMIT')
    } catch (err) {
        db.exec('ROLLBACK')
        throw err
    }
}

// ─── Session CRUD ──────────────────────────────────────────────

export function createSession(session: AgentRoomSession): void {
    const db = requireDb()
    db.prepare(
        `INSERT INTO ${AR_SESSIONS_TABLE} (id, name, auto_delivery_enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
    ).run(session.id, session.name, session.autoDeliveryEnabled ? 1 : 0, session.createdAt, session.updatedAt)
}

export function getSession(id: string): AgentRoomSession | null {
    const db = requireDb()
    const row = db.prepare(`SELECT * FROM ${AR_SESSIONS_TABLE} WHERE id = ?`).get(id) as Record<string, unknown> | undefined
    return row ? mapSessionRow(row) : null
}

export function listSessions(): AgentRoomSession[] {
    const db = requireDb()
    const rows = db.prepare(`SELECT * FROM ${AR_SESSIONS_TABLE} ORDER BY updated_at DESC`).all() as Array<Record<string, unknown>>
    return rows.map(mapSessionRow)
}

export function updateSessionTimestamp(id: string): void {
    const db = requireDb()
    db.prepare(`UPDATE ${AR_SESSIONS_TABLE} SET updated_at = ? WHERE id = ?`).run(new Date().toISOString(), id)
}

export function updateSessionAutoDelivery(id: string, enabled: boolean): void {
    const db = requireDb()
    db.prepare(`UPDATE ${AR_SESSIONS_TABLE} SET auto_delivery_enabled = ?, updated_at = ? WHERE id = ?`).run(
        enabled ? 1 : 0,
        new Date().toISOString(),
        id,
    )
}

// ─── Task CRUD ─────────────────────────────────────────────────

export function createTask(task: AgentRoomTask): void {
    const db = requireDb()
    db.prepare(
        `INSERT INTO ${AR_TASKS_TABLE} (id, session_id, title, description, assigned_agent_id, status, parent_task_id, revision_round, max_revision_rounds, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
        task.id, task.sessionId, task.title, task.description,
        task.assignedAgentId ?? null, task.status,
        task.parentTaskId ?? null, task.revisionRound, task.maxRevisionRounds,
        task.createdAt, task.updatedAt,
    )
}

export function getTask(id: string): AgentRoomTask | null {
    const db = requireDb()
    const row = db.prepare(`SELECT * FROM ${AR_TASKS_TABLE} WHERE id = ?`).get(id) as Record<string, unknown> | undefined
    return row ? mapTaskRow(row) : null
}

export function listTasksBySession(sessionId: string): AgentRoomTask[] {
    const db = requireDb()
    const rows = db.prepare(`SELECT * FROM ${AR_TASKS_TABLE} WHERE session_id = ? ORDER BY created_at ASC, rowid ASC`).all(sessionId) as Array<Record<string, unknown>>
    return rows.map(mapTaskRow)
}

export function updateTask(task: AgentRoomTask): void {
    const db = requireDb()
    db.prepare(
        `UPDATE ${AR_TASKS_TABLE} SET session_id = ?, title = ?, description = ?, assigned_agent_id = ?, status = ?, parent_task_id = ?, revision_round = ?, max_revision_rounds = ?, updated_at = ? WHERE id = ?`,
    ).run(
        task.sessionId, task.title, task.description,
        task.assignedAgentId ?? null, task.status,
        task.parentTaskId ?? null, task.revisionRound, task.maxRevisionRounds,
        task.updatedAt, task.id,
    )
}

// ─── Review CRUD ───────────────────────────────────────────────

export function createReview(review: AgentRoomReview): void {
    const db = requireDb()
    db.prepare(
        `INSERT INTO ${AR_REVIEWS_TABLE} (id, session_id, task_id, reviewer_agent_id, status, comment, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(review.id, review.sessionId, review.taskId, review.reviewerAgentId, review.status, review.comment, encodeJson(review.metadata), review.createdAt)
}

export function listReviewsByTask(taskId: string): AgentRoomReview[] {
    const db = requireDb()
    const rows = db.prepare(`SELECT * FROM ${AR_REVIEWS_TABLE} WHERE task_id = ? ORDER BY created_at ASC, rowid ASC`).all(taskId) as Array<Record<string, unknown>>
    return rows.map(mapReviewRow)
}

export function listReviewsBySession(sessionId: string): AgentRoomReview[] {
    const db = requireDb()
    const rows = db.prepare(`SELECT * FROM ${AR_REVIEWS_TABLE} WHERE session_id = ? ORDER BY created_at ASC, rowid ASC`).all(sessionId) as Array<Record<string, unknown>>
    return rows.map(mapReviewRow)
}

// ─── Message CRUD ──────────────────────────────────────────────

export function createMessage(msg: AgentRoomMessage): void {
    const db = requireDb()
    db.prepare(
        `INSERT INTO ${AR_MESSAGES_TABLE} (id, session_id, sender_id, sender_name, sender_role, type, content, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
        msg.id, msg.sessionId, msg.senderId, msg.senderName,
        msg.senderRole, msg.type, msg.content,
        encodeJson(msg.metadata), msg.createdAt,
    )
}

export function listMessagesBySession(sessionId: string): AgentRoomMessage[] {
    const db = requireDb()
    const rows = db.prepare(`SELECT * FROM ${AR_MESSAGES_TABLE} WHERE session_id = ? ORDER BY created_at ASC, rowid ASC`).all(sessionId) as Array<Record<string, unknown>>
    return rows.map(mapMessageRow)
}

// ─── Workflow Event CRUD ───────────────────────────────────────

export function createWorkflowEvent(event: AgentRoomWorkflowEvent): void {
    const db = requireDb()
    db.prepare(
        `INSERT INTO ${AR_WORKFLOW_EVENTS_TABLE} (id, session_id, task_id, type, agent_id, agent_role, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
        event.id, event.sessionId, event.taskId, event.type,
        event.agentId, event.agentRole,
        encodeJson(event.payload), event.createdAt,
    )
}

export function listWorkflowEventsBySession(sessionId: string): AgentRoomWorkflowEvent[] {
    const db = requireDb()
    const rows = db.prepare(`SELECT * FROM ${AR_WORKFLOW_EVENTS_TABLE} WHERE session_id = ? ORDER BY created_at ASC, rowid ASC`).all(sessionId) as Array<Record<string, unknown>>
    return rows.map(mapEventRow)
}

// ─── Artifact CRUD ─────────────────────────────────────────────

export function createArtifact(artifact: AgentRoomArtifact): void {
    const db = requireDb()
    db.prepare(
        `INSERT INTO ${AR_ARTIFACTS_TABLE} (id, session_id, task_id, name, type, content, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
        artifact.id, artifact.sessionId, artifact.taskId,
        artifact.name, artifact.type,
        artifact.content ?? null, encodeJson(artifact.metadata),
        artifact.createdAt,
    )
}

export function getArtifact(id: string): AgentRoomArtifact | null {
    const db = requireDb()
    const row = db.prepare(`SELECT * FROM ${AR_ARTIFACTS_TABLE} WHERE id = ?`).get(id) as Record<string, unknown> | undefined
    return row ? mapArtifactRow(row) : null
}

export function listArtifactsBySession(sessionId: string): AgentRoomArtifact[] {
    const db = requireDb()
    const rows = db.prepare(`SELECT * FROM ${AR_ARTIFACTS_TABLE} WHERE session_id = ? ORDER BY created_at DESC, rowid DESC`).all(sessionId) as Array<Record<string, unknown>>
    return rows.map(mapArtifactRow)
}

export function listArtifactsByTask(taskId: string): AgentRoomArtifact[] {
    const db = requireDb()
    const rows = db.prepare(`SELECT * FROM ${AR_ARTIFACTS_TABLE} WHERE task_id = ? ORDER BY created_at DESC, rowid DESC`).all(taskId) as Array<Record<string, unknown>>
    return rows.map(mapArtifactRow)
}

export function deleteArtifact(id: string): void {
    const db = requireDb()
    db.prepare(`DELETE FROM ${AR_ARTIFACTS_TABLE} WHERE id = ?`).run(id)
}

export function deleteArtifactsByTask(taskId: string): void {
    const db = requireDb()
    db.prepare(`DELETE FROM ${AR_ARTIFACTS_TABLE} WHERE task_id = ?`).run(taskId)
}

export function deleteArtifactsBySession(sessionId: string): void {
    const db = requireDb()
    db.prepare(`DELETE FROM ${AR_ARTIFACTS_TABLE} WHERE session_id = ?`).run(sessionId)
}

// ─── Role Bindings ─────────────────────────────────────────────

function mapRoleBindingRow(row: Record<string, unknown>): AgentRoomRoleBinding {
    return {
        id: String(row.id),
        sessionId: String(row.session_id),
        role: String(row.role),
        profileName: String(row.agent_id),
        createdAt: String(row.created_at),
    }
}

export function createRoleBinding(binding: AgentRoomRoleBinding): void {
    const db = requireDb()
    db.prepare(`INSERT INTO ${AR_ROLE_BINDINGS_TABLE} (id, session_id, role, agent_id, created_at) VALUES (?, ?, ?, ?, ?)`)
        .run(binding.id, binding.sessionId, binding.role, binding.profileName, binding.createdAt)
}

export function getRoleBinding(id: string): AgentRoomRoleBinding | null {
    const db = requireDb()
    const row = db.prepare(`SELECT * FROM ${AR_ROLE_BINDINGS_TABLE} WHERE id = ?`).get(id) as Record<string, unknown> | undefined
    return row ? mapRoleBindingRow(row) : null
}

export function listRoleBindingsBySession(sessionId: string): AgentRoomRoleBinding[] {
    const db = requireDb()
    const rows = db.prepare(`SELECT * FROM ${AR_ROLE_BINDINGS_TABLE} WHERE session_id = ? ORDER BY created_at`).all(sessionId) as Record<string, unknown>[]
    return rows.map(mapRoleBindingRow)
}

export function getRoleBindingBySessionAndRole(sessionId: string, role: string): AgentRoomRoleBinding | null {
    const db = requireDb()
    const row = db.prepare(`SELECT * FROM ${AR_ROLE_BINDINGS_TABLE} WHERE session_id = ? AND role = ?`).get(sessionId, role) as Record<string, unknown> | undefined
    return row ? mapRoleBindingRow(row) : null
}

export function updateRoleBinding(binding: AgentRoomRoleBinding): void {
    const db = requireDb()
    db.prepare(`UPDATE ${AR_ROLE_BINDINGS_TABLE} SET agent_id = ? WHERE id = ?`)
        .run(binding.profileName, binding.id)
}

export function deleteRoleBinding(id: string): void {
    const db = requireDb()
    db.prepare(`DELETE FROM ${AR_ROLE_BINDINGS_TABLE} WHERE id = ?`).run(id)
}

export function deleteRoleBindingsBySession(sessionId: string): void {
    const db = requireDb()
    db.prepare(`DELETE FROM ${AR_ROLE_BINDINGS_TABLE} WHERE session_id = ?`).run(sessionId)
}

// ─── Run CRUD ───────────────────────────────────────────────────

function mapRunRow(row: Record<string, unknown>): AgentRoomRun {
    return {
        id: String(row.id),
        sessionId: String(row.session_id),
        taskId: String(row.task_id),
        status: String(row.status) as AgentRoomRunStatus,
        upstreamRunId: row.upstream_run_id != null ? String(row.upstream_run_id) : undefined,
        runnerName: String(row.runner_name),
        errorMessage: row.error_message != null ? String(row.error_message) : undefined,
        startedAt: row.started_at != null ? String(row.started_at) : undefined,
        finishedAt: row.finished_at != null ? String(row.finished_at) : undefined,
        createdAt: String(row.created_at),
        updatedAt: String(row.updated_at),
    }
}

export function createRun(run: AgentRoomRun): void {
    const db = requireDb()
    db.prepare(
        `INSERT INTO ${AR_RUNS_TABLE} (id, session_id, task_id, status, upstream_run_id, runner_name, error_message, started_at, finished_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
        run.id, run.sessionId, run.taskId, run.status,
        run.upstreamRunId ?? null, run.runnerName,
        run.errorMessage ?? null, run.startedAt ?? null, run.finishedAt ?? null,
        run.createdAt, run.updatedAt,
    )
}

export function getRun(id: string): AgentRoomRun | null {
    const db = requireDb()
    const row = db.prepare(`SELECT * FROM ${AR_RUNS_TABLE} WHERE id = ?`).get(id) as Record<string, unknown> | undefined
    return row ? mapRunRow(row) : null
}

export function updateRun(run: AgentRoomRun): void {
    const db = requireDb()
    db.prepare(
        `UPDATE ${AR_RUNS_TABLE} SET status = ?, upstream_run_id = ?, runner_name = ?, error_message = ?, started_at = ?, finished_at = ?, updated_at = ? WHERE id = ?`,
    ).run(
        run.status, run.upstreamRunId ?? null, run.runnerName,
        run.errorMessage ?? null, run.startedAt ?? null, run.finishedAt ?? null,
        run.updatedAt, run.id,
    )
}

export function listRunsBySession(sessionId: string): AgentRoomRun[] {
    const db = requireDb()
    const rows = db.prepare(`SELECT * FROM ${AR_RUNS_TABLE} WHERE session_id = ? ORDER BY created_at DESC, rowid DESC`).all(sessionId) as Array<Record<string, unknown>>
    return rows.map(mapRunRow)
}

export function listRunsByTask(taskId: string): AgentRoomRun[] {
    const db = requireDb()
    const rows = db.prepare(`SELECT * FROM ${AR_RUNS_TABLE} WHERE task_id = ? ORDER BY created_at DESC, rowid DESC`).all(taskId) as Array<Record<string, unknown>>
    return rows.map(mapRunRow)
}

/**
 * Check whether a task has any active (queued or running) run in the database.
 * Used as a DB-level guard against concurrent workflow starts.
 */
export function hasActiveRunForTask(taskId: string): boolean {
    const db = requireDb()
    const row = db.prepare(
        `SELECT 1 FROM ${AR_RUNS_TABLE} WHERE task_id = ? AND status IN ('queued', 'running') LIMIT 1`
    ).get(taskId)
    return !!row
}

export function findByUpstreamRunId(upstreamRunId: string): AgentRoomRun | null {
    const db = requireDb()
    const row = db.prepare(`SELECT * FROM ${AR_RUNS_TABLE} WHERE upstream_run_id = ?`).get(upstreamRunId) as Record<string, unknown> | undefined
    return row ? mapRunRow(row) : null
}

export function deleteRunsBySession(sessionId: string): void {
    const db = requireDb()
    db.prepare(`DELETE FROM ${AR_RUNS_TABLE} WHERE session_id = ?`).run(sessionId)
}

export function deleteRunsByTask(taskId: string): void {
    const db = requireDb()
    db.prepare(`DELETE FROM ${AR_RUNS_TABLE} WHERE task_id = ?`).run(taskId)
}

/**
 * Recover stale runs left in queued/running state from a previous server session.
 * Called once at bootstrap to ensure no orphaned active runs block new workflows.
 */
export function recoverStaleRuns(): number {
    const db = requireDb()
    const now = new Date().toISOString()
    const result = db.prepare(
        `UPDATE ${AR_RUNS_TABLE} SET status = 'failed', error_message = 'Server restarted — stale run recovered', finished_at = ?, updated_at = ? WHERE status IN ('queued', 'running')`
    ).run(now, now)
    return result.changes
}

/**
 * Recover stale role runs left in queued/running state from a previous server session.
 */
export function recoverStaleRoleRuns(): number {
    const db = requireDb()
    const now = new Date().toISOString()
    const result = db.prepare(
        `UPDATE ${AR_ROLE_RUNS_TABLE} SET status = 'failed', error_message = 'Server restarted — stale role run recovered', finished_at = ?, updated_at = ? WHERE status IN ('queued', 'running')`
    ).run(now, now)
    return result.changes
}

// ─── Role Run CRUD (P3.2) ──────────────────────────────────────

function mapRoleRunRow(row: Record<string, unknown>): AgentRoomRoleRun {
    return {
        id: String(row.id),
        runId: String(row.run_id),
        sessionId: String(row.session_id),
        taskId: String(row.task_id),
        role: String(row.role),
        phase: String(row.phase),
        profileName: row.profile_name != null ? String(row.profile_name) : undefined,
        upstreamRunId: row.upstream_run_id != null ? String(row.upstream_run_id) : undefined,
        status: String(row.status) as AgentRoomRoleRunStatus,
        startedAt: row.started_at != null ? String(row.started_at) : undefined,
        finishedAt: row.finished_at != null ? String(row.finished_at) : undefined,
        errorMessage: row.error_message != null ? String(row.error_message) : undefined,
        metadata: decodeJson<Record<string, unknown>>(row.metadata),
        createdAt: String(row.created_at),
        updatedAt: String(row.updated_at),
    }
}

export function createRoleRun(roleRun: AgentRoomRoleRun): void {
    const db = requireDb()
    db.prepare(
        `INSERT INTO ${AR_ROLE_RUNS_TABLE} (id, run_id, session_id, task_id, role, phase, profile_name, upstream_run_id, status, started_at, finished_at, error_message, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
        roleRun.id, roleRun.runId, roleRun.sessionId, roleRun.taskId,
        roleRun.role, roleRun.phase,
        roleRun.profileName ?? null, roleRun.upstreamRunId ?? null,
        roleRun.status, roleRun.startedAt ?? null, roleRun.finishedAt ?? null,
        roleRun.errorMessage ?? null, encodeJson(roleRun.metadata),
        roleRun.createdAt, roleRun.updatedAt,
    )
}

export function updateRoleRun(roleRun: AgentRoomRoleRun): void {
    const db = requireDb()
    db.prepare(
        `UPDATE ${AR_ROLE_RUNS_TABLE} SET status = ?, upstream_run_id = ?, profile_name = ?, started_at = ?, finished_at = ?, error_message = ?, metadata = ?, updated_at = ? WHERE id = ?`,
    ).run(
        roleRun.status, roleRun.upstreamRunId ?? null, roleRun.profileName ?? null,
        roleRun.startedAt ?? null, roleRun.finishedAt ?? null,
        roleRun.errorMessage ?? null, encodeJson(roleRun.metadata),
        roleRun.updatedAt, roleRun.id,
    )
}

export function getRoleRun(id: string): AgentRoomRoleRun | null {
    const db = requireDb()
    const row = db.prepare(`SELECT * FROM ${AR_ROLE_RUNS_TABLE} WHERE id = ?`).get(id) as Record<string, unknown> | undefined
    return row ? mapRoleRunRow(row) : null
}

export function getRoleRunByRunAndRole(runId: string, role: string): AgentRoomRoleRun | null {
    const db = requireDb()
    const row = db.prepare(`SELECT * FROM ${AR_ROLE_RUNS_TABLE} WHERE run_id = ? AND role = ?`).get(runId, role) as Record<string, unknown> | undefined
    return row ? mapRoleRunRow(row) : null
}

export function listRoleRunsByRun(runId: string): AgentRoomRoleRun[] {
    const db = requireDb()
    const rows = db.prepare(`SELECT * FROM ${AR_ROLE_RUNS_TABLE} WHERE run_id = ? ORDER BY created_at ASC, rowid ASC`).all(runId) as Array<Record<string, unknown>>
    return rows.map(mapRoleRunRow)
}

export function listRoleRunsByTask(taskId: string): AgentRoomRoleRun[] {
    const db = requireDb()
    const rows = db.prepare(`SELECT * FROM ${AR_ROLE_RUNS_TABLE} WHERE task_id = ? ORDER BY created_at ASC, rowid ASC`).all(taskId) as Array<Record<string, unknown>>
    return rows.map(mapRoleRunRow)
}

export function deleteRoleRunsByRun(runId: string): void {
    const db = requireDb()
    db.prepare(`DELETE FROM ${AR_ROLE_RUNS_TABLE} WHERE run_id = ?`).run(runId)
}

export function deleteRoleRunsBySession(sessionId: string): void {
    const db = requireDb()
    db.prepare(`DELETE FROM ${AR_ROLE_RUNS_TABLE} WHERE session_id = ?`).run(sessionId)
}

// ─── Run Event CRUD ─────────────────────────────────────────────

// P3.4: Added roleRunId for optional role-level event correlation
export interface AgentRoomRunEvent {
    id: string
    runId: string
    sessionId: string
    taskId: string
    upstreamRunId?: string
    roleRunId?: string
    source: string
    sequence: number
    eventType: string
    payload?: Record<string, unknown>
    createdAt: string
}

function mapRunEventRow(row: Record<string, unknown>): AgentRoomRunEvent {
    return {
        id: String(row.id),
        runId: String(row.run_id),
        sessionId: String(row.session_id),
        taskId: String(row.task_id),
        upstreamRunId: row.upstream_run_id != null ? String(row.upstream_run_id) : undefined,
        roleRunId: row.role_run_id != null ? String(row.role_run_id) : undefined,
        source: String(row.source),
        sequence: Number(row.sequence),
        eventType: String(row.event_type),
        payload: decodeJson<Record<string, unknown>>(row.payload),
        createdAt: String(row.created_at),
    }
}

export function createRunEvent(event: AgentRoomRunEvent): void {
    const db = requireDb()
    db.prepare(
        `INSERT INTO ${AR_RUN_EVENTS_TABLE} (id, run_id, session_id, task_id, upstream_run_id, role_run_id, source, sequence, event_type, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
        event.id, event.runId, event.sessionId, event.taskId,
        event.upstreamRunId ?? null, event.roleRunId ?? null,
        event.source, event.sequence,
        event.eventType, encodeJson(event.payload), event.createdAt,
    )
}

export function listRunEventsByRun(runId: string): AgentRoomRunEvent[] {
    const db = requireDb()
    const rows = db.prepare(
        `SELECT * FROM ${AR_RUN_EVENTS_TABLE} WHERE run_id = ? ORDER BY sequence ASC, rowid ASC`,
    ).all(runId) as Array<Record<string, unknown>>
    return rows.map(mapRunEventRow)
}

export function listRunEventsBySession(sessionId: string): AgentRoomRunEvent[] {
    const db = requireDb()
    const rows = db.prepare(
        `SELECT * FROM ${AR_RUN_EVENTS_TABLE} WHERE session_id = ? ORDER BY created_at ASC, rowid ASC`,
    ).all(sessionId) as Array<Record<string, unknown>>
    return rows.map(mapRunEventRow)
}

export function findRunEventByUpstreamRunId(upstreamRunId: string): AgentRoomRunEvent | null {
    const db = requireDb()
    const row = db.prepare(
        `SELECT * FROM ${AR_RUN_EVENTS_TABLE} WHERE upstream_run_id = ? LIMIT 1`,
    ).get(upstreamRunId) as Record<string, unknown> | undefined
    return row ? mapRunEventRow(row) : null
}

export function getNextRunEventSequence(runId: string): number {
    const db = requireDb()
    const row = db.prepare(
        `SELECT COALESCE(MAX(sequence), 0) + 1 AS next_seq FROM ${AR_RUN_EVENTS_TABLE} WHERE run_id = ?`,
    ).get(runId) as { next_seq: number } | undefined
    return row?.next_seq ?? 1
}

export function deleteRunEventsByRun(runId: string): void {
    const db = requireDb()
    db.prepare(`DELETE FROM ${AR_RUN_EVENTS_TABLE} WHERE run_id = ?`).run(runId)
}

export function deleteRunEventsBySession(sessionId: string): void {
    const db = requireDb()
    db.prepare(`DELETE FROM ${AR_RUN_EVENTS_TABLE} WHERE session_id = ?`).run(sessionId)
}

// ─── Cascade Delete ─────────────────────────────────────────────

/**
 * Delete a session and all its child records (tasks, reviews, messages, workflow events, role bindings).
 * Caller is responsible for transaction management.
 */
export function deleteSessionCascade(sessionId: string): void {
    const db = requireDb()
    // Delete in dependency order: reviews → workflow_events → run_events → role_runs → artifacts → runs → role_bindings → messages → tasks → session
    db.prepare(`DELETE FROM ${AR_REVIEWS_TABLE} WHERE session_id = ?`).run(sessionId)
    db.prepare(`DELETE FROM ${AR_WORKFLOW_EVENTS_TABLE} WHERE session_id = ?`).run(sessionId)
    db.prepare(`DELETE FROM ${AR_RUN_EVENTS_TABLE} WHERE session_id = ?`).run(sessionId)
    db.prepare(`DELETE FROM ${AR_ROLE_RUNS_TABLE} WHERE session_id = ?`).run(sessionId)
    db.prepare(`DELETE FROM ${AR_ARTIFACTS_TABLE} WHERE session_id = ?`).run(sessionId)
    db.prepare(`DELETE FROM ${AR_RUNS_TABLE} WHERE session_id = ?`).run(sessionId)
    db.prepare(`DELETE FROM ${AR_ROLE_BINDINGS_TABLE} WHERE session_id = ?`).run(sessionId)
    db.prepare(`DELETE FROM ${AR_MESSAGES_TABLE} WHERE session_id = ?`).run(sessionId)
    db.prepare(`DELETE FROM ${AR_TASKS_TABLE} WHERE session_id = ?`).run(sessionId)
    db.prepare(`DELETE FROM ${AR_SESSIONS_TABLE} WHERE id = ?`).run(sessionId)
}

/**
 * Delete a task and its child records (reviews, workflow events, task-scoped messages).
 * Task-scoped messages are identified by metadata.taskId === taskId (no SQL LIKE).
 * Caller is responsible for transaction management.
 */
export function deleteTaskCascade(sessionId: string, taskId: string): void {
    const db = requireDb()
    // Delete task reviews
    db.prepare(`DELETE FROM ${AR_REVIEWS_TABLE} WHERE task_id = ?`).run(taskId)
    // Delete task workflow events
    db.prepare(`DELETE FROM ${AR_WORKFLOW_EVENTS_TABLE} WHERE task_id = ?`).run(taskId)
    // Delete task run events
    db.prepare(`DELETE FROM ${AR_RUN_EVENTS_TABLE} WHERE task_id = ?`).run(taskId)
    // Delete task role runs
    db.prepare(`DELETE FROM ${AR_ROLE_RUNS_TABLE} WHERE task_id = ?`).run(taskId)
    // Delete task artifacts
    db.prepare(`DELETE FROM ${AR_ARTIFACTS_TABLE} WHERE task_id = ?`).run(taskId)
    // Delete task runs
    db.prepare(`DELETE FROM ${AR_RUNS_TABLE} WHERE task_id = ?`).run(taskId)
    // Delete task-scoped messages: list all session messages, filter by metadata.taskId, delete by id
    const sessionMessages = listMessagesBySession(sessionId)
    const stmt = db.prepare(`DELETE FROM ${AR_MESSAGES_TABLE} WHERE id = ?`)
    for (const msg of sessionMessages) {
        if (msg.metadata?.taskId === taskId) {
            stmt.run(msg.id)
        }
    }
    // Delete the task itself
    db.prepare(`DELETE FROM ${AR_TASKS_TABLE} WHERE id = ?`).run(taskId)
}
