<script setup lang="ts">
import { ref } from 'vue'
import { useAgentRoomStore } from '@/stores/hermes/agent-room'
import type { AgentRoomTask } from '@/api/hermes/agent-room'
import AgentRoomWorkspace from './AgentRoomWorkspace.vue'
import AgentRoomMessageList from './AgentRoomMessageList.vue'
import AgentRoomTaskPanel from './AgentRoomTaskPanel.vue'
import AgentRoomEventFeed from './AgentRoomEventFeed.vue'
import CreateTaskModal from './CreateTaskModal.vue'
import ReviewDecisionModal from './ReviewDecisionModal.vue'

const store = useAgentRoomStore()

const inputText = ref('')
const showNewSession = ref(false)
const newSessionName = ref('')

// ─── Modal State ───────────────────────────────────────────────
const showCreateTask = ref(false)
const showReviewDecision = ref(false)
const reviewTargetTask = ref<AgentRoomTask | null>(null)
const creatingTask = ref(false)
const submittingReview = ref(false)

// ─── Session Management ────────────────────────────────────────
async function handleCreateSession() {
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
    await store.runMockWorkflow(taskId)
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
</script>

<template>
    <div class="agent-room-panel">
        <!-- Top: Session Tabs -->
        <div class="session-bar">
            <div class="session-list">
                <button
                    v-for="session in store.sessions"
                    :key="session.id"
                    class="session-tab"
                    :class="{ active: session.id === store.currentSessionId }"
                    @click="handleSelectSession(session.id)"
                >
                    {{ session.name }}
                </button>
            </div>
            <button class="btn-new-session" :disabled="store.creatingSession" @click="showNewSession = !showNewSession">
                + 新建会话
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
            <!-- Middle: Workspace + Right Info Panel -->
            <div class="workspace-main">
                <div class="workspace-center">
                    <div class="workspace-canvas">
                        <AgentRoomWorkspace />
                    </div>
                </div>
                <div class="workspace-panel">
                    <AgentRoomTaskPanel
                        :tasks="store.tasks"
                        :reviews="store.reviews"
                        :workflow-events="store.workflowEvents"
                        :agents="store.agents"
                        :active-task-id="store.activeTaskId"
                        :action-loading-task-id="store.actionLoadingTaskId"
                        @create-task="showCreateTask = true"
                        @run-workflow="handleRunWorkflow"
                        @open-review="handleOpenReview"
                        @deliver-task="handleDeliverTask"
                        @select-task="handleSelectTask"
                    />
                </div>
            </div>

            <!-- Bottom: Event Feed + Message Input -->
            <div class="bottom-panels">
                <div class="event-feed-area">
                    <AgentRoomEventFeed
                        :messages="store.messages"
                        :workflow-events="store.workflowEvents"
                        :reviews="store.reviews"
                    />
                </div>
                <div class="chat-area">
                    <AgentRoomMessageList :messages="store.messages" />
                    <div class="chat-input-area">
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
    padding: 4px 12px;
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

.workspace-panel {
    width: 280px;
    flex-shrink: 0;
    min-height: 0;
}

// ─── Bottom Panels ─────────────────────────────────────────────
.bottom-panels {
    display: flex;
    gap: 8px;
    padding: 0 8px 8px;
    flex-shrink: 0;
    max-height: 280px;
}

.event-feed-area {
    width: 360px;
    flex-shrink: 0;
}

.chat-area {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
    background: #0c1222;
    border: 1px solid #1e293b;
    border-radius: 6px;
    overflow: hidden;
}

.chat-input-area {
    display: flex;
    gap: 4px;
    padding: 6px 8px;
    border-top: 1px solid #1e293b;
    background: #111827;

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

    .bottom-panels {
        flex-direction: column;
        max-height: none;
    }

    .event-feed-area {
        width: 100%;
    }
}
</style>
