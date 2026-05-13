// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
    startWorkflow: vi.fn(),
    deleteSession: vi.fn(),
    deleteTask: vi.fn(),
    listRoleBindings: vi.fn(),
    setRoleBinding: vi.fn(),
    deleteRoleBindingByRole: vi.fn(),
    listRuns: vi.fn(),
    listRunEventsBySession: vi.fn(),
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
        mockApi.listRoleBindings.mockResolvedValue([])
        mockApi.listRuns.mockResolvedValue([])

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

    // ─── Workflow Facade ───────────────────────────────────────
    it('runWorkflow calls startWorkflow API and inserts run locally', async () => {
        const store = useAgentRoomStore()

        store.currentSessionId = 's1'
        store.sessions = [{ id: 's1', name: 'Test', createdAt: '2025-01-01', updatedAt: '2025-01-01' }]

        const mockRun = { id: 'run-1', sessionId: 's1', taskId: 't1', status: 'queued', runnerName: 'real', createdAt: '2025-01-01', updatedAt: '2025-01-01' }
        mockApi.startWorkflow.mockResolvedValue({ success: true, run: mockRun })

        await store.runWorkflow('t1')

        expect(mockApi.startWorkflow).toHaveBeenCalledWith('s1', 't1')
        expect(store.runs).toContainEqual(mockRun)
        expect(store.actionLoadingTaskId).toBeNull()
    })

    it('runWorkflow starts polling for active runs', async () => {
        vi.useFakeTimers()
        const store = useAgentRoomStore()

        store.currentSessionId = 's1'
        store.sessions = [{ id: 's1', name: 'Test', createdAt: '2025-01-01', updatedAt: '2025-01-01' }]

        const mockRun = { id: 'run-1', sessionId: 's1', taskId: 't1', status: 'queued', runnerName: 'real', createdAt: '2025-01-01', updatedAt: '2025-01-01' }
        mockApi.startWorkflow.mockResolvedValue({ success: true, run: mockRun })

        // After polling starts, listRuns returns completed run so polling stops
        mockApi.listRuns.mockResolvedValue([
            { ...mockRun, status: 'completed' },
        ])
        mockApi.listRunEventsBySession.mockResolvedValue([])

        await store.runWorkflow('t1')

        // The run should be in local state
        expect(store.runs).toContainEqual(mockRun)

        // Advance timers to trigger the polling interval (3000ms)
        await vi.advanceTimersByTimeAsync(3500)

        // listRuns should have been called by the polling tick
        expect(mockApi.listRuns).toHaveBeenCalledWith('s1')
        expect(mockApi.listRunEventsBySession).toHaveBeenCalledWith('s1')

        vi.useRealTimers()
    })

    it('runMockWorkflow still works as alias for runWorkflow', async () => {
        const store = useAgentRoomStore()

        store.currentSessionId = 's1'
        store.sessions = [{ id: 's1', name: 'Test', createdAt: '2025-01-01', updatedAt: '2025-01-01' }]

        const mockRun = { id: 'run-1', sessionId: 's1', taskId: 't1', status: 'queued', runnerName: 'real', createdAt: '2025-01-01', updatedAt: '2025-01-01' }
        mockApi.startWorkflow.mockResolvedValue({ success: true, run: mockRun })

        await store.runMockWorkflow('t1')

        expect(mockApi.startWorkflow).toHaveBeenCalledWith('s1', 't1')
    })

    it('runWorkflow sets error on API failure', async () => {
        const store = useAgentRoomStore()

        store.currentSessionId = 's1'

        mockApi.startWorkflow.mockRejectedValue(new Error('Workflow is already running'))

        await expect(store.runWorkflow('t1')).rejects.toThrow('Workflow is already running')
        expect(store.error).toBe('Workflow is already running')
        expect(store.actionLoadingTaskId).toBeNull()
    })
})

