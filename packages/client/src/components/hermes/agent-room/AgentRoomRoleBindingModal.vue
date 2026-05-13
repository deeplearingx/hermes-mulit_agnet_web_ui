<script setup lang="ts">
import { ref, watch, computed } from 'vue'
import type { AgentRoomRole, AgentRoomRoleBinding } from '@/api/hermes/agent-room'
import { AGENT_ROOM_ROLES, AGENT_ROOM_AGENTS } from '@/api/hermes/agent-room'
import { useProfilesStore } from '@/stores/hermes/profiles'
import { useAppStore } from '@/stores/hermes/app'

const props = defineProps<{
    visible: boolean
    roleBindings: AgentRoomRoleBinding[]
    saving?: boolean
}>()

const emit = defineEmits<{
    (e: 'close'): void
    (e: 'save', data: { role: AgentRoomRole; profileName: string; provider?: string; model?: string }): void
    (e: 'delete', role: AgentRoomRole): void
}>()

const profilesStore = useProfilesStore()
const appStore = useAppStore()

// Provider options from appStore.modelGroups (same pattern as AgentSettingsModal)
const providerOptions = computed(() =>
    appStore.modelGroups.map(g => ({ label: g.label || g.provider, value: g.provider }))
)

// Track which role is currently being saved
const savingRole = ref<AgentRoomRole | null>(null)

// Whether the user chose "custom" for each role (shows manual input)
const customMode = ref<Record<AgentRoomRole, boolean>>({
    conversation: false,
    planner: false,
    developer: false,
    reviewer: false,
    delivery: false,
})

// Local edit state per role: profileName being edited (for custom input fallback)
const customValues = ref<Record<AgentRoomRole, string>>({
    conversation: '',
    planner: '',
    developer: '',
    reviewer: '',
    delivery: '',
})

// Selected profile name per role (from dropdown)
const selectedProfile = ref<Record<AgentRoomRole, string>>({
    conversation: '',
    planner: '',
    developer: '',
    reviewer: '',
    delivery: '',
})

// Provider override per role
const providerValues = ref<Record<AgentRoomRole, string>>({
    conversation: '',
    planner: '',
    developer: '',
    reviewer: '',
    delivery: '',
})

// Model override per role
const modelValues = ref<Record<AgentRoomRole, string>>({
    conversation: '',
    planner: '',
    developer: '',
    reviewer: '',
    delivery: '',
})

// Custom option sentinel
const CUSTOM_VALUE = '__custom__'

// Whether to show advanced (Profile) section
const showAdvanced = ref(false)

// Whether profiles fetch completed (success or failure)
const profilesLoaded = ref(false)

// Whether profiles fetch failed
const profilesFailed = ref(false)

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

// Format a profile option label: name · model · gateway/alias
function profileOptionLabel(profile: { name: string; model: string; gateway: string; alias: string; active: boolean }): string {
    const parts = [profile.name]
    if (profile.model) parts.push(profile.model)
    const gwInfo = profile.alias || profile.gateway
    if (gwInfo) parts.push(gwInfo)
    return parts.join(' · ')
}

// The effective profile name for a role (what gets saved)
function effectiveProfileName(role: AgentRoomRole): string {
    if (customMode.value[role] || !showSelect.value) {
        return customValues.value[role].trim()
    }
    return selectedProfile.value[role]
}

// Active profile name for hints
const activeProfileName = computed(() => profilesStore.activeProfile?.name ?? profilesStore.activeProfileName ?? '')

// Whether profiles are loading
const profilesLoading = computed(() => profilesStore.loading)

// Available profiles
const profiles = computed(() => profilesStore.profiles)

// Show select dropdown when profiles are loaded (even if empty — custom option is always available)
const showSelect = computed(() => profilesLoaded.value)

// Initialize edit values when modal opens (immediate: true handles mount with visible=true)
watch(() => props.visible, async (v) => {
    if (v) {
        // Fetch profiles on open
        profilesLoaded.value = false
        profilesFailed.value = false
        try {
            await profilesStore.fetchProfiles()
            profilesLoaded.value = true
        } catch {
            // Store may swallow errors internally; this catch is for unexpected throws
            profilesFailed.value = true
        }

        // Initialize selected values from existing bindings
        for (const role of AGENT_ROOM_ROLES) {
            const binding = bindingMap.value.get(role)
            const boundName = binding?.profileName ?? ''

            if (boundName) {
                // Check if the bound name exists in profiles list
                const exists = profiles.value.some(p => p.name === boundName)
                if (exists) {
                    customMode.value[role] = false
                    selectedProfile.value[role] = boundName
                    customValues.value[role] = ''
                } else {
                    // Bound name not in profiles list → use custom mode
                    customMode.value[role] = true
                    customValues.value[role] = boundName
                    selectedProfile.value[role] = ''
                }
            } else {
                customMode.value[role] = false
                selectedProfile.value[role] = ''
                customValues.value[role] = ''
            }

            // Initialize provider/model from existing binding
            providerValues.value[role] = binding?.provider ?? ''
            modelValues.value[role] = binding?.model ?? ''
        }
        savingRole.value = null
    }
}, { immediate: true })

