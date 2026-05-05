<script setup lang="ts">
import { computed, ref } from 'vue'
import type { RoomAgent, ChatMessage, GroupTask, GroupArtifact } from '@/api/hermes/group-chat'
import type { GroupRuntimeEvent } from '@/stores/hermes/group-chat'
import { useGroupChatStore } from '@/stores/hermes/group-chat'
import type { AgentWorkspaceState } from './runtime/types'
import AgentStatusList from './AgentStatusList.vue'

const props = defineProps<{
    agents: RoomAgent[]
    // P0-2: key is agentId
    contextStatuses: Map<string, { agentId: string; agentName: string; status: string }>
    messages: ChatMessage[]
    typingNames: string[]
    tasks: GroupTask[]
    artifacts: GroupArtifact[]
    liveEvents?: GroupRuntimeEvent[]
    agentWorkspaceStates: AgentWorkspaceState[]  // P8-3: pre-computed from store
    displayTask: GroupTask | null                 // P8-1: display-driven task
}>()

const store = useGroupChatStore()

// ─── Phase pipeline ──────────────────────────────────────
const PHASES = [
    { key: 'requirement', label: '需求', icon: '📋' },
    { key: 'planning', label: '规划', icon: '📐' },
    { key: 'coding', label: '开发', icon: '⚡' },
    { key: 'review', label: '审核', icon: '🔍' },
    { key: 'delivery', label: '交付', icon: '📦' },
] as const

const PHASE_LABELS: Record<string, string> = {
    requirement: '需求',
    planning: '规划',
    coding: '开发',
    review: '审核',
    delivery: '交付',
}

// P11-6: Main task for the task card — use displayTask (shows draft/done too)
const mainTask = computed(() => props.displayTask)

const activePhaseIndex = computed(() => {
    if (!mainTask.value) return -1
    return PHASES.findIndex(p => p.key === mainTask.value!.phase)
})

// ─── Stats ───────────────────────────────────────────────
const activeRuns = computed(() => store.activeRunAgentIds.size)

const activeCount = computed(() => {
    let count = 0
    for (const [, status] of props.contextStatuses) {
        if (['compressing', 'replying', 'calling_tool'].includes(status.status)) count++
    }
    return count
})

// ─── Task management ─────────────────────────────────────
const showNewTaskForm = ref(false)
const newTaskTitle = ref('')
const newTaskDesc = ref('')
const newTaskAssignee = ref('')
const newTaskPhase = ref<string>('requirement')

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

async function onCreateTask() {
    if (!newTaskTitle.value.trim()) return
    await store.addTask(
        newTaskTitle.value.trim(),
        newTaskDesc.value.trim() || undefined,
        newTaskAssignee.value || undefined,
        newTaskPhase.value || undefined,
    )
    newTaskTitle.value = ''
    newTaskDesc.value = ''
    newTaskAssignee.value = ''
    newTaskPhase.value = 'requirement'
    showNewTaskForm.value = false
}

// P12-3: Task action buttons with dispatch semantics
const TASK_ACTIONS: Record<string, Array<{
    label: string
    key: string
    icon: string
    isDispatch: boolean  // true = dispatch to agent, false = manual patch
}>> = {
    draft: [
        { label: '开始规划', key: 'start_planning', icon: '📐', isDispatch: true },
    ],
    planning: [
        { label: '开始开发', key: 'start_coding', icon: '⚡', isDispatch: true },
    ],
    running: [
        { label: '提交审核', key: 'request_review', icon: '🔍', isDispatch: true },
        { label: '标记失败', key: 'mark_failed', icon: '❌', isDispatch: false },
    ],
    reviewing: [
        { label: '审核通过', key: 'deliver', icon: '✅', isDispatch: true },
        { label: '打回修改', key: 'revise', icon: '↩️', isDispatch: true },
    ],
    done: [
        { label: '重新打开', key: 'reopen', icon: '🔄', isDispatch: false },
    ],
    failed: [
        { label: '重新开始', key: 'restart', icon: '🔄', isDispatch: false },
    ],
}

