// ─── Agent Room Routes ─────────────────────────────────────────
// Independent API routes for Agent Room workflow.
// Prefix: /api/agent-room

import Router from '@koa/router'
import * as agentRoomService from '../../services/hermes/agent-room'

export const agentRoomRoutes = new Router()

// ─── Sessions ──────────────────────────────────────────────────

// List sessions
agentRoomRoutes.get('/api/agent-room/sessions', async (ctx) => {
    ctx.body = agentRoomService.listSessions()
})

// Create session
agentRoomRoutes.post('/api/agent-room/sessions', async (ctx) => {
    const { name } = ctx.request.body as { name?: string }
    if (!name || !name.trim()) {
        ctx.status = 400
        ctx.body = { error: 'Session name is required' }
        return
    }
    ctx.body = agentRoomService.createSession(name.trim())
})

// Get session
agentRoomRoutes.get('/api/agent-room/sessions/:sessionId', async (ctx) => {
    const session = agentRoomService.getSession(ctx.params.sessionId)
    if (!session) {
        ctx.status = 404
        ctx.body = { error: 'Session not found' }
        return
    }
    ctx.body = session
})

// ─── Messages ──────────────────────────────────────────────────

// List messages
agentRoomRoutes.get('/api/agent-room/sessions/:sessionId/messages', async (ctx) => {
    try {
        ctx.body = agentRoomService.listMessages(ctx.params.sessionId)
    } catch (err: any) {
        ctx.status = 404
        ctx.body = { error: err.message }
    }
})

// Send message
agentRoomRoutes.post('/api/agent-room/sessions/:sessionId/messages', async (ctx) => {
    const { content } = ctx.request.body as { content?: string }
    if (!content || !content.trim()) {
        ctx.status = 400
        ctx.body = { error: 'Message content is required' }
        return
    }
    try {
        const msg = agentRoomService.addMessage({
            sessionId: ctx.params.sessionId,
            senderId: 'user',
            senderName: '用户',
            senderRole: 'user',
            type: 'user_message',
            content: content.trim(),
        })
        ctx.body = msg
    } catch (err: any) {
        ctx.status = 404
        ctx.body = { error: err.message }
    }
})

// ─── Tasks ─────────────────────────────────────────────────────

// List tasks
agentRoomRoutes.get('/api/agent-room/sessions/:sessionId/tasks', async (ctx) => {
    try {
        ctx.body = agentRoomService.listTasks(ctx.params.sessionId)
    } catch (err: any) {
        ctx.status = 404
        ctx.body = { error: err.message }
    }
})

// Create task
agentRoomRoutes.post('/api/agent-room/sessions/:sessionId/tasks', async (ctx) => {
    const { title, description, assignedAgentId } = ctx.request.body as {
        title?: string
        description?: string
        assignedAgentId?: string
    }
    if (!title || !title.trim()) {
        ctx.status = 400
        ctx.body = { error: 'Task title is required' }
        return
    }
    try {
        const task = agentRoomService.createTask(
            ctx.params.sessionId,
            title.trim(),
            description?.trim() ?? '',
            assignedAgentId,
        )
        ctx.body = task
    } catch (err: any) {
        ctx.status = 404
        ctx.body = { error: err.message }
    }
})

// Update task status (with session boundary check + updatedAt refresh)
agentRoomRoutes.patch('/api/agent-room/sessions/:sessionId/tasks/:taskId/status', async (ctx) => {
    const { status } = ctx.request.body as { status?: string }
    if (!status) {
        ctx.status = 400
        ctx.body = { error: 'Status is required' }
        return
    }
    try {
        const task = agentRoomService.updateTaskStatusInSession(
            ctx.params.sessionId,
            ctx.params.taskId,
            status as any,
        )
        ctx.body = task
    } catch (err: any) {
        if (err.message.startsWith('Session not found')) {
            ctx.status = 404
        } else if (err.message.startsWith('Task not found')) {
            ctx.status = 404
        } else if (err.message.includes('belongs to session')) {
            ctx.status = 403
        } else if (err.message.startsWith('Invalid transition')) {
            ctx.status = 400
        } else {
            ctx.status = 400
        }
        ctx.body = { error: err.message }
    }
})

// ─── Reviews ───────────────────────────────────────────────────

