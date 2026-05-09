<script setup lang="ts">
import { ref } from 'vue'
import { useAgentRoomStore, type AgentRoomView } from '@/stores/hermes/agent-room'
import type { AgentRoomTask, AgentRoomRole } from '@/api/hermes/agent-room'
import AgentRoomWorkspace from './AgentRoomWorkspace.vue'
import AgentRoomTaskPanel from './AgentRoomTaskPanel.vue'
import AgentRoomTimelineView from './AgentRoomTimelineView.vue'
import AgentRoomChatView from './AgentRoomChatView.vue'
import AgentRoomArtifactsView from './AgentRoomArtifactsView.vue'
import AgentRoomRunsView from './AgentRoomRunsView.vue'
import CreateTaskModal from './CreateTaskModal.vue'
import ReviewDecisionModal from './ReviewDecisionModal.vue'
import AgentRoomRoleBindingModal from './AgentRoomRoleBindingModal.vue'

const store = useAgentRoomStore()

const inputText = ref('')
const showNewSession = ref(false)
const newSessionName = ref('')
const taskPanelRef = ref<InstanceType<typeof AgentRoomTaskPanel> | null>(null)

// ─── Modal State ───────────────────────────────────────────────
const showCreateTask = ref(false)
const showReviewDecision = ref(false)
const reviewTargetTask = ref<AgentRoomTask | null>(null)
const creatingTask = ref(false)
const submittingReview = ref(false)
const showRoleBindings = ref(false)
const savingRoleBinding = ref(false)

// ─── Session Management ────────────────────────────────────────
async function handleCreateSession() {
    if (store.creatingSession) return
    const name = newSessionName.value.trim() || `会话 ${store.sessions.length + 1}`
    try {
        await store.createSession(name)
        newSessionName.value = ''
        showNewSession.value = false
    } catch {
        // Error already set in store; keep form open for retry
    }
}

async function handleSelectSession(sessionId: string) {
    if (sessionId === store.currentSessionId) return
    await store.selectSession(sessionId)
}

// ─── Message Sending ───────────────────────────────────────────
async function handleSend() {
    const content = inputText.value.trim()
    if (!content || !store.currentSessionId) return
    inputText.value = ''
    await store.sendUserMessage(content)
}

function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        handleSend()
    }
}

// ─── Task Actions ──────────────────────────────────────────────
async function handleCreateTaskSubmit(data: { title: string; description: string }) {
    creatingTask.value = true
    try {
        await store.addTask(data.title, data.description || undefined)
        showCreateTask.value = false
    } catch {
        // Failure: keep modal open for retry
    } finally {
        creatingTask.value = false
    }
}

async function handleRunWorkflow(taskId: string) {
    await store.runWorkflow(taskId)
}

function handleOpenReview(taskId: string) {
    const task = store.tasks.find(t => t.id === taskId)
    if (!task) return
    reviewTargetTask.value = task
    showReviewDecision.value = true
}

async function handleReviewSubmit(data: { status: 'passed' | 'rejected'; comment: string }) {
    if (!reviewTargetTask.value) return
    submittingReview.value = true
    try {
        await store.submitTaskReview(reviewTargetTask.value.id, 'reviewer', data.status, data.comment)
        showReviewDecision.value = false
        reviewTargetTask.value = null
    } catch {
        // Failure: keep modal open for retry
    } finally {
        submittingReview.value = false
    }
}

async function handleDeliverTask(taskId: string) {
    await store.deliverTask(taskId)
}

function handleSelectTask(taskId: string) {
    store.setActiveTask(taskId)
}

// ─── Delete Actions ─────────────────────────────────────────────
async function handleDeleteSession(sessionId: string) {
    const session = store.sessions.find(s => s.id === sessionId)
    const name = session?.name ?? sessionId
    if (!window.confirm(`确认删除会话「${name}」？该会话下任务、消息、审核记录、事件流和产出物都会删除。`)) return
    try {
        await store.removeSession(sessionId)
    } catch {
        // Error already set in store
    }
}

