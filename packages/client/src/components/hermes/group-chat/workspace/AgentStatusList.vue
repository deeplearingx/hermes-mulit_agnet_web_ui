<script setup lang="ts">
import { computed } from 'vue'
import { useGroupChatStore } from '@/stores/hermes/group-chat'
import { agentColor } from './runtime/agent-state'
import { STATUS_VISUALS } from './runtime/types'
import type { AgentWorkspaceState, AgentWorkStatus } from './runtime/types'

const props = defineProps<{
    agentStates: AgentWorkspaceState[]  // P8-3: pre-computed from store
}>()

const store = useGroupChatStore()

const selectedAgentId = computed(() => store.selectedAgentId)

const ROLE_LABELS: Record<string, string> = {
    observer: '👁️ 观察员',
    planner: '📐 架构师',
    developer: '💻 开发',
    reviewer: '🔍 评审',
    delivery: '📦 交付',
    tester: '🧪 测试',
}

// P9-6: Event type labels for behavior card
const EVENT_LABELS: Record<string, string> = {
    run_started: '🚀 开始运行',
    context_compressing: '⚙️ 压缩上下文',
    replying: '✍️ 生成回复',
    tool_call: '🔧 调用工具',
    run_completed: '✅ 运行完成',
    run_failed: '❌ 运行失败',
}

function statusColor(status: AgentWorkStatus): string {
    return '#' + STATUS_VISUALS[status].color.toString(16).padStart(6, '0')
}

function handleAgentClick(agentId: string) {
    // P8-9: Toggle selection via store
    store.selectAgent(store.selectedAgentId === agentId ? null : agentId)
}

const selectedAgent = computed(() =>
    props.agentStates.find(a => a.agentId === selectedAgentId.value) ?? null
)
</script>

<template>
    <div class="agent-status-list">
        <div class="asl-header">
            <span class="asl-title">🤖 Agent 状态</span>
            <span class="asl-count">{{ agentStates.length }}</span>
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
            <div v-if="agentStates.length === 0" class="asl-empty">
                暂无 Agent
            </div>
        </div>

        <!-- P8-9 + P9-6: Agent detail panel (enhanced behavior card) -->
        <div v-if="selectedAgent" class="asl-detail">
            <div class="asl-detail-header">
                <span class="asl-detail-name">{{ selectedAgent.agentName }}</span>
                <span v-if="selectedAgent.pinned" class="asl-pin-badge">📌</span>
                <button class="asl-detail-close" @click="store.selectAgent(null)">✕</button>
            </div>
            <div class="asl-detail-row">
                <span class="asl-detail-label">角色</span>
                <span class="asl-detail-value">{{ ROLE_LABELS[selectedAgent.roleType] || selectedAgent.roleType }}</span>
            </div>
            <div class="asl-detail-row">
                <span class="asl-detail-label">状态</span>
                <span class="asl-detail-value" :style="{ color: statusColor(selectedAgent.status) }">
                    {{ STATUS_VISUALS[selectedAgent.status].emoji }} {{ STATUS_VISUALS[selectedAgent.status].label }}
                </span>
            </div>
            <div v-if="selectedAgent.currentTaskTitle" class="asl-detail-row">
                <span class="asl-detail-label">任务</span>
                <span class="asl-detail-value">{{ selectedAgent.currentTaskTitle }}</span>
            </div>
            <div v-if="selectedAgent.phase" class="asl-detail-row">
                <span class="asl-detail-label">阶段</span>
                <span class="asl-detail-value">{{ selectedAgent.phase }}</span>
            </div>
            <!-- P9-6: 正在调用的工具 -->
            <div v-if="selectedAgent.activeToolName" class="asl-detail-row asl-highlight">
                <span class="asl-detail-label">🔧 工具</span>
                <span class="asl-detail-value">{{ selectedAgent.activeToolName }}</span>
            </div>
            <!-- P9-6: 最近事件 -->
            <div v-if="selectedAgent.lastEventType" class="asl-detail-row">
                <span class="asl-detail-label">最近事件</span>
                <span class="asl-detail-value">
                    {{ EVENT_LABELS[selectedAgent.lastEventType] || selectedAgent.lastEventType }}
                    <span v-if="selectedAgent.lastEventPayload"> · {{ selectedAgent.lastEventPayload }}</span>
                </span>
            </div>
            <!-- P9-6: 最近产出物 -->
            <div v-if="selectedAgent.lastArtifactName" class="asl-detail-row">
                <span class="asl-detail-label">📦 产出</span>
                <span class="asl-detail-value">{{ selectedAgent.lastArtifactName }}</span>
            </div>
            <div class="asl-detail-row">
                <span class="asl-detail-label">区域</span>
                <span class="asl-detail-value">{{ selectedAgent.zone }}</span>
            </div>
            <div class="asl-detail-row">
                <span class="asl-detail-label">固定</span>
                <span class="asl-detail-value">{{ selectedAgent.pinned ? '📌 是' : '否' }}</span>
            </div>
            <div class="asl-detail-row">
                <span class="asl-detail-label">Profile</span>
                <span class="asl-detail-value">{{ selectedAgent.profile }}</span>
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

// ─── Agent Detail Panel (P8-9) ───────────────────────────
.asl-detail {
    border-top: 1px solid #1e293b;
    padding: 8px;
    background: #0f1729;
}

.asl-detail-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 6px;
}

.asl-detail-name {
    font-size: 12px;
    font-weight: 600;
    color: #e2e8f0;
    font-family: 'Courier New', monospace;
}

.asl-detail-close {
    background: none;
    border: none;
    color: #64748b;
    cursor: pointer;
    font-size: 12px;
    padding: 2px 4px;

    &:hover {
        color: #e2e8f0;
    }
}

.asl-detail-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 2px 0;
}

.asl-detail-label {
    font-size: 10px;
    color: #64748b;
    font-family: 'Courier New', monospace;
}

.asl-detail-value {
    font-size: 10px;
    color: #94a3b8;
    font-family: 'Courier New', monospace;
    text-align: right;
    max-width: 140px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
</style>
