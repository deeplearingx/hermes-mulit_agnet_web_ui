import Router from '@koa/router'
import type { GroupChatServer } from '../../services/hermes/group-chat'

export const groupChatRoutes = new Router()

let chatServer: GroupChatServer | null = null

export function setGroupChatServer(server: GroupChatServer) {
    chatServer = server
}

export function getGroupChatServer(): GroupChatServer | null {
    return chatServer
}

function generateId(): string {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

// Create room
groupChatRoutes.post('/api/hermes/group-chat/rooms', async (ctx) => {
    if (!chatServer) {
        ctx.status = 503
        ctx.body = { error: 'Group chat not initialized' }
        return
    }

    const { name, inviteCode, agents, compression } = ctx.request.body as {
        name?: string
        inviteCode?: string
        agents?: { profile: string; name?: string; description?: string; invited?: boolean }[]
        compression?: { triggerTokens?: number; maxHistoryTokens?: number; tailMessageCount?: number }
    }
    if (!name || !inviteCode) {
        ctx.status = 400
        ctx.body = { error: 'name and inviteCode are required' }
        return
    }

    const roomId = generateId()
    const storage = chatServer.getStorage()
    storage.saveRoom(roomId, name, inviteCode, compression)

    // Save agents to DB and auto-connect via Socket.IO
    const addedAgents = []
    for (const a of agents || []) {
        const agentId = generateId()
        const agent = storage.addRoomAgent(roomId, agentId, a.profile, a.name || a.profile, a.description || '', a.invited ? 1 : 0)
        addedAgents.push(agent)

        try {
            const client = await chatServer.agentClients.createAgent({
                profile: agent.profile,
                name: agent.name,
                description: agent.description,
                invited: agent.invited,
                dbAgentId: agent.agentId,
            })
            await chatServer.agentClients.addAgentToRoom(roomId, client)
        } catch (err: any) {
            console.error(`[GroupChat] Failed to connect agent ${a.profile} to room ${roomId}: ${err.message}`)
        }
    }

    const room = storage.getRoom(roomId)
    ctx.body = { room, agents: addedAgents }
})

// Get room detail and messages
groupChatRoutes.get('/api/hermes/group-chat/rooms/:roomId', async (ctx) => {
    if (!chatServer) {
        ctx.status = 503
        ctx.body = { error: 'Group chat not initialized' }
        return
    }

    const room = chatServer.getStorage().getRoom(ctx.params.roomId)
    if (!room) {
        ctx.status = 404
        ctx.body = { error: 'Room not found' }
        return
    }

    const messages = chatServer.getStorage().getMessages(ctx.params.roomId)
    const agents = chatServer.getStorage().getRoomAgents(ctx.params.roomId)
    const members = chatServer.getStorage().getRoomMembers(ctx.params.roomId)
    ctx.body = { room, messages, agents, members }
})

// List rooms
groupChatRoutes.get('/api/hermes/group-chat/rooms', async (ctx) => {
    if (!chatServer) {
        ctx.status = 503
        ctx.body = { error: 'Group chat not initialized' }
        return
    }

    const rooms = chatServer.getStorage().getAllRooms()
    ctx.body = { rooms }
})

// Get room by invite code
groupChatRoutes.get('/api/hermes/group-chat/rooms/join/:code', async (ctx) => {
    if (!chatServer) {
        ctx.status = 503
        ctx.body = { error: 'Group chat not initialized' }
        return
    }

    const room = chatServer.getStorage().getRoomByInviteCode(ctx.params.code)
    if (!room) {
        ctx.status = 404
        ctx.body = { error: 'Room not found' }
        return
    }

    ctx.body = { room }
})

// Update room invite code
groupChatRoutes.put('/api/hermes/group-chat/rooms/:roomId/invite-code', async (ctx) => {
    if (!chatServer) {
        ctx.status = 503
        ctx.body = { error: 'Group chat not initialized' }
        return
    }

    const { inviteCode } = ctx.request.body as { inviteCode?: string }
    if (!inviteCode) {
        ctx.status = 400
        ctx.body = { error: 'inviteCode is required' }
        return
    }

    chatServer.getStorage().updateRoomInviteCode(ctx.params.roomId, inviteCode)
    ctx.body = { success: true }
})

// Add agent to room
groupChatRoutes.post('/api/hermes/group-chat/rooms/:roomId/agents', async (ctx) => {
    if (!chatServer) {
        ctx.status = 503
        ctx.body = { error: 'Group chat not initialized' }
        return
    }

    const { profile, name, description, invited } = ctx.request.body as { profile?: string; name?: string; description?: string; invited?: boolean }
    if (!profile) {
        ctx.status = 400
        ctx.body = { error: 'profile is required' }
        return
    }

    // Prevent duplicate agent in same room
    const existing = chatServer.getStorage().getRoomAgents(ctx.params.roomId)
    if (existing.find(a => a.profile === profile)) {
        ctx.status = 409
        ctx.body = { error: 'Agent already in room' }
        return
    }

    const agentId = generateId()
    const agent = chatServer.getStorage().addRoomAgent(ctx.params.roomId, agentId, profile, name || profile, description || '', invited ? 1 : 0)

    // Auto-connect agent via Socket.IO
    try {
        const client = await chatServer.agentClients.createAgent({
            profile: agent.profile,
            name: agent.name,
            description: agent.description,
            invited: agent.invited,
            dbAgentId: agent.agentId,
        })
        await chatServer.agentClients.addAgentToRoom(ctx.params.roomId, client)
    } catch (err: any) {
        console.error(`[GroupChat] Failed to connect agent ${profile} to room ${ctx.params.roomId}: ${err.message}`)
    }

    ctx.body = { agent }
})

// List agents in room
groupChatRoutes.get('/api/hermes/group-chat/rooms/:roomId/agents', async (ctx) => {
    if (!chatServer) {
        ctx.status = 503
        ctx.body = { error: 'Group chat not initialized' }
        return
    }

    const agents = chatServer.getStorage().getRoomAgents(ctx.params.roomId)
    ctx.body = { agents }
})

// Get agent override settings
groupChatRoutes.get('/api/hermes/group-chat/rooms/:roomId/agents/:agentId/override', async (ctx) => {
    if (!chatServer) { ctx.status = 503; ctx.body = { error: 'Group chat not initialized' }; return }
    const override = chatServer.getStorage().getAgentOverride(ctx.params.roomId, ctx.params.agentId)
    ctx.body = { override: override ?? null }
})

// Update agent override settings
groupChatRoutes.put('/api/hermes/group-chat/rooms/:roomId/agents/:agentId/override', async (ctx) => {
    if (!chatServer) { ctx.status = 503; ctx.body = { error: 'Group chat not initialized' }; return }
    const { roomId, agentId } = ctx.params
    const body = ctx.request.body as {
        model?: string | null
        provider?: string | null
        systemPrompt?: string | null
        skillsAllowList?: string[] | null
        contextEnabled?: boolean | null
        triggerTokens?: number | null
        maxHistoryTokens?: number | null
        tailMessageCount?: number | null
    }
    const override = chatServer.getStorage().upsertAgentOverride(roomId, agentId, body)
    // Propagate to in-memory agent client
    chatServer.agentClients.updateAgentOverride(roomId, agentId, override)
    ctx.body = { override }
})

// Remove agent from room
groupChatRoutes.delete('/api/hermes/group-chat/rooms/:roomId/agents/:agentId', async (ctx) => {
    if (!chatServer) {
        ctx.status = 503
        ctx.body = { error: 'Group chat not initialized' }
        return
    }

    chatServer.getStorage().removeRoomAgent(ctx.params.agentId)
    chatServer.agentClients.removeAgentFromRoom(ctx.params.roomId, ctx.params.agentId)
    ctx.body = { success: true }
})

// Delete room
groupChatRoutes.delete('/api/hermes/group-chat/rooms/:roomId', async (ctx) => {
    if (!chatServer) {
        ctx.status = 503
        ctx.body = { error: 'Group chat not initialized' }
        return
    }

    const roomId = ctx.params.roomId
    // Disconnect all agents in room
    chatServer.agentClients.disconnectRoom(roomId)
    // Delete all data
    chatServer.getStorage().deleteRoom(roomId)
    ctx.body = { success: true }
})

// Update room compression config
groupChatRoutes.put('/api/hermes/group-chat/rooms/:roomId/config', async (ctx) => {
    if (!chatServer) {
        ctx.status = 503
        ctx.body = { error: 'Group chat not initialized' }
        return
    }

    const roomId = ctx.params.roomId
    const { triggerTokens, maxHistoryTokens, tailMessageCount } = ctx.request.body as {
        triggerTokens?: number
        maxHistoryTokens?: number
        tailMessageCount?: number
    }

    chatServer.getStorage().updateRoomConfig(roomId, { triggerTokens, maxHistoryTokens, tailMessageCount })
    const room = chatServer.getStorage().getRoom(roomId)
    ctx.body = { room }
})

// Force compress a room's context
groupChatRoutes.post('/api/hermes/group-chat/rooms/:roomId/compress', async (ctx) => {
    if (!chatServer) {
        ctx.status = 503
        ctx.body = { error: 'Group chat not initialized' }
        return
    }

    const roomId = ctx.params.roomId
    if (!chatServer.getStorage().getRoom(roomId)) {
        ctx.status = 404
        ctx.body = { error: 'Room not found' }
        return
    }

    const engine = chatServer.getContextEngine()
    if (!engine) {
        ctx.status = 503
        ctx.body = { error: 'Context engine not available' }
        return
    }

    try {
        const result = await engine.forceCompress(roomId)
        ctx.body = { success: true, summary: result }
    } catch (err: any) {
        ctx.status = 500
        ctx.body = { error: err.message }
    }
})

// ─── Workspace API ──────────────────────────────────────────
groupChatRoutes.get('/api/hermes/group-chat/rooms/:roomId/workspace', async (ctx) => {
    if (!chatServer) { ctx.status = 503; ctx.body = { error: 'Group chat not initialized' }; return }
    const roomId = ctx.params.roomId
    const storage = chatServer.getStorage()
    ctx.body = {
        layout: storage.getWorkspaceLayout(roomId),
        tasks: storage.getTasks(roomId),
        artifacts: storage.getArtifacts(roomId),
    }
})

groupChatRoutes.put('/api/hermes/group-chat/rooms/:roomId/workspace/layout', async (ctx) => {
    if (!chatServer) { ctx.status = 503; ctx.body = { error: 'Group chat not initialized' }; return }
    const roomId = ctx.params.roomId
    const { layout } = ctx.request.body as { layout: Array<{ agentId: string; x: number; y: number; zone: string }> }
    const storage = chatServer.getStorage()
    storage.saveWorkspaceLayout(roomId, layout)
    // Broadcast to room
    chatServer.getIO().of('/group-chat').to(roomId).emit('workspace_updated', { roomId, layout })
    ctx.body = { success: true }
})

groupChatRoutes.post('/api/hermes/group-chat/rooms/:roomId/tasks', async (ctx) => {
    if (!chatServer) { ctx.status = 503; ctx.body = { error: 'Group chat not initialized' }; return }
    const roomId = ctx.params.roomId
    const { title, description, assigneeAgentId, phase } = ctx.request.body as { title: string; description?: string; assigneeAgentId?: string; phase?: string }
    if (!title) { ctx.status = 400; ctx.body = { error: 'title is required' }; return }
    const storage = chatServer.getStorage()
    const task = storage.createTask(roomId, title, description || '', assigneeAgentId, phase)
    // Broadcast workspace update to room
    chatServer.getIO().of('/group-chat').to(roomId).emit('workspace_updated', {
        roomId,
        tasks: storage.getTasks(roomId),
    })
    ctx.body = { task }
})

groupChatRoutes.put('/api/hermes/group-chat/rooms/:roomId/tasks/:taskId', async (ctx) => {
    if (!chatServer) { ctx.status = 503; ctx.body = { error: 'Group chat not initialized' }; return }
    const roomId = ctx.params.roomId
    const { taskId } = ctx.params
    const patch = ctx.request.body as { title?: string; description?: string; status?: string; phase?: string; assigneeAgentId?: string }
    const storage = chatServer.getStorage()
    storage.updateTask(taskId, patch)
    // Return updated task and broadcast
    const updated = storage.getTasks(roomId).find(t => t.id === taskId) || null
    chatServer.getIO().of('/group-chat').to(roomId).emit('workspace_updated', {
        roomId,
        tasks: storage.getTasks(roomId),
    })
    ctx.body = { task: updated }
})

// ─── Artifact API ──────────────────────────────────────────
groupChatRoutes.post('/api/hermes/group-chat/rooms/:roomId/artifacts', async (ctx) => {
    if (!chatServer) { ctx.status = 503; ctx.body = { error: 'Group chat not initialized' }; return }
    const roomId = ctx.params.roomId
    const { name, type, taskId, agentId, path, contentPreview } = ctx.request.body as {
        name: string; type: string; taskId?: string; agentId?: string; path?: string; contentPreview?: string
    }
    if (!name || !type) { ctx.status = 400; ctx.body = { error: 'name and type are required' }; return }
    const storage = chatServer.getStorage()
    const result = storage.createArtifact(roomId, name, type, { taskId, agentId, path, contentPreview })
    const artifact = { id: result.id, roomId, taskId: taskId || null, agentId: agentId || null, name, type, path: path || null, contentPreview: contentPreview || null, createdAt: Date.now() }
    // Broadcast workspace update
    chatServer.getIO().of('/group-chat').to(roomId).emit('workspace_updated', {
        roomId,
        artifacts: storage.getArtifacts(roomId),
    })
    ctx.body = { artifact }
})

groupChatRoutes.get('/api/hermes/group-chat/rooms/:roomId/artifacts/:artifactId', async (ctx) => {
    if (!chatServer) { ctx.status = 503; ctx.body = { error: 'Group chat not initialized' }; return }
    const { artifactId } = ctx.params
    const storage = chatServer.getStorage()
    const artifact = storage.getArtifact(artifactId)
    if (!artifact) { ctx.status = 404; ctx.body = { error: 'Artifact not found' }; return }
    ctx.body = { artifact }
})

groupChatRoutes.patch('/api/hermes/group-chat/rooms/:roomId/artifacts/:artifactId', async (ctx) => {
    if (!chatServer) { ctx.status = 503; ctx.body = { error: 'Group chat not initialized' }; return }
    const roomId = ctx.params.roomId
    const { artifactId } = ctx.params
    const patch = ctx.request.body as { name?: string; type?: string; path?: string; contentPreview?: string }
    const storage = chatServer.getStorage()
    storage.updateArtifact(artifactId, patch)
    const updated = storage.getArtifact(artifactId)
    chatServer.getIO().of('/group-chat').to(roomId).emit('workspace_updated', {
        roomId,
        artifacts: storage.getArtifacts(roomId),
    })
    ctx.body = { artifact: updated }
})

groupChatRoutes.delete('/api/hermes/group-chat/rooms/:roomId/artifacts/:artifactId', async (ctx) => {
    if (!chatServer) { ctx.status = 503; ctx.body = { error: 'Group chat not initialized' }; return }
    const roomId = ctx.params.roomId
    const { artifactId } = ctx.params
    const storage = chatServer.getStorage()
    storage.deleteArtifact(artifactId)
    chatServer.getIO().of('/group-chat').to(roomId).emit('workspace_updated', {
        roomId,
        artifacts: storage.getArtifacts(roomId),
    })
    ctx.body = { success: true }
})
