<script setup lang="ts">
import { computed } from 'vue'
import type { RoomAgent, ChatMessage, MemberInfo, GroupTask, GroupArtifact } from '@/api/hermes/group-chat'
import type { GroupRuntimeEvent } from '@/stores/hermes/group-chat'
import { useGroupChatStore } from '@/stores/hermes/group-chat'
import PhaserWorkspace from './PhaserWorkspace.vue'
import LiveEventStream from './LiveEventStream.vue'
import OrchestrationPanel from './OrchestrationPanel.vue'

const props = defineProps<{
    roomId: string
    agents: RoomAgent[]
    members: MemberInfo[]
    messages: ChatMessage[]
    // P0-2: key is agentId
    contextStatuses: Map<string, { agentId: string; agentName: string; status: string }>
    typingNames: string[]
    tasks: GroupTask[]
    artifacts: GroupArtifact[]
    liveEvents?: GroupRuntimeEvent[]
}>()

const store = useGroupChatStore()

// P8-11: Use store's unified computed — single source of truth
const activeTask = computed(() => store.activeTask)
const displayTask = computed(() => store.displayTask)
const agentWorkspaceStates = computed(() => store.agentWorkspaceStates)
</script>

<template>
    <div class="workspace-main">
        <!-- Left: Phaser canvas + event stream -->
        <div class="workspace-center">
            <div class="workspace-canvas">
                <PhaserWorkspace
                    :agent-workspace-states="agentWorkspaceStates"
                    :active-phase="activeTask?.phase"
                    :active-task-title="activeTask?.title"
                />
            </div>
            <div class="workspace-stream">
                <LiveEventStream
                    :messages="messages"
                    :context-statuses="contextStatuses"
                    :live-events="liveEvents"
                    :agents="agents"
                />
            </div>
        </div>

        <!-- Right: Orchestration panel -->
        <div class="workspace-panel">
            <OrchestrationPanel
                :agents="agents"
                :context-statuses="contextStatuses"
                :messages="messages"
                :typing-names="typingNames"
                :tasks="tasks"
                :artifacts="artifacts"
                :live-events="liveEvents"
                :agent-workspace-states="agentWorkspaceStates"
                :display-task="displayTask"
            />
        </div>
    </div>
</template>

<style scoped lang="scss">
.workspace-main {
    display: flex;
    gap: 8px;
    height: 100%;
    min-height: 0;
    padding: 8px;
    background: #0a0f1e;
}

.workspace-center {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-width: 0;
    min-height: 0;
}

.workspace-canvas {
    flex: 1;
    min-height: 300px;
    border-radius: 6px;
    overflow: hidden;
}

.workspace-stream {
    flex-shrink: 0;
    max-height: 220px;
}

.workspace-panel {
    width: 280px;
    flex-shrink: 0;
    min-height: 0;
}

// Responsive: stack on narrow screens
@media (max-width: 900px) {
    .workspace-main {
        flex-direction: column;
    }

    .workspace-panel {
        width: 100%;
        max-height: 300px;
    }
}
</style>
