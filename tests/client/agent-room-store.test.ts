// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

// ─── Mock API ──────────────────────────────────────────────────
const mockApi = vi.hoisted(() => ({
    createSession: vi.fn(),
    listSessions: vi.fn(),
    listMessages: vi.fn(),
    sendMessage: vi.fn(),
    listTasks: vi.fn(),
    createTask: vi.fn(),
    updateTaskStatus: vi.fn(),
    submitReview: vi.fn(),
    retryTask: vi.fn(),
    deliverTask: vi.fn(),
    listReviews: vi.fn(),
    listWorkflowEvents: vi.fn(),
    listArtifacts: vi.fn(),
    deleteArtifact: vi.fn(),
    runWorkflow: vi.fn(),
    deleteSession: vi.fn(),
    deleteTask: vi.fn(),
    AGENT_ROOM_AGENTS: [
        { id: 'planner', name: 'Planner', role: 'planner' },
        { id: 'developer', name: 'Developer', role: 'developer' },
        { id: 'reviewer', name: 'Reviewer', role: 'reviewer' },
    ],
}))

vi.mock('@/api/hermes/agent-room', () => mockApi)

import { useAgentRoomStore } from '@/stores/hermes/agent-room'

describe('Agent Room Client Store — Artifact Stability', () => {
    beforeEach(() => {
        setActivePinia(createPinia())
        vi.clearAllMocks()
    })

    it('createSession clears stale artifacts from previous session', async () => {
        const store = useAgentRoomStore()

        // Pre-populate artifacts as if a previous session had them
        store.artifacts = [
            { id: 'a1', sessionId: 'old', taskId: 't1', name: 'Old Artifact', type: 'code_output', createdAt: '2025-01-01' },
        ]

        mockApi.createSession.mockResolvedValue({ id: 'new-s', name: 'New', createdAt: '2025-01-02', updatedAt: '2025-01-02' })
        mockApi.listMessages.mockResolvedValue([])
        mockApi.listTasks.mockResolvedValue([])
        mockApi.listReviews.mockResolvedValue([])
        mockApi.listWorkflowEvents.mockResolvedValue([])
        mockApi.listArtifacts.mockResolvedValue([])

        await store.createSession('New')

        // After createSession, artifacts should be cleared (then reloaded as empty)
        expect(store.artifacts).toEqual([])
    })

    it('removeSession clears artifacts when deleting the last session', async () => {
        const store = useAgentRoomStore()

        // Set up a single session as current
        store.sessions = [{ id: 's1', name: 'Only', createdAt: '2025-01-01', updatedAt: '2025-01-01' }]
        store.currentSessionId = 's1'
        store.artifacts = [
            { id: 'a1', sessionId: 's1', taskId: 't1', name: 'Artifact', type: 'final_delivery', createdAt: '2025-01-01' },
        ]

        mockApi.deleteSession.mockResolvedValue({ success: true })

        await store.removeSession('s1')

        expect(store.artifacts).toEqual([])
        expect(store.currentSessionId).toBeNull()
    })

    it('removeArtifact calls API and filters local list immediately', async () => {
        const store = useAgentRoomStore()

        store.currentSessionId = 's1'
        store.artifacts = [
            { id: 'a1', sessionId: 's1', taskId: 't1', name: 'Keep', type: 'code_output', createdAt: '2025-01-01' },
            { id: 'a2', sessionId: 's1', taskId: 't1', name: 'Delete', type: 'log', createdAt: '2025-01-02' },
        ]

        mockApi.deleteArtifact.mockResolvedValue({ success: true })

        await store.removeArtifact('a2')

        expect(mockApi.deleteArtifact).toHaveBeenCalledWith('s1', 'a2')
        expect(store.artifacts).toHaveLength(1)
        expect(store.artifacts[0].id).toBe('a1')
    })

    it('removeArtifact does nothing when no currentSessionId', async () => {
        const store = useAgentRoomStore()

        store.currentSessionId = null
        store.artifacts = [
            { id: 'a1', sessionId: 's1', taskId: 't1', name: 'X', type: 'log', createdAt: '2025-01-01' },
        ]

        await store.removeArtifact('a1')

        expect(mockApi.deleteArtifact).not.toHaveBeenCalled()
        expect(store.artifacts).toHaveLength(1)
    })

    it('removeArtifact sets error on API failure', async () => {
        const store = useAgentRoomStore()

        store.currentSessionId = 's1'
        store.artifacts = [
            { id: 'a1', sessionId: 's1', taskId: 't1', name: 'X', type: 'log', createdAt: '2025-01-01' },
        ]

        mockApi.deleteArtifact.mockRejectedValue(new Error('Network error'))

        await expect(store.removeArtifact('a1')).rejects.toThrow('Network error')
        expect(store.error).toBe('Network error')
        // Artifact should NOT be removed from local list on failure
        expect(store.artifacts).toHaveLength(1)
    })
})
