<script setup lang="ts">
import { computed } from 'vue'
import type { AgentRoomTask, AgentRoomReview, AgentRoomWorkflowEvent, AgentRoomTaskStatus } from '@/api/hermes/agent-room'

const props = defineProps<{
    tasks: AgentRoomTask[]
    reviews: AgentRoomReview[]
    workflowEvents: AgentRoomWorkflowEvent[]
    activeTaskId?: string | null
    actionLoadingTaskId?: string | null
}>()

const emit = defineEmits<{
    (e: 'create-task'): void
    (e: 'run-workflow', taskId: string): void
    (e: 'open-review', taskId: string): void
    (e: 'deliver-task', taskId: string): void
    (e: 'select-task', taskId: string): void
}>()

// ─── Status Display ────────────────────────────────────────────
const STATUS_CONFIG: Record<AgentRoomTaskStatus, { label: string; color: string; icon: string }> = {
    created: { label: '已创建', color: '#999999', icon: '📝' },
    planned: { label: '已规划', color: '#ba68c8', icon: '📐' },
    assigned: { label: '已分配', color: '#4fc3f7', icon: '📌' },
    in_progress: { label: '进行中', color: '#81c784', icon: '⚡' },
    submitted_for_review: { label: '待审核', color: '#ffb74d', icon: '🔍' },
    review_passed: { label: '审核通过', color: '#81c784', icon: '✅' },
    review_rejected: { label: '审核驳回', color: '#e57373', icon: '❌' },
    revision_required: { label: '需修改', color: '#ffb74d', icon: '↩️' },
    delivering: { label: '交付中', color: '#4fc3f7', icon: '📦' },
    completed: { label: '已完成', color: '#81c784', icon: '🎉' },
    failed: { label: '失败', color: '#e57373', icon: '💥' },
    need_user_decision: { label: '等待决策', color: '#ffb74d', icon: '⚠️' },
}

function getStatusConfig(status: AgentRoomTaskStatus) {
    return STATUS_CONFIG[status] ?? { label: status, color: '#999999', icon: '❓' }
}

// ─── Task Actions ──────────────────────────────────────────────
interface TaskAction {
    label: string
    icon: string
    action: 'run-workflow' | 'open-review' | 'deliver'
    color: string
}

function getTaskActions(task: AgentRoomTask): TaskAction[] {
    const actions: TaskAction[] = []
    switch (task.status) {
        case 'created':
            actions.push({ label: '启动工作流', icon: '🚀', action: 'run-workflow', color: '#0e639c' })
            break
        case 'submitted_for_review':
            actions.push({ label: '审核', icon: '🔍', action: 'open-review', color: '#ffb74d' })
            break
        case 'review_passed':
            actions.push({ label: '开始交付', icon: '📦', action: 'deliver', color: '#0e639c' })
            break
        case 'revision_required':
            actions.push({ label: '重新开发', icon: '🔄', action: 'run-workflow', color: '#f57c00' })
            break
        case 'need_user_decision':
            actions.push({ label: '继续修改', icon: '🔄', action: 'run-workflow', color: '#f57c00' })
            break
        case 'failed':
            actions.push({ label: '重新开始', icon: '🔄', action: 'run-workflow', color: '#f57c00' })
            break
    }
    return actions
}

function handleAction(task: AgentRoomTask, action: TaskAction) {
    if (props.actionLoadingTaskId === task.id) return
    switch (action.action) {
        case 'run-workflow':
            emit('run-workflow', task.id)
            break
        case 'open-review':
            emit('open-review', task.id)
            break
        case 'deliver':
            emit('deliver-task', task.id)
            break
    }
}

function handleSelectTask(taskId: string) {
    emit('select-task', taskId)
}