async function handleDeleteTask(taskId: string) {
    const task = store.tasks.find(t => t.id === taskId)
    const title = task?.title ?? taskId
    if (!window.confirm(`确认删除任务「${title}」？相关审核记录、工作流事件、任务消息和产出物也会删除。`)) return
    try {
        await store.removeTask(taskId)
    } catch {
        // Error already set in store
    }
}

async function handleDeleteArtifact(artifactId: string) {
    const artifact = store.artifacts.find(a => a.id === artifactId)
    const name = artifact?.name ?? artifactId
    if (!window.confirm(`确认删除产出物「${name}」？此操作不可恢复。`)) return
    try {
        await store.removeArtifact(artifactId)
        // Notify TaskPanel to clear expand state after successful deletion
        taskPanelRef.value?.clearExpandedArtifact(artifactId)
    } catch {
        // Error already set in store
    }
}

// ─── Role Binding Actions ──────────────────────────────────────
async function handleSaveRoleBinding(data: { role: AgentRoomRole; profileName: string }) {
    savingRoleBinding.value = true
    try {
        await store.saveRoleBinding(data.role, data.profileName)
    } catch {
        // Error already set in store
    } finally {
        savingRoleBinding.value = false
    }
}

async function handleDeleteRoleBinding(role: AgentRoomRole) {
    savingRoleBinding.value = true
    try {
        await store.removeRoleBinding(role)
    } catch {
        // Error already set in store
    } finally {
        savingRoleBinding.value = false
    }
}
</script>

