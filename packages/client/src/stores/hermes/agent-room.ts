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
    AgentRoomRoleBinding,
    AgentRoomRole,
    AgentRoomRun,
    AgentRoomRunEvent,
    AgentRoomRoleRun,
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
    updateSessionConfig as apiUpdateSessionConfig,
    listReviews as apiListReviews,
    listWorkflowEvents as apiListWorkflowEvents,
    listArtifacts as apiListArtifacts,
    deleteArtifact as apiDeleteArtifact,
    startWorkflow as apiStartWorkflow,
    deleteSession as apiDeleteSession,
    deleteTask as apiDeleteTask,
    listRoleBindings as apiListRoleBindings,
    setRoleBinding as apiSetRoleBinding,
    deleteRoleBindingByRole as apiDeleteRoleBindingByRole,
    listRuns as apiListRuns,
    listRunEventsBySession as apiListRunEventsBySession,
    listRoleRunsByRun as apiListRoleRunsByRun,
} from '@/api/hermes/agent-room'


// ─── Store ─────────────────────────────────────────────────────
export type AgentRoomView = 'timeline' | 'chat' | 'artifacts' | 'runs'

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
    const roleBindings = ref<AgentRoomRoleBinding[]>([])
    const runs = ref<AgentRoomRun[]>([])
    const runEvents = ref<AgentRoomRunEvent[]>([])
    const roleRuns = ref<AgentRoomRoleRun[]>([])
    const loading = ref(false)
    const error = ref<string | null>(null)
    const activeTaskId = ref<string | null>(null)
    const actionLoadingTaskId = ref<string | null>(null)
    const creatingSession = ref(false)
    const activeView = ref<AgentRoomView>('timeline')
    let sessionsLoadSeq = 0
    let sessionDataLoadSeq = 0
    let pollingTimer: ReturnType<typeof setInterval> | null = null

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

    /** Map from role → binding for quick lookup */
    const roleBindingMap = computed(() => {
        const map = new Map<AgentRoomRole, AgentRoomRoleBinding>()
        for (const b of roleBindings.value) map.set(b.role, b)
        return map
    })

    /** Runs that are currently queued or running (for polling) */
    const activeRuns = computed(() =>
        runs.value.filter(r => r.status === 'queued' || r.status === 'running'),
    )

    /** Whether any run is actively executing */
    const hasActiveRuns = computed(() => activeRuns.value.length > 0)

    /** Run events grouped by runId for quick lookup */
    const runEventsByRunId = computed(() => {
        const map = new Map<string, AgentRoomRunEvent[]>()
        for (const evt of runEvents.value) {
            const list = map.get(evt.runId) ?? []
            list.push(evt)
            map.set(evt.runId, list)
        }
        // Sort each group by sequence ascending
        for (const list of map.values()) {
            list.sort((a, b) => a.sequence - b.sequence)
        }
        return map
    })

    /** Role runs grouped by runId for quick lookup */
    const roleRunsByRunId = computed(() => {
        const map = new Map<string, AgentRoomRoleRun[]>()
        for (const rr of roleRuns.value) {
            const list = map.get(rr.runId) ?? []
            list.push(rr)
            map.set(rr.runId, list)
        }
        return map
    })

    // ─── View Actions ──────────────────────────────────────────
    function setActiveView(view: AgentRoomView) {
        activeView.value = view
    }

    // ─── Polling for Active Runs ───────────────────────────────
    const POLL_INTERVAL_MS = 3000

    function startPolling() {
        stopPolling()
        pollingTimer = setInterval(async () => {
            if (!currentSessionId.value) return
            if (!hasActiveRuns.value) {
                stopPolling()
                return
            }
            await refreshRunsAndEvents()
        }, POLL_INTERVAL_MS)
    }

    function stopPolling() {
        if (pollingTimer) {
            clearInterval(pollingTimer)
            pollingTimer = null
        }
    }

    /** Lightweight refresh: only re-fetch runs + runEvents (not full session) */
    async function refreshRunsAndEvents() {
        if (!currentSessionId.value) return
        const sessionId = currentSessionId.value
        try {
            const [nextRuns, nextRunEvents] = await Promise.all([
                apiListRuns(sessionId),
                apiListRunEventsBySession(sessionId),
            ])
            if (currentSessionId.value !== sessionId) return
            runs.value = nextRuns
            runEvents.value = nextRunEvents
            // Refresh role runs for all active runs
            await refreshRoleRunsForRuns(nextRuns)
            // If no more active runs, stop polling immediately and do a full refresh
            if (nextRuns.every(r => r.status === 'completed' || r.status === 'failed')) {
                stopPolling()
                await refreshCurrentSession()
            }
        } catch {
            // Silently ignore polling errors; next tick will retry
        }
    }

    /** Fetch role runs for all workflow runs and merge into state */
    async function refreshRoleRunsForRuns(nextRuns: AgentRoomRun[]) {
        const allRoleRuns: AgentRoomRoleRun[] = []
        await Promise.all(nextRuns.map(async (run) => {
            try {
                const rr = await apiListRoleRunsByRun(run.id)
                allRoleRuns.push(...rr)
            } catch { /* ignore */ }
        }))
        roleRuns.value = allRoleRuns
    }

    /** Load role runs for a single run (called when expanding a run card) */
    async function loadRoleRunsForRun(runId: string) {
        try {
            const rr = await apiListRoleRunsByRun(runId)
            // Merge: replace role runs for this runId, keep others
            roleRuns.value = [
                ...roleRuns.value.filter(r => r.runId !== runId),
                ...rr,
            ]
        } catch { /* ignore */ }
    }

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
            runs.value = []
            runEvents.value = []
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
        roleBindings.value = []
        runs.value = []
        runEvents.value = []
        roleRuns.value = []

        try {
            const [nextMessages, nextTasks, nextReviews, nextWorkflowEvents, nextArtifacts, nextRoleBindings, nextRuns, nextRunEvents] = await Promise.all([
                apiListMessages(sessionId),
                apiListTasks(sessionId),
                apiListReviews(sessionId),
                apiListWorkflowEvents(sessionId),
                apiListArtifacts(sessionId),
                apiListRoleBindings(sessionId),
                apiListRuns(sessionId),
                apiListRunEventsBySession(sessionId),
            ])

            if (seq !== sessionDataLoadSeq || currentSessionId.value !== sessionId) return

            messages.value = nextMessages
            tasks.value = nextTasks
            reviews.value = nextReviews
            workflowEvents.value = nextWorkflowEvents
            artifacts.value = nextArtifacts
            roleBindings.value = nextRoleBindings
            runs.value = nextRuns
            runEvents.value = nextRunEvents

            // Fetch role runs for all workflow runs
            await refreshRoleRunsForRuns(nextRuns)

            // Auto-start polling if there are active runs
            if (nextRuns.some(r => r.status === 'queued' || r.status === 'running')) {
                startPolling()
            } else {
                stopPolling()
            }
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
            const [nextMessages, nextTasks, nextReviews, nextWorkflowEvents, nextArtifacts, nextRoleBindings, nextRuns, nextRunEvents] = await Promise.all([
                apiListMessages(sessionId),
                apiListTasks(sessionId),
                apiListReviews(sessionId),
                apiListWorkflowEvents(sessionId),
                apiListArtifacts(sessionId),
                apiListRoleBindings(sessionId),
                apiListRuns(sessionId),
                apiListRunEventsBySession(sessionId),
            ])

            if (seq !== sessionDataLoadSeq || currentSessionId.value !== sessionId) return

            messages.value = nextMessages
            tasks.value = nextTasks
            reviews.value = nextReviews
            workflowEvents.value = nextWorkflowEvents
            artifacts.value = nextArtifacts
            roleBindings.value = nextRoleBindings
            runs.value = nextRuns
            runEvents.value = nextRunEvents

            // Fetch role runs for all workflow runs
            await refreshRoleRunsForRuns(nextRuns)
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
                    roleBindings.value = []
                    runs.value = []
                    runEvents.value = []
                    roleRuns.value = []
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

    // ─── Role Binding Actions ──────────────────────────────────
    async function loadRoleBindings(sessionId: string) {
        try {
            roleBindings.value = await apiListRoleBindings(sessionId)
        } catch (err: any) {
            error.value = err.message
        }
    }

    async function saveRoleBinding(role: AgentRoomRole, profileName: string, provider?: string, model?: string) {
        if (!currentSessionId.value) return null
        error.value = null
        try {
            const binding = await apiSetRoleBinding(currentSessionId.value, role, profileName, provider, model)
            // Upsert locally: replace existing or append
            const idx = roleBindings.value.findIndex(b => b.role === role)
            if (idx >= 0) {
                roleBindings.value[idx] = binding
            } else {
                roleBindings.value.push(binding)
            }
            touchSession(currentSessionId.value)
            return binding
        } catch (err: any) {
            error.value = err.message
            throw err
        }
    }

    async function removeRoleBinding(role: AgentRoomRole) {
        if (!currentSessionId.value) return
        error.value = null
        try {
            await apiDeleteRoleBindingByRole(currentSessionId.value, role)
            // Local immediate update
            roleBindings.value = roleBindings.value.filter(b => b.role !== role)
            touchSession(currentSessionId.value)
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
            const result = await apiStartWorkflow(currentSessionId.value, taskId)
            touchSession(currentSessionId.value)
            // Insert the returned run locally for immediate UI feedback
            if (result.run) {
                const existing = runs.value.findIndex(r => r.id === result.run!.id)
                if (existing === -1) {
                    runs.value = [...runs.value, result.run]
                }
            }
            // Start polling immediately — the run is executing in the background
            startPolling()
        } catch (err: any) {
            error.value = err.message
            throw err
        } finally {
            actionLoadingTaskId.value = null
        }
    }

    // Compatibility alias — delegates to runWorkflow
    async function runMockWorkflow(taskId: string) {
        return runWorkflow(taskId)
    }

    // ─── Session Config Actions ─────────────────────────────────
    const autoDeliveryEnabled = computed(() =>
        currentSession.value?.autoDeliveryEnabled ?? false,
    )

    async function updateAutoDelivery(enabled: boolean) {
        if (!currentSessionId.value) return
        try {
            await apiUpdateSessionConfig(currentSessionId.value, { autoDeliveryEnabled: enabled })
            // Update local session object immediately
            const idx = sessions.value.findIndex(s => s.id === currentSessionId.value)
            if (idx >= 0) {
                sessions.value[idx] = { ...sessions.value[idx], autoDeliveryEnabled: enabled }
            }
        } catch (err: any) {
            error.value = err.message
            throw err
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
        stopPolling()
        sessionsLoadSeq++
        sessionDataLoadSeq++
        sessions.value = []
        currentSessionId.value = null
        messages.value = []
        tasks.value = []
        reviews.value = []
        workflowEvents.value = []
        artifacts.value = []
        roleBindings.value = []
        runs.value = []
        runEvents.value = []
        roleRuns.value = []
        loading.value = false
        error.value = null
        activeTaskId.value = null
        actionLoadingTaskId.value = null
        creatingSession.value = false
        activeView.value = 'timeline'
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
        roleBindings,
        runs,
        runEvents,
        roleRuns,
        agents,
        loading,
        error,
        activeTaskId,
        actionLoadingTaskId,
        creatingSession,
        activeView,
        // Computed
        currentSession,
        activeTask,
        agentMap,
        roleBindingMap,
        activeRuns,
        hasActiveRuns,
        runEventsByRunId,
        roleRunsByRunId,
        autoDeliveryEnabled,
        // Actions
        loadSessions,
        createSession,
        selectSession,
        refreshCurrentSession,
        refreshRunsAndEvents,
        loadRoleRunsForRun,
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
        loadRoleBindings,
        saveRoleBinding,
        removeRoleBinding,
        updateAutoDelivery,
        runWorkflow,
        runMockWorkflow,
        setActiveTask,
        setActiveView,
        startPolling,
        stopPolling,
        clearError,
        $reset,
    }
})
