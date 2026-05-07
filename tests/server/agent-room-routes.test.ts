import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

function ensureTableForTest(db: any, tableName: string, schema: Record<string, string>): void {
    const cols = Object.entries(schema).map(([col, type]) => `${col} ${type}`).join(', ')
    db.exec(`CREATE TABLE IF NOT EXISTS ${tableName} (${cols})`)
}

describe('Agent Room HTTP Routes — Artifact Delete', () => {
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

    it('DELETE /api/agent-room/sessions/:sessionId/artifacts/:artifactId returns 200 on success', async () => {
        const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
        const { agentRoomRoutes } = await import('../../packages/server/src/routes/hermes/agent-room')

        const session = svc.createSession('Test')
        const task = svc.createTask(session.id, 'Task', '')
        await svc.runWorkflow(session.id, task.id)
        svc.submitReview(session.id, task.id, 'reviewer', 'passed', '')
        svc.deliverTask(session.id, task.id)

        const artifacts = svc.listArtifacts(session.id)
        expect(artifacts.length).toBe(1)

        const deleteRoute = agentRoomRoutes.stack.find((r: any) => 
            r.path === '/api/agent-room/sessions/:sessionId/artifacts/:artifactId' && 
            r.methods.includes('DELETE')
        )
        expect(deleteRoute).toBeDefined()

        const ctx = {
            params: { sessionId: session.id, artifactId: artifacts[0].id },
            status: 200,
            body: null,
        } as any

        await deleteRoute!.stack[0](ctx, async () => {})

        expect(ctx.status).toBe(200)
        expect(ctx.body).toEqual({ success: true })
        expect(svc.listArtifacts(session.id).length).toBe(0)
    })

    it('DELETE artifact returns 404 for nonexistent artifact', async () => {
        const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
        const { agentRoomRoutes } = await import('../../packages/server/src/routes/hermes/agent-room')

        const session = svc.createSession('Test')

        const deleteRoute = agentRoomRoutes.stack.find((r: any) =>
            r.path === '/api/agent-room/sessions/:sessionId/artifacts/:artifactId' &&
            r.methods.includes('DELETE')
        )

        const ctx = {
            params: { sessionId: session.id, artifactId: 'nonexistent' },
            status: 200,
            body: null,
        } as any

        await deleteRoute!.stack[0](ctx, async () => {})

        expect(ctx.status).toBe(404)
        expect(ctx.body).toHaveProperty('error')
        expect(ctx.body.error).toContain('Artifact not found')
    })

    it('DELETE artifact returns 403 for cross-session access', async () => {
        const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
        const { agentRoomRoutes } = await import('../../packages/server/src/routes/hermes/agent-room')

        const s1 = svc.createSession('S1')
        const s2 = svc.createSession('S2')
        const task = svc.createTask(s1.id, 'Task', '')
        await svc.runWorkflow(s1.id, task.id)
        svc.submitReview(s1.id, task.id, 'reviewer', 'passed', '')
        svc.deliverTask(s1.id, task.id)

        const artifacts = svc.listArtifacts(s1.id)
        expect(artifacts.length).toBe(1)

        const deleteRoute = agentRoomRoutes.stack.find((r: any) =>
            r.path === '/api/agent-room/sessions/:sessionId/artifacts/:artifactId' &&
            r.methods.includes('DELETE')
        )

        const ctx = {
            params: { sessionId: s2.id, artifactId: artifacts[0].id },
            status: 200,
            body: null,
        } as any

        await deleteRoute!.stack[0](ctx, async () => {})

        expect(ctx.status).toBe(403)
        expect(ctx.body).toHaveProperty('error')
        expect(ctx.body.error).toContain('belongs to session')
    })
})
