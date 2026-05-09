<script setup lang="ts">
import { computed, ref, watch, nextTick } from 'vue'
import type { AgentRoomRunEvent, AgentRoomWorkflowEvent } from '@/api/hermes/agent-room'

const props = defineProps<{
    runEvents: AgentRoomRunEvent[]
    workflowEvents: AgentRoomWorkflowEvent[]
}>()

const streamRef = ref<HTMLDivElement>()
const maxEvents = 80

interface TimelineItem {
    id: string
    icon: string
    source: string
    label: string
    detail: string
    time: number
    color: string
}

const RUN_EVENT_ICONS: Record<string, { icon: string; label: string; color: string }> = {
    'run:started':      { icon: '🚀', label: 'Run 启动', color: '#22c55e' },
    'run:completed':    { icon: '✅', label: 'Run 完成', color: '#22c55e' },
    'run:failed':       { icon: '💥', label: 'Run 失败', color: '#ef4444' },
    'step:started':     { icon: '▶️', label: '步骤开始', color: '#3b82f6' },
    'step:completed':   { icon: '✔️', label: '步骤完成', color: '#22c55e' },
    'step:failed':      { icon: '❌', label: '步骤失败', color: '#ef4444' },
    'agent:message':    { icon: '💬', label: 'Agent 消息', color: '#a855f7' },
    'agent:tool_call':  { icon: '🔧', label: '工具调用', color: '#f59e0b' },
    'agent:tool_result':{ icon: '📋', label: '工具结果', color: '#06b6d4' },
    'artifact:created': { icon: '📦', label: '产出物创建', color: '#22c55e' },
}

const WORKFLOW_ICONS: Record<string, { icon: string; label: string; color: string }> = {
    task_created:          { icon: '📝', label: '任务创建', color: '#94a3b8' },
    task_planned:          { icon: '📐', label: '任务规划', color: '#a855f7' },
    task_assigned:         { icon: '📌', label: '任务分配', color: '#3b82f6' },
    task_started:          { icon: '⚡', label: '开始开发', color: '#22c55e' },
    task_submitted:        { icon: '🔍', label: '提交审核', color: '#f59e0b' },
    review_passed:         { icon: '✅', label: '审核通过', color: '#22c55e' },
    review_rejected:       { icon: '❌', label: '审核驳回', color: '#ef4444' },
    revision_started:      { icon: '🔄', label: '开始修改', color: '#f59e0b' },
    delivery_started:      { icon: '📦', label: '开始交付', color: '#06b6d4' },
    delivery_completed:    { icon: '🎉', label: '交付完成', color: '#22c55e' },
    task_failed:           { icon: '💥', label: '任务失败', color: '#ef4444' },
    need_user_decision:    { icon: '⚠️', label: '等待决策', color: '#eab308' },
}

const items = computed<TimelineItem[]>(() => {
    const result: TimelineItem[] = []

    // Primary source: runEvents (granular execution events)
    for (const evt of props.runEvents) {
        const meta = RUN_EVENT_ICONS[evt.eventType] ?? { icon: '📌', label: evt.eventType, color: '#94a3b8' }
        let detail = ''
        if (evt.payload) {
            if (typeof evt.payload.message === 'string') {
                detail = evt.payload.message.slice(0, 120)
            } else if (typeof evt.payload.name === 'string') {
                detail = evt.payload.name
            }
        }
        result.push({
            id: `re-${evt.id}`,
            icon: meta.icon,
            source: evt.source,
            label: meta.label,
            detail,
            time: new Date(evt.createdAt).getTime(),
            color: meta.color,
        })
    }

    // Secondary source: workflowEvents (high-level state transitions)
    // Only include if no runEvents exist for the same task to avoid duplication
    const runEventTaskIds = new Set(props.runEvents.map(e => e.taskId))
    for (const evt of props.workflowEvents) {
        // Skip workflow events for tasks that already have runEvents
        if (runEventTaskIds.has(evt.taskId)) continue
        const meta = WORKFLOW_ICONS[evt.type] ?? { icon: '📌', label: evt.type, color: '#94a3b8' }
        let detail = ''
        if ((evt.type === 'review_passed' || evt.type === 'review_rejected') && evt.payload?.comment) {
            detail = String(evt.payload.comment).slice(0, 120)
        }
        result.push({
            id: `wf-${evt.id}`,
            icon: meta.icon,
            source: evt.agentRole,
            label: meta.label,
            detail,
            time: new Date(evt.createdAt).getTime(),
            color: meta.color,
        })
    }

    return result.sort((a, b) => b.time - a.time).slice(0, maxEvents)
})

// Auto-scroll to top (newest first)
watch(() => items.value.length, async () => {
    await nextTick()
    if (streamRef.value) {
        streamRef.value.scrollTop = 0
    }
})

function formatTime(ts: number): string {
    const d = new Date(ts)
    return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}`
}
</script>

<template>
    <div class="timeline-view">
        <div class="timeline-header">
            <span class="timeline-dot" />
            <span class="timeline-title">Timeline</span>
            <span class="timeline-count">{{ items.length }}</span>
        </div>
        <div ref="streamRef" class="timeline-body">
            <div
                v-for="item in items"
                :key="item.id"
                class="timeline-item"
            >
                <span class="tl-icon">{{ item.icon }}</span>
                <span class="tl-source" :style="{ color: item.color }">{{ item.source }}</span>
                <span class="tl-label">{{ item.label }}</span>
                <span v-if="item.detail" class="tl-detail">{{ item.detail }}</span>
                <span class="tl-time">{{ formatTime(item.time) }}</span>
            </div>
            <div v-if="items.length === 0" class="timeline-empty">
                暂无事件
            </div>
        </div>
    </div>
</template>

<style scoped lang="scss">
.timeline-view {
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

.timeline-header {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 10px;
    background: #111827;
    border-bottom: 1px solid #1e293b;
}

.timeline-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: #22c55e;
    animation: pulse-dot 2s infinite;
}

@keyframes pulse-dot {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.4; }
}

.timeline-title {
    color: #94a3b8;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 1px;
}

.timeline-count {
    margin-left: auto;
    color: #475569;
    font-size: 10px;
}

.timeline-body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 4px 0;
}

.timeline-item {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 3px 10px;
    transition: background 0.15s;

    &:hover {
        background: #1e293b;
    }
}

.tl-icon {
    flex-shrink: 0;
    font-size: 12px;
}

.tl-source {
    flex-shrink: 0;
    font-weight: 600;
    font-size: 11px;
    max-width: 80px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.tl-label {
    flex-shrink: 0;
    color: #cbd5e1;
    font-size: 11px;
}

.tl-detail {
    flex: 1;
    color: #64748b;
    font-size: 11px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
}

.tl-time {
    flex-shrink: 0;
    color: #475569;
    font-size: 10px;
}

.timeline-empty {
    padding: 20px;
    text-align: center;
    color: #475569;
}
</style>