describe('Agent Room Client Store — Role Bindings', () => {
    beforeEach(() => {
        setActivePinia(createPinia())
        vi.clearAllMocks()
    })

    it('selectSession loads role bindings in parallel batch', async () => {
        const store = useAgentRoomStore()

        mockApi.listMessages.mockResolvedValue([])
        mockApi.listTasks.mockResolvedValue([])
        mockApi.listReviews.mockResolvedValue([])
        mockApi.listWorkflowEvents.mockResolvedValue([])
        mockApi.listArtifacts.mockResolvedValue([])
        mockApi.listRoleBindings.mockResolvedValue([
            { id: 'rb1', sessionId: 's1', role: 'developer', profileName: 'gpt-4', createdAt: '2025-01-01', updatedAt: '2025-01-01' },
        ])
        mockApi.listRuns.mockResolvedValue([])

        await store.selectSession('s1')

        expect(mockApi.listRoleBindings).toHaveBeenCalledWith('s1')
        expect(store.roleBindings).toHaveLength(1)
        expect(store.roleBindings[0].role).toBe('developer')
        expect(store.roleBindings[0].profileName).toBe('gpt-4')
    })

    it('refreshCurrentSession loads role bindings', async () => {
        const store = useAgentRoomStore()

        store.currentSessionId = 's1'

        mockApi.listMessages.mockResolvedValue([])
        mockApi.listTasks.mockResolvedValue([])
        mockApi.listReviews.mockResolvedValue([])
        mockApi.listWorkflowEvents.mockResolvedValue([])
        mockApi.listArtifacts.mockResolvedValue([])
        mockApi.listRoleBindings.mockResolvedValue([
            { id: 'rb1', sessionId: 's1', role: 'planner', profileName: 'claude-3', createdAt: '2025-01-01', updatedAt: '2025-01-01' },
        ])
        mockApi.listRuns.mockResolvedValue([])

        await store.refreshCurrentSession()

        expect(mockApi.listRoleBindings).toHaveBeenCalledWith('s1')
        expect(store.roleBindings).toHaveLength(1)
        expect(store.roleBindings[0].role).toBe('planner')
    })

    it('roleBindingMap computed returns Map from role to binding', async () => {
        const store = useAgentRoomStore()

        store.currentSessionId = 's1'

        mockApi.listMessages.mockResolvedValue([])
        mockApi.listTasks.mockResolvedValue([])
        mockApi.listReviews.mockResolvedValue([])
        mockApi.listWorkflowEvents.mockResolvedValue([])
        mockApi.listArtifacts.mockResolvedValue([])
        mockApi.listRoleBindings.mockResolvedValue([
            { id: 'rb1', sessionId: 's1', role: 'developer', profileName: 'gpt-4', createdAt: '2025-01-01', updatedAt: '2025-01-01' },
            { id: 'rb2', sessionId: 's1', role: 'reviewer', profileName: 'claude-3', createdAt: '2025-01-01', updatedAt: '2025-01-01' },
        ])
        mockApi.listRuns.mockResolvedValue([])

        await store.selectSession('s1')

        const map = store.roleBindingMap
        expect(map.size).toBe(2)
        expect(map.get('developer')?.profileName).toBe('gpt-4')
        expect(map.get('reviewer')?.profileName).toBe('claude-3')
        expect(map.get('planner')).toBeUndefined()
    })

    it('saveRoleBinding calls setRoleBinding API and upserts locally', async () => {
        const store = useAgentRoomStore()

        store.currentSessionId = 's1'
        store.sessions = [{ id: 's1', name: 'Test', createdAt: '2025-01-01', updatedAt: '2025-01-01' }]

        const newBinding = { id: 'rb1', sessionId: 's1', role: 'developer', profileName: 'gpt-4', createdAt: '2025-01-01', updatedAt: '2025-01-01' }
        mockApi.setRoleBinding.mockResolvedValue(newBinding)

        const result = await store.saveRoleBinding('developer', 'gpt-4')

        expect(mockApi.setRoleBinding).toHaveBeenCalledWith('s1', 'developer', 'gpt-4', undefined, undefined)
        expect(result).toEqual(newBinding)
        expect(store.roleBindings).toHaveLength(1)
        expect(store.roleBindings[0].role).toBe('developer')
    })

    it('saveRoleBinding updates existing binding in local list', async () => {
        const store = useAgentRoomStore()

        store.currentSessionId = 's1'
        store.sessions = [{ id: 's1', name: 'Test', createdAt: '2025-01-01', updatedAt: '2025-01-01' }]
        store.roleBindings = [
            { id: 'rb1', sessionId: 's1', role: 'developer', profileName: 'old-model', createdAt: '2025-01-01', updatedAt: '2025-01-01' },
        ]

        const updatedBinding = { id: 'rb1', sessionId: 's1', role: 'developer', profileName: 'new-model', createdAt: '2025-01-01', updatedAt: '2025-01-02' }
        mockApi.setRoleBinding.mockResolvedValue(updatedBinding)

        await store.saveRoleBinding('developer', 'new-model')

        expect(store.roleBindings).toHaveLength(1)
        expect(store.roleBindings[0].profileName).toBe('new-model')
    })

    it('saveRoleBinding does nothing when no currentSessionId', async () => {
        const store = useAgentRoomStore()

        store.currentSessionId = null

        const result = await store.saveRoleBinding('developer', 'gpt-4')

        expect(result).toBeNull()
        expect(mockApi.setRoleBinding).not.toHaveBeenCalled()
    })

    it('saveRoleBinding sets error on API failure', async () => {
        const store = useAgentRoomStore()

        store.currentSessionId = 's1'

        mockApi.setRoleBinding.mockRejectedValue(new Error('Invalid profile'))

        await expect(store.saveRoleBinding('developer', '')).rejects.toThrow('Invalid profile')
        expect(store.error).toBe('Invalid profile')
    })

    it('removeRoleBinding calls deleteRoleBindingByRole API and filters locally', async () => {
        const store = useAgentRoomStore()

        store.currentSessionId = 's1'
        store.sessions = [{ id: 's1', name: 'Test', createdAt: '2025-01-01', updatedAt: '2025-01-01' }]
        store.roleBindings = [
            { id: 'rb1', sessionId: 's1', role: 'developer', profileName: 'gpt-4', createdAt: '2025-01-01', updatedAt: '2025-01-01' },
            { id: 'rb2', sessionId: 's1', role: 'reviewer', profileName: 'claude-3', createdAt: '2025-01-01', updatedAt: '2025-01-01' },
        ]

        mockApi.deleteRoleBindingByRole.mockResolvedValue({ success: true })

        await store.removeRoleBinding('developer')

        expect(mockApi.deleteRoleBindingByRole).toHaveBeenCalledWith('s1', 'developer')
        expect(store.roleBindings).toHaveLength(1)
        expect(store.roleBindings[0].role).toBe('reviewer')
    })

    it('removeRoleBinding does nothing when no currentSessionId', async () => {
        const store = useAgentRoomStore()

        store.currentSessionId = null

        await store.removeRoleBinding('developer')

        expect(mockApi.deleteRoleBindingByRole).not.toHaveBeenCalled()
    })

    it('removeRoleBinding sets error on API failure', async () => {
        const store = useAgentRoomStore()

        store.currentSessionId = 's1'
        store.roleBindings = [
            { id: 'rb1', sessionId: 's1', role: 'developer', profileName: 'gpt-4', createdAt: '2025-01-01', updatedAt: '2025-01-01' },
        ]

        mockApi.deleteRoleBindingByRole.mockRejectedValue(new Error('Network error'))

        await expect(store.removeRoleBinding('developer')).rejects.toThrow('Network error')
        expect(store.error).toBe('Network error')
        // Should NOT be removed from local list on failure
        expect(store.roleBindings).toHaveLength(1)
    })

    it('$reset clears roleBindings', async () => {
        const store = useAgentRoomStore()

        store.roleBindings = [
            { id: 'rb1', sessionId: 's1', role: 'developer', profileName: 'gpt-4', createdAt: '2025-01-01', updatedAt: '2025-01-01' },
        ]

        store.$reset()

        expect(store.roleBindings).toEqual([])
    })

    it('removeSession clears roleBindings when deleting the last session', async () => {
        const store = useAgentRoomStore()

        store.sessions = [{ id: 's1', name: 'Only', createdAt: '2025-01-01', updatedAt: '2025-01-01' }]
        store.currentSessionId = 's1'
        store.roleBindings = [
            { id: 'rb1', sessionId: 's1', role: 'developer', profileName: 'gpt-4', createdAt: '2025-01-01', updatedAt: '2025-01-01' },
        ]

        mockApi.deleteSession.mockResolvedValue({ success: true })

        await store.removeSession('s1')

        expect(store.roleBindings).toEqual([])
        expect(store.currentSessionId).toBeNull()
    })
})

