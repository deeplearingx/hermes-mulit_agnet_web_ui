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
} from './schemas'

// ─── Domain Types (mirrored from services/hermes/agent-room/index.ts) ───

export interface AgentRoomSession {
    id: string
    name: string
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
        `INSERT INTO ${AR_SESSIONS_TABLE} (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`,
    ).run(session.id, session.name, session.createdAt, session.updatedAt)
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
    const rows = db.prepare(`SELECT * FROM ${AR_TASKS_TABLE} WHERE session_id = ? ORDER BY created_at ASC`).all(sessionId) as Array<Record<string, unknown>>
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
        `INSERT INTO ${AR_REVIEWS_TABLE} (id, session_id, task_id, reviewer_agent_id, status, comment, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(review.id, review.sessionId, review.taskId, review.reviewerAgentId, review.status, review.comment, review.createdAt)
}

export function listReviewsByTask(taskId: string): AgentRoomReview[] {
    const db = requireDb()
    const rows = db.prepare(`SELECT * FROM ${AR_REVIEWS_TABLE} WHERE task_id = ? ORDER BY created_at ASC`).all(taskId) as Array<Record<string, unknown>>
    return rows.map(mapReviewRow)
}

export function listReviewsBySession(sessionId: string): AgentRoomReview[] {
    const db = requireDb()
    const rows = db.prepare(`SELECT * FROM ${AR_REVIEWS_TABLE} WHERE session_id = ? ORDER BY created_at ASC`).all(sessionId) as Array<Record<string, unknown>>
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
    const rows = db.prepare(`SELECT * FROM ${AR_MESSAGES_TABLE} WHERE session_id = ? ORDER BY created_at ASC`).all(sessionId) as Array<Record<string, unknown>>
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
