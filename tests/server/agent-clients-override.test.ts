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

vi.mock('../../packages/server/src/services/auth', () => ({
    getToken: vi.fn().mockResolvedValue('test-token'),
}))

vi.mock('../../packages/server/src/config', () => ({
    config: {
        port: 9999,
    },
}))

import { io } from 'socket.io-client'
import { AgentClients } from '../../packages/server/src/services/hermes/group-chat/agent-clients'

describe('AgentClients.updateAgentOverride — dbAgentId fix', () => {
    let clients: AgentClients

    beforeEach(() => {
        vi.clearAllMocks()
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
        const setOverrideSpy = vi.spyOn(client, 'setOverride')
        await clients.addAgentToRoom('room-1', client)

        const override = { model: 'gpt-4o' }
        clients.updateAgentOverride('room-1', dbAgentId, override)

        expect(clients.getAgent('room-1', dbAgentId)).toBe(client)
        expect(setOverrideSpy).toHaveBeenCalledWith(override)
    })

    it('updateAgentOverride is a no-op when agentId does not match', () => {
        expect(() => clients.updateAgentOverride('room-1', 'nonexistent', { model: 'gpt-4o' })).not.toThrow()
    })

    it('createAgent connects to the configured server port when no port is passed', async () => {
        await clients.createAgent({
            profile: 'default',
            name: 'PortAwareAgent',
            description: '',
            invited: 0,
            dbAgentId: 'port-aware-agent',
        })

        expect(io).toHaveBeenCalledWith(
            'http://127.0.0.1:9999/group-chat',
            expect.objectContaining({
                auth: expect.objectContaining({
                    token: 'test-token',
                    name: 'PortAwareAgent',
                }),
                transports: ['websocket'],
            }),
        )
    })
})
