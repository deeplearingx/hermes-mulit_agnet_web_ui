// ─── Agent Room Routes ─────────────────────────────────────────
// Independent API routes for Agent Room workflow.
// Prefix: /api/agent-room

import Router from '@koa/router'
import type { Context } from 'koa'
import * as agentRoomService from '../../services/hermes/agent-room'
import { isAgentRoomRole } from '../../services/hermes/agent-room'

export const agentRoomRoutes = new Router()

// ─── Unified Error Mapper ─────────────────────────────────────
export function mapAgentRoomError(ctx: Context, err: any): void {
    const message: string = err?.message ?? 'Unknown error'

    if (message.startsWith('Session not found')) ctx.status = 404
    else if (message.startsWith('Task not found')) ctx.status = 404
    else if (message.startsWith('Artifact not found')) ctx.status = 404
    else if (message.startsWith('Run not found')) ctx.status = 404
    else if (message.includes('belongs to session')) ctx.status = 403
    else if (message.includes('while workflow is running')) ctx.status = 409
    else if (message.includes('Workflow is already running')) ctx.status = 409
    else if (message.startsWith('Invalid transition')) ctx.status = 400
    else if (message.startsWith('Cannot review task')) ctx.status = 400
    else ctx.status = 400

    ctx.body = { error: message }
}

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
        mapAgentRoomError(ctx, err)
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
        mapAgentRoomError(ctx, err)
    }
})

// ─── Tasks ─────────────────────────────────────────────────────

// List tasks
agentRoomRoutes.get('/api/agent-room/sessions/:sessionId/tasks', async (ctx) => {
    try {
        ctx.body = agentRoomService.listTasks(ctx.params.sessionId)
    } catch (err: any) {
        mapAgentRoomError(ctx, err)
    }
})

// Create task
agentRoomRoutes.post('/api/agent-room/sessions/:sessionId/tasks', async (ctx) => {
    const { title, description, assignedAgentId, maxRevisionRounds } = ctx.request.body as {
        title?: string
        description?: string
        assignedAgentId?: string
        maxRevisionRounds?: number
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
            maxRevisionRounds,
        )
        ctx.body = task
    } catch (err: any) {
        mapAgentRoomError(ctx, err)
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
        mapAgentRoomError(ctx, err)
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
        mapAgentRoomError(ctx, err)
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
        mapAgentRoomError(ctx, err)
    }
})

// Deliver task
agentRoomRoutes.post('/api/agent-room/sessions/:sessionId/tasks/:taskId/deliver', async (ctx) => {
    try {
        const task = agentRoomService.deliverTask(ctx.params.sessionId, ctx.params.taskId, 'manual')
        if (!task) {
            ctx.status = 404
            ctx.body = { error: 'Task not found' }
            return
        }
        ctx.body = task
    } catch (err: any) {
        mapAgentRoomError(ctx, err)
    }
})

// Run workflow synchronously (delegates to active runner, awaits completion)
agentRoomRoutes.post('/api/agent-room/sessions/:sessionId/tasks/:taskId/workflow', async (ctx) => {
    try {
        const run = await agentRoomService.runWorkflow(ctx.params.sessionId, ctx.params.taskId)
        ctx.body = { success: true, run }
    } catch (err: any) {
        mapAgentRoomError(ctx, err)
    }
})

// Run workflow synchronously (explicit alias — same behavior as /workflow)
agentRoomRoutes.post('/api/agent-room/sessions/:sessionId/tasks/:taskId/workflow/run-sync', async (ctx) => {
    try {
        const run = await agentRoomService.runWorkflow(ctx.params.sessionId, ctx.params.taskId)
        ctx.body = { success: true, run }
    } catch (err: any) {
        mapAgentRoomError(ctx, err)
    }
})

// Start workflow asynchronously (returns run immediately, executes in background)
agentRoomRoutes.post('/api/agent-room/sessions/:sessionId/tasks/:taskId/workflow/start', async (ctx) => {
    try {
        const run = agentRoomService.startWorkflow(ctx.params.sessionId, ctx.params.taskId)
        ctx.body = { success: true, run }
    } catch (err: any) {
        mapAgentRoomError(ctx, err)
    }
})

// ─── Reviews ───────────────────────────────────────────────────

// List reviews for a session
agentRoomRoutes.get('/api/agent-room/sessions/:sessionId/reviews', async (ctx) => {
    try {
        ctx.body = agentRoomService.listReviews(ctx.params.sessionId)
    } catch (err: any) {
        mapAgentRoomError(ctx, err)
    }
})

// ─── Workflow Events ───────────────────────────────────────────

// List workflow events
agentRoomRoutes.get('/api/agent-room/sessions/:sessionId/events', async (ctx) => {
    try {
        ctx.body = agentRoomService.listWorkflowEvents(ctx.params.sessionId)
    } catch (err: any) {
        mapAgentRoomError(ctx, err)
    }
})

// ─── Runs ───────────────────────────────────────────────────────

// List runs for a session (optional taskId query filter)
agentRoomRoutes.get('/api/agent-room/sessions/:sessionId/runs', async (ctx) => {
    try {
        const taskId = ctx.query.taskId as string | undefined
        if (taskId) {
            ctx.body = agentRoomService.listTaskRuns(ctx.params.sessionId, taskId)
        } else {
            ctx.body = agentRoomService.listRuns(ctx.params.sessionId)
        }
    } catch (err: any) {
        mapAgentRoomError(ctx, err)
    }
})

// Get a single run by id
agentRoomRoutes.get('/api/agent-room/runs/:runId', async (ctx) => {
    const run = agentRoomService.getRun(ctx.params.runId)
    if (!run) {
        ctx.status = 404
        ctx.body = { error: 'Run not found' }
        return
    }
    ctx.body = run
})