describe('Agent Room Client Store — Runs', () => {
    beforeEach(() => {
        setActivePinia(createPinia())
        vi.clearAllMocks()
    })

    it('selectSession loads runs in parallel batch', async () => {
        const store = useAgentRoomStore()

        mockApi.listMessages.mockResolvedValue([])
        mockApi.listTasks.mockResolvedValue([])
        mockApi.listReviews.mockResolvedValue([])
        mockApi.listWorkflowEvents.mockResolvedValue([])
        mockApi.listArtifacts.mockResolvedValue([])
        mockApi.listRoleBindings.mockResolvedValue([])
        mockApi.listRuns.mockResolvedValue([
            { id: 'r1', sessionId: 's1', taskId: 't1', status: 'completed', runnerName: 'mock', createdAt: '2025-01-01', updatedAt: '2025-01-01' },
        ])

        await store.selectSession('s1')

        expect(mockApi.listRuns).toHaveBeenCalledWith('s1')
        expect(store.runs).toHaveLength(1)
        expect(store.runs[0].status).toBe('completed')
    })

    it('refreshCurrentSession loads runs', async () => {
        const store = useAgentRoomStore()

        store.currentSessionId = 's1'

        mockApi.listMessages.mockResolvedValue([])
        mockApi.listTasks.mockResolvedValue([])
        mockApi.listReviews.mockResolvedValue([])
        mockApi.listWorkflowEvents.mockResolvedValue([])
        mockApi.listArtifacts.mockResolvedValue([])
        mockApi.listRoleBindings.mockResolvedValue([])
        mockApi.listRuns.mockResolvedValue([
            { id: 'r1', sessionId: 's1', taskId: 't1', status: 'running', runnerName: 'mock', createdAt: '2025-01-01', updatedAt: '2025-01-01' },
        ])

        await store.refreshCurrentSession()

        expect(mockApi.listRuns).toHaveBeenCalledWith('s1')
        expect(store.runs).toHaveLength(1)
        expect(store.runs[0].status).toBe('running')
    })

    it('createSession clears stale runs from previous session', async () => {
        const store = useAgentRoomStore()

        store.runs = [
            { id: 'r1', sessionId: 'old', taskId: 't1', status: 'completed', runnerName: 'mock', createdAt: '2025-01-01', updatedAt: '2025-01-01' },
        ]

        mockApi.createSession.mockResolvedValue({ id: 'new-s', name: 'New', createdAt: '2025-01-02', updatedAt: '2025-01-02' })
        mockApi.listMessages.mockResolvedValue([])
        mockApi.listTasks.mockResolvedValue([])
        mockApi.listReviews.mockResolvedValue([])
        mockApi.listWorkflowEvents.mockResolvedValue([])
        mockApi.listArtifacts.mockResolvedValue([])
        mockApi.listRoleBindings.mockResolvedValue([])
        mockApi.listRuns.mockResolvedValue([])

        await store.createSession('New')

        expect(store.runs).toEqual([])
    })

    it('$reset clears runs', () => {
        const store = useAgentRoomStore()

        store.runs = [
            { id: 'r1', sessionId: 's1', taskId: 't1', status: 'completed', runnerName: 'mock', createdAt: '2025-01-01', updatedAt: '2025-01-01' },
        ]

        store.$reset()

        expect(store.runs).toEqual([])
    })

    it('removeSession clears runs when deleting the last session', async () => {
        const store = useAgentRoomStore()

        store.sessions = [{ id: 's1', name: 'Only', createdAt: '2025-01-01', updatedAt: '2025-01-01' }]
        store.currentSessionId = 's1'
        store.runs = [
            { id: 'r1', sessionId: 's1', taskId: 't1', status: 'completed', runnerName: 'mock', createdAt: '2025-01-01', updatedAt: '2025-01-01' },
        ]

        mockApi.deleteSession.mockResolvedValue({ success: true })

        await store.removeSession('s1')

        expect(store.runs).toEqual([])
        expect(store.currentSessionId).toBeNull()
    })
})

