<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import type { RoomAgent } from '@/api/hermes/group-chat'
import { deriveAgentStates, agentColor } from './runtime/agent-state'
import { STATUS_VISUALS } from './runtime/types'
import type { AgentWorkStatus } from './runtime/types'

const props = defineProps<{
    agents: RoomAgent[]
    // P0-2: key is agentId
    contextStatuses: Map<string, { agentId: string; agentName: string; status: string }>
}>()

const selectedAgentId = ref<string | null>(null)

const agentStates = computed(() => deriveAgentStates(props.agents, props.contextStatuses))

function statusColor(status: AgentWorkStatus): string {
    return '#' + STATUS_VISUALS[status].color.toString(16).padStart(6, '0')
}

function handleAgentClick(agentId: string) {
    selectedAgentId.value = agentId
}

// Listen for Phaser agent selection
function onPhaserSelect(e: Event) {
    const { agentId } = (e as CustomEvent).detail
    selectedAgentId.value = agentId
}

onMounted(() => {
    window.addEventListener('workspace:agent:selected', onPhaserSelect)
})

onBeforeUnmount(() => {
    window.removeEventListener('workspace:agent:selected', onPhaserSelect)
})
</script>

<template>
    <div class="agent-status-list">
        <div class="asl-header">
            <span class="asl-title">🤖 Agent 状态</span>
            <span class="asl-count">{{ agents.length }}</span>
        </div>
        <div class="asl-body">
            <div
                v-for="agent in agentStates"
                :key="agent.agentId"
                class="asl-card"
                :class="{ selected: selectedAgentId === agent.agentId }"
                @click="handleAgentClick(agent.agentId)"
            >
                <div class="asl-avatar" :style="{ background: '#' + agentColor(agent.agentName).toString(16).padStart(6, '0') }">
                    {{ agent.agentName.charAt(0).toUpperCase() }}
                </div>
                <div class="asl-info">
                    <div class="asl-name">{{ agent.agentName }}</div>
                    <div class="asl-profile">{{ agent.profile }}</div>
                </div>
                <div class="asl-status">
                    <span
                        class="asl-status-dot"
                        :style="{ background: statusColor(agent.status) }"
                    />
                    <span class="asl-status-label">{{ STATUS_VISUALS[agent.status].emoji }} {{ STATUS_VISUALS[agent.status].label }}</span>
                </div>
            </div>
            <div v-if="agents.length === 0" class="asl-empty">
                暂无 Agent
            </div>
        </div>
    </div>
</template>

<style scoped lang="scss">
.agent-status-list {
    display: flex;
    flex-direction: column;
}

.asl-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 12px;
    background: #111827;
    border-bottom: 1px solid #1e293b;
}

.asl-title {
    font-size: 11px;
    font-weight: 600;
    color: #94a3b8;
    text-transform: uppercase;
    letter-spacing: 1px;
    font-family: 'Courier New', monospace;
}

.asl-count {
    font-size: 10px;
    color: #475569;
    background: #1e293b;
    padding: 1px 6px;
    border-radius: 8px;
}

.asl-body {
    flex: 1;
    overflow-y: auto;
    padding: 4px;
}

.asl-card {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px;
    border-radius: 4px;
    cursor: pointer;
    transition: background 0.15s;

    &:hover {
        background: #1e293b;
    }

    &.selected {
        background: rgba(59, 130, 246, 0.1);
        border: 1px solid rgba(59, 130, 246, 0.3);
    }
}

.asl-avatar {
    width: 28px;
    height: 28px;
    border-radius: 4px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 12px;
    font-weight: 700;
    color: #0f172a;
    font-family: 'Courier New', monospace;
    flex-shrink: 0;
}

.asl-info {
    flex: 1;
    min-width: 0;
}

.asl-name {
    font-size: 12px;
    font-weight: 600;
    color: #e2e8f0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.asl-profile {
    font-size: 10px;
    color: #64748b;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.asl-status {
    display: flex;
    align-items: center;
    gap: 4px;
    flex-shrink: 0;
}

.asl-status-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
}

.asl-status-label {
    font-size: 10px;
    color: #94a3b8;
    font-family: 'Courier New', monospace;
}

.asl-empty {
    padding: 20px;
    text-align: center;
    color: #475569;
    font-size: 12px;
}
</style>