// Manual patch transitions for non-dispatch actions
const MANUAL_PATCHES: Record<string, { status: string; phase?: string; keepPhase?: boolean }> = {
    mark_failed: { status: 'failed', keepPhase: true },
    reopen: { status: 'running', phase: 'coding' },
    restart: { status: 'draft', phase: 'requirement' },
}

async function executeTaskAction(
    task: GroupTask,
    action: { key: string; isDispatch: boolean },
) {
    if (action.isDispatch) {
        // Dispatch to agent via backend
        await store.dispatchTask(task.id, action.key, task.assigneeAgentId || undefined)
    } else {
        // Manual patch (mark_failed, reopen, restart)
        const patch = MANUAL_PATCHES[action.key]
        if (patch) {
            const phase = patch.keepPhase ? task.phase : (patch.phase ?? task.phase)
            await store.patchTask(task.id, { status: patch.status, phase })
        }
    }
}

function artifactIcon(type: string): string {
    if (type.includes('code') || type.includes('script')) return '💻'
    if (type.includes('doc') || type.includes('text')) return '📄'
    if (type.includes('image')) return '🖼️'
    if (type.includes('data') || type.includes('json')) return '📊'
    return '📦'
}

// ─── Issue list (recent failures) ───────────────────────
const recentIssues = computed(() => {
    if (!props.liveEvents) return []
    return props.liveEvents
        .filter(e => e.type === 'run_failed')
        .slice(0, 5)
})
</script>