// ─── P5-1: View State & Run Events ─────────────────────────────
describe('Agent Room Client Store — P5-1 View State', () => {
    beforeEach(() => {
        setActivePinia(createPinia())
        vi.clearAllMocks()
        vi.useFakeTimers()
    })

    afterEach(() => {
        vi.useRealTimers()
    })

    it('activeView defaults to timeline', () => {
        const store = useAgentRoomStore()
        expect(store.activeView).toBe('timeline')
    })

    it('setActiveView changes activeView', () => {
        const store = useAgentRoomStore()
        store.setActiveView('runs')
        expect(store.activeView).toBe('runs')
        store.setActiveView('chat')
        expect(store.activeView).toBe('chat')
        store.setActiveView('artifacts')
        expect(store.activeView).toBe('artifacts')
    })

    it('$reset restores activeView to timeline', () => {
        const store = useAgentRoomStore()
        store.setActiveView('runs')
        store.$reset()
        expect(store.activeView).toBe('timeline')
    })
})

describe('Agent Room Client Store — P5-1 Run Events', () => {
    beforeEach(() => {
        setActivePinia(createPinia())
        vi.clearAllMocks()
    })

    it('selectSession loads runEvents in parallel batch', async () => {
        const store = useAgentRoomStore()

        mockApi.listMessages.mockResolvedValue([])
        mockApi.listTasks.mockResolvedValue([])
        mockApi.listReviews.mockResolvedValue([])
        mockApi.listWorkflowEvents.mockResolvedValue([])
        mockApi.listArtifacts.mockResolvedValue([])
        mockApi.listRoleBindings.mockResolvedValue([])
        mockApi.listRuns.mockResolvedValue([])
        mockApi.listRunEventsBySession.mockResolvedValue([
            { id: 'ev1', runId: 'r1', sessionId: 's1', taskId: 't1', source: 'mock', sequence: 1, eventType: 'run:started', createdAt: '2025-01-01T00:00:00Z' },
        ])

        await store.selectSession('s1')

        expect(mockApi.listRunEventsBySession).toHaveBeenCalledWith('s1')
        expect(store.runEvents).toHaveLength(1)
        expect(store.runEvents[0].eventType).toBe('run:started')
    })

    it('refreshCurrentSession loads runEvents', async () => {
        const store = useAgentRoomStore()
        store.currentSessionId = 's1'

        mockApi.listMessages.mockResolvedValue([])
        mockApi.listTasks.mockResolvedValue([])
        mockApi.listReviews.mockResolvedValue([])
        mockApi.listWorkflowEvents.mockResolvedValue([])
        mockApi.listArtifacts.mockResolvedValue([])
        mockApi.listRoleBindings.mockResolvedValue([])
        mockApi.listRuns.mockResolvedValue([])
        mockApi.listRunEventsBySession.mockResolvedValue([
            { id: 'ev1', runId: 'r1', sessionId: 's1', taskId: 't1', source: 'mock', sequence: 1, eventType: 'run:started', createdAt: '2025-01-01T00:00:00Z' },
            { id: 'ev2', runId: 'r1', sessionId: 's1', taskId: 't1', source: 'mock', sequence: 2, eventType: 'run:completed', createdAt: '2025-01-01T00:01:00Z' },
        ])

        await store.refreshCurrentSession()

        expect(store.runEvents).toHaveLength(2)
    })

    it('$reset clears runEvents', () => {
        const store = useAgentRoomStore()
        store.runEvents = [
            { id: 'ev1', runId: 'r1', sessionId: 's1', taskId: 't1', source: 'mock', sequence: 1, eventType: 'run:started', createdAt: '2025-01-01T00:00:00Z' },
        ]
        store.$reset()
        expect(store.runEvents).toEqual([])
    })
})

