<script setup lang="ts">
import { ref } from 'vue'
import { useAgentRoomStore } from '@/stores/hermes/agent-room'
import type { AgentRoomTask } from '@/api/hermes/agent-room'
import AgentRoomWorkspace from './AgentRoomWorkspace.vue'
import AgentRoomMessageList from './AgentRoomMessageList.vue'
import AgentRoomTaskPanel from './AgentRoomTaskPanel.vue'
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
// NOTE: loadSessions is called once in AgentRoomView.vue onMounted;
// do NOT duplicate it here.

async function handleCreateSession() {
    const name = newSessionName.value.trim() || `会话 ${store.sessions.length + 1}`
    try {
        await store.createSession(name)
        // Only close form on success
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
        <!-- Session List (top bar) -->
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
            <!-- Top: Pixel Workspace (main visual area) -->
            <div class="workspace-area">
                <AgentRoomWorkspace />
            </div>

            <!-- Bottom: Messages + Task Panel -->
            <div class="bottom-panels">
                <!-- Left: Chat Messages -->
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

                <!-- Right: Task Panel -->
                <AgentRoomTaskPanel
                    :tasks="store.tasks"
                    :reviews="store.reviews"
                    :workflow-events="store.workflowEvents"
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
    background: var(--vscode-editor-background, #1e1e1e);
    color: var(--vscode-editor-foreground, #cccccc);
}

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

.session-bar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    border-bottom: 1px solid var(--vscode-widget-border, #3c3c3c);
    background: var(--vscode-sideBar-background, #252526);
    flex-shrink: 0;
    position: relative;
}

.session-list {
    display: flex;
    gap: 4px;
    overflow-x: auto;
    flex: 1;
}

.session-tab {
    padding: 4px 12px;
    border: 1px solid var(--vscode-widget-border, #3c3c3c);
    border-radius: 4px;
    background: transparent;
    color: var(--vscode-editor-foreground, #cccccc);
    cursor: pointer;
    white-space: nowrap;
    font-size: 12px;

    &.active {
        background: var(--vscode-button-background, #0e639c);
        color: var(--vscode-button-foreground, #ffffff);
        border-color: var(--vscode-button-background, #0e639c);
    }

    &:hover:not(.active) {
        background: var(--vscode-list-hoverBackground, #2a2d2e);
    }
}

.btn-new-session {
    padding: 4px 10px;
    border: 1px solid var(--vscode-widget-border, #3c3c3c);
    border-radius: 4px;
    background: transparent;
    color: var(--vscode-editor-foreground, #cccccc);
    cursor: pointer;
    font-size: 12px;
    white-space: nowrap;

    &:hover {
        background: var(--vscode-list-hoverBackground, #2a2d2e);
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
    background: var(--vscode-dropdown-background, #252526);
    border: 1px solid var(--vscode-widget-border, #3c3c3c);
    border-radius: 4px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);

    input {
        padding: 4px 8px;
        border: 1px solid var(--vscode-input-border, #3c3c3c);
        border-radius: 3px;
        background: var(--vscode-input-background, #3c3c3c);
        color: var(--vscode-input-foreground, #cccccc);
        font-size: 12px;
        outline: none;

        &:focus {
            border-color: var(--vscode-focusBorder, #007fd4);
        }
    }

    button {
        padding: 4px 10px;
        border: none;
        border-radius: 3px;
        background: var(--vscode-button-background, #0e639c);
        color: var(--vscode-button-foreground, #ffffff);
        cursor: pointer;
        font-size: 12px;

        &:hover {
            background: var(--vscode-button-hoverBackground, #1177bb);
        }
    }
}

.room-content {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
}

.workspace-area {
    flex: 1 1 60%;
    min-height: 280px;
    border-bottom: 1px solid var(--vscode-widget-border, #3c3c3c);
}

.bottom-panels {
    flex: 0 0 auto;
    display: flex;
    max-height: 40%;
    min-height: 180px;
}

.chat-area {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
    border-right: 1px solid var(--vscode-widget-border, #3c3c3c);
}

.chat-input-area {
    display: flex;
    gap: 8px;
    padding: 8px 12px;
    border-top: 1px solid var(--vscode-widget-border, #3c3c3c);
    background: var(--vscode-sideBar-background, #252526);
    flex-shrink: 0;

    textarea {
        flex: 1;
        resize: none;
        padding: 6px 8px;
        border: 1px solid var(--vscode-input-border, #3c3c3c);
        border-radius: 4px;
        background: var(--vscode-input-background, #3c3c3c);
        color: var(--vscode-input-foreground, #cccccc);
        font-size: 13px;
        font-family: inherit;
        outline: none;

        &:focus {
            border-color: var(--vscode-focusBorder, #007fd4);
        }
    }
}

.btn-send {
    padding: 6px 16px;
    border: none;
    border-radius: 4px;
    background: var(--vscode-button-background, #0e639c);
    color: var(--vscode-button-foreground, #ffffff);
    cursor: pointer;
    font-size: 13px;
    align-self: flex-end;

    &:hover:not(:disabled) {
        background: var(--vscode-button-hoverBackground, #1177bb);
    }

    &:disabled {
        opacity: 0.5;
        cursor: not-allowed;
    }
}

.empty-state {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 12px;
    color: var(--vscode-descriptionForeground, #999999);

    .empty-icon {
        font-size: 48px;
    }

    h2 {
        margin: 0;
        font-size: 20px;
        color: var(--vscode-editor-foreground, #cccccc);
    }

    p {
        margin: 0;
        font-size: 14px;
    }
}

.btn-primary {
    padding: 8px 20px;
    border: none;
    border-radius: 4px;
    background: var(--vscode-button-background, #0e639c);
    color: var(--vscode-button-foreground, #ffffff);
    cursor: pointer;
    font-size: 14px;

    &:hover {
        background: var(--vscode-button-hoverBackground, #1177bb);
    }
}
</style>
