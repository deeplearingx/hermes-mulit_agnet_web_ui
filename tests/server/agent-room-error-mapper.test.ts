import { describe, expect, it } from 'vitest'
import { mapAgentRoomError } from '../../packages/server/src/routes/hermes/agent-room'

function makeCtx() {
    return { status: 200, body: null } as any
}

describe('Agent Room Routes — mapAgentRoomError', () => {
    it('maps "Artifact not found" to 404', () => {
        const ctx = makeCtx()
        mapAgentRoomError(ctx, new Error('Artifact not found'))
        expect(ctx.status).toBe(404)
        expect(ctx.body).toEqual({ error: 'Artifact not found' })
    })

    it('maps "Artifact belongs to session" to 403', () => {
        const ctx = makeCtx()
        mapAgentRoomError(ctx, new Error('Artifact belongs to session s1, not s2'))
        expect(ctx.status).toBe(403)
        expect(ctx.body).toEqual({ error: 'Artifact belongs to session s1, not s2' })
    })

    it('maps "Session not found" to 404', () => {
        const ctx = makeCtx()
        mapAgentRoomError(ctx, new Error('Session not found: abc'))
        expect(ctx.status).toBe(404)
        expect(ctx.body).toEqual({ error: 'Session not found: abc' })
    })

    it('maps "Task not found" to 404', () => {
        const ctx = makeCtx()
        mapAgentRoomError(ctx, new Error('Task not found'))
        expect(ctx.status).toBe(404)
        expect(ctx.body).toEqual({ error: 'Task not found' })
    })

    it('maps "Workflow is already running" to 409', () => {
        const ctx = makeCtx()
        mapAgentRoomError(ctx, new Error('Workflow is already running'))
        expect(ctx.status).toBe(409)
        expect(ctx.body).toEqual({ error: 'Workflow is already running' })
    })

    it('maps "Invalid transition" to 400', () => {
        const ctx = makeCtx()
        mapAgentRoomError(ctx, new Error('Invalid transition'))
        expect(ctx.status).toBe(400)
        expect(ctx.body).toEqual({ error: 'Invalid transition' })
    })

    it('maps "Cannot review task" to 400', () => {
        const ctx = makeCtx()
        mapAgentRoomError(ctx, new Error('Cannot review task'))
        expect(ctx.status).toBe(400)
        expect(ctx.body).toEqual({ error: 'Cannot review task' })
    })

    it('maps model resolution failures to 422', () => {
        const ctx = makeCtx()
        mapAgentRoomError(ctx, new Error('Agent Room model resolution failed [role=planner, profile=glm, model=missing, provider=missing]'))
        expect(ctx.status).toBe(422)
        expect(ctx.body).toEqual({ error: 'Agent Room model resolution failed [role=planner, profile=glm, model=missing, provider=missing]' })
    })

    it('maps unrunnable role bindings to 422', () => {
        const ctx = makeCtx()
        mapAgentRoomError(ctx, new Error('Agent Room role binding is not runnable [role=planner, profile=glm, model=missing, provider=missing].'))
        expect(ctx.status).toBe(422)
        expect(ctx.body).toEqual({ error: 'Agent Room role binding is not runnable [role=planner, profile=glm, model=missing, provider=missing].' })
    })

    it('maps unknown errors to 400', () => {
        const ctx = makeCtx()
        mapAgentRoomError(ctx, new Error('Something unexpected'))
        expect(ctx.status).toBe(400)
        expect(ctx.body).toEqual({ error: 'Something unexpected' })
    })

    it('maps null/undefined errors to 400 with "Unknown error"', () => {
        const ctx = makeCtx()
        mapAgentRoomError(ctx, null)
        expect(ctx.status).toBe(400)
        expect(ctx.body).toEqual({ error: 'Unknown error' })
    })
})