describe('Agent Room Client Store — P5-1 Computed Properties', () => {
    beforeEach(() => {
        setActivePinia(createPinia())
        vi.clearAllMocks()
    })

    it('activeRuns filters to queued and running runs', () => {
        const store = useAgentRoomStore()
        store.runs = [
            { id: 'r1', sessionId: 's1', taskId: 't1', status: 'completed', runnerName: 'mock', createdAt: '2025-01-01', updatedAt: '2025-01-01' },
            { id: 'r2', sessionId: 's1', taskId: 't1', status: 'running', runnerName: 'mock', createdAt: '2025-01-01', updatedAt: '2025-01-01' },
            { id: 'r3', sessionId: 's1', taskId: 't2', status: 'queued', runnerName: 'mock', createdAt: '2025-01-01', updatedAt: '2025-01-01' },
            { id: 'r4', sessionId: 's1', taskId: 't2', status: 'failed', runnerName: 'mock', createdAt: '2025-01-01', updatedAt: '2025-01-01' },
        ]

        expect(store.activeRuns).toHaveLength(2)
        expect(store.activeRuns.map((r: { id: string }) => r.id)).toEqual(['r2', 'r3'])
    })

    it('hasActiveRuns is true when there are queued or running runs', () => {
        const store = useAgentRoomStore()
        expect(store.hasActiveRuns).toBe(false)

        store.runs = [
            { id: 'r1', sessionId: 's1', taskId: 't1', status: 'running', runnerName: 'mock', createdAt: '2025-01-01', updatedAt: '2025-01-01' },
        ]
        expect(store.hasActiveRuns).toBe(true)

        store.runs = [
            { id: 'r1', sessionId: 's1', taskId: 't1', status: 'completed', runnerName: 'mock', createdAt: '2025-01-01', updatedAt: '2025-01-01' },
        ]
        expect(store.hasActiveRuns).toBe(false)
    })

    it('runEventsByRunId groups events by runId sorted by sequence', () => {
        const store = useAgentRoomStore()
        store.runEvents = [
            { id: 'ev3', runId: 'r2', sessionId: 's1', taskId: 't1', source: 'mock', sequence: 1, eventType: 'run:started', createdAt: '2025-01-01T00:02:00Z' },
            { id: 'ev1', runId: 'r1', sessionId: 's1', taskId: 't1', source: 'mock', sequence: 2, eventType: 'step:completed', createdAt: '2025-01-01T00:00:00Z' },
            { id: 'ev2', runId: 'r1', sessionId: 's1', taskId: 't1', source: 'mock', sequence: 1, eventType: 'run:started', createdAt: '2025-01-01T00:00:00Z' },
        ]

        const map = store.runEventsByRunId
        expect(map.size).toBe(2)
        expect(map.get('r1')).toHaveLength(2)
        // Should be sorted by sequence ascending
        expect(map.get('r1')![0].sequence).toBe(1)
        expect(map.get('r1')![1].sequence).toBe(2)
        expect(map.get('r2')).toHaveLength(1)
    })
})