<template>
    <div class="agent-room-panel">
        <!-- Top: Session Tabs -->
        <div class="session-bar">
            <div class="session-list">
                <div
                    v-for="session in store.sessions"
                    :key="session.id"
                    class="session-tab"
                    :class="{ active: session.id === store.currentSessionId }"
                    @click="handleSelectSession(session.id)"
                >
                    <span class="session-tab-name">{{ session.name }}</span>
                    <button
                        class="btn-delete-session"
                        title="删除会话"
                        @click.stop="handleDeleteSession(session.id)"
                    >✕</button>
                </div>
            </div>
            <button class="btn-new-session" :disabled="store.creatingSession" @click="showNewSession = !showNewSession">
                + 新建会话
            </button>
            <button
                v-if="store.currentSessionId"
                class="btn-role-bindings"
                title="角色 Profile 绑定"
                @click="showRoleBindings = true"
            >
                🔗 角色绑定
            </button>
            <div v-if="showNewSession" class="new-session-form">
                <input
                    v-model="newSessionName"
                    placeholder="会话名称"
                    :disabled="store.creatingSession"
                    @keydown.enter="handleCreateSession"
                />
                <button :disabled="store.creatingSession" @click="handleCreateSession">
                    {{ store.creatingSession ? '创建中...' : '创建' }}
                </button>
            </div>
        </div>

        <!-- Error Banner -->
        <div v-if="store.error" class="error-banner">
            <span class="error-text">⚠️ {{ store.error }}</span>
            <button class="error-dismiss" @click="store.clearError()">✕</button>
        </div>

        <!-- Main Content -->
        <div v-if="store.currentSessionId" class="room-content">
            <!-- Workspace Main: Center (canvas + views) + Right Panel -->
            <div class="workspace-main">
                <div class="workspace-center">
                    <div class="workspace-canvas">
                        <AgentRoomWorkspace />
                    </div>
                    <!-- View Tabs -->
                    <div class="view-tabs">
                        <button
                            v-for="tab in ([
                                { key: 'timeline', label: 'Timeline', icon: '📊' },
                                { key: 'chat', label: 'Chat', icon: '💬' },
                                { key: 'artifacts', label: 'Artifacts', icon: '📦' },
                                { key: 'runs', label: 'Runs', icon: '⚡' },
                            ] as const)"
                            :key="tab.key"
                            class="view-tab"
                            :class="{ active: store.activeView === tab.key }"
                            @click="store.setActiveView(tab.key)"
                        >
                            <span class="tab-icon">{{ tab.icon }}</span>
                            <span class="tab-label">{{ tab.label }}</span>
                            <span v-if="tab.key === 'runs' && store.hasActiveRuns" class="tab-badge">●</span>
                        </button>
                    </div>
                    <!-- View Content -->
                    <div class="view-content">
                        <AgentRoomTimelineView
                            v-if="store.activeView === 'timeline'"
                            :run-events="store.runEvents"
                            :workflow-events="store.workflowEvents"
                        />
                        <AgentRoomChatView
                            v-else-if="store.activeView === 'chat'"
                            :messages="store.messages"
                        />
                        <AgentRoomArtifactsView
                            v-else-if="store.activeView === 'artifacts'"
                            :artifacts="store.artifacts"
                            :tasks="store.tasks"
                            @delete-artifact="handleDeleteArtifact"
                        />
                        <AgentRoomRunsView
                            v-else-if="store.activeView === 'runs'"
                            :runs="store.runs"
                            :run-events="store.runEvents"
                            :tasks="store.tasks"
                            :has-active-runs="store.hasActiveRuns"
                        />
                    </div>
                    <!-- Chat Input (always visible for quick message sending) -->
                    <div class="stream-input">
                        <textarea
                            v-model="inputText"
                            placeholder="输入消息..."
                            rows="2"
                            @keydown="handleKeydown"
                        />
                        <button class="btn-send" @click="handleSend" :disabled="!inputText.trim()">
                            发送
                        </button>
                    </div>
                </div>
                <div class="workspace-panel">
                    <AgentRoomTaskPanel
                        ref="taskPanelRef"
                        :tasks="store.tasks"
                        :reviews="store.reviews"
                        :workflow-events="store.workflowEvents"
                        :agents="store.agents"
                        :artifacts="store.artifacts"
                        :role-bindings="store.roleBindings"
                        :active-task-id="store.activeTaskId"
                        :action-loading-task-id="store.actionLoadingTaskId"
                        @create-task="showCreateTask = true"
                        @run-workflow="handleRunWorkflow"
                        @open-review="handleOpenReview"
                        @deliver-task="handleDeliverTask"
                        @select-task="handleSelectTask"
                        @delete-task="handleDeleteTask"
                        @delete-artifact="handleDeleteArtifact"
                    />
                </div>
            </div>
        </div>

        <!-- Empty State -->
        <div v-else class="empty-state">
            <div class="empty-icon">🤖</div>
            <h2>Agent 工作室</h2>
            <p>选择一个会话或创建新会话开始工作</p>
            <button class="btn-primary" :disabled="store.creatingSession" @click="handleCreateSession">
                {{ store.creatingSession ? '创建中...' : '创建第一个会话' }}
            </button>
        </div>

        <!-- Modals -->
        <CreateTaskModal
            :visible="showCreateTask"
            :loading="creatingTask"
            @close="showCreateTask = false"
            @submit="handleCreateTaskSubmit"
        />
        <ReviewDecisionModal
            :visible="showReviewDecision"
            :loading="submittingReview"
            :task-title="reviewTargetTask?.title ?? ''"
            :revision-round="reviewTargetTask?.revisionRound ?? 0"
            :max-revision-rounds="reviewTargetTask?.maxRevisionRounds ?? 3"
            @close="showReviewDecision = false; reviewTargetTask = null"
            @submit="handleReviewSubmit"
        />
        <AgentRoomRoleBindingModal
            :visible="showRoleBindings"
            :role-bindings="store.roleBindings"
            :saving="savingRoleBinding"
            @close="showRoleBindings = false"
            @save="handleSaveRoleBinding"
            @delete="handleDeleteRoleBinding"
        />
    </div>
</template>

