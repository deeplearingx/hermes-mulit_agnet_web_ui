import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('socket.io-client', () => ({
    io: vi.fn(() => {
        const sock: any = {
            connected: true,
            id: 'mock-socket-id',
            on: vi.fn((event: string, cb: (...args: any[]) => void) => {
                if (event === 'connect') setTimeout(() => cb(), 0)
            }),
            // Call ack immediately for 'join' so joinRoom() resolves
            emit: vi.fn((event: string, _data: any, ack?: (res: any) => void) => {
                if (event === 'join' && ack) ack({ roomId: 'room-1', roomName: 'test', members: [], messages: [], rooms: [] })
            }),
            disconnect: vi.fn(),
            io: { on: vi.fn() },
        }
        return sock
    }),
}))

vi.mock('../../../packages/server/src/services/auth', () => ({
    getToken: vi.fn().mockResolvedValue('test-token'),
}))

import { AgentClients } from '../../packages/server/src/services/hermes/group-chat/agent-clients'

describe('AgentClients.updateAgentOverride — dbAgentId fix', () => {
    let clients: AgentClients

    beforeEach(() => {
        clients = new AgentClients()
    })

    it('client.agentId equals dbAgentId when provided', async () => {
        const dbAgentId = 'stable-db-id-123'
        const client = await clients.createAgent({
            profile: 'default', name: 'Agent', description: '', invited: 0, dbAgentId,
        })
        expect(client.agentId).toBe(dbAgentId)
    })

    it('updateAgentOverride finds client by DB agentId after addAgentToRoom', async () => {
        const dbAgentId = 'db-agent-abc'
        const client = await clients.createAgent({
            profile: 'default', name: 'TestAgent', description: '', invited: 0, dbAgentId,
        })
        await clients.addAgentToRoom('room-1', client)

        clients.updateAgentOverride('room-1', dbAgentId, { model: 'gpt-4o' })

        expect(clients.getAgent('room-1', dbAgentId)).toBe(client)
    })

    it('updateAgentOverride is a no-op when agentId does not match', () => {
        expect(() => clients.updateAgentOverride('room-1', 'nonexistent', { model: 'gpt-4o' })).not.toThrow()
    })
})
