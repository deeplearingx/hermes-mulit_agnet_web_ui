// ─── Agent Room Store ──────────────────────────────────────────
// Independent from useGroupChatStore. v1 with mock workflow state machine.

import { ref, computed } from 'vue'
import { defineStore } from 'pinia'
import type {
    AgentRoomAgent,
    AgentRoomTask,
    AgentRoomTaskStatus,
    AgentRoomReview,
    AgentRoomMessage,
    AgentRoomWorkflowEvent,
    AgentRoomSession,
} from '@/api/hermes/agent-room'
import {
    AGENT_ROOM_AGENTS,
    createSession as apiCreateSession,
    listSessions as apiListSessions,
    listMessages as apiListMessages,
    sendMessage as apiSendMessage,
    listTasks as apiListTasks,
    createTask as apiCreateTask,
    updateTaskStatus as apiUpdateTaskStatus,
    submitReview as apiSubmitReview,
    retryTask as apiRetryTask,
    deliverTask as apiDeliverTask,
    listWorkflowEvents as apiListWorkflowEvents,
    runWorkflow as apiRunWorkflow,
} from '@/api/hermes/agent-room'


// ─── Store ─────────────────────────────────────────────────────
export const useAgentRoomStore = defineStore('agentRoom', () => {
    // ─── State ─────────────────────────────────────────────────
    const sessions = ref<AgentRoomSession[]>([])
    const currentSessionId = ref<string | null>(null)
    const messages = ref<AgentRoomMessage[]>([])
    const tasks = ref<AgentRoomTask[]>([])
    const reviews = ref<AgentRoomReview[]>([])
    const workflowEvents = ref<AgentRoomWorkflowEvent[]>([])
    const agents = ref<AgentRoomAgent[]>([...AGENT_ROOM_AGENTS])
    const loading = ref(false)
    const error = ref<string | null>(null)

    // ─── Computed ──────────────────────────────────────────────
    const currentSession = computed(() =>
        sessions.value.find(s => s.id === currentSessionId.value) ?? null,
    )

    const activeTask = computed(() =>
        tasks.value.find(t =>
            !['completed', 'failed'].includes(t.status),
        ) ?? null,
    )

    const agentMap = computed(() => {
        const map = new Map<string, AgentRoomAgent>()
        for (const a of agents.value) map.set(a.id, a)
        return map
    })

    // ─── Session Actions ───────────────────────────────────────
    async function loadSessions() {
        try {
            sessions.value = await apiListSessions()
        } catch (err: any) {
            error.value = err.message
        }
    }

    async function createSession(name: string) {
        try {
            const session = await apiCreateSession(name)
            sessions.value.push(session)
            currentSessionId.value = session.id
            return session
        } catch (err: any) {
            error.value = err.message
            throw err
        }
    }

    async function selectSession(sessionId: string) {
        currentSessionId.value = sessionId
        await Promise.all([
            loadMessages(sessionId),
            loadTasks(sessionId),
            loadWorkflowEvents(sessionId),
        ])
    }

    // ─── Message Actions ───────────────────────────────────────
    async function loadMessages(sessionId: string) {
        try {
            messages.value = await apiListMessages(sessionId)
        } catch (err: any) {
            error.value = err.message
        }
    }

    async function sendUserMessage(content: string) {
        if (!currentSessionId.value) return
        try {
            const msg = await apiSendMessage(currentSessionId.value, content)
            messages.value.push(msg)
        } catch (err: any) {
            error.value = err.message
            throw err
        }
    }

    // ─── Task Actions ──────────────────────────────────────────
    async function loadTasks(sessionId: string) {
        try {
            tasks.value = await apiListTasks(sessionId)
        } catch (err: any) {
            error.value = err.message
        }
    }

    async function addTask(title: string, description?: string, assignedAgentId?: string) {
        if (!currentSessionId.value) return null
        try {
            const task = await apiCreateTask(currentSessionId.value, { title, description, assignedAgentId })
            tasks.value.push(task)
            return task
        } catch (err: any) {
            error.value = err.message
            throw err
        }
    }

    async function advanceTask(taskId: string, targetStatus: AgentRoomTaskStatus) {
        if (!currentSessionId.value) return null
        try {
            const task = await apiUpdateTaskStatus(currentSessionId.value, taskId, targetStatus)
            const idx = tasks.value.findIndex(t => t.id === taskId)
            if (idx >= 0) tasks.value[idx] = task
            return task
        } catch (err: any) {
            error.value = err.message
            throw err
        }
    }

    async function submitTaskReview(taskId: string, reviewerAgentId: string, status: 'passed' | 'rejected', comment?: string) {
        if (!currentSessionId.value) return null
        try {
            const review = await apiSubmitReview(currentSessionId.value, taskId, {
                reviewerAgentId,
                status,
                comment: comment ?? '',
            })
            reviews.value.push(review)

            // Server already transitions task status inside submitReview.
            // Reload tasks to stay in sync and avoid double state transitions.
            await loadTasks(currentSessionId.value)
            return review
        } catch (err: any) {
            error.value = err.message
            throw err
        }
    }

    async function retryTask(taskId: string) {
        if (!currentSessionId.value) return null
        try {
            const task = await apiRetryTask(currentSessionId.value, taskId)
            const idx = tasks.value.findIndex(t => t.id === taskId)
            if (idx >= 0) tasks.value[idx] = task
            return task
        } catch (err: any) {
            error.value = err.message
            throw err
        }
    }

    async function deliverTask(taskId: string) {
        if (!currentSessionId.value) return null
        try {
            const task = await apiDeliverTask(currentSessionId.value, taskId)
            const idx = tasks.value.findIndex(t => t.id === taskId)
            if (idx >= 0) tasks.value[idx] = task
            return task
        } catch (err: any) {
            error.value = err.message
            throw err
        }
    }

    // ─── Workflow Events ───────────────────────────────────────
    async function loadWorkflowEvents(sessionId: string) {
        try {
            workflowEvents.value = await apiListWorkflowEvents(sessionId)
        } catch (err: any) {
            error.value = err.message
        }
    }

    // ─── Mock Workflow (v1) ────────────────────────────────────
    // Calls server-side mock workflow, then reloads messages/tasks/events
    async function runMockWorkflow(taskId: string) {
        if (!currentSessionId.value) return
        try {
            await apiRunWorkflow(currentSessionId.value, taskId)
            // Reload all data from server after workflow completes
            await Promise.all([
                loadMessages(currentSessionId.value),
                loadTasks(currentSessionId.value),
                loadWorkflowEvents(currentSessionId.value),
            ])
        } catch (err: any) {
            error.value = err.message
            throw err
        }
    }

    // ─── Reset ─────────────────────────────────────────────────
    function $reset() {
        sessions.value = []
        currentSessionId.value = null
        messages.value = []
        tasks.value = []
        reviews.value = []
        workflowEvents.value = []
        loading.value = false
        error.value = null
    }

    return {
        // State
        sessions,
        currentSessionId,
        messages,
        tasks,
        reviews,
        workflowEvents,
        agents,
        loading,
        error,
        // Computed
        currentSession,
        activeTask,
        agentMap,
        // Actions
        loadSessions,
        createSession,
        selectSession,
        loadMessages,
        sendUserMessage,
        loadTasks,
        addTask,
        advanceTask,
        submitTaskReview,
        retryTask,
        deliverTask,
        loadWorkflowEvents,
        runMockWorkflow,
        $reset,
    }
})
