<script setup lang="ts">
import type { AgentRoomMessage } from '@/api/hermes/agent-room'
import AgentRoomMessageList from './AgentRoomMessageList.vue'

defineProps<{
    messages: AgentRoomMessage[]
}>()

const emit = defineEmits<{
    (e: 'send', content: string): void
}>()
</script>

<template>
    <div class="chat-view">
        <div class="chat-header">
            <span class="chat-title">Chat</span>
            <span class="chat-count">{{ messages.length }}</span>
        </div>
        <div class="chat-body">
            <AgentRoomMessageList :messages="messages" />
        </div>
    </div>
</template>

<style scoped lang="scss">
.chat-view {
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

.chat-header {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 10px;
    background: #111827;
    border-bottom: 1px solid #1e293b;
}

.chat-title {
    color: #94a3b8;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 1px;
}

.chat-count {
    margin-left: auto;
    color: #475569;
    font-size: 10px;
}

.chat-body {
    flex: 1;
    min-height: 0;
    overflow: hidden;
}
</style>
