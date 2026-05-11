<script setup lang="ts">
import { ref, computed } from 'vue'
import type { AgentRoomArtifact, AgentRoomTask } from '@/api/hermes/agent-room'

const props = defineProps<{
    artifacts: AgentRoomArtifact[]
    tasks: AgentRoomTask[]
}>()

const emit = defineEmits<{
    (e: 'delete-artifact', artifactId: string): void
}>()

const expandedArtifactId = ref<string | null>(null)
const filterTaskId = ref<string | null>(null)

const ARTIFACT_TYPE_ICONS: Record<string, string> = {
    final_delivery: '🎉',
    code_output: '💻',
    review_report: '📋',
    log: '📄',
    other: '📎',
}

function artifactTypeIcon(type: string): string {
    return ARTIFACT_TYPE_ICONS[type] ?? '📎'
}

function getTaskTitle(taskId: string): string {
    return props.tasks.find(t => t.id === taskId)?.title ?? taskId.slice(0, 8)
}

const filteredArtifacts = computed(() => {
    const sorted = [...props.artifacts].sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    )
    if (filterTaskId.value) {
        return sorted.filter(a => a.taskId === filterTaskId.value)
    }
    return sorted
})

/** Unique task IDs that have artifacts (for filter dropdown) */
const artifactTaskIds = computed(() => {
    const ids = new Set(props.artifacts.map(a => a.taskId))
    return [...ids]
})

function toggleArtifact(id: string) {
    expandedArtifactId.value = expandedArtifactId.value === id ? null : id
}

function handleDelete(artifactId: string) {
    emit('delete-artifact', artifactId)
}

function formatTime(iso: string): string {
    const d = new Date(iso)
    return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`
}
</script>

<template>
    <div class="artifacts-view">
        <div class="artifacts-header">
            <span class="artifacts-title">Artifacts</span>
            <select
                v-if="artifactTaskIds.length > 1"
                class="artifacts-filter"
                :value="filterTaskId ?? ''"
                @change="filterTaskId = ($event.target as HTMLSelectElement).value || null"
            >
                <option value="">全部任务</option>
                <option v-for="tid in artifactTaskIds" :key="tid" :value="tid">
                    {{ getTaskTitle(tid) }}
                </option>
            </select>
            <span class="artifacts-count">{{ filteredArtifacts.length }}</span>
        </div>
        <div class="artifacts-body">
            <div v-if="filteredArtifacts.length === 0" class="artifacts-empty">
                <span>📭</span>
                <p>暂无产出物</p>
            </div>
            <div
                v-for="artifact in filteredArtifacts"
                :key="artifact.id"
                class="artifact-card"
                :class="{ expanded: expandedArtifactId === artifact.id }"
            >
                <div class="artifact-row" @click="toggleArtifact(artifact.id)">
                    <span class="artifact-icon">{{ artifactTypeIcon(artifact.type) }}</span>
                    <span class="artifact-name">{{ artifact.name }}</span>
                    <a
                        v-if="artifact.storageUrl"
                        :href="artifact.storageUrl"
                        target="_blank"
                        rel="noopener noreferrer"
                        class="artifact-link"
                        title="Download artifact"
                        @click.stop
                    >⬇</a>
                    <span class="artifact-task">{{ getTaskTitle(artifact.taskId) }}</span>
                    <span class="artifact-type">{{ artifact.type }}</span>
                    <span class="artifact-time">{{ formatTime(artifact.createdAt) }}</span>
                    <button
                        class="btn-delete"
                        title="删除产出物"
                        @click.stop="handleDelete(artifact.id)"
                    >✕</button>
                    <span class="artifact-expand">{{ expandedArtifactId === artifact.id ? '▾' : '▸' }}</span>
                </div>
                <div v-if="expandedArtifactId === artifact.id && artifact.content" class="artifact-content">
                    <pre>{{ artifact.content }}</pre>
                </div>
            </div>
        </div>
    </div>
</template>

<style scoped lang="scss">
.artifacts-view {
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

.artifacts-header {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 10px;
    background: #111827;
    border-bottom: 1px solid #1e293b;
}

.artifacts-title {
    color: #94a3b8;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 1px;
}

.artifacts-filter {
    margin-left: 8px;
    padding: 2px 6px;
    border: 1px solid #334155;
    border-radius: 3px;
    background: #0f1729;
    color: #94a3b8;
    font-size: 10px;
    font-family: 'Courier New', monospace;
    outline: none;

    &:focus {
        border-color: #3b82f6;
    }
}

.artifacts-count {
    margin-left: auto;
    color: #475569;
    font-size: 10px;
}

.artifacts-body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 4px;
}

.artifacts-empty {
    padding: 20px;
    text-align: center;
    color: #475569;

    span {
        font-size: 24px;
        display: block;
        margin-bottom: 4px;
    }

    p {
        margin: 0;
        font-size: 11px;
    }
}

.artifact-card {
    border: 1px solid #1e293b;
    border-radius: 4px;
    margin-bottom: 4px;
    transition: border-color 0.15s;

    &.expanded {
        border-color: #334155;
    }
}

.artifact-row {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 8px;
    cursor: pointer;
    transition: background 0.15s;

    &:hover {
        background: #1e293b;
    }
}

.artifact-icon {
    flex-shrink: 0;
    font-size: 12px;
}

.artifact-name {
    flex: 1;
    color: #e2e8f0;
    font-size: 11px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
}

.artifact-link {
    flex-shrink: 0;
    color: #3b82f6;
    font-size: 11px;
    text-decoration: none;
    cursor: pointer;

    &:hover {
        color: #60a5fa;
    }
}

.artifact-task {
    flex-shrink: 0;
    color: #64748b;
    font-size: 10px;
    max-width: 80px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.artifact-type {
    flex-shrink: 0;
    color: #475569;
    font-size: 10px;
}

.artifact-time {
    flex-shrink: 0;
    color: #475569;
    font-size: 10px;
}

.btn-delete {
    width: 16px;
    height: 16px;
    display: flex;
    align-items: center;
    justify-content: center;
    border: none;
    border-radius: 2px;
    background: transparent;
    color: #64748b;
    cursor: pointer;
    font-size: 10px;
    line-height: 1;
    padding: 0;
    flex-shrink: 0;
    opacity: 0;
    transition: opacity 0.15s;

    .artifact-row:hover & {
        opacity: 1;
    }

    &:hover {
        background: rgba(239, 68, 68, 0.2);
        color: #fca5a5;
    }
}

.artifact-expand {
    flex-shrink: 0;
    color: #475569;
    font-size: 10px;
}

.artifact-content {
    padding: 6px 8px;
    border-top: 1px solid #1e293b;
    background: #0a0f1e;

    pre {
        margin: 0;
        padding: 8px;
        background: #0f1729;
        border: 1px solid #1e293b;
        border-radius: 3px;
        color: #94a3b8;
        font-size: 11px;
        line-height: 1.5;
        overflow-x: auto;
        white-space: pre-wrap;
        word-break: break-word;
        max-height: 200px;
    }
}
</style>
