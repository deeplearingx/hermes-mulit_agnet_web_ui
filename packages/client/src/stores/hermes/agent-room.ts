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
    listReviews as apiListReviews,
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
    const activeTaskId = ref<string | null>(null)
    const actionLoadingTaskId = ref<string | null>(null)
    const creatingSession = ref(false)
    let sessionsLoadSeq = 0
    let sessionDataLoadSeq = 0

    // ─── Computed ──────────────────────────────────────────────
    const currentSession = computed(() =>
        sessions.value.find(s => s.id === currentSessionId.value) ?? null,
    )

    const activeTask = computed(() => {
        // Priority 1: explicit activeTaskId
        if (activeTaskId.value) {
            const found = tasks.value.find(t => t.id === activeTaskId.value)
            if (found) return found
        }
        // Priority 2: first non-terminal task
        return tasks.value.find(t =>
            !['completed', 'failed'].includes(t.status),
        ) ?? null
    })

    const agentMap = computed(() => {
        const map = new Map<string, AgentRoomAgent>()
        for (const a of agents.value) map.set(a.id, a)
        return map
    })

    // ─── Session Actions ───────────────────────────────────────
    async function loadSessions() {
        const seq = ++sessionsLoadSeq
        try {
            const result = await apiListSessions()
            // Stale request guard: discard if a newer loadSessions was issued
            if (seq !== sessionsLoadSeq) return
            sessions.value = result
        } catch (err: any) {
            if (seq !== sessionsLoadSeq) return
            error.value = err.message
        }
    }

    async function createSession(name: string) {
        creatingSession.value = true
        error.value = null
        try {
            const session = await apiCreateSession(name)
            // Dedup insert: skip if session id already present
            if (!sessions.value.some(s => s.id === session.id)) {
                sessions.value.push(session)
            }
            currentSessionId.value = session.id
            activeTaskId.value = null
            // Clear stale data from previous session
            messages.value = []
            tasks.value = []
            reviews.value = []
            workflowEvents.value = []
            // Load data for the newly created session
            await refreshCurrentSession()
            return session
        } catch (err: any) {
            error.value = err.message
            throw err
        } finally {
            creatingSession.value = false
        }
    }

    async function selectSession(sessionId: string) {
        const seq = ++sessionDataLoadSeq
        currentSessionId.value = sessionId
        activeTaskId.value = null
        error.value = null

        try {
            const [nextMessages, nextTasks, nextReviews, nextWorkflowEvents] = await Promise.all([
                apiListMessages(sessionId),
                apiListTasks(sessionId),
                apiListReviews(sessionId),
                apiListWorkflowEvents(sessionId),
            ])

            if (seq !== sessionDataLoadSeq || currentSessionId.value !== sessionId) return

            messages.value = nextMessages
            tasks.value = nextTasks
            reviews.value = nextReviews
            workflowEvents.value = nextWorkflowEvents
        } catch (err: any) {
            if (seq !== sessionDataLoadSeq) return
            error.value = err.message
        }
    }

    // ─── Unified Refresh ───────────────────────────────────────
    async function refreshCurrentSession() {
        if (!currentSessionId.value) return
        const sessionId = currentSessionId.value
        const seq = ++sessionDataLoadSeq

        try {
            const [nextMessages, nextTasks, nextReviews, nextWorkflowEvents] = await Promise.all([
                apiListMessages(sessionId),
                apiListTasks(sessionId),
                apiListReviews(sessionId),
                apiListWorkflowEvents(sessionId),
            ])

            if (seq !== sessionDataLoadSeq || currentSessionId.value !== sessionId) return

            messages.value = nextMessages
            tasks.value = nextTasks
            reviews.value = nextReviews
            workflowEvents.value = nextWorkflowEvents
        } catch (err: any) {
            if (seq !== sessionDataLoadSeq) return
            error.value = err.message
        }
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
            activeTaskId.value = task.id
            // Server now emits task_created event + message; refresh to pick them up
            await refreshCurrentSession()
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
        actionLoadingTaskId.value = taskId
        error.value = null
        try {
            const review = await apiSubmitReview(currentSessionId.value, taskId, {
                reviewerAgentId,
                status,
                comment: comment ?? '',
            })
            await refreshCurrentSession()
            return review
        } catch (err: any) {
            error.value = err.message
            throw err
        } finally {
            actionLoadingTaskId.value = null
        }
    }

    async function retryTask(taskId: string) {
        if (!currentSessionId.value) return null
        actionLoadingTaskId.value = taskId
        error.value = null
        try {
            await apiRetryTask(currentSessionId.value, taskId)
            await refreshCurrentSession()
        } catch (err: any) {
            error.value = err.message
            throw err
        } finally {
            actionLoadingTaskId.value = null
        }
    }

    async function deliverTask(taskId: string) {
        if (!currentSessionId.value) return null
        actionLoadingTaskId.value = taskId
        error.value = null
        try {
            await apiDeliverTask(currentSessionId.value, taskId)
            await refreshCurrentSession()
        } catch (err: any) {
            error.value = err.message
            throw err
        } finally {
            actionLoadingTaskId.value = null
        }
    }

    // ─── Reviews ───────────────────────────────────────────────
    async function loadReviews(sessionId: string) {
        try {
            reviews.value = await apiListReviews(sessionId)
        } catch (err: any) {
            error.value = err.message
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
    // Calls server-side mock workflow, then reloads all data
    async function runMockWorkflow(taskId: string) {
        if (!currentSessionId.value) return
        actionLoadingTaskId.value = taskId
        error.value = null
        try {
            await apiRunWorkflow(currentSessionId.value, taskId)
            await refreshCurrentSession()
        } catch (err: any) {
            error.value = err.message
            throw err
        } finally {
            actionLoadingTaskId.value = null
        }
    }

    // ─── Reset ─────────────────────────────────────────────────
    function setActiveTask(taskId: string | null) {
        activeTaskId.value = taskId
    }

    function clearError() {
        error.value = null
    }

    function $reset() {
        sessionsLoadSeq++
        sessionDataLoadSeq++
        sessions.value = []
        currentSessionId.value = null
        messages.value = []
        tasks.value = []
        reviews.value = []
        workflowEvents.value = []
        loading.value = false
        error.value = null
        activeTaskId.value = null
        actionLoadingTaskId.value = null
        creatingSession.value = false
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
        activeTaskId,
        actionLoadingTaskId,
        creatingSession,
        // Computed
        currentSession,
        activeTask,
        agentMap,
        // Actions
        loadSessions,
        createSession,
        selectSession,
        refreshCurrentSession,
        loadMessages,
        sendUserMessage,
        loadTasks,
        addTask,
        advanceTask,
        submitTaskReview,
        retryTask,
        deliverTask,
        loadReviews,
        loadWorkflowEvents,
        runMockWorkflow,
        setActiveTask,
        clearError,
        $reset,
    }
})
