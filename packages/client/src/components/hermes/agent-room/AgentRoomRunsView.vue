<script setup lang="ts">
import { computed, ref } from 'vue'
import type { AgentRoomRun, AgentRoomRunEvent, AgentRoomTask } from '@/api/hermes/agent-room'

const props = defineProps<{
    runs: AgentRoomRun[]
    runEvents: AgentRoomRunEvent[]
    tasks: AgentRoomTask[]
    hasActiveRuns: boolean
}>()

const expandedRunId = ref<string | null>(null)

const RUN_STATUS_CONFIG: Record<string, { label: string; color: string; icon: string }> = {
    queued:    { label: '排队中', color: '#94a3b8', icon: '⏳' },
    running:   { label: '运行中', color: '#22c55e', icon: '⚡' },
    completed: { label: '已完成', color: '#22c55e', icon: '✅' },
    failed:    { label: '失败', color: '#ef4444', icon: '💥' },
}

function getStatusConfig(status: string) {
    return RUN_STATUS_CONFIG[status] ?? { label: status, color: '#94a3b8', icon: '❓' }
}

function getTaskTitle(taskId: string): string {
    return props.tasks.find(t => t.id === taskId)?.title ?? taskId.slice(0, 8)
}

/** Runs sorted by createdAt descending */
const sortedRuns = computed(() =>
    [...props.runs].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()),
)

/** Run events for the expanded run, sorted by sequence */
const expandedRunEvents = computed(() => {
    if (!expandedRunId.value) return []
    return props.runEvents
        .filter(e => e.runId === expandedRunId.value)
        .sort((a, b) => a.sequence - b.sequence)
})

function toggleRun(runId: string) {
    expandedRunId.value = expandedRunId.value === runId ? null : runId
}