function handleSelectChange(role: AgentRoomRole, value: string) {
    if (value === CUSTOM_VALUE) {
        customMode.value[role] = true
        selectedProfile.value[role] = ''
    } else {
        customMode.value[role] = false
        selectedProfile.value[role] = value
        customValues.value[role] = ''
    }
}

function handleSave(role: AgentRoomRole) {
    const provider = providerValues.value[role].trim() || undefined
    const model = modelValues.value[role].trim() || undefined

    // In advanced mode, require explicit profileName; otherwise default to active profile
    if (showAdvanced.value) {
        const profileName = effectiveProfileName(role)
        if (!profileName) return
        savingRole.value = role
        emit('save', { role, profileName, provider, model })
    } else {
        // Use explicit profile from advanced mode if previously set, else active profile
        const binding = bindingMap.value.get(role)
        const profileName = binding?.profileName || activeProfileName.value
        if (!profileName) return
        savingRole.value = role
        emit('save', { role, profileName, provider, model })
    }
}

function handleDelete(role: AgentRoomRole) {
    savingRole.value = role
    emit('delete', role)
    selectedProfile.value[role] = ''
    customValues.value[role] = ''
    customMode.value[role] = false
    providerValues.value[role] = ''
    modelValues.value[role] = ''
}

function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
        emit('close')
    }
}

function isDirty(role: AgentRoomRole): boolean {
    const binding = bindingMap.value.get(role)
    const currentProvider = providerValues.value[role].trim() || undefined
    const originalProvider = binding?.provider || undefined
    const currentModel = modelValues.value[role].trim() || undefined
    const originalModel = binding?.model || undefined

    if (showAdvanced.value) {
        const currentProfile = effectiveProfileName(role)
        const originalProfile = binding?.profileName ?? ''
        return currentProfile !== originalProfile || currentProvider !== originalProvider || currentModel !== originalModel
    }
    return currentProvider !== originalProvider || currentModel !== originalModel
}

function hasBinding(role: AgentRoomRole): boolean {
    return bindingMap.value.has(role)
}

function fallbackHint(role: AgentRoomRole): string {
    if (hasBinding(role)) {
        return '已绑定 profile，将覆盖当前默认 Hermes profile'
    }
    if (role === 'delivery') {
        return '未绑定时将使用系统交付'
    }
    if (activeProfileName.value) {
        return `未绑定时将使用当前 active profile: ${activeProfileName.value}`
    }
    if (role === 'planner' || role === 'developer' || role === 'reviewer') {
        return '未绑定时将使用当前默认 Hermes profile'
    }
    return '未绑定时使用当前默认设置'
}

// Compute the current value for the <select> element
function selectValue(role: AgentRoomRole): string {
    if (customMode.value[role]) return CUSTOM_VALUE
    return selectedProfile.value[role]
}
</script>

