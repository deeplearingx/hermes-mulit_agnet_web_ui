<script setup lang="ts">
import { ref, watch, computed } from 'vue'
import type { AgentRoomRole, AgentRoomRoleBinding } from '@/api/hermes/agent-room'
import { AGENT_ROOM_ROLES, AGENT_ROOM_AGENTS } from '@/api/hermes/agent-room'

const props = defineProps<{
    visible: boolean
    roleBindings: AgentRoomRoleBinding[]
    saving?: boolean
}>()

const emit = defineEmits<{
    (e: 'close'): void
    (e: 'save', data: { role: AgentRoomRole; profileName: string }): void
    (e: 'delete', role: AgentRoomRole): void
}>()

// Local edit state per role: profileName being edited
const editValues = ref<Record<AgentRoomRole, string>>({
    conversation: '',
    planner: '',
    developer: '',
    reviewer: '',
    delivery: '',
})

// Track which role is currently being saved
const savingRole = ref<AgentRoomRole | null>(null)

// Build a lookup map from role → binding
const bindingMap = computed(() => {
    const map = new Map<AgentRoomRole, AgentRoomRoleBinding>()
    for (const b of props.roleBindings) map.set(b.role, b)
    return map
})

// Role display metadata
const roleMeta = AGENT_ROOM_ROLES.map(role => {
    const agent = AGENT_ROOM_AGENTS.find(a => a.role === role)
    return {
        role,
        name: agent?.name ?? role,
        description: agent?.description ?? '',
    }
})

// Initialize edit values when modal opens
watch(() => props.visible, (v) => {
    if (v) {
        for (const role of AGENT_ROOM_ROLES) {
            const binding = bindingMap.value.get(role)
            editValues.value[role] = binding?.profileName ?? ''
        }
        savingRole.value = null
    }
})

function handleSave(role: AgentRoomRole) {
    const profileName = editValues.value[role].trim()
    if (!profileName) return
    savingRole.value = role
    emit('save', { role, profileName })
}

function handleDelete(role: AgentRoomRole) {
    savingRole.value = role
    emit('delete', role)
    editValues.value[role] = ''
}

function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
        emit('close')
    }
}

function isDirty(role: AgentRoomRole): boolean {
    const binding = bindingMap.value.get(role)
    const current = editValues.value[role].trim()
    const original = binding?.profileName ?? ''
    return current !== original
}

function hasBinding(role: AgentRoomRole): boolean {
    return bindingMap.value.has(role)
}
</script>

<template>
    <Teleport to="body">
        <div v-if="visible" class="modal-overlay" @click.self="emit('close')" @keydown="handleKeydown">
            <div class="modal-content">
                <div class="modal-header">
                    <span class="modal-icon">🔗</span>
                    <h3>角色 Profile 绑定</h3>
                    <button class="modal-close" @click="emit('close')">✕</button>
                </div>
                <div class="modal-body">
                    <p class="modal-desc">
                        为每个 Agent 角色指定 Gateway Profile。未绑定的角色将使用默认 Profile。
                    </p>
                    <div v-for="meta in roleMeta" :key="meta.role" class="role-row">
                        <div class="role-info">
                            <span class="role-name">{{ meta.name }}</span>
                            <span class="role-desc">{{ meta.description }}</span>
                        </div>
                        <div class="role-actions">
                            <input
                                v-model="editValues[meta.role]"
                                class="profile-input"
                                :placeholder="`Profile name for ${meta.role}...`"
                                @keydown.enter.prevent="handleSave(meta.role)"
                            />
                            <button
                                class="btn-save"
                                :disabled="saving || !editValues[meta.role].trim() || (!isDirty(meta.role) && hasBinding(meta.role))"
                                @click="handleSave(meta.role)"
                            >
                                {{ hasBinding(meta.role) ? '更新' : '绑定' }}
                            </button>
                            <button
                                v-if="hasBinding(meta.role)"
                                class="btn-delete"
                                :disabled="saving"
                                @click="handleDelete(meta.role)"
                            >
                                解绑
                            </button>
                        </div>
                    </div>
                </div>
                <div class="modal-footer">
                    <button class="btn-cancel" @click="emit('close')">关闭</button>
                </div>
            </div>
        </div>
    </Teleport>
