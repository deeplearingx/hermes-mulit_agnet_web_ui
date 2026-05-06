<script setup lang="ts">
import type { AgentRoomAgent, AgentRoomTask } from '@/api/hermes/agent-room'

const props = defineProps<{
    agents: AgentRoomAgent[]
    activeTask: AgentRoomTask | null
}>()

function roleEmoji(role: string): string {
    switch (role) {
        case 'conversation': return '💬'
        case 'planner': return '📐'
        case 'developer': return '⚡'
        case 'reviewer': return '🔍'
        case 'delivery': return '✅'
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
        default: return '#aaaaaa'
    }
}

function isAgentActive(agent: AgentRoomAgent): boolean {
    if (!props.activeTask) return false
    // Map task status to expected active agent role
    const statusRoleMap: Record<string, string> = {
        created: 'conversation',
        planned: 'planner',
        assigned: 'developer',
        in_progress: 'developer',
        submitted_for_review: 'reviewer',
        review_passed: 'reviewer',
        review_rejected: 'reviewer',
        revision_required: 'developer',
        delivering: 'delivery',
        completed: 'delivery',
        failed: 'developer',
        need_user_decision: 'conversation',
    }
    return statusRoleMap[props.activeTask.status] === agent.role
}
</script>

<template>
    <div class="agent-list">
        <div class="agent-list-header">
            <span class="header-icon">🤖</span>
            <span>Agent 列表</span>
        </div>
        <div class="agent-items">
            <div
                v-for="agent in agents"
                :key="agent.id"
                class="agent-item"
                :class="{ active: isAgentActive(agent) }"
            >
                <div class="agent-avatar" :style="{ borderColor: roleColor(agent.role) }">
                    {{ roleEmoji(agent.role) }}
                </div>
                <div class="agent-info">
                    <div class="agent-name" :style="{ color: roleColor(agent.role) }">
                        {{ agent.name }}
                    </div>
                    <div class="agent-desc">{{ agent.description }}</div>
                </div>
                <div v-if="isAgentActive(agent)" class="active-indicator">
                    <span class="pulse-dot" :style="{ background: roleColor(agent.role) }"></span>
                </div>
            </div>
        </div>
    </div>
</template>

<style scoped lang="scss">
.agent-list {
    width: 200px;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    background: var(--vscode-sideBar-background, #252526);
    border-right: 1px solid var(--vscode-widget-border, #3c3c3c);
}

.agent-list-header {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 10px 12px;
    font-size: 12px;
    font-weight: 600;
    color: var(--vscode-sideBarSectionHeader-foreground, #bbbbbb);
    border-bottom: 1px solid var(--vscode-widget-border, #3c3c3c);
    text-transform: uppercase;
    letter-spacing: 0.5px;

    .header-icon {
        font-size: 14px;
    }
}

.agent-items {
    flex: 1;
    overflow-y: auto;
    padding: 4px 0;
}

.agent-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    cursor: default;
    transition: background 0.15s;

    &:hover {
        background: var(--vscode-list-hoverBackground, #2a2d2e);
    }

    &.active {
        background: var(--vscode-list-activeSelectionBackground, #094771);
    }
}

.agent-avatar {
    width: 28px;
    height: 28px;
    border-radius: 50%;
    border: 2px solid;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 12px;
    flex-shrink: 0;
    background: var(--vscode-editor-background, #1e1e1e);
}

.agent-info {
    flex: 1;
    min-width: 0;
}

.agent-name {
    font-size: 12px;
    font-weight: 600;
    line-height: 1.3;
}

.agent-desc {
    font-size: 10px;
    color: var(--vscode-descriptionForeground, #999999);
    line-height: 1.3;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.active-indicator {
    flex-shrink: 0;
}

.pulse-dot {
    display: block;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    animation: pulse 1.5s ease-in-out infinite;
}

@keyframes pulse {
    0%, 100% { opacity: 1; transform: scale(1); }
    50% { opacity: 0.5; transform: scale(0.8); }
}
</style>
