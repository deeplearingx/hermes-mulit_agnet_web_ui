<script setup lang="ts">
import { computed, ref } from 'vue'
import type { RoomAgent, ChatMessage, GroupTask, GroupArtifact } from '@/api/hermes/group-chat'
import type { GroupRuntimeEvent } from '@/stores/hermes/group-chat'
import { useGroupChatStore } from '@/stores/hermes/group-chat'
import AgentStatusList from './AgentStatusList.vue'

const props = defineProps<{
    agents: RoomAgent[]
    contextStatuses: Map<string, { agentName: string; status: string }>
    messages: ChatMessage[]
    typingNames: string[]
    tasks: GroupTask[]
    artifacts: GroupArtifact[]
    liveEvents?: GroupRuntimeEvent[]
}>()

const store = useGroupChatStore()

const activeCount = computed(() => {
    let count = 0
    for (const [, status] of props.contextStatuses) {
        if (status.status === 'compressing' || status.status === 'replying') count++
    }
    return count
})

const activeRuns = computed(() => {
    if (!props.liveEvents) return 0
    const running = new Set<string>()
    for (const evt of props.liveEvents.slice(0, 20)) {
        if (evt.type === 'run_started') running.add(evt.agentId)
        if (evt.type === 'run_completed' || evt.type === 'run_failed') running.delete(evt.agentId)
    }
    return running.size
})

// ─── Task management ──────────────────────────────────────
const showNewTaskForm = ref(false)
const newTaskTitle = ref('')
const newTaskDesc = ref('')

const STATUS_LABELS: Record<string, string> = {
    draft: '📝 草稿',
    planning: '📐 规划中',
    running: '⚡ 执行中',
    reviewing: '🔍 审核中',
    done: '✅ 完成',
    failed: '❌ 失败',
}

const STATUS_COLORS: Record<string, string> = {
    draft: '#64748b',
    planning: '#8b5cf6',
    running: '#3b82f6',
    reviewing: '#f59e0b',
    done: '#22c55e',
    failed: '#ef4444',
}

const PHASE_LABELS: Record<string, string> = {
    requirement: '需求',
    planning: '规划',
    execution: '执行',
    review: '审核',
    delivery: '交付',
}

async function onCreateTask() {
    if (!newTaskTitle.value.trim()) return
    await store.addTask(newTaskTitle.value.trim(), newTaskDesc.value.trim() || undefined)
    newTaskTitle.value = ''
    newTaskDesc.value = ''
    showNewTaskForm.value = false
}

async function cycleTaskStatus(task: GroupTask) {
    const order = ['draft', 'planning', 'running', 'reviewing', 'done'] as const
    const idx = order.indexOf(task.status as any)
    const next = order[(idx + 1) % order.length]
    await store.patchTask(task.id, { status: next })
}

function artifactIcon(type: string): string {
    if (type.includes('code') || type.includes('script')) return '💻'
    if (type.includes('doc') || type.includes('text')) return '📄'
    if (type.includes('image')) return '🖼️'
    if (type.includes('data') || type.includes('json')) return '📊'
    return '📦'
}
</script>