describe('Agent Room Client Store — P5-1 Polling', () => {
    beforeEach(() => {
        setActivePinia(createPinia())
        vi.clearAllMocks()
        vi.useFakeTimers()
    })

    afterEach(() => {
        vi.useRealTimers()
    })

    it('refreshRunsAndEvents fetches runs and runEvents only', async () => {
        const store = useAgentRoomStore()
        store.currentSessionId = 's1'

        mockApi.listRuns.mockResolvedValue([
            { id: 'r1', sessionId: 's1', taskId: 't1', status: 'running', runnerName: 'mock', createdAt: '2025-01-01', updatedAt: '2025-01-01' },
        ])
        mockApi.listRunEventsBySession.mockResolvedValue([
            { id: 'ev1', runId: 'r1', sessionId: 's1', taskId: 't1', source: 'mock', sequence: 1, eventType: 'run:started', createdAt: '2025-01-01T00:00:00Z' },
        ])

        await store.refreshRunsAndEvents()

        expect(mockApi.listRuns).toHaveBeenCalledWith('s1')
        expect(mockApi.listRunEventsBySession).toHaveBeenCalledWith('s1')
        expect(store.runs).toHaveLength(1)
        expect(store.runEvents).toHaveLength(1)
        // Should NOT call full session refresh APIs
        expect(mockApi.listMessages).not.toHaveBeenCalled()
        expect(mockApi.listTasks).not.toHaveBeenCalled()
    })

    it('refreshRunsAndEvents does full refresh when all runs are terminal', async () => {
        const store = useAgentRoomStore()
        store.currentSessionId = 's1'

        mockApi.listRuns.mockResolvedValue([
            { id: 'r1', sessionId: 's1', taskId: 't1', status: 'completed', runnerName: 'mock', createdAt: '2025-01-01', updatedAt: '2025-01-01' },
        ])
        mockApi.listRunEventsBySession.mockResolvedValue([])
        mockApi.listMessages.mockResolvedValue([])
        mockApi.listTasks.mockResolvedValue([])
        mockApi.listReviews.mockResolvedValue([])
        mockApi.listWorkflowEvents.mockResolvedValue([])
        mockApi.listArtifacts.mockResolvedValue([])
        mockApi.listRoleBindings.mockResolvedValue([])

        await store.refreshRunsAndEvents()

        // Full refresh should have been triggered
        expect(mockApi.listMessages).toHaveBeenCalledWith('s1')
        expect(mockApi.listTasks).toHaveBeenCalledWith('s1')
    })

    it('refreshRunsAndEvents does nothing when no currentSessionId', async () => {
        const store = useAgentRoomStore()
        store.currentSessionId = null

        await store.refreshRunsAndEvents()

        expect(mockApi.listRuns).not.toHaveBeenCalled()
        expect(mockApi.listRunEventsBySession).not.toHaveBeenCalled()
    })

    it('$reset stops polling', () => {
        const store = useAgentRoomStore()
        store.currentSessionId = 's1'

        // Start polling by setting active runs
        store.runs = [
            { id: 'r1', sessionId: 's1', taskId: 't1', status: 'running', runnerName: 'mock', createdAt: '2025-01-01', updatedAt: '2025-01-01' },
        ]
        store.startPolling()

        store.$reset()

        // After reset, advancing timers should not trigger API calls
        vi.advanceTimersByTime(10000)
        expect(mockApi.listRuns).not.toHaveBeenCalled()
    })
})