// ─── Recent Events ─────────────────────────────────────────────
const recentEvents = computed(() =>
    [...props.workflowEvents].sort((a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    ).slice(0, 10),
)

function formatTime(iso: string): string {
    const d = new Date(iso)
    return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function eventLabel(type: string): string {
    const map: Record<string, string> = {
        task_created: '任务创建',
        task_planned: '任务规划',
        task_assigned: '任务分配',
        task_started: '开始开发',
        task_submitted: '提交审核',
        review_passed: '审核通过',
        review_rejected: '审核驳回',
        revision_started: '开始修改',
        delivery_started: '开始交付',
        delivery_completed: '交付完成',
        task_failed: '任务失败',
        need_user_decision: '等待用户决策',
    }
    return map[type] ?? type
}
</script>

<template>
    <div class="task-panel">
        <div class="panel-header">
            <span class="header-icon">📋</span>
            <span>任务状态</span>
            <button class="btn-create" @click="emit('create-task')">+ 新任务</button>
        </div>

        <!-- Task List -->
        <div class="task-list">
            <div v-if="tasks.length === 0" class="empty-tasks">
                <span>📭</span>
                <p>暂无任务</p>
            </div>
            <div
                v-for="task in tasks"
                :key="task.id"
                class="task-card"
                :class="{ selected: task.id === activeTaskId }"
                @click="handleSelectTask(task.id)"
            >
                <div class="task-header">
                    <span class="task-icon">{{ getStatusConfig(task.status).icon }}</span>
                    <span class="task-title">{{ task.title }}</span>
                </div>
                <div class="task-status-bar">
                    <span
                        class="status-badge"
                        :style="{ background: getStatusConfig(task.status).color + '22', color: getStatusConfig(task.status).color }"
                    >
                        {{ getStatusConfig(task.status).label }}
                    </span>
                    <span v-if="task.revisionRound > 0" class="round-badge">
                        修改轮次: {{ task.revisionRound }}/{{ task.maxRevisionRounds }}
                    </span>
                </div>
                <div v-if="task.description" class="task-desc">{{ task.description }}</div>

                <!-- Task Actions -->
                <div class="task-actions">
                    <button
                        v-for="action in getTaskActions(task)"
                        :key="action.action"
                        class="task-action-btn"
                        :style="{ borderColor: action.color, color: action.color }"
                        :disabled="actionLoadingTaskId === task.id"
                        @click.stop="handleAction(task, action)"
                    >
                        <span v-if="actionLoadingTaskId === task.id" class="loading-spinner">⏳</span>
                        {{ action.icon }} {{ action.label }}
                    </button>
                </div>
            </div>
        </div>

        <!-- Recent Reviews -->
        <div v-if="reviews.length > 0" class="section">
            <div class="section-header">
                <span>🔍 审核记录</span>
            </div>
            <div class="review-list">
                <div v-for="review in reviews.slice(-5).reverse()" :key="review.id" class="review-item">
                    <span class="review-status" :class="review.status">
                        {{ review.status === 'passed' ? '✅ 通过' : '❌ 驳回' }}
                    </span>
                    <span v-if="review.comment" class="review-comment">{{ review.comment }}</span>
                    <span v-else class="review-no-comment">（无审核意见）</span>
                </div>
            </div>
        </div>

        <!-- Workflow Events -->
        <div v-if="recentEvents.length > 0" class="section">
            <div class="section-header">
                <span>📡 工作流事件</span>
            </div>
            <div class="event-list">
                <div v-for="evt in recentEvents" :key="evt.id" class="event-item">
                    <span class="event-time">{{ formatTime(evt.createdAt) }}</span>
                    <span class="event-label">{{ eventLabel(evt.type) }}</span>
                    <span class="event-agent">{{ evt.agentRole }}</span>
                </div>
            </div>
        </div>
    </div>
</template>

<style scoped lang="scss">
.task-panel {
    width: 280px;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    background: var(--vscode-sideBar-background, #252526);
    overflow-y: auto;
}

.panel-header {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 10px 12px;
    font-size: 12px;
    font-weight: 600;
    color: var(--vscode-sideBarSectionHeader-foreground, #bbbbbb);
    border-bottom: 1px solid var(--vscode-widget-border, #3c3c3c);
    text-transform: uppercase;
    letter-spacing: 0.5px;

    .header-icon {
        font-size: 14px;
    }
}

.btn-create {
    margin-left: auto;
    padding: 2px 8px;
    border: 1px solid var(--vscode-widget-border, #3c3c3c);
    border-radius: 3px;
    background: transparent;
    color: var(--vscode-editor-foreground, #cccccc);
    cursor: pointer;
    font-size: 11px;

    &:hover {
        background: var(--vscode-list-hoverBackground, #2a2d2e);
    }
}

.task-list {
    padding: 8px;
    display: flex;
    flex-direction: column;
    gap: 8px;
}

.empty-tasks {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    padding: 20px;
    color: var(--vscode-descriptionForeground, #999999);
    font-size: 13px;

    span {
        font-size: 24px;
    }

    p {
        margin: 0;
    }
}

.task-card {
    padding: 10px;
    border-radius: 6px;
    background: var(--vscode-editorWidget-background, #252526);
    border: 1px solid var(--vscode-widget-border, #3c3c3c);
    cursor: pointer;
    transition: border-color 0.15s;

    &:hover {
        border-color: var(--vscode-focusBorder, #007fd4);
    }

    &.selected {
        border-color: var(--vscode-button-background, #0e639c);
        background: rgba(14, 99, 156, 0.08);
    }
}

.task-header {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 6px;
}

.task-icon {
    font-size: 14px;
}

.task-title {
    font-size: 13px;
    font-weight: 600;
    color: var(--vscode-editor-foreground, #cccccc);
}

.task-status-bar {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 6px;
}

.status-badge {
    font-size: 10px;
    padding: 2px 6px;
    border-radius: 3px;
    font-weight: 600;
}

.round-badge {
    font-size: 10px;
    color: var(--vscode-descriptionForeground, #999999);
}

.task-desc {
    font-size: 11px;
    color: var(--vscode-descriptionForeground, #999999);
    margin-bottom: 8px;
    line-height: 1.4;
}

.task-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
}

.task-action-btn {
    padding: 3px 8px;
    border: 1px solid;
    border-radius: 3px;
    background: transparent;
    cursor: pointer;
    font-size: 11px;
    transition: background 0.15s;

    &:hover:not(:disabled) {
        background: rgba(255, 255, 255, 0.05);
    }

    &:disabled {
        opacity: 0.5;
        cursor: not-allowed;
    }

    .loading-spinner {
        animation: spin 1s linear infinite;
    }
}

@keyframes spin {
    from { transform: rotate(0deg); }
    to { transform: rotate(360deg); }
}

.section {
    border-top: 1px solid var(--vscode-widget-border, #3c3c3c);
    padding: 8px;
}

.section-header {
    font-size: 11px;
    font-weight: 600;
    color: var(--vscode-sideBarSectionHeader-foreground, #bbbbbb);
    margin-bottom: 6px;
    text-transform: uppercase;
    letter-spacing: 0.3px;
}

.review-list {
    display: flex;
    flex-direction: column;
    gap: 4px;
}

.review-item {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 6px;
    border-radius: 3px;
    background: var(--vscode-editorWidget-background, #252526);
    font-size: 11px;
}

.review-status {
    font-weight: 600;
    white-space: nowrap;

    &.passed {
        color: #81c784;
    }

    &.rejected {
        color: #e57373;
    }
}

.review-comment {
    color: var(--vscode-descriptionForeground, #999999);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.review-no-comment {
    color: var(--vscode-descriptionForeground, #666666);
    font-style: italic;
}

.event-list {
    display: flex;
    flex-direction: column;
    gap: 2px;
}

.event-item {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 3px 6px;
    font-size: 10px;
    color: var(--vscode-descriptionForeground, #999999);
}

.event-time {
    color: var(--vscode-descriptionForeground, #666666);
    font-family: monospace;
    white-space: nowrap;
}

.event-label {
    flex: 1;
    color: var(--vscode-editor-foreground, #cccccc);
}

.event-agent {
    color: var(--vscode-descriptionForeground, #999999);
    font-style: italic;
}
</style>