</template>

<style scoped lang="scss">
.modal-overlay {
    position: fixed;
    inset: 0;
    z-index: 1000;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(0, 0, 0, 0.5);
    backdrop-filter: blur(2px);
}

.modal-content {
    width: 560px;
    max-width: 90vw;
    max-height: 80vh;
    background: var(--vscode-editorWidget-background, #252526);
    border: 1px solid var(--vscode-widget-border, #454545);
    border-radius: 8px;
    display: flex;
    flex-direction: column;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
}

.modal-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 16px 20px;
    border-bottom: 1px solid var(--vscode-widget-border, #454545);

    .modal-icon {
        font-size: 20px;
    }

    h3 {
        flex: 1;
        margin: 0;
        font-size: 16px;
        font-weight: 600;
        color: var(--vscode-foreground, #cccccc);
    }

    .modal-close {
        background: none;
        border: none;
        color: var(--vscode-descriptionForeground, #999);
        font-size: 18px;
        cursor: pointer;
        padding: 4px 8px;
        border-radius: 4px;

        &:hover {
            background: var(--vscode-toolbar-hoverBackground, rgba(255, 255, 255, 0.1));
        }
    }
}

.modal-body {
    padding: 16px 20px;
    overflow-y: auto;
    flex: 1;

    .modal-desc {
        margin: 0 0 16px;
        font-size: 13px;
        color: var(--vscode-descriptionForeground, #999);
        line-height: 1.5;
    }
}

.role-row {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 12px 0;
    border-bottom: 1px solid var(--vscode-widget-border, #454545);

    &:last-child {
        border-bottom: none;
    }
}

.role-info {
    display: flex;
    align-items: baseline;
    gap: 8px;

    .role-name {
        font-size: 14px;
        font-weight: 600;
        color: var(--vscode-foreground, #cccccc);
    }

    .role-desc {
        font-size: 12px;
        color: var(--vscode-descriptionForeground, #999);
    }
}

.role-actions {
    display: flex;
    align-items: center;
    gap: 8px;
}

.profile-input {
    flex: 1;
    padding: 6px 10px;
    font-size: 13px;
    background: var(--vscode-input-background, #3c3c3c);
    color: var(--vscode-input-foreground, #cccccc);
    border: 1px solid var(--vscode-input-border, #555);
    border-radius: 4px;
    outline: none;

    &:focus {
        border-color: var(--vscode-focusBorder, #007acc);
    }

    &::placeholder {
        color: var(--vscode-input-placeholderForeground, #888);
    }
}

.btn-save {
    padding: 6px 14px;
    font-size: 12px;
    font-weight: 500;
    background: var(--vscode-button-background, #0e639c);
    color: var(--vscode-button-foreground, #fff);
    border: none;
    border-radius: 4px;
    cursor: pointer;
    white-space: nowrap;

    &:hover:not(:disabled) {
        background: var(--vscode-button-hoverBackground, #1177bb);
    }

    &:disabled {
        opacity: 0.5;
        cursor: not-allowed;
    }
}

.btn-delete {
    padding: 6px 14px;
    font-size: 12px;
    font-weight: 500;
    background: transparent;
    color: var(--vscode-errorForeground, #f44747);
    border: 1px solid var(--vscode-errorForeground, #f44747);
    border-radius: 4px;
    cursor: pointer;
    white-space: nowrap;

    &:hover:not(:disabled) {
        background: rgba(244, 71, 71, 0.1);
    }

    &:disabled {
        opacity: 0.5;
        cursor: not-allowed;
    }
}

.modal-footer {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    padding: 12px 20px;
    border-top: 1px solid var(--vscode-widget-border, #454545);

    .btn-cancel {
        padding: 8px 20px;
        font-size: 13px;
        background: var(--vscode-button-secondaryBackground, #3c3c3c);
        color: var(--vscode-button-secondaryForeground, #ccc);
        border: 1px solid var(--vscode-widget-border, #555);
        border-radius: 4px;
        cursor: pointer;

        &:hover {
            background: var(--vscode-button-secondaryHoverBackground, #45494e);
        }
    }
}
</style>
