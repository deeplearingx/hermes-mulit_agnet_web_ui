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

describe('Agent Room Role Bindings', () => {
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
        for (const idx of schemas.AR_INDEXES) {
            try { db.exec(idx) } catch { /* ignore */ }
        }
    })

    afterEach(() => {
        db?.close()
        db = null
    })

    // ─── Store Layer CRUD ────────────────────────────────────────

    describe('store CRUD', () => {
        it('createRoleBinding and getRoleBinding', async () => {
            const store = await import('../../packages/server/src/db/hermes/agent-room-store')
            store.createSession({ id: 'sess-1', name: 'test', createdAt: '2025-01-01T00:00:00Z', updatedAt: '2025-01-01T00:00:00Z' })

            const binding = { id: 'rb-1', sessionId: 'sess-1', role: 'developer', profileName: 'agent-a', createdAt: '2025-01-01T00:00:00Z' }
            store.createRoleBinding(binding)

            const fetched = store.getRoleBinding('rb-1')
            expect(fetched).toEqual(binding)
        })

        it('listRoleBindingsBySession returns all bindings for a session', async () => {
            const store = await import('../../packages/server/src/db/hermes/agent-room-store')
            store.createSession({ id: 'sess-1', name: 'test', createdAt: '2025-01-01T00:00:00Z', updatedAt: '2025-01-01T00:00:00Z' })

            store.createRoleBinding({ id: 'rb-1', sessionId: 'sess-1', role: 'developer', profileName: 'agent-a', createdAt: '2025-01-01T00:00:00Z' })
            store.createRoleBinding({ id: 'rb-2', sessionId: 'sess-1', role: 'reviewer', profileName: 'agent-b', createdAt: '2025-01-01T00:00:01Z' })

            const bindings = store.listRoleBindingsBySession('sess-1')
            expect(bindings).toHaveLength(2)
            expect(bindings[0].role).toBe('developer')
            expect(bindings[1].role).toBe('reviewer')
        })

        it('getRoleBindingBySessionAndRole returns specific binding', async () => {
            const store = await import('../../packages/server/src/db/hermes/agent-room-store')
            store.createSession({ id: 'sess-1', name: 'test', createdAt: '2025-01-01T00:00:00Z', updatedAt: '2025-01-01T00:00:00Z' })

            store.createRoleBinding({ id: 'rb-1', sessionId: 'sess-1', role: 'developer', profileName: 'agent-a', createdAt: '2025-01-01T00:00:00Z' })

            const binding = store.getRoleBindingBySessionAndRole('sess-1', 'developer')
            expect(binding).not.toBeNull()
            expect(binding!.profileName).toBe('agent-a')

            const missing = store.getRoleBindingBySessionAndRole('sess-1', 'reviewer')
            expect(missing).toBeNull()
        })

        it('updateRoleBinding changes profileName', async () => {
            const store = await import('../../packages/server/src/db/hermes/agent-room-store')
            store.createSession({ id: 'sess-1', name: 'test', createdAt: '2025-01-01T00:00:00Z', updatedAt: '2025-01-01T00:00:00Z' })

            store.createRoleBinding({ id: 'rb-1', sessionId: 'sess-1', role: 'developer', profileName: 'agent-a', createdAt: '2025-01-01T00:00:00Z' })
            store.updateRoleBinding({ id: 'rb-1', sessionId: 'sess-1', role: 'developer', profileName: 'agent-z', createdAt: '2025-01-01T00:00:00Z' })

            const updated = store.getRoleBinding('rb-1')
            expect(updated!.profileName).toBe('agent-z')
        })

        it('deleteRoleBinding removes specific binding', async () => {
            const store = await import('../../packages/server/src/db/hermes/agent-room-store')
            store.createSession({ id: 'sess-1', name: 'test', createdAt: '2025-01-01T00:00:00Z', updatedAt: '2025-01-01T00:00:00Z' })

            store.createRoleBinding({ id: 'rb-1', sessionId: 'sess-1', role: 'developer', profileName: 'agent-a', createdAt: '2025-01-01T00:00:00Z' })
            store.deleteRoleBinding('rb-1')

            expect(store.getRoleBinding('rb-1')).toBeNull()
        })

        it('deleteRoleBindingsBySession removes all bindings for a session', async () => {
            const store = await import('../../packages/server/src/db/hermes/agent-room-store')
            store.createSession({ id: 'sess-1', name: 'test', createdAt: '2025-01-01T00:00:00Z', updatedAt: '2025-01-01T00:00:00Z' })

            store.createRoleBinding({ id: 'rb-1', sessionId: 'sess-1', role: 'developer', profileName: 'agent-a', createdAt: '2025-01-01T00:00:00Z' })
            store.createRoleBinding({ id: 'rb-2', sessionId: 'sess-1', role: 'reviewer', profileName: 'agent-b', createdAt: '2025-01-01T00:00:01Z' })
            store.deleteRoleBindingsBySession('sess-1')

            expect(store.listRoleBindingsBySession('sess-1')).toHaveLength(0)
        })

        it('getRoleBinding returns null for non-existent id', async () => {
            const store = await import('../../packages/server/src/db/hermes/agent-room-store')
            expect(store.getRoleBinding('non-existent')).toBeNull()
        })
    })

    // ─── Cascade Delete ──────────────────────────────────────────

    describe('cascade delete', () => {
        it('deleteSessionCascade removes role bindings', async () => {
            const store = await import('../../packages/server/src/db/hermes/agent-room-store')
            store.createSession({ id: 'sess-1', name: 'test', createdAt: '2025-01-01T00:00:00Z', updatedAt: '2025-01-01T00:00:00Z' })

            store.createRoleBinding({ id: 'rb-1', sessionId: 'sess-1', role: 'developer', profileName: 'agent-a', createdAt: '2025-01-01T00:00:00Z' })
            store.createRoleBinding({ id: 'rb-2', sessionId: 'sess-1', role: 'reviewer', profileName: 'agent-b', createdAt: '2025-01-01T00:00:01Z' })

            store.deleteSessionCascade('sess-1')

            expect(store.getRoleBinding('rb-1')).toBeNull()
            expect(store.getRoleBinding('rb-2')).toBeNull()
        })

        it('deleteSessionCascade does not remove role bindings from other sessions', async () => {
            const store = await import('../../packages/server/src/db/hermes/agent-room-store')
            store.createSession({ id: 'sess-1', name: 'test-1', createdAt: '2025-01-01T00:00:00Z', updatedAt: '2025-01-01T00:00:00Z' })
            store.createSession({ id: 'sess-2', name: 'test-2', createdAt: '2025-01-01T00:00:00Z', updatedAt: '2025-01-01T00:00:00Z' })

            store.createRoleBinding({ id: 'rb-1', sessionId: 'sess-1', role: 'developer', profileName: 'agent-a', createdAt: '2025-01-01T00:00:00Z' })
            store.createRoleBinding({ id: 'rb-2', sessionId: 'sess-2', role: 'developer', profileName: 'agent-b', createdAt: '2025-01-01T00:00:01Z' })

            store.deleteSessionCascade('sess-1')

            expect(store.getRoleBinding('rb-1')).toBeNull()
            expect(store.getRoleBinding('rb-2')).not.toBeNull()
        })
    })

    // ─── Service Layer ───────────────────────────────────────────

    describe('service API', () => {
        it('createRoleBinding creates and returns binding', async () => {
            const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
            svc.createSession('test-session')
            const sessions = svc.listSessions()
            const sessionId = sessions[0].id

            const binding = svc.createRoleBinding(sessionId, 'developer', 'agent-alpha')
            expect(binding.sessionId).toBe(sessionId)
            expect(binding.role).toBe('developer')
            expect(binding.profileName).toBe('agent-alpha')
            expect(binding.id).toBeDefined()
            expect(binding.createdAt).toBeDefined()
        })

        it('createRoleBinding throws on duplicate session+role', async () => {
            const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
            svc.createSession('test-session')
            const sessions = svc.listSessions()
            const sessionId = sessions[0].id

            svc.createRoleBinding(sessionId, 'developer', 'agent-alpha')
            expect(() => svc.createRoleBinding(sessionId, 'developer', 'agent-beta'))
                .toThrow('Role binding already exists')
        })

        it('createRoleBinding throws on non-existent session', async () => {
            const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
            expect(() => svc.createRoleBinding('non-existent', 'developer', 'agent-alpha'))
                .toThrow('Session not found')
        })

        it('listRoleBindings returns all bindings for session', async () => {
            const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
            svc.createSession('test-session')
            const sessions = svc.listSessions()
            const sessionId = sessions[0].id

            svc.createRoleBinding(sessionId, 'developer', 'agent-alpha')
            svc.createRoleBinding(sessionId, 'reviewer', 'agent-beta')

            const bindings = svc.listRoleBindings(sessionId)
            expect(bindings).toHaveLength(2)
            expect(bindings.map(b => b.role).sort()).toEqual(['developer', 'reviewer'])
        })

        it('getRoleBindingForAgent returns binding for specific role', async () => {
            const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
            svc.createSession('test-session')
            const sessions = svc.listSessions()
            const sessionId = sessions[0].id

            svc.createRoleBinding(sessionId, 'developer', 'agent-alpha')

            const binding = svc.getRoleBindingForAgent(sessionId, 'developer')
            expect(binding).not.toBeNull()
            expect(binding!.profileName).toBe('agent-alpha')

            const missing = svc.getRoleBindingForAgent(sessionId, 'reviewer')
            expect(missing).toBeNull()
        })

        it('updateRoleBinding changes profileName', async () => {
            const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
            svc.createSession('test-session')
            const sessions = svc.listSessions()
            const sessionId = sessions[0].id

            const binding = svc.createRoleBinding(sessionId, 'developer', 'agent-alpha')
            const updated = svc.updateRoleBinding(sessionId, binding.id, 'agent-zeta')

            expect(updated.profileName).toBe('agent-zeta')
            expect(updated.id).toBe(binding.id)
        })

        it('updateRoleBinding throws on non-existent binding', async () => {
            const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
            svc.createSession('test-session')
            const sessions = svc.listSessions()
            const sessionId = sessions[0].id

            expect(() => svc.updateRoleBinding(sessionId, 'non-existent', 'agent-zeta'))
                .toThrow('Role binding not found')
        })

        it('updateRoleBinding throws on session mismatch', async () => {
            const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
            svc.createSession('session-a')
            svc.createSession('session-b')
            const sessions = svc.listSessions()
            const sessionA = sessions.find(s => s.name === 'session-a')!
            const sessionB = sessions.find(s => s.name === 'session-b')!

            const binding = svc.createRoleBinding(sessionA.id, 'developer', 'agent-alpha')
            expect(() => svc.updateRoleBinding(sessionB.id, binding.id, 'agent-zeta'))
                .toThrow(/Role binding belongs to session/)
        })

        it('deleteRoleBinding removes binding', async () => {
            const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
            svc.createSession('test-session')
            const sessions = svc.listSessions()
            const sessionId = sessions[0].id

            const binding = svc.createRoleBinding(sessionId, 'developer', 'agent-alpha')
            svc.deleteRoleBinding(sessionId, binding.id)

            expect(svc.getRoleBindingForAgent(sessionId, 'developer')).toBeNull()
        })

        it('deleteRoleBinding throws on non-existent binding', async () => {
            const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
            svc.createSession('test-session')
            const sessions = svc.listSessions()
            const sessionId = sessions[0].id

            expect(() => svc.deleteRoleBinding(sessionId, 'non-existent'))
                .toThrow('Role binding not found')
        })

        it('deleteRoleBinding throws on session mismatch', async () => {
            const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
            svc.createSession('session-a')
            svc.createSession('session-b')
            const sessions = svc.listSessions()
            const sessionA = sessions.find(s => s.name === 'session-a')!
            const sessionB = sessions.find(s => s.name === 'session-b')!

            const binding = svc.createRoleBinding(sessionA.id, 'developer', 'agent-alpha')
            expect(() => svc.deleteRoleBinding(sessionB.id, binding.id))
                .toThrow(/Role binding belongs to session/)
        })

        it('deleteSession removes all role bindings', async () => {
            const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
            svc.createSession('test-session')
            const sessions = svc.listSessions()
            const sessionId = sessions[0].id

            svc.createRoleBinding(sessionId, 'developer', 'agent-alpha')
            svc.createRoleBinding(sessionId, 'reviewer', 'agent-beta')

            svc.deleteSession(sessionId)

            const store = await import('../../packages/server/src/db/hermes/agent-room-store')
            expect(store.listRoleBindingsBySession(sessionId)).toHaveLength(0)
        })
    })

    // ─── setRoleBinding upsert ───────────────────────────────────

    describe('setRoleBinding upsert', () => {
        it('creates binding when none exists', async () => {
            const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
            svc.createSession('test-session')
            const sessions = svc.listSessions()
            const sessionId = sessions[0].id

            const binding = svc.setRoleBinding(sessionId, 'developer', 'agent-alpha')
            expect(binding.profileName).toBe('agent-alpha')
            expect(binding.role).toBe('developer')
            expect(binding.id).toBeDefined()
        })

        it('updates profileName when binding already exists', async () => {
            const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
            svc.createSession('test-session')
            const sessions = svc.listSessions()
            const sessionId = sessions[0].id

            const first = svc.setRoleBinding(sessionId, 'developer', 'agent-alpha')
            const second = svc.setRoleBinding(sessionId, 'developer', 'agent-zeta')

            expect(second.id).toBe(first.id)
            expect(second.profileName).toBe('agent-zeta')

            const bindings = svc.listRoleBindings(sessionId)
            expect(bindings).toHaveLength(1)
            expect(bindings[0].profileName).toBe('agent-zeta')
        })

        it('throws on non-existent session', async () => {
            const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
            expect(() => svc.setRoleBinding('non-existent', 'developer', 'agent-alpha'))
                .toThrow('Session not found')
        })
    })

    // ─── Unique Constraint ───────────────────────────────────────

    describe('unique constraint', () => {
        it('rejects duplicate session_id + role at DB level', async () => {
            const store = await import('../../packages/server/src/db/hermes/agent-room-store')
            store.createSession({ id: 'sess-1', name: 'test', createdAt: '2025-01-01T00:00:00Z', updatedAt: '2025-01-01T00:00:00Z' })

            store.createRoleBinding({ id: 'rb-1', sessionId: 'sess-1', role: 'developer', profileName: 'agent-a', createdAt: '2025-01-01T00:00:00Z' })
            expect(() => store.createRoleBinding({ id: 'rb-2', sessionId: 'sess-1', role: 'developer', profileName: 'agent-b', createdAt: '2025-01-01T00:00:01Z' }))
                .toThrow()
        })

        it('allows same role in different sessions', async () => {
            const store = await import('../../packages/server/src/db/hermes/agent-room-store')
            store.createSession({ id: 'sess-1', name: 'test-1', createdAt: '2025-01-01T00:00:00Z', updatedAt: '2025-01-01T00:00:00Z' })
            store.createSession({ id: 'sess-2', name: 'test-2', createdAt: '2025-01-01T00:00:00Z', updatedAt: '2025-01-01T00:00:00Z' })

            store.createRoleBinding({ id: 'rb-1', sessionId: 'sess-1', role: 'developer', profileName: 'agent-a', createdAt: '2025-01-01T00:00:00Z' })
            store.createRoleBinding({ id: 'rb-2', sessionId: 'sess-2', role: 'developer', profileName: 'agent-b', createdAt: '2025-01-01T00:00:01Z' })

            expect(store.listRoleBindingsBySession('sess-1')).toHaveLength(1)
            expect(store.listRoleBindingsBySession('sess-2')).toHaveLength(1)
        })

        it('allows different roles in same session', async () => {
            const store = await import('../../packages/server/src/db/hermes/agent-room-store')
            store.createSession({ id: 'sess-1', name: 'test', createdAt: '2025-01-01T00:00:00Z', updatedAt: '2025-01-01T00:00:00Z' })

            store.createRoleBinding({ id: 'rb-1', sessionId: 'sess-1', role: 'developer', profileName: 'agent-a', createdAt: '2025-01-01T00:00:00Z' })
            store.createRoleBinding({ id: 'rb-2', sessionId: 'sess-1', role: 'reviewer', profileName: 'agent-b', createdAt: '2025-01-01T00:00:01Z' })
            store.createRoleBinding({ id: 'rb-3', sessionId: 'sess-1', role: 'planner', profileName: 'agent-c', createdAt: '2025-01-01T00:00:02Z' })

            expect(store.listRoleBindingsBySession('sess-1')).toHaveLength(3)
        })
    })
})
