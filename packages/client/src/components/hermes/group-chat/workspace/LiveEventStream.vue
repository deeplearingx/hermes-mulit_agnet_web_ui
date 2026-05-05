<script setup lang="ts">
import { computed, ref, watch, nextTick } from 'vue'
import type { ChatMessage, RoomAgent } from '@/api/hermes/group-chat'
import type { GroupRuntimeEvent } from '@/stores/hermes/group-chat'

const props = defineProps<{
    messages: ChatMessage[]
    // P0-2: key is agentId
    contextStatuses: Map<string, { agentId: string; agentName: string; status: string }>
    liveEvents?: GroupRuntimeEvent[]
    agents: RoomAgent[]              // P7-9: for accurate isAgent detection
}>()

const streamRef = ref<HTMLDivElement>()
const maxEvents = 50

interface StreamEvent {
    id: string
    type: 'message' | 'status'
    icon: string
    sender: string
    content: string
    time: number
    color: string
}

const events = computed<StreamEvent[]>(() => {
    const result: StreamEvent[] = []
    // P7-9: use agentIds set for accurate isAgent detection
    const agentIds = new Set(props.agents.map(a => a.agentId))

    // Messages
    for (const msg of props.messages.slice(-30)) {
        const isAgent = agentIds.has(msg.senderId)
        result.push({
            id: msg.id,
            type: 'message',
            icon: isAgent ? '🤖' : '👤',
            sender: msg.senderName,
            content: msg.content.length > 80 ? msg.content.slice(0, 80) + '…' : msg.content,
            time: msg.timestamp,
            color: isAgent ? '#3b82f6' : '#e2e8f0',
        })
    }

    // Context status changes (P0-2: key is agentId, use agentName for display)
    for (const [key, status] of props.contextStatuses) {
        const icon = status.status === 'compressing' ? '⚙️' : '✍️'
        const label = status.status === 'compressing' ? '正在压缩上下文' : '正在生成回复'
        result.push({
            id: `ctx-${key}-${status.status}`,
            type: 'status',
            icon,
            sender: status.agentName || key,
            content: label,
            time: Date.now(),
            color: status.status === 'compressing' ? '#f59e0b' : '#3b82f6',
        })
    }

    // Agent runtime events
    if (props.liveEvents) {
        const typeMap: Record<string, { icon: string; label: string; color: string }> = {
            run_started: { icon: '🚀', label: '开始运行', color: '#22c55e' },
            context_compressing: { icon: '⚙️', label: '压缩上下文', color: '#f59e0b' },
            replying: { icon: '✍️', label: '生成回复', color: '#3b82f6' },
            tool_call: { icon: '🔧', label: '调用工具', color: '#8b5cf6' },
            run_completed: { icon: '✅', label: '运行完成', color: '#22c55e' },
            run_failed: { icon: '❌', label: '运行失败', color: '#ef4444' },
        }
        // P0-1a fix: store uses unshift (newest at index 0), so slice(0, 20) gets newest
        for (const evt of props.liveEvents.slice(0, 20)) {
            const meta = typeMap[evt.type] || { icon: '📌', label: evt.type, color: '#94a3b8' }
            result.push({
                id: `evt-${evt.id}`,
                type: 'status',
                icon: meta.icon,
                sender: evt.agentName,
                content: meta.label + (evt.payload.model ? ` (${evt.payload.model})` : ''),
                time: evt.timestamp,
                color: meta.color,
            })
        }
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
    <div class="live-event-stream">
        <div class="stream-header">
            <span class="stream-dot" />
            <span class="stream-title">实时事件流</span>
            <span class="stream-count">{{ events.length }}</span>
        </div>
        <div ref="streamRef" class="stream-body">
            <div
                v-for="evt in events"
                :key="evt.id"
                class="stream-event"
                :class="{ 'is-status': evt.type === 'status' }"
            >
                <span class="event-icon">{{ evt.icon }}</span>
                <span class="event-sender" :style="{ color: evt.color }">{{ evt.sender }}</span>
                <span class="event-content">{{ evt.content }}</span>
                <span class="event-time">{{ formatTime(evt.time) }}</span>
            </div>
            <div v-if="events.length === 0" class="stream-empty">
                暂无事件
            </div>
        </div>
    </div>
</template>

<style scoped lang="scss">
.live-event-stream {
    display: flex;
    flex-direction: column;
    background: #0c1222;
    border: 1px solid #1e293b;
    border-radius: 6px;
    overflow: hidden;
    font-family: 'Courier New', monospace;
    font-size: 12px;
}

.stream-header {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 10px;
    background: #111827;
    border-bottom: 1px solid #1e293b;
}

.stream-dot {
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

.stream-title {
    color: #94a3b8;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 1px;
}

.stream-count {
    margin-left: auto;
    color: #475569;
    font-size: 10px;
}

.stream-body {
    flex: 1;
    overflow-y: auto;
    padding: 4px 0;
    max-height: 200px;
}

.stream-event {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 3px 10px;
    transition: background 0.15s;

    &:hover {
        background: #1e293b;
    }

    &.is-status {
        background: rgba(59, 130, 246, 0.05);
        border-left: 2px solid #3b82f6;
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

.stream-empty {
    padding: 20px;
    text-align: center;
    color: #475569;
}
</style>