<template>
    <div class="orchestration-panel">
        <!-- Stats header -->
        <div class="op-stats">
            <div class="op-stat">
                <span class="op-stat-value">{{ agents.length }}</span>
                <span class="op-stat-label">Agents</span>
            </div>
            <div class="op-stat">
                <span class="op-stat-value">{{ messages.length }}</span>
                <span class="op-stat-label">消息</span>
            </div>
            <div class="op-stat" :class="{ active: activeRuns > 0 }">
                <span class="op-stat-value">{{ activeRuns }}</span>
                <span class="op-stat-label">运行中</span>
            </div>
        </div>

        <!-- Agent status list -->
        <div class="op-section">
            <AgentStatusList
                :agents="agents"
                :context-statuses="contextStatuses"
            />
        </div>

        <!-- Typing indicator -->
        <div v-if="typingNames.length > 0" class="op-typing">
            <span class="typing-dots"><span /><span /><span /></span>
            <span>{{ typingNames.join(', ') }} 正在输入...</span>
        </div>

        <!-- Artifacts -->
        <div class="op-section op-artifacts">
            <div class="op-section-header">
                <span>📦 产出物</span>
                <span class="op-badge">{{ artifacts.length }}</span>
            </div>
            <div v-if="artifacts.length === 0" class="op-placeholder">
                暂无产出物
            </div>
            <div v-else class="op-artifact-list">
                <div
                    v-for="artifact in artifacts"
                    :key="artifact.id"
                    class="op-artifact-item"
                >
                    <span class="op-artifact-icon">{{ artifactIcon(artifact.type) }}</span>
                    <div class="op-artifact-info">
                        <span class="op-artifact-name">{{ artifact.name }}</span>
                        <span class="op-artifact-type">{{ artifact.type }}</span>
                    </div>
                </div>
            </div>
        </div>

        <!-- Tasks -->
        <div class="op-section op-tasks">
            <div class="op-section-header">
                <span>📋 任务</span>
                <button class="op-add-btn" @click="showNewTaskForm = !showNewTaskForm">+</button>
            </div>

            <!-- New task form -->
            <div v-if="showNewTaskForm" class="op-new-task-form">
                <input
                    v-model="newTaskTitle"
                    class="op-input"
                    placeholder="任务标题"
                    @keyup.enter="onCreateTask"
                />
                <input
                    v-model="newTaskDesc"
                    class="op-input"
                    placeholder="描述（可选）"
                    @keyup.enter="onCreateTask"
                />
                <button class="op-submit-btn" @click="onCreateTask">创建</button>
            </div>

            <div v-if="tasks.length === 0 && !showNewTaskForm" class="op-placeholder">
                暂无任务
            </div>
            <div v-else class="op-task-list">
                <div
                    v-for="task in tasks"
                    :key="task.id"
                    class="op-task-card"
                >
                    <div class="op-task-header">
                        <span class="op-task-title">{{ task.title }}</span>
                        <button
                            class="op-task-status-btn"
                            :style="{ color: STATUS_COLORS[task.status] }"
                            @click="cycleTaskStatus(task)"
                        >
                            {{ STATUS_LABELS[task.status] || task.status }}
                        </button>
                    </div>
                    <div v-if="task.description" class="op-task-desc">
                        {{ task.description }}
                    </div>
                    <div class="op-task-meta">
                        <span class="op-task-phase">{{ PHASE_LABELS[task.phase] || task.phase }}</span>
                        <span v-if="task.assigneeAgentId" class="op-task-assignee">
                            → {{ agents.find(a => a.agentId === task.assigneeAgentId)?.name || task.assigneeAgentId }}
                        </span>
                    </div>
                </div>
            </div>
        </div>
    </div>
</template>

<style scoped lang="scss">
.orchestration-panel {
    display: flex;
    flex-direction: column;
    background: #0c1222;
    border: 1px solid #1e293b;
    border-radius: 6px;
    overflow: hidden;
    font-family: 'Courier New', monospace;
    height: 100%;
}

.op-stats {
    display: flex;
    border-bottom: 1px solid #1e293b;
    background: #111827;
}

.op-stat {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 8px 4px;
    border-right: 1px solid #1e293b;

    &:last-child {
        border-right: none;
    }

    &.active .op-stat-value {
        color: #3b82f6;
        animation: pulse-value 1.5s infinite;
    }
}

@keyframes pulse-value {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.6; }
}

.op-stat-value {
    font-size: 16px;
    font-weight: 700;
    color: #e2e8f0;
}

.op-stat-label {
    font-size: 9px;
    color: #64748b;
    text-transform: uppercase;
    letter-spacing: 1px;
}

.op-section {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    border-bottom: 1px solid #1e293b;
}