// List role runs for a specific workflow run
agentRoomRoutes.get('/api/agent-room/runs/:runId/role-runs', async (ctx) => {
    const run = agentRoomService.getRun(ctx.params.runId)
    if (!run) {
        ctx.status = 404
        ctx.body = { error: 'Run not found' }
        return
    }
    ctx.body = agentRoomService.listRoleRunsByRun(ctx.params.runId)
})

// ─── Run Events ─────────────────────────────────────────────────

// List run events for a session
agentRoomRoutes.get('/api/agent-room/sessions/:sessionId/run-events', async (ctx) => {
    try {
        ctx.body = agentRoomService.listRunEventsBySession(ctx.params.sessionId)
    } catch (err: any) {
        mapAgentRoomError(ctx, err)
    }
})

// List run events for a specific run
agentRoomRoutes.get('/api/agent-room/runs/:runId/events', async (ctx) => {
    ctx.body = agentRoomService.listRunEventsByRun(ctx.params.runId)
})

// ─── Session Config ─────────────────────────────────────────────

// Get session config
agentRoomRoutes.get('/api/agent-room/sessions/:sessionId/config', async (ctx) => {
    try {
        ctx.body = agentRoomService.getSessionConfig(ctx.params.sessionId)
    } catch (err: any) {
        mapAgentRoomError(ctx, err)
    }
})

// Update session config
agentRoomRoutes.patch('/api/agent-room/sessions/:sessionId/config', async (ctx) => {
    const { autoDeliveryEnabled } = ctx.request.body as { autoDeliveryEnabled?: boolean }
    if (autoDeliveryEnabled === undefined) {
        ctx.status = 400
        ctx.body = { error: 'autoDeliveryEnabled is required' }
        return
    }
    try {
        ctx.body = agentRoomService.updateSessionConfig(ctx.params.sessionId, { autoDeliveryEnabled })
    } catch (err: any) {
        mapAgentRoomError(ctx, err)
    }
})

// ─── Delete ─────────────────────────────────────────────────────

// Delete session (cascade)
agentRoomRoutes.delete('/api/agent-room/sessions/:sessionId', async (ctx) => {
    try {
        agentRoomService.deleteSession(ctx.params.sessionId)
        ctx.body = { success: true }
    } catch (err: any) {
        mapAgentRoomError(ctx, err)
    }
})

// Delete task (cascade)
agentRoomRoutes.delete('/api/agent-room/sessions/:sessionId/tasks/:taskId', async (ctx) => {
    try {
        agentRoomService.deleteTask(ctx.params.sessionId, ctx.params.taskId)
        ctx.body = { success: true }
    } catch (err: any) {
        mapAgentRoomError(ctx, err)
    }
})

// ─── Artifacts ─────────────────────────────────────────────────

// List artifacts for a session
agentRoomRoutes.get('/api/agent-room/sessions/:sessionId/artifacts', async (ctx) => {
    try {
        ctx.body = agentRoomService.listArtifacts(ctx.params.sessionId)
    } catch (err: any) {
        mapAgentRoomError(ctx, err)
    }
})

// List artifacts for a task
agentRoomRoutes.get('/api/agent-room/sessions/:sessionId/tasks/:taskId/artifacts', async (ctx) => {
    try {
        ctx.body = agentRoomService.listTaskArtifacts(ctx.params.sessionId, ctx.params.taskId)
    } catch (err: any) {
        mapAgentRoomError(ctx, err)
    }
})

// Delete artifact
agentRoomRoutes.delete('/api/agent-room/sessions/:sessionId/artifacts/:artifactId', async (ctx) => {
    try {
        agentRoomService.deleteArtifact(ctx.params.sessionId, ctx.params.artifactId)
        ctx.body = { success: true }
    } catch (err: any) {
        mapAgentRoomError(ctx, err)
    }
})

// ─── Role Bindings ─────────────────────────────────────────────

// List role bindings for a session
agentRoomRoutes.get('/api/agent-room/sessions/:sessionId/role-bindings', async (ctx) => {
    try {
        ctx.body = agentRoomService.listRoleBindings(ctx.params.sessionId)
    } catch (err: any) {
        mapAgentRoomError(ctx, err)
    }
})

// Upsert role binding (PUT by role)
agentRoomRoutes.put('/api/agent-room/sessions/:sessionId/role-bindings/:role', async (ctx) => {
    const { role } = ctx.params
    if (!isAgentRoomRole(role)) {
        ctx.status = 400
        ctx.body = { error: `Invalid role '${role}'. Must be one of: conversation, planner, developer, reviewer, delivery` }
        return
    }
    const { profileName } = ctx.request.body as { profileName?: string }
    if (!profileName || !profileName.trim()) {
        ctx.status = 400
        ctx.body = { error: 'profileName is required' }
        return
    }
    try {
        ctx.body = agentRoomService.setRoleBinding(ctx.params.sessionId, role, profileName)
    } catch (err: any) {
        mapAgentRoomError(ctx, err)
    }
})

// Delete role binding by role (no-op if not found)
agentRoomRoutes.delete('/api/agent-room/sessions/:sessionId/role-bindings/:role', async (ctx) => {
    const { role } = ctx.params
    if (!isAgentRoomRole(role)) {
        ctx.status = 400
        ctx.body = { error: `Invalid role '${role}'. Must be one of: conversation, planner, developer, reviewer, delivery` }
        return
    }
    try {
        agentRoomService.deleteRoleBindingByRole(ctx.params.sessionId, role)
        ctx.body = { success: true }
    } catch (err: any) {
        mapAgentRoomError(ctx, err)
    }
})