<template>
    <div class="orchestration-panel">
        <!-- 1. Main Task Card -->
        <div class="op-main-task">
            <div class="op-mt-header">
                <span class="op-mt-title">🎯 主任务</span>
                <button class="op-add-btn" @click="showNewTaskForm = !showNewTaskForm">+</button>
            </div>
            <!-- P11-6: Show mainTask (displayTask) with explicit action buttons -->
            <div v-if="mainTask" class="op-mt-card">
                <div class="op-mt-card-top">
                    <span class="op-mt-name">{{ mainTask.title }}</span>
                    <span
                        class="op-task-status-badge"
                        :style="{ color: STATUS_COLORS[mainTask.status] }"
                    >
                        {{ STATUS_LABELS[mainTask.status] || mainTask.status }}
                    </span>
                </div>
                <div v-if="mainTask.description" class="op-mt-desc">
                    {{ mainTask.description }}
                </div>
                <div class="op-mt-meta">
                    <span v-if="mainTask.assigneeAgentId" class="op-mt-assignee">
                        → {{ agents.find(a => a.agentId === mainTask.assigneeAgentId)?.name || mainTask.assigneeAgentId }}
                    </span>
                </div>
                <!-- P11-6: Explicit action buttons -->
                <div v-if="TASK_ACTIONS[mainTask.status]" class="op-mt-actions">
                    <button
                        v-for="action in TASK_ACTIONS[mainTask.status]"
                        :key="action.key"
                        class="op-action-btn"
                        @click="executeTaskAction(mainTask, action)"
                    >
                        {{ action.icon }} {{ action.label }}
                    </button>
                </div>
            </div>
            <div v-else class="op-placeholder">
                暂无任务，点击 + 创建
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
                <select v-model="newTaskAssignee" class="op-input op-select">
                    <option value="">未指定负责人</option>
                    <option v-for="a in agents" :key="a.agentId" :value="a.agentId">{{ a.name }}</option>
                </select>
                <select v-model="newTaskPhase" class="op-input op-select">
                    <option value="requirement">📋 需求</option>
                    <option value="planning">📐 规划</option>
                    <option value="coding">⚡ 开发</option>
                    <option value="review">🔍 审核</option>
                    <option value="delivery">📦 交付</option>
                </select>
                <button class="op-submit-btn" @click="onCreateTask">创建</button>
            </div>
        </div>

        <!-- 2. Phase Progress Pipeline -->
        <div class="op-phase-pipeline">
            <div
                v-for="(phase, idx) in PHASES"
                :key="phase.key"
                class="op-phase-step"
                :class="{
                    active: idx === activePhaseIndex,
                    done: idx < activePhaseIndex,
                }"
            >
                <span class="op-phase-icon">{{ phase.icon }}</span>
                <span class="op-phase-label">{{ phase.label }}</span>
                <span v-if="idx < PHASES.length - 1" class="op-phase-arrow">›</span>
            </div>
        </div>

        <!-- 3. Stats bar -->
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

        <!-- 4. Agent Execution List -->
        <div class="op-section op-agents">
            <AgentStatusList
                :agent-states="agentWorkspaceStates"
            />
        </div>

        <!-- Typing indicator -->
        <div v-if="typingNames.length > 0" class="op-typing">
            <span class="typing-dots"><span /><span /><span /></span>
            <span>{{ typingNames.join(', ') }} 正在输入...</span>
        </div>

        <!-- 5. Artifact List -->
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

        <!-- 6. Issue List (recent failures) -->
        <div v-if="recentIssues.length > 0" class="op-section op-issues">
            <div class="op-section-header op-issue-header">
                <span>⚠️ 风险 / 失败</span>
                <span class="op-badge op-badge-warn">{{ recentIssues.length }}</span>
            </div>
            <div class="op-issue-list">
                <div
                    v-for="issue in recentIssues"
                    :key="issue.id"
                    class="op-issue-item"
                >
                    <span class="op-issue-agent">{{ issue.agentName }}</span>
                    <span class="op-issue-time">{{ new Date(issue.timestamp).toLocaleTimeString() }}</span>
                </div>
            </div>
        </div>

        <!-- 7. Other tasks (collapsed) -->
        <div v-if="tasks.length > 1" class="op-section op-other-tasks">
            <div class="op-section-header">
                <span>📋 其他任务</span>
                <span class="op-badge">{{ tasks.length - 1 }}</span>
            </div>
            <div class="op-task-list">
                <div
                    v-for="task in tasks.filter(t => t.id !== mainTask?.id)"
                    :key="task.id"
                    class="op-task-card"
                >
                    <div class="op-task-header">
                        <span class="op-task-title">{{ task.title }}</span>
                        <span
                            class="op-task-status-badge"
                            :style="{ color: STATUS_COLORS[task.status] }"
                        >
                            {{ STATUS_LABELS[task.status] || task.status }}
                        </span>
                    </div>
                    <div class="op-task-meta">
                        <span class="op-task-phase">{{ PHASE_LABELS[task.phase] || task.phase }}</span>
                        <span v-if="task.assigneeAgentId" class="op-task-assignee">
                            → {{ agents.find(a => a.agentId === task.assigneeAgentId)?.name || task.assigneeAgentId }}
                        </span>
                    </div>
                    <!-- P11-6: Explicit action buttons for other tasks too -->
                    <div v-if="TASK_ACTIONS[task.status]" class="op-task-actions">
                        <button
                            v-for="action in TASK_ACTIONS[task.status]"
                            :key="action.key"
                            class="op-action-btn-sm"
                            @click="executeTaskAction(task, action)"
                        >
                            {{ action.icon }} {{ action.label }}
                        </button>
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
    overflow-y: auto;
    overflow-x: hidden;
    font-family: 'Courier New', monospace;
    height: 100%;
    gap: 0;
}

// ─── Main Task Card ──────────────────────────────────────
.op-main-task {
    border-bottom: 1px solid #1e293b;
}

.op-mt-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 12px;
    background: #111827;
    border-bottom: 1px solid #1e293b;
}

.op-mt-title {
    font-size: 11px;
    font-weight: 600;
    color: #94a3b8;
    text-transform: uppercase;
    letter-spacing: 1px;
}

.op-mt-card {
    padding: 10px 12px;
    background: rgba(59, 130, 246, 0.04);
}

.op-mt-card-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
}