<style scoped lang="scss">
.agent-room-panel {
    height: 100%;
    display: flex;
    flex-direction: column;
    background: #0a0f1e;
    color: #e2e8f0;
    font-family: 'Courier New', monospace;
}

// ─── Error Banner ──────────────────────────────────────────────
.error-banner {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 12px;
    background: rgba(239, 68, 68, 0.15);
    border-bottom: 1px solid rgba(239, 68, 68, 0.3);
    flex-shrink: 0;

    .error-text {
        flex: 1;
        font-size: 12px;
        color: #fca5a5;
    }

    .error-dismiss {
        padding: 2px 6px;
        border: none;
        background: transparent;
        color: #fca5a5;
        cursor: pointer;
        font-size: 12px;

        &:hover {
            background: rgba(239, 68, 68, 0.2);
        }
    }
}

// ─── Session Bar ───────────────────────────────────────────────
.session-bar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 12px;
    border-bottom: 1px solid #1e293b;
    background: #111827;
    flex-shrink: 0;
    position: relative;
}

.session-list {
    display: flex;
    gap: 2px;
    overflow-x: auto;
    flex: 1;
    scrollbar-width: none;

    &::-webkit-scrollbar {
        display: none;
    }
}

.session-tab {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 4px 8px;
    border: 1px solid #1e293b;
    border-radius: 3px;
    background: transparent;
    color: #94a3b8;
    cursor: pointer;
    font-size: 11px;
    font-family: 'Courier New', monospace;
    white-space: nowrap;
    transition: all 0.15s;

    &:hover {
        background: #1e293b;
        color: #e2e8f0;
    }

    &.active {
        background: #1e3a5f;
        border-color: #3b82f6;
        color: #e2e8f0;
    }
}

.session-tab-name {
    overflow: hidden;
    text-overflow: ellipsis;
}

.btn-delete-session {
    width: 14px;
    height: 14px;
    display: flex;
    align-items: center;
    justify-content: center;
    border: none;
    border-radius: 2px;
    background: transparent;
    color: #64748b;
    cursor: pointer;
    font-size: 9px;
    line-height: 1;
    padding: 0;
    flex-shrink: 0;
    opacity: 0;
    transition: opacity 0.15s;

    .session-tab:hover & {
        opacity: 1;
    }

    .session-tab.active & {
        opacity: 1;
    }

    &:hover {
        background: rgba(239, 68, 68, 0.2);
        color: #fca5a5;
    }
}

.btn-new-session {
    padding: 4px 10px;
    border: 1px solid #334155;
    border-radius: 3px;
    background: transparent;
    color: #94a3b8;
    cursor: pointer;
    font-size: 11px;
    font-family: 'Courier New', monospace;
    white-space: nowrap;

    &:hover {
        background: #1e293b;
        color: #e2e8f0;
    }
}

.btn-role-bindings {
    padding: 4px 10px;
    border: 1px solid #334155;
    border-radius: 3px;
    background: transparent;
    color: #94a3b8;
    cursor: pointer;
    font-size: 11px;
    font-family: 'Courier New', monospace;
    white-space: nowrap;
    margin-left: 4px;

    &:hover {
        background: #1e293b;
        color: #e2e8f0;
    }
}

.new-session-form {
    position: absolute;
    top: 100%;
    left: 12px;
    z-index: 10;
    display: flex;
    gap: 4px;
    padding: 8px;
    background: #111827;
    border: 1px solid #1e293b;
    border-radius: 4px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);

    input {
        padding: 4px 8px;
        border: 1px solid #334155;
        border-radius: 3px;
        background: #0f1729;
        color: #e2e8f0;
        font-size: 12px;
        font-family: 'Courier New', monospace;
        outline: none;

        &:focus {
            border-color: #3b82f6;
        }
    }

    button {
        padding: 4px 10px;
        border: 1px solid #3b82f6;
        border-radius: 3px;
        background: #1e3a5f;
        color: #e2e8f0;
        cursor: pointer;
        font-size: 11px;
        font-family: 'Courier New', monospace;

        &:hover {
            background: #2563eb;
        }
    }
}

