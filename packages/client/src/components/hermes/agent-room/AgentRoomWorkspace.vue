<script setup lang="ts">
import { ref, watch, onMounted, onBeforeUnmount, computed } from 'vue'
import { useAgentRoomStore } from '@/stores/hermes/agent-room'
import type { AgentRoomTaskStatus } from '@/api/hermes/agent-room'

const store = useAgentRoomStore()
const containerRef = ref<HTMLDivElement>()
let game: Phaser.Game | null = null
let sceneReady = false
const instanceId = `ar-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

// ─── Derive agent display states from store ─────────────────
interface AgentDisplayState {
    id: string
    name: string
    role: string
    status: 'idle' | 'active' | 'completed' | 'failed'
}

// Map task status → which agent role is "active"
const STATUS_TO_ACTIVE_ROLE: Partial<Record<AgentRoomTaskStatus, string>> = {
    created: 'conversation',
    planned: 'planner',
    assigned: 'developer',
    in_progress: 'developer',
    submitted_for_review: 'reviewer',
    review_passed: 'delivery',
    review_rejected: 'reviewer',
    revision_required: 'developer',
    delivering: 'delivery',
    completed: 'delivery',
    failed: 'developer',
    need_user_decision: 'conversation',
}

const agentDisplayStates = computed<AgentDisplayState[]>(() => {
    const activeRole = store.activeTask
        ? STATUS_TO_ACTIVE_ROLE[store.activeTask.status] ?? null
        : null

    return store.agents.map(agent => {
        let status: AgentDisplayState['status'] = 'idle'
        if (store.activeTask) {
            if (agent.role === activeRole) {
                status = 'active'
            } else if (store.activeTask.status === 'completed') {
                status = 'completed'
            } else if (store.activeTask.status === 'failed') {
                status = 'failed'
            }
        }
        return {
            id: agent.id,
            name: agent.name,
            role: agent.role,
            status,
        }
    })
})

const taskDisplayState = computed(() => {
    const task = store.activeTask
    if (!task) return null
    return {
        title: task.title,
        status: task.status,
        assignedAgentRole: STATUS_TO_ACTIVE_ROLE[task.status] ?? null,
    }
})

// ─── Push state to Phaser scene ─────────────────────────────
function pushStateToScene() {
    window.dispatchEvent(new CustomEvent('agent-room:state:update', {
        detail: {
            instanceId,
            agents: agentDisplayStates.value,
            task: taskDisplayState.value,
        },
    }))
}

// ─── Phaser lifecycle ────────────────────────────────────────
onMounted(async () => {
    if (!containerRef.value) return

    window.addEventListener('agent-room:scene:ready', onSceneReady as EventListener)

    const PhaserLib = (await import('phaser')).default
    const { AgentRoomBootScene } = await import('./scenes/AgentRoomBootScene')
    const { AgentRoomOfficeScene } = await import('./scenes/AgentRoomOfficeScene')

    game = new PhaserLib.Game({
        type: PhaserLib.AUTO,
        parent: containerRef.value,
        width: 960,
        height: 540,
        pixelArt: true,
        backgroundColor: '#0f1729',
        scene: [new AgentRoomBootScene(instanceId), new AgentRoomOfficeScene(instanceId)],
        scale: {
            mode: PhaserLib.Scale.FIT,
            autoCenter: PhaserLib.Scale.CENTER_BOTH,
        },
        banner: false,
        audio: { noAudio: true },
    })
})

onBeforeUnmount(() => {
    sceneReady = false
    if (game) {
        game.destroy(true)
        game = null
    }
    window.removeEventListener('agent-room:scene:ready', onSceneReady as EventListener)
})

function onSceneReady(e: Event) {
    const detail = (e as CustomEvent).detail as { instanceId?: string }
    // Only accept ready events from our own Phaser instance
    if (!detail.instanceId || detail.instanceId !== instanceId) return
    sceneReady = true
    pushStateToScene()
}

// ─── Watch store changes → push to scene ─────────────────────
watch(
    () => [agentDisplayStates.value, taskDisplayState.value],
    () => {
        if (sceneReady) pushStateToScene()
    },
    { deep: true },
)
</script>

<template>
    <div ref="containerRef" class="agent-room-workspace" />
</template>

<style scoped lang="scss">
.agent-room-workspace {
    width: 100%;
    height: 100%;
    min-height: 400px;
    border-radius: 6px;
    overflow: hidden;
    background: #0f1729;

    :deep(canvas) {
        display: block;
        image-rendering: pixelated;
        image-rendering: crisp-edges;
    }
}
</style>
