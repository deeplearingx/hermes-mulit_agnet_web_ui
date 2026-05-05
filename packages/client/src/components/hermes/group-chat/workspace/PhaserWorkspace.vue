<script setup lang="ts">
import { ref, watch, onMounted, onBeforeUnmount } from 'vue'
import type { WorkspaceLayoutItem } from '@/api/hermes/group-chat'
import type { AgentWorkspaceState } from './runtime/types'
import { useGroupChatStore } from '@/stores/hermes/group-chat'

const props = defineProps<{
    agentWorkspaceStates: AgentWorkspaceState[]  // P8-3: pre-computed from store
    activePhase?: string
    activeTaskTitle?: string
}>()

const store = useGroupChatStore()
const containerRef = ref<HTMLDivElement>()
let game: Phaser.Game | null = null
let layoutDebounceTimer: ReturnType<typeof setTimeout> | null = null
const pendingLayoutChanges = ref<Map<string, WorkspaceLayoutItem>>(new Map())
let sceneReady = false

onMounted(async () => {
    if (!containerRef.value) return

    const Phaser = (await import('phaser')).default
    const { BootScene } = await import('./scenes/BootScene')
    const { GroupOfficeScene } = await import('./scenes/GroupOfficeScene')

    // V4: 16:9 widescreen canvas
    game = new Phaser.Game({
        type: Phaser.AUTO,
        parent: containerRef.value,
        width: 960,
        height: 540,
        pixelArt: true,
        backgroundColor: '#0f1729',
        scene: [BootScene, GroupOfficeScene],
        scale: {
            mode: Phaser.Scale.FIT,
            autoCenter: Phaser.Scale.CENTER_BOTH,
        },
        banner: false,
        audio: { noAudio: true },
    })

    // Listen for layout changes from Phaser drag events
    window.addEventListener('workspace:layout:changed', onLayoutChanged as EventListener)

    // P8-2: Listen for scene ready, then push current snapshot
    window.addEventListener('workspace:scene:ready', onSceneReady as EventListener)

    // P8-9: Listen for agent selection from Phaser
    window.addEventListener('workspace:agent:selected', onAgentSelected as EventListener)
})

onBeforeUnmount(() => {
    if (game) {
        game.destroy(true)
        game = null
    }
    if (layoutDebounceTimer) {
        clearTimeout(layoutDebounceTimer)
        layoutDebounceTimer = null
    }
    window.removeEventListener('workspace:layout:changed', onLayoutChanged as EventListener)
    window.removeEventListener('workspace:scene:ready', onSceneReady as EventListener)
    window.removeEventListener('workspace:agent:selected', onAgentSelected as EventListener)
})

// P8-2: Scene is ready — push current state snapshot
function onSceneReady() {
    sceneReady = true
    pushStateToScene()
}

// P8-9: Agent selected in Phaser — update store
function onAgentSelected(e: Event) {
    const { agentId } = (e as CustomEvent).detail
    store.selectAgent(agentId)
}

function pushStateToScene() {
    window.dispatchEvent(new CustomEvent('workspace:agents:update', {
        detail: { agents: props.agentWorkspaceStates },
    }))
    window.dispatchEvent(new CustomEvent('workspace:phase:update', {
        detail: { activePhase: props.activePhase, activeTaskTitle: props.activeTaskTitle },
    }))
}

function onLayoutChanged(e: Event) {
    const { agentId, x, y, zone } = (e as CustomEvent).detail
    pendingLayoutChanges.value.set(agentId, { agentId, x, y, zone })
    store.setDragging(true)

    // Debounce: save layout after 1 second of no changes
    if (layoutDebounceTimer) clearTimeout(layoutDebounceTimer)
    layoutDebounceTimer = setTimeout(async () => {
        const existing = [...store.workspaceLayout]
        for (const [id, item] of pendingLayoutChanges.value) {
            const idx = existing.findIndex(l => l.agentId === id)
            if (idx >= 0) {
                existing[idx] = item
            } else {
                existing.push(item)
            }
        }
        pendingLayoutChanges.value.clear()
        await store.saveWorkspaceLayout(existing)
        store.setDragging(false)
    }, 1000)
}

// P8-3: Watch pre-computed states from store → push to Phaser scene
watch(
    () => [props.agentWorkspaceStates, props.activePhase, props.activeTaskTitle],
    () => {
        if (sceneReady) pushStateToScene()
    },
    { deep: true },
)
</script>

<template>
    <div ref="containerRef" class="phaser-workspace" />
</template>

<style scoped lang="scss">
.phaser-workspace {
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