.op-mt-name {
    font-size: 13px;
    font-weight: 700;
    color: #e2e8f0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

.op-mt-desc {
    font-size: 10px;
    color: #64748b;
    margin-top: 4px;
    line-height: 1.4;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
}

.op-mt-meta {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 4px;
}

.op-mt-assignee {
    font-size: 10px;
    color: #60a5fa;
}

// ─── Phase Pipeline ──────────────────────────────────────
.op-phase-pipeline {
    display: flex;
    align-items: center;
    padding: 8px 12px;
    gap: 2px;
    border-bottom: 1px solid #1e293b;
    background: #0f1729;
    flex-wrap: wrap;
}

.op-phase-step {
    display: flex;
    align-items: center;
    gap: 3px;
    padding: 3px 6px;
    border-radius: 4px;
    font-size: 10px;
    color: #334155;
    transition: all 0.2s;

    &.done {
        color: #22c55e;
        .op-phase-icon { opacity: 1; }
    }

    &.active {
        color: #3b82f6;
        background: rgba(59, 130, 246, 0.1);
        .op-phase-icon { opacity: 1; }
        .op-phase-label { font-weight: 600; }
    }
}

.op-phase-icon {
    font-size: 12px;
    opacity: 0.5;
}

.op-phase-label {
    font-size: 10px;
}

.op-phase-arrow {
    color: #1e293b;
    font-size: 14px;
    margin: 0 2px;
}

// ─── Stats ───────────────────────────────────────────────
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
    padding: 6px 4px;
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
    font-size: 14px;
    font-weight: 700;
    color: #e2e8f0;
}

.op-stat-label {
    font-size: 9px;
    color: #64748b;
    text-transform: uppercase;
    letter-spacing: 1px;
}

// ─── Sections ────────────────────────────────────────────
.op-section {
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

.op-badge-warn {
    color: #f59e0b;
    background: rgba(245, 158, 11, 0.15);
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

// ─── New Task Form ───────────────────────────────────────
.op-new-task-form {
    padding: 8px 12px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    border-top: 1px solid #1e293b;
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

// ─── Artifacts ───────────────────────────────────────────
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

// ─── Issues ──────────────────────────────────────────────
.op-issue-header {
    color: #f59e0b !important;
}

.op-issue-list {
    padding: 4px 0;
}

.op-issue-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6px 12px;
    font-size: 10px;

    &:hover {
        background: rgba(245, 158, 11, 0.05);
    }
}

.op-issue-agent {
    color: #f59e0b;
    font-weight: 600;
}

.op-issue-time {
    color: #475569;
}

// ─── Other Tasks ─────────────────────────────────────────
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

.op-task-status-badge {
    font-size: 9px;
    font-family: 'Courier New', monospace;
    white-space: nowrap;
    flex-shrink: 0;
}

.op-mt-actions {
    display: flex;
    gap: 6px;
    margin-top: 8px;
    flex-wrap: wrap;
}

.op-action-btn {
    background: rgba(59, 130, 246, 0.1);
    border: 1px solid rgba(59, 130, 246, 0.3);
    border-radius: 4px;
    padding: 4px 10px;
    font-size: 10px;
    font-family: 'Courier New', monospace;
    color: #93c5fd;
    cursor: pointer;
    white-space: nowrap;
    transition: all 0.15s;

    &:hover {
        background: rgba(59, 130, 246, 0.2);
        border-color: rgba(59, 130, 246, 0.5);
    }
}

.op-task-actions {
    display: flex;
    gap: 4px;
    margin-top: 6px;
    flex-wrap: wrap;
}

.op-action-btn-sm {
    background: rgba(59, 130, 246, 0.08);
    border: 1px solid rgba(59, 130, 246, 0.2);
    border-radius: 3px;
    padding: 2px 8px;
    font-size: 9px;
    font-family: 'Courier New', monospace;
    color: #93c5fd;
    cursor: pointer;
    white-space: nowrap;
    transition: all 0.15s;

    &:hover {
        background: rgba(59, 130, 246, 0.15);
        border-color: rgba(59, 130, 246, 0.4);
    }
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

// ─── Typing ──────────────────────────────────────────────
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
