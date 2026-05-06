<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue'
import AgentRoomPanel from '@/components/hermes/agent-room/AgentRoomPanel.vue'
import { useAgentRoomStore } from '@/stores/hermes/agent-room'

const store = useAgentRoomStore()

onMounted(() => {
    store.loadSessions()
})

onUnmounted(() => {
    store.$reset()
})
</script>

<template>
    <div class="agent-room-view">
        <AgentRoomPanel />
    </div>
</template>

<style scoped lang="scss">
.agent-room-view {
    height: calc(100 * var(--vh));
    display: flex;
    flex-direction: column;
}
</style>
