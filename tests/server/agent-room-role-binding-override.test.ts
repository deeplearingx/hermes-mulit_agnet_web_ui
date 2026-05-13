import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

function ensureTableForTest(db: any, tableName: string, schema: Record<string, string>): void {
    const cols = Object.entries(schema).map(([col, type]) => `${col} ${type}`).join(', ')
    db.exec(`CREATE TABLE IF NOT EXISTS ${tableName} (${cols})`)
}

describe('Agent Room Role Binding — Provider/Model Override', () => {
    let mockDb: any

    beforeEach(async () => {
        vi.resetModules()
        const { DatabaseSync } = await import('node:sqlite')
        mockDb = new DatabaseSync(':memory:')
        vi.doMock('../../packages/server/src/db/index', () => ({
            getDb: () => mockDb,
            ensureTable: ensureTableForTest.bind(null, mockDb),
        }))

        const { initAllHermesTables } = await import('../../packages/server/src/db/hermes/schemas')
        initAllHermesTables()
    })

    afterEach(() => {
        if (mockDb) mockDb.close()
        vi.restoreAllMocks()
    })

    describe('Service layer — setRoleBinding with provider/model', () => {
        it('creates a role binding with provider and model', async () => {
            const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
            const session = svc.createSession('Test')

            const binding = svc.setRoleBinding(session.id, 'developer', 'gpt-4o', 'openai', 'gpt-4o')

            expect(binding.profileName).toBe('gpt-4o')
            expect(binding.provider).toBe('openai')
            expect(binding.model).toBe('gpt-4o')
            expect(binding.role).toBe('developer')
        })

        it('creates a role binding without provider/model (backward compatible)', async () => {
            const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
            const session = svc.createSession('Test')

            const binding = svc.setRoleBinding(session.id, 'planner', 'claude-3')

            expect(binding.profileName).toBe('claude-3')
            expect(binding.provider).toBeUndefined()
            expect(binding.model).toBeUndefined()
        })

        it('updates provider/model on existing binding', async () => {
            const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
            const session = svc.createSession('Test')

            // Create initial binding
            svc.setRoleBinding(session.id, 'reviewer', 'gpt-4o', 'openai', 'gpt-4o')

            // Update with new provider/model
            const updated = svc.setRoleBinding(session.id, 'reviewer', 'gpt-4o', 'anthropic', 'claude-3-opus')

            expect(updated.provider).toBe('anthropic')
            expect(updated.model).toBe('claude-3-opus')
        })

        it('clears provider/model when set to empty string', async () => {
            const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
            const session = svc.createSession('Test')

            svc.setRoleBinding(session.id, 'developer', 'gpt-4o', 'openai', 'gpt-4o')
            const updated = svc.setRoleBinding(session.id, 'developer', 'gpt-4o', '', '')

            expect(updated.provider).toBeUndefined()
            expect(updated.model).toBeUndefined()
        })

        it('persists provider/model across listRoleBindings', async () => {
            const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
            const session = svc.createSession('Test')

            svc.setRoleBinding(session.id, 'planner', 'gpt-4o', 'openai', 'gpt-4o')
            svc.setRoleBinding(session.id, 'developer', 'claude-3', 'anthropic', 'claude-3')

            const bindings = svc.listRoleBindings(session.id)
            expect(bindings.length).toBe(2)

            const planner = bindings.find(b => b.role === 'planner')!
            expect(planner.provider).toBe('openai')
            expect(planner.model).toBe('gpt-4o')

            const developer = bindings.find(b => b.role === 'developer')!
            expect(developer.provider).toBe('anthropic')
            expect(developer.model).toBe('claude-3')
        })
    })

    describe('Store layer — CRUD with provider/model', () => {
        it('mapRoleBindingRow reads provider and model from DB', async () => {
            const store = await import('../../packages/server/src/db/hermes/agent-room-store')

            const binding = {
                id: 'test-id',
                sessionId: 'session-1',
                role: 'developer',
                profileName: 'gpt-4o',
                provider: 'openai',
                model: 'gpt-4o',
                createdAt: new Date().toISOString(),
            }

            // Create session first (foreign key)
            mockDb.exec(`INSERT INTO agent_room_sessions (id, name, auto_delivery_enabled, created_at, updated_at) VALUES ('session-1', 'Test', 0, '${binding.createdAt}', '${binding.createdAt}')`)

            store.createRoleBinding(binding)
            const retrieved = store.getRoleBinding('test-id')

            expect(retrieved).not.toBeNull()
            expect(retrieved!.provider).toBe('openai')
            expect(retrieved!.model).toBe('gpt-4o')
        })

        it('mapRoleBindingRow handles null provider/model as undefined', async () => {
            const store = await import('../../packages/server/src/db/hermes/agent-room-store')

            const binding = {
                id: 'test-id-2',
                sessionId: 'session-1',
                role: 'planner',
                profileName: 'claude-3',
                createdAt: new Date().toISOString(),
            }

            mockDb.exec(`INSERT INTO agent_room_sessions (id, name, auto_delivery_enabled, created_at, updated_at) VALUES ('session-1', 'Test', 0, '${binding.createdAt}', '${binding.createdAt}')`)

            store.createRoleBinding(binding)
            const retrieved = store.getRoleBinding('test-id-2')

            expect(retrieved).not.toBeNull()
            expect(retrieved!.provider).toBeUndefined()
            expect(retrieved!.model).toBeUndefined()
        })

        it('updateRoleBinding persists provider/model changes', async () => {
            const store = await import('../../packages/server/src/db/hermes/agent-room-store')

            const binding = {
                id: 'test-id-3',
                sessionId: 'session-1',
                role: 'reviewer',
                profileName: 'gpt-4o',
                provider: 'openai',
                model: 'gpt-4o',
                createdAt: new Date().toISOString(),
            }

            mockDb.exec(`INSERT INTO agent_room_sessions (id, name, auto_delivery_enabled, created_at, updated_at) VALUES ('session-1', 'Test', 0, '${binding.createdAt}', '${binding.createdAt}')`)

            store.createRoleBinding(binding)

            // Update
            const updated = { ...binding, provider: 'anthropic', model: 'claude-3-opus' }
            store.updateRoleBinding(updated)

            const retrieved = store.getRoleBinding('test-id-3')
            expect(retrieved!.provider).toBe('anthropic')
            expect(retrieved!.model).toBe('claude-3-opus')
        })
    })

    describe('Route layer — PUT role-binding with provider/model', () => {
        it('passes provider and model to setRoleBinding', async () => {
            const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
            const { agentRoomRoutes } = await import('../../packages/server/src/routes/hermes/agent-room')

            const session = svc.createSession('Route Test')

            const putRoute = agentRoomRoutes.stack.find((r: any) =>
                r.path === '/api/agent-room/sessions/:sessionId/role-bindings/:role' &&
                r.methods.includes('PUT')
            )
            expect(putRoute).toBeDefined()

            const ctx = {
                params: { sessionId: session.id, role: 'developer' },
                request: {
                    body: {
                        profileName: 'gpt-4o',
                        provider: 'openai',
                        model: 'gpt-4o',
                    },
                },
                status: 200,
                body: null,
            } as any

            await putRoute!.stack[0](ctx, async () => {})

            expect(ctx.status).toBe(200)
            expect(ctx.body).toMatchObject({
                profileName: 'gpt-4o',
                provider: 'openai',
                model: 'gpt-4o',
                role: 'developer',
            })
        })

        it('works without provider/model (backward compatible)', async () => {
            const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
            const { agentRoomRoutes } = await import('../../packages/server/src/routes/hermes/agent-room')

            const session = svc.createSession('Route Test 2')

            const putRoute = agentRoomRoutes.stack.find((r: any) =>
                r.path === '/api/agent-room/sessions/:sessionId/role-bindings/:role' &&
                r.methods.includes('PUT')
            )

            const ctx = {
                params: { sessionId: session.id, role: 'planner' },
                request: { body: { profileName: 'claude-3' } },
                status: 200,
                body: null,
            } as any

            await putRoute!.stack[0](ctx, async () => {})

            expect(ctx.status).toBe(200)
            expect(ctx.body).toMatchObject({
                profileName: 'claude-3',
                role: 'planner',
            })
            expect((ctx.body as any).provider).toBeUndefined()
            expect((ctx.body as any).model).toBeUndefined()
        })
    })
})
