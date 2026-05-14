<script setup lang="ts">
import { computed, ref } from 'vue'
import type { AgentRoomTask, AgentRoomReview, AgentRoomWorkflowEvent, AgentRoomTaskStatus, AgentRoomAgent, AgentRoomArtifact, AgentRoomRoleBinding, AgentRoomRun } from '@/api/hermes/agent-room'

const props = defineProps<{
    tasks: AgentRoomTask[]
    reviews: AgentRoomReview[]
    workflowEvents: AgentRoomWorkflowEvent[]
    agents: AgentRoomAgent[]
    artifacts: AgentRoomArtifact[]
    roleBindings?: AgentRoomRoleBinding[]
    runs?: AgentRoomRun[]
    activeTaskId?: string | null
    actionLoadingTaskId?: string | null
}>()

const emit = defineEmits<{
    (e: 'create-task'): void
    (e: 'run-workflow', taskId: string): void
    (e: 'open-review', taskId: string): void
    (e: 'deliver-task', taskId: string): void
    (e: 'select-task', taskId: string): void
    (e: 'delete-task', taskId: string): void
    (e: 'delete-artifact', artifactId: string): void
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

interface RoleBindingHint {
    role: string
    label: string
    status: 'blocking' | 'warning' | 'info' | 'ok'
    message: string
}

// ─── Active Task ───────────────────────────────────────────────
const activeTask = computed(() => {
    if (props.activeTaskId) {
        const found = props.tasks.find(t => t.id === props.activeTaskId)
        if (found) return found
    }
    return props.tasks.find(t => !['completed', 'failed'].includes(t.status)) ?? null
})

/** Latest failed run error message for the active task */
const latestRunError = computed(() => {
    if (!activeTask.value) return null
    const taskRuns = (props.runs ?? [])
        .filter(r => r.taskId === activeTask.value!.id)
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    const lastRun = taskRuns[0]
    return lastRun?.errorMessage ?? null
})

const deliveryBinding = computed(() =>
    (props.roleBindings ?? []).find(binding => binding.role === 'delivery') ?? null,
)

const roleBindingValidation = computed<RoleBindingHint[]>(() => {
    const bindings = props.roleBindings ?? []
    const bindingMap = new Map(bindings.map(binding => [binding.role, binding]))
    const hints: RoleBindingHint[] = []

    // Planner — falls back to the current default Hermes profile
    if (!bindingMap.has('planner')) {
        hints.push({
            role: 'planner',
            label: '规划 Agent',
            status: 'warning',
            message: '未绑定，将使用当前默认 Hermes profile',
        })
    } else {
        hints.push({
            role: 'planner',
            label: '规划 Agent',
            status: 'ok',
            message: `已绑定: ${bindingMap.get('planner')!.profileName}`,
        })
    }

    // Reviewer — falls back to the current default Hermes profile
    if (!bindingMap.has('reviewer')) {
        hints.push({
            role: 'reviewer',
            label: '审核 Agent',
            status: 'warning',
            message: '未绑定，将使用当前默认 Hermes profile',
        })
    } else {
        hints.push({
            role: 'reviewer',
            label: '审核 Agent',
            status: 'ok',
            message: `已绑定: ${bindingMap.get('reviewer')!.profileName}`,
        })
    }

    // Developer — has binding/assignedAgentId/default fallback
    if (!bindingMap.has('developer')) {
        if (activeTask.value?.assignedAgentId) {
            hints.push({
                role: 'developer',
                label: '开发 Agent',
                status: 'warning',
                message: `未绑定，将使用任务分配 profile: ${activeTask.value.assignedAgentId}`,
            })
        } else {
            hints.push({
                role: 'developer',
                label: '开发 Agent',
                status: 'warning',
                message: '未绑定，将使用当前默认 Hermes profile',
            })
        }
    } else {
        hints.push({
            role: 'developer',
            label: '开发 Agent',
            status: 'ok',
            message: `已绑定: ${bindingMap.get('developer')!.profileName}`,
        })
    }

    // Delivery — optional, falls back to system delivery
    if (!bindingMap.has('delivery')) {
        hints.push({
            role: 'delivery',
            label: '交付 Agent',
            status: 'info',
            message: '未绑定，将使用系统交付',
        })
    } else {
        hints.push({
            role: 'delivery',
            label: '交付 Agent',
            status: 'ok',
            message: `已绑定: ${bindingMap.get('delivery')!.profileName}（交付 Agent 模式）`,
        })
    }

    return hints
})

/** Whether workflow can start — role binding fallbacks are non-blocking. */
const canStartWorkflow = computed(() => true)

function getDeliveryActionLabel(task: AgentRoomTask): { label: string; icon: string } {
    if (task.status === 'delivering') {
        return { label: '交付中', icon: '⏳' }
    }
    if (task.status === 'failed') {
        return { label: '重新交付', icon: '🔄' }
    }
    if (deliveryBinding.value) {
        return { label: '交付 Agent 生成', icon: '🤖' }
    }
    return { label: '系统生成交付', icon: '📦' }
}

function getTaskActions(task: AgentRoomTask): TaskAction[] {
    const actions: TaskAction[] = []
    switch (task.status) {
        case 'created':
            actions.push({
                label: canStartWorkflow.value ? '启动工作流' : '⚠️ 配置未完成',
                icon: canStartWorkflow.value ? '🚀' : '⛔',
                action: 'run-workflow',
                color: canStartWorkflow.value ? '#0e639c' : '#ef4444',
            })
            break
        case 'submitted_for_review':
            actions.push({ label: '审核', icon: '🔍', action: 'open-review', color: '#ffb74d' })
            break
        case 'review_passed': {
            const deliveryAction = getDeliveryActionLabel(task)
            actions.push({ label: deliveryAction.label, icon: deliveryAction.icon, action: 'deliver', color: '#0e639c' })
            break
        }
        case 'revision_required':
            actions.push({ label: `重新开发 (第${task.revisionRound}轮)`, icon: '🔄', action: 'run-workflow', color: '#f57c00' })
            break
        case 'need_user_decision':
            actions.push({ label: `继续修改 (第${task.revisionRound}/${task.maxRevisionRounds}轮已用尽)`, icon: '🔄', action: 'run-workflow', color: '#f57c00' })
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
            if (!canStartWorkflow.value) {
                // Keep guard for future blocking validations; role binding fallbacks are non-blocking.
                return
            }
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

// ─── Agent Status (derived from task status) ───────────────────
const STATUS_TO_ACTIVE_ROLE: Partial<Record<AgentRoomTaskStatus, string>> = {
    created: 'conversation',
    planned: 'planner',
    assigned: 'developer',
    in_progress: 'developer',
    submitted_for_review: 'reviewer',
    review_passed: 'delivery',
    review_rejected: 'reviewer',
    revision_required: 'developer',
    delivering: 'delivery',
    completed: 'delivery',
    failed: 'developer',
    need_user_decision: 'conversation',
}

const AGENT_ROLE_COLORS: Record<string, string> = {
    conversation: '#3b82f6',
    planner: '#a855f7',
    developer: '#22c55e',
    reviewer: '#f59e0b',
    delivery: '#06b6d4',
}

interface AgentStatusItem {
    id: string
    name: string
    role: string
    status: 'idle' | 'active' | 'completed' | 'failed'
    color: string
}

const agentStatuses = computed<AgentStatusItem[]>(() => {
    const activeRole = activeTask.value
        ? STATUS_TO_ACTIVE_ROLE[activeTask.value.status] ?? null
        : null

    return props.agents.map(agent => {
        let status: AgentStatusItem['status'] = 'idle'
        if (activeTask.value) {
            if (agent.role === activeRole) {
                status = 'active'
            } else if (activeTask.value.status === 'completed') {
                status = 'completed'
            } else if (activeTask.value.status === 'failed') {
                status = 'failed'
            }
        }
        return {
            id: agent.id,
            name: agent.name,
            role: agent.role,
            status,
            color: AGENT_ROLE_COLORS[agent.role] ?? '#94a3b8',
        }
    })
})

const roleBindingSnapshot = computed(() => {
    const bindingMap = new Map((props.roleBindings ?? []).map(binding => [binding.role, binding]))
    return [
        {
            role: 'planner',
            label: 'Planner',
            value: bindingMap.get('planner')?.model || bindingMap.get('planner')?.profileName || 'active profile',
        },
        {
            role: 'developer',
            label: 'Developer',
            value: bindingMap.get('developer')?.model || bindingMap.get('developer')?.profileName || activeTask.value?.assignedAgentId || 'active profile',
        },
        {
            role: 'reviewer',
            label: 'Reviewer',
            value: bindingMap.get('reviewer')?.model || bindingMap.get('reviewer')?.profileName || 'active profile',
        },
    ]
})

const STATUS_DOT_COLORS: Record<string, string> = {
    idle: '#475569',
    active: '#22c55e',
    completed: '#22c55e',
    failed: '#ef4444',
}

const STATUS_DOT_LABELS: Record<string, string> = {
    idle: '待命',
    active: '工作中',
    completed: '已完成',
    failed: '失败',
}

// ─── Artifacts ─────────────────────────────────────────────────
const expandedArtifactId = ref<string | null>(null)

const activeTaskArtifacts = computed(() => {
    if (!activeTask.value) return []
    return props.artifacts.filter(a => a.taskId === activeTask.value!.id)
})

const ARTIFACT_TYPE_ICONS: Record<string, string> = {
    final_delivery: '🎉',
    code_output: '💻',
    review_report: '📋',
    log: '📄',
    other: '📎',
}

function artifactTypeIcon(type: string): string {
    return ARTIFACT_TYPE_ICONS[type] ?? '📎'
}

function toggleArtifact(id: string) {
    expandedArtifactId.value = expandedArtifactId.value === id ? null : id
}

function handleDeleteArtifact(artifactId: string) {
    emit('delete-artifact', artifactId)
}

function deliveryMetadataEntries(metadata: Record<string, unknown> | undefined): Array<[string, unknown]> {
    if (!metadata) return []
    const keys = [
        'deliveryMode',
        'deliveryProfileName',
        'deliveryRunId',
        'provider',
        'model',
        'fallbackReason',
        'trigger',
    ]
    return keys
        .map((key) => [key, metadata[key]] as [string, unknown])
        .filter(([, value]) => value !== undefined && value !== null && value !== '')
}

function clearExpandedArtifact(artifactId: string) {
    if (expandedArtifactId.value === artifactId) {
        expandedArtifactId.value = null
    }
}

defineExpose({
    clearExpandedArtifact
})
</script>

<template>
    <div class="info-panel">
        <!-- Section A: Main Task -->
        <div class="section-main-task">
            <div class="section-header">
                <span class="header-icon">🎯</span>
                <span class="header-title">主任务</span>
                <button class="btn-add" @click="emit('create-task')">+</button>
            </div>

            <div v-if="activeTask" class="task-card">
                <div class="task-card-top">
                    <span class="task-icon">{{ getStatusConfig(activeTask.status).icon }}</span>
                    <span class="task-title">{{ activeTask.title }}</span>
                    <button
                        class="btn-delete-task"
                        title="删除任务"
                        :disabled="actionLoadingTaskId === activeTask.id"
                        @click="emit('delete-task', activeTask.id)"
                    >✕</button>
                </div>
                <div class="task-status-bar">
                    <span
                        class="status-badge"
                        :style="{ background: getStatusConfig(activeTask.status).color + '22', color: getStatusConfig(activeTask.status).color }"
                    >
                        {{ getStatusConfig(activeTask.status).label }}
                    </span>
                    <span v-if="activeTask.revisionRound > 0" class="round-badge">
                        {{ activeTask.revisionRound }}/{{ activeTask.maxRevisionRounds }}
                    </span>
                </div>
                <div v-if="activeTask && latestRunError" class="run-error-hint">
                    💥 {{ latestRunError }}
                </div>
                <div v-if="activeTask.description" class="task-desc">{{ activeTask.description }}</div>
                <!-- Pre-flight role binding validation -->
                <div v-if="activeTask && activeTask.status === 'created'" class="role-validation">
                    <div class="rv-header">启动前校验</div>
                    <div
                        v-for="hint in roleBindingValidation"
                        :key="hint.role"
                        class="rv-item"
                        :class="`rv-${hint.status}`"
                    >
                        <span class="rv-icon">{{ hint.status === 'blocking' ? '⛔' : hint.status === 'warning' ? '⚠️' : hint.status === 'ok' ? '✅' : 'ℹ️' }}</span>
                        <span class="rv-label">{{ hint.label }}</span>
                        <span class="rv-message">{{ hint.message }}</span>
                    </div>
                </div>
                <div class="task-actions">
                    <button
                        v-for="action in getTaskActions(activeTask)"
                        :key="action.action"
                        class="action-btn"
                        :style="{ borderColor: action.color, color: action.color }"
                        :disabled="actionLoadingTaskId === activeTask.id"
                        @click="handleAction(activeTask, action)"
                    >
                        <span v-if="actionLoadingTaskId === activeTask.id" class="loading-spinner">⏳</span>
                        {{ action.icon }} {{ action.label }}
                    </button>
                </div>
            </div>
            <div v-else class="empty-task">
                <span>📭</span>
                <p>暂无任务，点击 + 创建</p>
            </div>

            <!-- Task list (compact) -->
            <div v-if="tasks.length > 1" class="task-list-compact">
                <div
                    v-for="task in tasks.filter(t => t.id !== activeTask?.id).slice(0, 4)"
                    :key="task.id"
                    class="task-list-item"
                    @click="emit('select-task', task.id)"
                >
                    <span class="tli-icon">{{ getStatusConfig(task.status).icon }}</span>
                    <span class="tli-title">{{ task.title }}</span>
                    <span
                        class="tli-badge"
                        :style="{ color: getStatusConfig(task.status).color }"
                    >
                        {{ getStatusConfig(task.status).label }}
                    </span>
                    <button
                        class="btn-delete-task"
                        title="删除任务"
                        :disabled="actionLoadingTaskId === task.id"
                        @click.stop="emit('delete-task', task.id)"
                    >✕</button>
                </div>
            </div>
        </div>

        <!-- Section B: Agent Status -->
        <div class="section-agents">
            <div class="section-header">
                <span class="header-icon">🤖</span>
                <span class="header-title">Agent 状态</span>
            </div>
            <div class="agent-list">
                <div
                    v-for="agent in agentStatuses"
                    :key="agent.id"
                    class="agent-item"
                    :class="{ active: agent.status === 'active' }"
                >
                    <span class="agent-dot" :style="{ background: STATUS_DOT_COLORS[agent.status] }" />
                    <span class="agent-name" :style="{ color: agent.color }">{{ agent.name }}</span>
                    <span class="agent-role">{{ agent.role }}</span>
                    <span class="agent-status-label">{{ STATUS_DOT_LABELS[agent.status] }}</span>
                </div>
            </div>
            <div class="role-binding-snapshot">
                <div
                    v-for="item in roleBindingSnapshot"
                    :key="item.role"
                    class="binding-snapshot-item"
                >
                    <span class="binding-snapshot-label">{{ item.label }}</span>
                    <strong class="binding-snapshot-value">{{ item.value }}</strong>
                </div>
            </div>
        </div>

        <!-- Section C: Artifacts -->
        <div class="section-artifacts">
            <div class="section-header">
                <span class="header-icon">📦</span>
                <span class="header-title">产出物</span>
                <span v-if="activeTaskArtifacts.length" class="artifact-count">{{ activeTaskArtifacts.length }}</span>
            </div>
            <div v-if="activeTaskArtifacts.length > 0" class="artifact-list">
                <div
                    v-for="artifact in activeTaskArtifacts"
                    :key="artifact.id"
                    class="artifact-item"
                    @click="toggleArtifact(artifact.id)"
                >
                    <div class="artifact-row">
                        <span class="artifact-icon">{{ artifactTypeIcon(artifact.type) }}</span>
                        <span class="artifact-name">{{ artifact.name }}</span>
                        <span class="artifact-type">{{ artifact.type }}</span>
                        <button
                            class="btn-delete-artifact"
                            title="删除产出物"
                            @click.stop="handleDeleteArtifact(artifact.id)"
                        >✕</button>
                        <span class="artifact-expand">{{ expandedArtifactId === artifact.id ? '▾' : '▸' }}</span>
                    </div>
                    <div v-if="expandedArtifactId === artifact.id && artifact.content" class="artifact-content">
                        <pre>{{ artifact.content }}</pre>
                        <div v-if="deliveryMetadataEntries(artifact.metadata).length" class="artifact-metadata">
                            <div
                                v-for="entry in deliveryMetadataEntries(artifact.metadata)"
                                :key="entry[0]"
                                class="artifact-meta-row"
                            >
                                <span class="artifact-meta-key">{{ entry[0] }}</span>
                                <span class="artifact-meta-value">{{ String(entry[1]) }}</span>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
            <div v-else class="empty-artifacts">
                <span>📭</span>
                <p>暂无产出物</p>
            </div>
        </div>
    </div>
</template>

<style scoped lang="scss">
.info-panel {
    width: 280px;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
    background: #0c1222;
    border: 1px solid #1e293b;
    border-radius: 6px;
    overflow-y: auto;
    font-family: 'Courier New', monospace;
}

.section-header {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 8px 10px;
    background: #111827;
    border-bottom: 1px solid #1e293b;
    font-size: 11px;
    font-weight: 600;
    color: #94a3b8;
    text-transform: uppercase;
    letter-spacing: 0.5px;
}

.header-icon {
    font-size: 12px;
}

.header-title {
    flex: 1;
}

.btn-add {
    width: 20px;
    height: 20px;
    display: flex;
    align-items: center;
    justify-content: center;
    border: 1px solid #334155;
    border-radius: 3px;
    background: transparent;
    color: #94a3b8;
    cursor: pointer;
    font-size: 12px;
    line-height: 1;

    &:hover {
        background: #1e293b;
        color: #e2e8f0;
    }
}

// ─── Section A: Main Task ──────────────────────────────────────
.section-main-task {
    background: #0f1729;
}

.task-card {
    padding: 8px 10px;
}

.task-card-top {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 4px;
}

.task-icon {
    font-size: 14px;
}

.task-title {
    flex: 1;
    font-size: 12px;
    font-weight: 600;
    color: #e2e8f0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.btn-delete-task {
    width: 16px;
    height: 16px;
    display: flex;
    align-items: center;
    justify-content: center;
    border: none;
    border-radius: 2px;
    background: transparent;
    color: #64748b;
    cursor: pointer;
    font-size: 10px;
    line-height: 1;
    padding: 0;
    flex-shrink: 0;
    opacity: 0;
    transition: opacity 0.15s;

    .task-card-top:hover &,
    .task-list-item:hover & {
        opacity: 1;
    }

    &:hover {
        background: rgba(239, 68, 68, 0.2);
        color: #fca5a5;
    }
}

.task-status-bar {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 4px;
}

.status-badge {
    font-size: 10px;
    padding: 1px 6px;
    border-radius: 3px;
    font-weight: 600;
}

.round-badge {
    font-size: 10px;
    color: #64748b;
}

.run-error-hint {
    padding: 4px 8px;
    margin-bottom: 4px;
    border-left: 3px solid #ef4444;
    background: rgba(239, 68, 68, 0.08);
    color: #fca5a5;
    font-size: 10px;
    line-height: 1.4;
}

.task-desc {
    font-size: 11px;
    color: #64748b;
    margin-bottom: 6px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.role-validation {
    padding: 6px 8px;
    border-top: 1px solid #1e293b;
    border-bottom: 1px solid #1e293b;
    margin-bottom: 4px;
}

.rv-header {
    font-size: 10px;
    color: #64748b;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin-bottom: 4px;
}

.rv-item {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 2px 0;
    font-size: 10px;
}

.rv-icon {
    flex-shrink: 0;
    font-size: 10px;
}

.rv-label {
    flex-shrink: 0;
    font-weight: 600;
    min-width: 60px;
}

.rv-message {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.rv-blocking .rv-label { color: #ef4444; }
.rv-blocking .rv-message { color: #fca5a5; }

.rv-warning .rv-label { color: #f59e0b; }
.rv-warning .rv-message { color: #fcd34d; }

.rv-info .rv-label { color: #3b82f6; }
.rv-info .rv-message { color: #93c5fd; }

.rv-ok .rv-label { color: #22c55e; }
.rv-ok .rv-message { color: #86efac; }

.task-actions {
    display: flex;
    gap: 4px;
    flex-wrap: wrap;
}

.action-btn {
    padding: 3px 8px;
    border: 1px solid;
    border-radius: 3px;
    background: transparent;
    cursor: pointer;
    font-size: 10px;
    font-family: 'Courier New', monospace;
    transition: background 0.15s;

    &:hover:not(:disabled) {
        background: rgba(255, 255, 255, 0.05);
    }

    &:disabled {
        opacity: 0.5;
        cursor: not-allowed;
    }
}

.loading-spinner {
    animation: spin 1s linear infinite;
}

@keyframes spin {
    from { transform: rotate(0deg); }
    to { transform: rotate(360deg); }
}

.empty-task {
    padding: 16px 10px;
    text-align: center;
    color: #475569;
    font-size: 11px;

    span {
        font-size: 20px;
        display: block;
        margin-bottom: 4px;
    }
}

.task-list-compact {
    border-top: 1px solid #1e293b;
    padding: 4px 0;
}

.task-list-item {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
    cursor: pointer;
    transition: background 0.15s;

    &:hover {
        background: #1e293b;
    }
}

.tli-icon {
    font-size: 11px;
    flex-shrink: 0;
}

.tli-title {
    flex: 1;
    font-size: 11px;
    color: #94a3b8;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.tli-badge {
    font-size: 9px;
    flex-shrink: 0;
}

// ─── Section B: Agent Status ───────────────────────────────────
.section-agents {
    background: #0f1729;
}

.agent-list {
    padding: 4px 0;
}

.agent-item {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
    transition: background 0.15s;

    &.active {
        background: rgba(34, 197, 94, 0.06);
    }
}

.agent-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    flex-shrink: 0;
}

.agent-item.active .agent-dot {
    animation: pulse-dot 2s infinite;
}

@keyframes pulse-dot {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.4; }
}

.agent-name {
    font-size: 11px;
    font-weight: 600;
    flex-shrink: 0;
    max-width: 70px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.agent-role {
    font-size: 10px;
    color: #475569;
    flex: 1;
}

.agent-status-label {
    font-size: 10px;
    color: #64748b;
    flex-shrink: 0;
}

.role-binding-snapshot {
    margin-top: 6px;
    display: grid;
    gap: 6px;
}

.binding-snapshot-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 6px 10px;
    background: #0f1729;
    border: 1px solid #1e293b;
    border-radius: 4px;
}

.binding-snapshot-label {
    font-size: 11px;
    color: #94a3b8;
}

.binding-snapshot-value {
    font-size: 11px;
    color: #22c55e;
    font-weight: 600;
    text-align: right;
    word-break: break-word;
}

// ─── Section C: Artifacts ──────────────────────────────────────
.section-artifacts {
    background: #0f1729;
}

.artifact-count {
    font-size: 9px;
    color: #64748b;
    background: #1e293b;
    padding: 1px 5px;
    border-radius: 8px;
    margin-left: auto;
}

.artifact-list {
    padding: 4px 0;
}

.artifact-item {
    cursor: pointer;

    &:hover {
        background: rgba(255, 255, 255, 0.03);
    }
}

.btn-delete-artifact {
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

    .artifact-item:hover & {
        opacity: 1;
    }

    &:hover {
        background: rgba(239, 68, 68, 0.2);
        color: #fca5a5;
    }
}

.artifact-row {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
}

.artifact-icon {
    font-size: 12px;
    flex-shrink: 0;
}

.artifact-name {
    flex: 1;
    font-size: 11px;
    color: #94a3b8;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.artifact-type {
    font-size: 9px;
    color: #475569;
    flex-shrink: 0;
}

.artifact-expand {
    font-size: 10px;
    color: #475569;
    flex-shrink: 0;
    width: 12px;
    text-align: center;
}

.artifact-content {
    padding: 4px 10px 6px 28px;

    pre {
        margin: 0;
        font-size: 10px;
        color: #94a3b8;
        background: #0c1222;
        border: 1px solid #1e293b;
        border-radius: 4px;
        padding: 6px 8px;
        max-height: 120px;
        overflow: auto;
        white-space: pre-wrap;
        word-break: break-word;
        font-family: 'Courier New', monospace;
    }
}

.artifact-metadata {
    margin-top: 8px;
    padding-top: 8px;
    border-top: 1px solid #1e293b;
}

.artifact-meta-row {
    display: flex;
    gap: 8px;
    padding: 2px 0;
    font-size: 10px;
}

.artifact-meta-key {
    min-width: 110px;
    color: #64748b;
}

.artifact-meta-value {
    color: #cbd5e1;
    word-break: break-all;
}

.empty-artifacts {
    padding: 16px 10px;
    text-align: center;
    color: #475569;
    font-size: 11px;

    span {
        font-size: 16px;
        display: block;
        margin-bottom: 2px;
    }
}
</style>
