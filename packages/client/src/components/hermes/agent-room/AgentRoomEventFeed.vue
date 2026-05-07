<script setup lang="ts">
import { computed, ref, watch, nextTick } from 'vue'
import type { AgentRoomWorkflowEvent } from '@/api/hermes/agent-room'

const props = defineProps<{
    workflowEvents: AgentRoomWorkflowEvent[]
}>()

const streamRef = ref<HTMLDivElement>()
const maxEvents = 50

interface FeedEvent {
    id: string
    icon: string
    sender: string
    content: string
    time: number
    color: string
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

const events = computed<FeedEvent[]>(() => {
    const result: FeedEvent[] = []

    // Only consume workflowEvents as the single timeline source.
    // User messages are displayed separately by AgentRoomMessageList.
    // Review details (comment) are embedded in review_passed/review_rejected payload.
    for (const evt of props.workflowEvents.slice(-30)) {
        const meta = WORKFLOW_ICONS[evt.type] || { icon: '📌', label: evt.type, color: '#94a3b8' }
        let content = meta.label

        // Append review comment from payload when available
        if ((evt.type === 'review_passed' || evt.type === 'review_rejected') && evt.payload?.comment) {
            content += `: ${evt.payload.comment}`
        }

        result.push({
            id: `wf-${evt.id}`,
            icon: meta.icon,
            sender: evt.agentRole,
            content,
            time: new Date(evt.createdAt).getTime(),
            color: meta.color,
        })
    }

    return result.sort((a, b) => b.time - a.time).slice(0, maxEvents)
})

// Auto-scroll to top (newest first)
watch(() => events.value.length, async () => {
    await nextTick()
    if (streamRef.value) {
        streamRef.value.scrollTop = 0
    }
})

function formatTime(ts: number): string {
    const d = new Date(ts)
    return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`
}
</script>

<template>
    <div class="event-feed">
        <div class="feed-header">
            <span class="feed-dot" />
            <span class="feed-title">实时事件流</span>
            <span class="feed-count">{{ events.length }}</span>
        </div>
        <div ref="streamRef" class="feed-body">
            <div
                v-for="evt in events"
                :key="evt.id"
                class="feed-event"
            >
                <span class="event-icon">{{ evt.icon }}</span>
                <span class="event-sender" :style="{ color: evt.color }">{{ evt.sender }}</span>
                <span class="event-content">{{ evt.content }}</span>
                <span class="event-time">{{ formatTime(evt.time) }}</span>
            </div>
            <div v-if="events.length === 0" class="feed-empty">
                暂无事件
            </div>
        </div>
    </div>
</template>

<style scoped lang="scss">
.event-feed {
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

.feed-header {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 10px;
    background: #111827;
    border-bottom: 1px solid #1e293b;
}

.feed-dot {
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

.feed-title {
    color: #94a3b8;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 1px;
}

.feed-count {
    margin-left: auto;
    color: #475569;
    font-size: 10px;
}

.feed-body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 4px 0;
}

.feed-event {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 3px 10px;
    transition: background 0.15s;

    &:hover {
        background: #1e293b;
    }
}

.event-icon {
    flex-shrink: 0;
    font-size: 12px;
}

.event-sender {
    flex-shrink: 0;
    font-weight: 600;
    font-size: 11px;
    max-width: 80px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.event-content {
    flex: 1;
    color: #94a3b8;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.event-time {
    flex-shrink: 0;
    color: #475569;
    font-size: 10px;
}

.feed-empty {
    padding: 20px;
    text-align: center;
    color: #475569;
}
</style>