// Submit review
agentRoomRoutes.post('/api/agent-room/sessions/:sessionId/tasks/:taskId/review', async (ctx) => {
    const { reviewerAgentId, status, comment } = ctx.request.body as {
        reviewerAgentId?: string
        status?: 'passed' | 'rejected'
        comment?: string
    }
    if (!reviewerAgentId || !status) {
        ctx.status = 400
        ctx.body = { error: 'reviewerAgentId and status are required' }
        return
    }
    try {
        const review = agentRoomService.submitReview(
            ctx.params.sessionId,
            ctx.params.taskId,
            reviewerAgentId,
            status,
            comment ?? '',
        )
        if (!review) {
            ctx.status = 404
            ctx.body = { error: 'Task not found' }
            return
        }
        ctx.body = review
    } catch (err: any) {
        ctx.status = 400
        ctx.body = { error: err.message }
    }
})

// ─── Task Actions ──────────────────────────────────────────────

// Retry task
agentRoomRoutes.post('/api/agent-room/sessions/:sessionId/tasks/:taskId/retry', async (ctx) => {
    try {
        const task = agentRoomService.retryTask(ctx.params.sessionId, ctx.params.taskId)
        if (!task) {
            ctx.status = 404
            ctx.body = { error: 'Task not found' }
            return
        }
        ctx.body = task
    } catch (err: any) {
        ctx.status = 400
        ctx.body = { error: err.message }
    }
})

// Deliver task
agentRoomRoutes.post('/api/agent-room/sessions/:sessionId/tasks/:taskId/deliver', async (ctx) => {
    try {
        const task = agentRoomService.deliverTask(ctx.params.sessionId, ctx.params.taskId)
        if (!task) {
            ctx.status = 404
            ctx.body = { error: 'Task not found' }
            return
        }
        ctx.body = task
    } catch (err: any) {
        ctx.status = 400
        ctx.body = { error: err.message }
    }
})

// Run mock workflow
agentRoomRoutes.post('/api/agent-room/sessions/:sessionId/tasks/:taskId/workflow', async (ctx) => {
    try {
        await agentRoomService.runMockWorkflow(ctx.params.sessionId, ctx.params.taskId)
        ctx.body = { success: true }
    } catch (err: any) {
        ctx.status = 400
        ctx.body = { error: err.message }
    }
})

// ─── Reviews ───────────────────────────────────────────────────

// List reviews for a session
agentRoomRoutes.get('/api/agent-room/sessions/:sessionId/reviews', async (ctx) => {
    try {
        ctx.body = agentRoomService.listReviews(ctx.params.sessionId)
    } catch (err: any) {
        ctx.status = 404
        ctx.body = { error: err.message }
    }
})

// ─── Workflow Events ───────────────────────────────────────────

// List workflow events
agentRoomRoutes.get('/api/agent-room/sessions/:sessionId/events', async (ctx) => {
    try {
        ctx.body = agentRoomService.listWorkflowEvents(ctx.params.sessionId)
    } catch (err: any) {
        ctx.status = 404
        ctx.body = { error: err.message }
    }
})

// ─── Delete ─────────────────────────────────────────────────────

// Delete session (cascade)
agentRoomRoutes.delete('/api/agent-room/sessions/:sessionId', async (ctx) => {
    try {
        agentRoomService.deleteSession(ctx.params.sessionId)
        ctx.body = { success: true }
    } catch (err: any) {
        if (err.message.startsWith('Session not found')) {
            ctx.status = 404
        } else if (err.message.includes('while workflow is running')) {
            ctx.status = 409
        } else {
            ctx.status = 400
        }
        ctx.body = { error: err.message }
    }
})

// Delete task (cascade)
agentRoomRoutes.delete('/api/agent-room/sessions/:sessionId/tasks/:taskId', async (ctx) => {
    try {
        agentRoomService.deleteTask(ctx.params.sessionId, ctx.params.taskId)
        ctx.body = { success: true }
    } catch (err: any) {
        if (err.message.startsWith('Session not found')) {
            ctx.status = 404
        } else if (err.message.startsWith('Task not found')) {
            ctx.status = 404
        } else if (err.message.includes('belongs to session')) {
            ctx.status = 403
        } else if (err.message.includes('while workflow is running')) {
            ctx.status = 409
        } else {
            ctx.status = 400
        }
        ctx.body = { error: err.message }
    }
})
