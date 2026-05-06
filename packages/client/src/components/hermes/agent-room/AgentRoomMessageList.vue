<script setup lang="ts">
import { ref, watch, nextTick } from 'vue'
import type { AgentRoomMessage } from '@/api/hermes/agent-room'

const props = defineProps<{
    messages: AgentRoomMessage[]
}>()

const listRef = ref<HTMLDivElement | null>(null)

// Auto-scroll to bottom on new messages
watch(() => props.messages.length, async () => {
    await nextTick()
    if (listRef.value) {
        listRef.value.scrollTop = listRef.value.scrollHeight
    }
})

function roleEmoji(role: string): string {
    switch (role) {
        case 'conversation': return '💬'
        case 'planner': return '📐'
        case 'developer': return '⚡'
        case 'reviewer': return '🔍'
        case 'delivery': return '✅'
        case 'user': return '👤'
        default: return '🤖'
    }
}

function roleColor(role: string): string {
    switch (role) {
        case 'conversation': return '#4fc3f7'
        case 'planner': return '#ba68c8'
        case 'developer': return '#81c784'
        case 'reviewer': return '#ffb74d'
        case 'delivery': return '#e57373'
        case 'user': return '#90caf9'
        default: return '#aaaaaa'
    }
}

function formatTime(iso: string): string {
    const d = new Date(iso)
    return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

function messageTypeLabel(type: string): string {
    switch (type) {
        case 'task_event': return '📋 任务事件'
        case 'review_result': return '🔍 审核结果'
        case 'final_delivery': return '🎉 最终交付'
        case 'error': return '❌ 错误'
        default: return ''
    }
}
</script>

<template>
    <div ref="listRef" class="message-list">
        <div v-if="messages.length === 0" class="empty-messages">
            <span class="empty-icon">💬</span>
            <p>暂无消息，发送消息或创建任务开始工作</p>
        </div>
        <div
            v-for="msg in messages"
            :key="msg.id"
            class="message-item"
            :class="[`role-${msg.senderRole}`, `type-${msg.type}`]"
        >
            <div class="msg-avatar" :style="{ borderColor: roleColor(msg.senderRole) }">
                {{ roleEmoji(msg.senderRole) }}
            </div>
            <div class="msg-body">
                <div class="msg-header">
                    <span class="msg-sender" :style="{ color: roleColor(msg.senderRole) }">
                        {{ msg.senderName }}
                    </span>
                    <span v-if="msg.type !== 'agent_message' && msg.type !== 'user_message'" class="msg-type-badge">
                        {{ messageTypeLabel(msg.type) }}
                    </span>
                    <span class="msg-time">{{ formatTime(msg.createdAt) }}</span>
                </div>
                <div class="msg-content">{{ msg.content }}</div>
                <div v-if="msg.metadata?.reviewComment" class="msg-review-comment">
                    审核意见：{{ msg.metadata.reviewComment }}
                </div>
                <div v-if="msg.metadata?.roundIndex !== undefined" class="msg-round">
                    修改轮次：{{ msg.metadata.roundIndex }}
                </div>
            </div>
        </div>
    </div>
</template>

<style scoped lang="scss">
.message-list {
    flex: 1;
    overflow-y: auto;
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 8px;
}

.empty-messages {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    color: var(--vscode-descriptionForeground, #999999);

    .empty-icon {
        font-size: 32px;
    }

    p {
        margin: 0;
        font-size: 13px;
    }
}

.message-item {
    display: flex;
    gap: 8px;
    padding: 8px;
    border-radius: 6px;
    background: var(--vscode-editorWidget-background, #252526);

    &.type-task_event,
    &.type-review_result,
    &.type-final_delivery {
        border-left: 3px solid var(--vscode-terminal-ansiYellow, #e5c07b);
    }

    &.type-error {
        border-left: 3px solid var(--vscode-errorForeground, #f44747);
    }
}

.msg-avatar {
    width: 32px;
    height: 32px;
    border-radius: 50%;
    border: 2px solid;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 14px;
    flex-shrink: 0;
    background: var(--vscode-editor-background, #1e1e1e);
}

.msg-body {
    flex: 1;
    min-width: 0;
}

.msg-header {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 4px;
}

.msg-sender {
    font-size: 12px;
    font-weight: 600;
}

.msg-type-badge {
    font-size: 10px;
    padding: 1px 6px;
    border-radius: 3px;
    background: var(--vscode-badge-background, #4d4d4d);
    color: var(--vscode-badge-foreground, #ffffff);
}

.msg-time {
    font-size: 10px;
    color: var(--vscode-descriptionForeground, #999999);
    margin-left: auto;
}

.msg-content {
    font-size: 13px;
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-word;
}

.msg-review-comment {
    margin-top: 6px;
    padding: 4px 8px;
    border-radius: 4px;
    background: var(--vscode-textBlockQuote-background, #2a2d2e);
    border-left: 3px solid var(--vscode-terminal-ansiYellow, #e5c07b);
    font-size: 12px;
    color: var(--vscode-descriptionForeground, #999999);
}

.msg-round {
    margin-top: 4px;
    font-size: 11px;
    color: var(--vscode-descriptionForeground, #999999);
}
</style>