<template>
    <Teleport to="body">
        <div v-if="visible" class="modal-overlay" data-testid="role-binding-modal" @click.self="emit('close')" @keydown="handleKeydown">
            <div class="modal-content">
                <div class="modal-header">
                    <span class="modal-icon">🤖</span>
                    <h3>角色模型配置</h3>
                    <button class="modal-close" @click="emit('close')">✕</button>
                </div>
                <div class="modal-body">
                    <p class="modal-desc">
                        为每个 Agent 角色配置 Provider 和 Model。未配置时将使用当前 active profile 的默认设置。
                        <button
                            class="btn-toggle-advanced"
                            @click="showAdvanced = !showAdvanced"
                        >
                            {{ showAdvanced ? '隐藏' : '显示' }}高级选项（Profile）
                        </button>
                    </p>

                    <!-- Loading indicator -->
                    <div v-if="profilesLoading" class="profiles-loading">
                        加载 profiles 中…
                    </div>

                    <div v-for="meta in roleMeta" :key="meta.role" class="role-row" :data-role="meta.role">
                        <div class="role-info">
                            <span class="role-name">{{ meta.name }}</span>
                            <span class="role-desc">{{ meta.description }}</span>
                        </div>
                        <div class="role-actions">
                            <!-- Provider dropdown (primary) -->
                            <div class="model-field">
                                <label class="field-label">Provider</label>
                                <select
                                    class="model-select"
                                    :value="providerValues[meta.role]"
                                    @change="providerValues[meta.role] = ($event.target as HTMLSelectElement).value"
                                >
                                    <option value="">自动（从 profile）</option>
                                    <option
                                        v-for="opt in providerOptions"
                                        :key="opt.value"
                                        :value="opt.value"
                                    >
                                        {{ opt.label }}
                                    </option>
                                </select>
                            </div>

                            <!-- Model input (primary) -->
                            <div class="model-field">
                                <label class="field-label">Model</label>
                                <input
                                    v-model="modelValues[meta.role]"
                                    class="model-input"
                                    placeholder="自动（从 profile）"
                                />
                            </div>

                            <!-- Advanced: Profile override (collapsible) -->
                            <div v-if="showAdvanced" class="advanced-section">
                                <label class="field-label">Profile（高级）</label>
                                <select
                                    v-if="showSelect"
                                    class="profile-select"
                                    :data-role-select="meta.role"
                                    :value="selectValue(meta.role)"
                                    @change="handleSelectChange(meta.role, ($event.target as HTMLSelectElement).value)"
                                >
                                    <option value="">使用 active profile: {{ activeProfileName }}</option>
                                    <option
                                        v-for="p in profiles"
                                        :key="p.name"
                                        :value="p.name"
                                    >
                                        {{ profileOptionLabel(p) }}{{ p.active ? ' ✓' : '' }}
                                    </option>
                                    <option :value="CUSTOM_VALUE">✏️ 手动输入…</option>
                                </select>

                                <input
                                    v-if="customMode[meta.role] || !showSelect"
                                    v-model="customValues[meta.role]"
                                    class="profile-input"
                                    :data-role-input="meta.role"
                                    :placeholder="`Profile name for ${meta.role}...`"
                                />
                            </div>

                            <div class="action-buttons">
                                <button
                                    class="btn-save"
                                    :disabled="saving || (!isDirty(meta.role) && hasBinding(meta.role))"
                                    @click="handleSave(meta.role)"
                                >
                                    {{ hasBinding(meta.role) ? '更新' : '保存' }}
                                </button>
                                <button
                                    v-if="hasBinding(meta.role)"
                                    class="btn-delete"
                                    :disabled="saving"
                                    @click="handleDelete(meta.role)"
                                >
                                    重置
                                </button>
                            </div>
                        </div>
                    </div>

                    <!-- Empty state: no profiles found after load -->
                    <div v-if="profilesLoaded && profiles.length === 0 && showAdvanced" class="profiles-empty">
                        未发现 Hermes profiles。可手动输入 profile name，或前往 <strong>Profiles</strong> 页面创建。
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
    width: 680px;
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

.profiles-loading {
    padding: 8px 0;
    font-size: 13px;
    color: var(--vscode-descriptionForeground, #999);
    font-style: italic;
}

.profiles-empty {
    margin-top: 12px;
    padding: 10px 14px;
    font-size: 12px;
    color: var(--vscode-descriptionForeground, #999);
    background: var(--vscode-input-background, #3c3c3c);
    border-radius: 4px;
    line-height: 1.5;

    strong {
        color: var(--vscode-textLink-foreground, #4fc3f7);
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
    flex-direction: column;
    gap: 4px;

    .role-name {
        font-size: 14px;
        font-weight: 600;
        color: var(--vscode-foreground, #cccccc);
    }

    .role-desc {
        font-size: 12px;
        color: var(--vscode-descriptionForeground, #999);
    }

    .role-hint {
        font-size: 12px;
        color: var(--vscode-textLink-foreground, #4fc3f7);
    }
}

.role-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    gap: 8px;
}

.model-field {
    display: flex;
    flex-direction: column;
    gap: 2px;
    flex: 1;
    min-width: 140px;

    .field-label {
        font-size: 11px;
        color: var(--vscode-descriptionForeground, #999);
        font-weight: 500;
        text-transform: uppercase;
        letter-spacing: 0.5px;
    }
}

.model-select,
.model-input,
.profile-select,
.profile-input {
    width: 100%;
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

    option {
        background: var(--vscode-input-background, #3c3c3c);
        color: var(--vscode-input-foreground, #cccccc);
    }
}

.model-select,
.profile-select {
    cursor: pointer;
}

.advanced-section {
    display: flex;
    flex-direction: column;
    gap: 2px;
    width: 100%;

    .field-label {
        font-size: 11px;
        color: var(--vscode-descriptionForeground, #999);
        font-weight: 500;
    }
}

.action-buttons {
    display: flex;
    gap: 6px;
    align-items: center;
}

.btn-toggle-advanced {
    background: none;
    border: none;
    color: var(--vscode-textLink-foreground, #4fc3f7);
    cursor: pointer;
    font-size: 12px;
    padding: 0;
    text-decoration: underline;
    margin-left: 8px;

    &:hover {
        color: var(--vscode-textLink-activeForeground, #6dd0ff);
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