.op-section-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 12px;
    background: #111827;
    border-bottom: 1px solid #1e293b;
    font-size: 11px;
    font-weight: 600;
    color: #94a3b8;
    text-transform: uppercase;
    letter-spacing: 1px;
}

.op-badge {
    font-size: 9px;
    color: #475569;
    background: #1e293b;
    padding: 1px 6px;
    border-radius: 8px;
}

.op-placeholder {
    padding: 16px 12px;
    text-align: center;
    color: #334155;
    font-size: 11px;
    font-style: italic;
}

.op-add-btn {
    background: #1e293b;
    color: #94a3b8;
    border: 1px solid #334155;
    border-radius: 4px;
    width: 20px;
    height: 20px;
    font-size: 14px;
    line-height: 1;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;

    &:hover {
        background: #334155;
        color: #e2e8f0;
    }
}

.op-new-task-form {
    padding: 8px 12px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    border-bottom: 1px solid #1e293b;
}

.op-input {
    background: #0f1729;
    border: 1px solid #1e293b;
    border-radius: 4px;
    padding: 6px 8px;
    color: #e2e8f0;
    font-size: 11px;
    font-family: 'Courier New', monospace;
    outline: none;

    &:focus {
        border-color: #3b82f6;
    }

    &::placeholder {
        color: #334155;
    }
}

.op-submit-btn {
    background: #1e40af;
    color: #e2e8f0;
    border: none;
    border-radius: 4px;
    padding: 6px;
    font-size: 11px;
    font-family: 'Courier New', monospace;
    cursor: pointer;

    &:hover {
        background: #2563eb;
    }
}

.op-artifact-list {
    padding: 4px 0;
}

.op-artifact-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 12px;
    cursor: default;

    &:hover {
        background: rgba(59, 130, 246, 0.05);
    }
}

.op-artifact-icon {
    font-size: 14px;
    flex-shrink: 0;
}

.op-artifact-info {
    display: flex;
    flex-direction: column;
    min-width: 0;
}

.op-artifact-name {
    font-size: 11px;
    color: #e2e8f0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

.op-artifact-type {
    font-size: 9px;
    color: #475569;
}

.op-task-list {
    padding: 4px 0;
}

.op-task-card {
    padding: 8px 12px;
    border-bottom: 1px solid #0f1729;

    &:hover {
        background: rgba(59, 130, 246, 0.03);
    }
}

.op-task-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
}

.op-task-title {
    font-size: 11px;
    color: #e2e8f0;
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

.op-task-status-btn {
    background: none;
    border: 1px solid #1e293b;
    border-radius: 4px;
    padding: 2px 6px;
    font-size: 9px;
    font-family: 'Courier New', monospace;
    cursor: pointer;
    white-space: nowrap;
    flex-shrink: 0;

    &:hover {
        border-color: #334155;
    }
}

.op-task-desc {
    font-size: 10px;
    color: #64748b;
    margin-top: 4px;
    line-height: 1.4;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
}

.op-task-meta {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 4px;
}

.op-task-phase {
    font-size: 9px;
    color: #475569;
    background: #1e293b;
    padding: 1px 6px;
    border-radius: 4px;
}

.op-task-assignee {
    font-size: 9px;
    color: #64748b;
}

.op-typing {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 12px;
    background: rgba(59, 130, 246, 0.05);
    border-bottom: 1px solid #1e293b;
    font-size: 11px;
    color: #60a5fa;
}

.typing-dots {
    display: inline-flex;
    gap: 2px;

    span {
        width: 4px;
        height: 4px;
        border-radius: 50%;
        background: #60a5fa;
        animation: typing-bounce 1.4s infinite;

        &:nth-child(2) { animation-delay: 0.2s; }
        &:nth-child(3) { animation-delay: 0.4s; }
    }
}

@keyframes typing-bounce {
    0%, 60%, 100% { transform: translateY(0); }
    30% { transform: translateY(-4px); }
}
</style>
