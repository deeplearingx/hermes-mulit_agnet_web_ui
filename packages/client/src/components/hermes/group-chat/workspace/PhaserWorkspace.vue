<script setup lang="ts">
import { ref, watch, onMounted, onBeforeUnmount } from 'vue'
import type { RoomAgent, WorkspaceLayoutItem } from '@/api/hermes/group-chat'
import { useGroupChatStore } from '@/stores/hermes/group-chat'
import { deriveAgentStates } from './runtime/agent-state'

const props = defineProps<{
    agents: RoomAgent[]
    contextStatuses: Map<string, { agentName: string; status: string }>
}>()

const store = useGroupChatStore()
const containerRef = ref<HTMLDivElement>()
let game: Phaser.Game | null = null
let layoutDebounceTimer: ReturnType<typeof setTimeout> | null = null
const pendingLayoutChanges = ref<Map<string, WorkspaceLayoutItem>>(new Map())

onMounted(async () => {
    if (!containerRef.value) return

    const Phaser = (await import('phaser')).default
    const { GroupOfficeScene } = await import('./scenes/GroupOfficeScene')

    game = new Phaser.Game({
        type: Phaser.AUTO,
        parent: containerRef.value,
        width: 720,
        height: 560,
        pixelArt: true,
        backgroundColor: '#0f1729',
        scene: [GroupOfficeScene],
        scale: {
            mode: Phaser.Scale.FIT,
            autoCenter: Phaser.Scale.CENTER_BOTH,
        },
        banner: false,
        audio: { noAudio: true },
    })

    // Enable drag mode after game is ready
    setTimeout(() => {
        window.dispatchEvent(new CustomEvent('workspace:drag:enable', {
            detail: { enabled: true },
        }))
    }, 500)

    // Listen for layout changes from Phaser drag events
    window.addEventListener('workspace:layout:changed', onLayoutChanged as EventListener)
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
})

function onLayoutChanged(e: Event) {
    const { agentId, x, y, zone } = (e as CustomEvent).detail
    pendingLayoutChanges.value.set(agentId, { agentId, x, y, zone })

    // Debounce: save layout after 1 second of no changes
    if (layoutDebounceTimer) clearTimeout(layoutDebounceTimer)
    layoutDebounceTimer = setTimeout(async () => {
        // Merge pending changes with existing layout
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
    }, 1000)
}

// Bridge: Vue props → Phaser scene via CustomEvent
watch(
    () => [props.agents, props.contextStatuses],
    () => {
        const states = deriveAgentStates(props.agents, props.contextStatuses)
        window.dispatchEvent(new CustomEvent('workspace:agents:update', {
            detail: { agents: states },
        }))
    },
    { deep: true, immediate: true },
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