function formatDateTime(iso: string | undefined): string {
    if (!iso) return '—'
    const d = new Date(iso)
    return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}`
}

function formatDuration(start: string | undefined, end: string | undefined): string {
    if (!start) return '—'
    const s = new Date(start).getTime()
    const e = end ? new Date(end).getTime() : Date.now()
    const sec = Math.round((e - s) / 1000)
    if (sec < 60) return `${sec}s`
    const min = Math.floor(sec / 60)
    return `${min}m${sec % 60}s`
}

const RUN_EVENT_ICONS: Record<string, string> = {
    'run:started':       '🚀',
    'run:completed':     '✅',
    'run:failed':        '💥',
    'step:planned':      '📐',
    'step:assigned':     '📌',
    'step:in_progress':  '⚡',
    'step:submitted_for_review': '🔍',
    'step:started':      '▶️',
    'step:completed':    '✔️',
    'step:failed':       '❌',
    'step:info':         'ℹ️',
    'agent:message':     '💬',
    'agent:tool_call':   '🔧',
    'agent:tool_result': '📋',
    'artifact:created':  '📦',
}
</script>

<template>
    <div class="runs-view">
        <div class="runs-header">
            <span class="runs-title">Runs</span>
            <span v-if="hasActiveRuns" class="runs-active-badge">⚡ 运行中</span>
            <span class="runs-count">{{ runs.length }}</span>
        </div>
        <div class="runs-body">
            <div v-if="sortedRuns.length === 0" class="runs-empty">
                暂无 Run 记录
            </div>
            <div
                v-for="run in sortedRuns"
                :key="run.id"
                class="run-card"
                :class="{ expanded: expandedRunId === run.id, active: run.status === 'running' || run.status === 'queued' }"
            >
                <div class="run-row" @click="toggleRun(run.id)">
                    <span class="run-icon">{{ getStatusConfig(run.status).icon }}</span>
                    <span class="run-task">{{ getTaskTitle(run.taskId) }}</span>
                    <span
                        class="run-status"
                        :style="{ color: getStatusConfig(run.status).color }"
                    >{{ getStatusConfig(run.status).label }}</span>
                    <span class="run-runner">{{ run.runnerName }}</span>
                    <span class="run-duration">{{ formatDuration(run.startedAt, run.finishedAt) }}</span>
                    <span class="run-expand">{{ expandedRunId === run.id ? '▾' : '▸' }}</span>
                </div>
                <div v-if="expandedRunId === run.id" class="run-detail">
                    <div class="run-meta">
                        <span>ID: {{ run.id.slice(0, 12) }}…</span>
                        <span>开始: {{ formatDateTime(run.startedAt) }}</span>
                        <span>结束: {{ formatDateTime(run.finishedAt) }}</span>
                    </div>
                    <div v-if="run.errorMessage" class="run-error">
                        {{ run.errorMessage }}
                    </div>
                    <div class="run-events">
                        <div class="run-events-header">事件流 ({{ expandedRunEvents.length }})</div>
                        <div
                            v-for="evt in expandedRunEvents"
                            :key="evt.id"
                            class="run-event-item"
                        >
                            <span class="re-icon">{{ RUN_EVENT_ICONS[evt.eventType] ?? '📌' }}</span>
                            <span class="re-type">{{ evt.eventType }}</span>
                            <span class="re-source">{{ evt.source }}</span>
                            <span class="re-seq">#{{ evt.sequence }}</span>
                            <span class="re-time">{{ formatDateTime(evt.createdAt) }}</span>
                        </div>
                        <div v-if="expandedRunEvents.length === 0" class="run-events-empty">
                            暂无事件
                        </div>
                    </div>
                </div>
            </div>
        </div>
    </div>
</template>

<style scoped lang="scss">
.runs-view {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
    background: #0c1222;
    border: 1px solid #1e293b;
    border-radius: 6px;
    overflow: hidden;
    font-family: 'Courier New', monospace;
    font-size: 12px;
}

.runs-header {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 10px;
    background: #111827;
    border-bottom: 1px solid #1e293b;
}

.runs-title {
    color: #94a3b8;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 1px;
}

.runs-active-badge {
    font-size: 10px;
    padding: 1px 6px;
    border-radius: 3px;
    background: rgba(34, 197, 94, 0.15);
    color: #22c55e;
    animation: pulse-badge 2s infinite;
}

@keyframes pulse-badge {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.6; }
}

.runs-count {
    margin-left: auto;
    color: #475569;
    font-size: 10px;
}

.runs-body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 4px;
}

.runs-empty {
    padding: 20px;
    text-align: center;
    color: #475569;
}

.run-card {
    border: 1px solid #1e293b;
    border-radius: 4px;
    margin-bottom: 4px;
    transition: border-color 0.15s;

    &.expanded {
        border-color: #334155;
    }

    &.active {
        border-color: #22c55e44;
    }
}

.run-row {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 8px;
    cursor: pointer;
    transition: background 0.15s;

    &:hover {
        background: #1e293b;
    }
}

.run-icon {
    flex-shrink: 0;
    font-size: 12px;
}

.run-task {
    flex: 1;
    color: #e2e8f0;
    font-size: 11px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
}

.run-status {
    flex-shrink: 0;
    font-size: 10px;
    font-weight: 600;
}

.run-runner {
    flex-shrink: 0;
    color: #64748b;
    font-size: 10px;
}

.run-duration {
    flex-shrink: 0;
    color: #475569;
    font-size: 10px;
}

.run-expand {
    flex-shrink: 0;
    color: #475569;
    font-size: 10px;
}

.run-detail {
    padding: 6px 8px;
    border-top: 1px solid #1e293b;
    background: #0a0f1e;
}

.run-meta {
    display: flex;
    gap: 12px;
    color: #64748b;
    font-size: 10px;
    margin-bottom: 6px;
}

.run-error {
    padding: 4px 8px;
    margin-bottom: 6px;
    border-radius: 3px;
    background: rgba(239, 68, 68, 0.1);
    border-left: 3px solid #ef4444;
    color: #fca5a5;
    font-size: 11px;
}

.run-events {
    margin-top: 4px;
}

.run-events-header {
    color: #64748b;
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin-bottom: 4px;
}

.run-event-item {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 2px 0;
    font-size: 11px;
}

.re-icon {
    flex-shrink: 0;
    font-size: 10px;
}

.re-type {
    flex-shrink: 0;
    color: #94a3b8;
    font-size: 10px;
}

.re-source {
    flex-shrink: 0;
    color: #64748b;
    font-size: 10px;
}

.re-seq {
    flex-shrink: 0;
    color: #475569;
    font-size: 9px;
}

.re-time {
    margin-left: auto;
    color: #475569;
    font-size: 9px;
}

.run-events-empty {
    color: #475569;
    font-size: 10px;
    padding: 4px 0;
}
</style>
