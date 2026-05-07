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
    AgentRoomArtifact,
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
    listArtifacts as apiListArtifacts,
    deleteArtifact as apiDeleteArtifact,
    runWorkflow as apiRunWorkflow,
    deleteSession as apiDeleteSession,
    deleteTask as apiDeleteTask,
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
    const artifacts = ref<AgentRoomArtifact[]>([])
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
        // Re-entry guard: prevent duplicate creates
        if (creatingSession.value) return null
        creatingSession.value = true
        error.value = null
        // Invalidate any in-flight loadSessions so stale results don't overwrite
        ++sessionsLoadSeq
        try {
            const session = await apiCreateSession(name)
            // Immutable front-insert with dedup
            sessions.value = [session, ...sessions.value.filter(s => s.id !== session.id)]
            currentSessionId.value = session.id
            activeTaskId.value = null
            // Clear stale data from previous session
            messages.value = []
            tasks.value = []
            reviews.value = []
            workflowEvents.value = []
            artifacts.value = []
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
        // Immediately clear stale data from previous session
        messages.value = []
        tasks.value = []
        reviews.value = []
        workflowEvents.value = []
        artifacts.value = []

        try {
            const [nextMessages, nextTasks, nextReviews, nextWorkflowEvents, nextArtifacts] = await Promise.all([
                apiListMessages(sessionId),
                apiListTasks(sessionId),
                apiListReviews(sessionId),
                apiListWorkflowEvents(sessionId),
                apiListArtifacts(sessionId),
            ])

            if (seq !== sessionDataLoadSeq || currentSessionId.value !== sessionId) return

            messages.value = nextMessages
            tasks.value = nextTasks
            reviews.value = nextReviews
            workflowEvents.value = nextWorkflowEvents
            artifacts.value = nextArtifacts
        } catch (err: any) {
            if (seq !== sessionDataLoadSeq || currentSessionId.value !== sessionId) return
            error.value = err.message
        }
    }

    // ─── Unified Refresh ───────────────────────────────────────
    async function refreshCurrentSession() {
        if (!currentSessionId.value) return
        const sessionId = currentSessionId.value
        const seq = ++sessionDataLoadSeq

        try {
            const [nextMessages, nextTasks, nextReviews, nextWorkflowEvents, nextArtifacts] = await Promise.all([
                apiListMessages(sessionId),
                apiListTasks(sessionId),
                apiListReviews(sessionId),
                apiListWorkflowEvents(sessionId),
                apiListArtifacts(sessionId),
            ])

            if (seq !== sessionDataLoadSeq || currentSessionId.value !== sessionId) return

            messages.value = nextMessages
            tasks.value = nextTasks
            reviews.value = nextReviews
            workflowEvents.value = nextWorkflowEvents
            artifacts.value = nextArtifacts
        } catch (err: any) {
            if (seq !== sessionDataLoadSeq || currentSessionId.value !== sessionId) return
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

    // ─── Local Session Touch ────────────────────────────────────
    // Bump session updatedAt locally and re-sort by most-recent first
    function touchSession(sessionId: string) {
        const idx = sessions.value.findIndex(s => s.id === sessionId)
        if (idx < 0) return
        sessions.value[idx] = { ...sessions.value[idx], updatedAt: new Date().toISOString() }
        // Immutable sort: most recently active first
        sessions.value = [...sessions.value].sort(
            (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
        )
    }

    async function sendUserMessage(content: string) {
        if (!currentSessionId.value) return
        try {
            const msg = await apiSendMessage(currentSessionId.value, content)
            messages.value.push(msg)
            touchSession(currentSessionId.value)
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
            touchSession(currentSessionId.value)
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
            touchSession(currentSessionId.value)
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
            touchSession(currentSessionId.value)
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
            touchSession(currentSessionId.value)
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

    // ─── Delete Actions ─────────────────────────────────────────
    async function removeSession(sessionId: string) {
        error.value = null
        // Invalidate any in-flight loadSessions so stale results don't overwrite
        ++sessionsLoadSeq
        try {
            await apiDeleteSession(sessionId)
            // Remove from local list
            sessions.value = sessions.value.filter(s => s.id !== sessionId)
            // If deleted the current session, switch or clear
            if (currentSessionId.value === sessionId) {
                if (sessions.value.length > 0) {
                    await selectSession(sessions.value[0].id)
                } else {
                    // Invalidate any in-flight session data requests
                    ++sessionDataLoadSeq
                    currentSessionId.value = null
                    messages.value = []
                    tasks.value = []
                    reviews.value = []
                    workflowEvents.value = []
                    artifacts.value = []
                    activeTaskId.value = null
                }
            }
        } catch (err: any) {
            error.value = err.message
            throw err
        }
    }

    async function removeTask(taskId: string) {
        if (!currentSessionId.value) return
        error.value = null
        try {
            await apiDeleteTask(currentSessionId.value, taskId)
            // If deleted the active task, reselect next non-terminal or clear
            if (activeTaskId.value === taskId) {
                const remaining = tasks.value.filter(t => t.id !== taskId)
                const nextActive = remaining.find(t => !['completed', 'failed'].includes(t.status))
                activeTaskId.value = nextActive?.id ?? null
            }
            touchSession(currentSessionId.value)
            // Refresh to ensure consistency
            await refreshCurrentSession()
        } catch (err: any) {
            error.value = err.message
            throw err
        }
    }

    // ─── Artifact Actions ──────────────────────────────────────
    async function removeArtifact(artifactId: string) {
        if (!currentSessionId.value) return
        error.value = null
        try {
            await apiDeleteArtifact(currentSessionId.value, artifactId)
            // Local immediate update: filter out the deleted artifact
            artifacts.value = artifacts.value.filter(a => a.id !== artifactId)
        } catch (err: any) {
            error.value = err.message
            throw err
        }
    }

    // ─── Workflow Actions ──────────────────────────────────────
    // Primary workflow entry point — delegates to server-side runner
    async function runWorkflow(taskId: string) {
        if (!currentSessionId.value) return
        actionLoadingTaskId.value = taskId
        error.value = null
        try {
            await apiRunWorkflow(currentSessionId.value, taskId)
            touchSession(currentSessionId.value)
            await refreshCurrentSession()
        } catch (err: any) {
            error.value = err.message
            throw err
        } finally {
            actionLoadingTaskId.value = null
        }
    }

    // Compatibility alias — delegates to runWorkflow
    async function runMockWorkflow(taskId: string) {
        if (!currentSessionId.value) return
        actionLoadingTaskId.value = taskId
        error.value = null
        try {
            await apiRunWorkflow(currentSessionId.value, taskId)
            touchSession(currentSessionId.value)
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
        artifacts.value = []
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
        artifacts,
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
        removeSession,
        removeTask,
        removeArtifact,
        loadReviews,
        loadWorkflowEvents,
        runWorkflow,
        runMockWorkflow,
        setActiveTask,
        clearError,
        $reset,
    }
})