// ─── Main Content ──────────────────────────────────────────────
.room-content {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
}

// ─── Workspace Main (middle area) ──────────────────────────────
.workspace-main {
    flex: 1;
    display: flex;
    gap: 8px;
    min-height: 0;
    padding: 8px;
    background: #0a0f1e;
}

.workspace-center {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
}

.workspace-canvas {
    flex: 1;
    min-height: 300px;
    border-radius: 6px;
    overflow: hidden;
}

.view-tabs {
    display: flex;
    gap: 2px;
    padding: 4px 0;
    margin-top: 8px;
    flex-shrink: 0;
}

.view-tab {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 4px 10px;
    border: 1px solid #1e293b;
    border-radius: 3px 3px 0 0;
    background: transparent;
    color: #64748b;
    cursor: pointer;
    font-size: 11px;
    font-family: 'Courier New', monospace;
    white-space: nowrap;
    transition: all 0.15s;
    position: relative;

    &:hover {
        background: #1e293b;
        color: #94a3b8;
    }

    &.active {
        background: #0c1222;
        border-color: #1e293b;
        border-bottom-color: #0c1222;
        color: #e2e8f0;
    }
}

.tab-icon {
    font-size: 11px;
}

.tab-label {
    font-size: 11px;
}

.tab-badge {
    color: #22c55e;
    font-size: 8px;
    animation: pulse-dot 2s infinite;
}

.view-content {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    border: 1px solid #1e293b;
    border-top: none;
    border-radius: 0 0 6px 6px;
    overflow: hidden;
}

.stream-input {
    display: flex;
    gap: 4px;
    padding: 6px 8px;
    border-top: 1px solid #1e293b;
    background: #111827;
    border-radius: 0 0 6px 6px;

    textarea {
        flex: 1;
        padding: 4px 8px;
        border: 1px solid #334155;
        border-radius: 3px;
        background: #0f1729;
        color: #e2e8f0;
        font-size: 12px;
        font-family: 'Courier New', monospace;
        resize: none;
        outline: none;

        &:focus {
            border-color: #3b82f6;
        }
    }
}

.btn-send {
    padding: 4px 12px;
    border: 1px solid #3b82f6;
    border-radius: 3px;
    background: #1e3a5f;
    color: #e2e8f0;
    cursor: pointer;
    font-size: 11px;
    font-family: 'Courier New', monospace;
    align-self: flex-end;

    &:hover:not(:disabled) {
        background: #2563eb;
    }

    &:disabled {
        opacity: 0.4;
        cursor: not-allowed;
    }
}

.workspace-panel {
    width: 280px;
    flex-shrink: 0;
    min-height: 0;
}

// ─── Empty State ───────────────────────────────────────────────
.empty-state {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 12px;
    color: #64748b;

    .empty-icon {
        font-size: 48px;
    }

    h2 {
        font-size: 18px;
        color: #94a3b8;
        font-family: 'Courier New', monospace;
    }

    p {
        font-size: 13px;
        font-family: 'Courier New', monospace;
    }
}

.btn-primary {
    padding: 8px 20px;
    border: 1px solid #3b82f6;
    border-radius: 4px;
    background: #1e3a5f;
    color: #e2e8f0;
    cursor: pointer;
    font-size: 13px;
    font-family: 'Courier New', monospace;

    &:hover:not(:disabled) {
        background: #2563eb;
    }

    &:disabled {
        opacity: 0.5;
        cursor: not-allowed;
    }
}

// ─── Responsive ────────────────────────────────────────────────
@media (max-width: 900px) {
    .workspace-main {
        flex-direction: column;
    }

    .workspace-panel {
        width: 100%;
        max-height: 300px;
    }

    .view-content {
        min-height: 200px;
    }
}
</style>
