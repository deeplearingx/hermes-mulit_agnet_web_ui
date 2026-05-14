<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { NButton, NInput, NSelect, NTag, NSpace } from 'naive-ui'
import type { AgentRoomRole, AgentRoomRoleBinding } from '@/api/hermes/agent-room'
import { AGENT_ROOM_ROLES, AGENT_ROOM_AGENTS } from '@/api/hermes/agent-room'
import { useProfilesStore } from '@/stores/hermes/profiles'
import { useAppStore } from '@/stores/hermes/app'
import { useAgentRoomStore } from '@/stores/hermes/agent-room'

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
const agentRoomStore = useAgentRoomStore()

const ACTIVE_PROFILE_VALUE = '__active__'
const CUSTOM_PROFILE_VALUE = '__custom__'

type ProfileMode = 'active' | 'selected' | 'custom'

interface RoleDraft {
    profileMode: ProfileMode
    selectedProfile: string
    customProfile: string
    provider: string
    model: string
}

const savingRole = ref<AgentRoomRole | null>(null)
const expandedRole = ref<AgentRoomRole | null>(null)
const profilesLoaded = ref(false)
const profilesFailed = ref(false)
const previewLoading = ref<Partial<Record<AgentRoomRole, boolean>>>({})
const previewErrors = ref<Partial<Record<AgentRoomRole, string>>>({})
const inheritedTargets = ref<Partial<Record<AgentRoomRole, { provider?: string; model?: string; providerSource?: string; modelSource?: string; hasApiKey?: boolean }>>>({})

function createEmptyDraft(): Record<AgentRoomRole, RoleDraft> {
    return {
        conversation: { profileMode: 'active', selectedProfile: '', customProfile: '', provider: '', model: '' },
        planner: { profileMode: 'active', selectedProfile: '', customProfile: '', provider: '', model: '' },
        developer: { profileMode: 'active', selectedProfile: '', customProfile: '', provider: '', model: '' },
        reviewer: { profileMode: 'active', selectedProfile: '', customProfile: '', provider: '', model: '' },
        delivery: { profileMode: 'active', selectedProfile: '', customProfile: '', provider: '', model: '' },
    }
}

const drafts = ref<Record<AgentRoomRole, RoleDraft>>(createEmptyDraft())

const bindingMap = computed(() => {
    const map = new Map<AgentRoomRole, AgentRoomRoleBinding>()
    for (const binding of props.roleBindings) map.set(binding.role, binding)
    return map
})

const profilesLoading = computed(() => profilesStore.loading)
const profiles = computed(() => profilesStore.profiles)
const activeProfileName = computed(() => profilesStore.activeProfile?.name ?? profilesStore.activeProfileName ?? '')

const providerOptions = computed(() =>
    appStore.modelGroups.map(group => ({ label: group.label || group.provider, value: group.provider })),
)

const roleMeta = AGENT_ROOM_ROLES.map(role => {
    const agent = AGENT_ROOM_AGENTS.find(item => item.role === role)
    return {
        role,
        name: agent?.name ?? role,
        description: agent?.description ?? '',
    }
})

const profileOptions = computed(() => {
    const options = [{ label: `使用 active profile: ${activeProfileName.value || '未设置'}`, value: ACTIVE_PROFILE_VALUE }]
    for (const profile of profiles.value) {
        const parts = [profile.name]
        if (profile.model) parts.push(profile.model)
        const aliasOrGateway = profile.alias || profile.gateway
        if (aliasOrGateway) parts.push(aliasOrGateway)
        options.push({
            label: `${parts.join(' · ')}${profile.active ? ' ✓' : ''}`,
            value: profile.name,
        })
    }
    options.push({ label: '手动输入 profile…', value: CUSTOM_PROFILE_VALUE })
    return options
})

function resetDrafts() {
    drafts.value = createEmptyDraft()
    previewErrors.value = {}
    inheritedTargets.value = {}
    for (const role of AGENT_ROOM_ROLES) {
        const binding = bindingMap.value.get(role)
        const boundProfileName = binding?.profileName ?? ''
        const existsInProfiles = boundProfileName
            ? profiles.value.some(profile => profile.name === boundProfileName)
            : false

        if (!binding) {
            drafts.value[role] = {
                profileMode: 'active',
                selectedProfile: '',
                customProfile: '',
                provider: '',
                model: '',
            }
            continue
        }

        drafts.value[role] = {
            profileMode: existsInProfiles ? 'selected' : 'custom',
            selectedProfile: existsInProfiles ? boundProfileName : '',
            customProfile: existsInProfiles ? '' : boundProfileName,
            provider: binding.provider ?? '',
            model: binding.model ?? '',
        }
    }
}

async function refreshInheritedTarget(role: AgentRoomRole) {
    const profileName = effectiveProfileName(role)
    if (!profileName) return
    const provider = drafts.value[role].provider.trim() || undefined
    const model = drafts.value[role].model.trim() || undefined
    previewLoading.value = { ...previewLoading.value, [role]: true }
    previewErrors.value = { ...previewErrors.value, [role]: undefined }
    try {
        const target = await agentRoomStore.previewRoleBindingTarget(profileName, provider, model)
        inheritedTargets.value = {
            ...inheritedTargets.value,
            [role]: {
                provider: target.provider,
                model: target.model,
                providerSource: target.providerSource,
                modelSource: target.modelSource,
                hasApiKey: target.hasApiKey,
            },
        }
    } catch (err: any) {
        inheritedTargets.value = { ...inheritedTargets.value, [role]: undefined }
        previewErrors.value = { ...previewErrors.value, [role]: err?.message || 'Profile 解析失败' }
    } finally {
        previewLoading.value = { ...previewLoading.value, [role]: false }
    }
}

async function loadProfiles() {
    profilesLoaded.value = false
    profilesFailed.value = false
    try {
        await profilesStore.fetchProfiles()
        profilesLoaded.value = true
    } catch {
        profilesFailed.value = true
    }
}

watch(() => props.visible, async (visible) => {
    if (!visible) {
        expandedRole.value = null
        savingRole.value = null
        return
    }
    await loadProfiles()
    resetDrafts()
}, { immediate: true })

function roleSelectValue(role: AgentRoomRole): string {
    const draft = drafts.value[role]
    if (draft.profileMode === 'custom') return CUSTOM_PROFILE_VALUE
    if (draft.profileMode === 'selected') return draft.selectedProfile
    return ACTIVE_PROFILE_VALUE
}

function handleProfileSelect(role: AgentRoomRole, value: string | null) {
    const draft = drafts.value[role]
    if (value === CUSTOM_PROFILE_VALUE) {
        draft.profileMode = 'custom'
        draft.selectedProfile = ''
        inheritedTargets.value = { ...inheritedTargets.value, [role]: undefined }
        return
    }
    if (!value || value === ACTIVE_PROFILE_VALUE) {
        draft.profileMode = 'active'
        draft.selectedProfile = ''
        draft.customProfile = ''
        void refreshInheritedTarget(role)
        return
    }
    draft.profileMode = 'selected'
    draft.selectedProfile = value
    draft.customProfile = ''
    void refreshInheritedTarget(role)
}

function effectiveProfileName(role: AgentRoomRole): string {
    const draft = drafts.value[role]
    if (!profilesLoaded.value) return draft.customProfile.trim()
    if (draft.profileMode === 'custom') return draft.customProfile.trim()
    if (draft.profileMode === 'selected') return draft.selectedProfile.trim()
    return activeProfileName.value.trim()
}

function fallbackMessage(role: AgentRoomRole): string {
    switch (role) {
        case 'planner':
            return '未绑定时将使用当前 active profile。'
        case 'developer':
            return '未绑定时将优先使用任务 assigned profile，否则使用当前 active profile。'
        case 'reviewer':
            return '未绑定时将使用当前 active profile。'
        case 'delivery':
            return '未绑定时将使用系统交付。'
        default:
            return '未绑定时将使用当前 active profile。'
    }
}

function profileSummary(role: AgentRoomRole): string {
    const binding = bindingMap.value.get(role)
    if (binding) return binding.profileName
    switch (role) {
        case 'developer':
            return '任务 assigned profile / active profile'
        case 'delivery':
            return '系统交付'
        default:
            return activeProfileName.value ? `active profile · ${activeProfileName.value}` : 'active profile'
    }
}

function providerSummary(role: AgentRoomRole): string {
    const provider = bindingMap.value.get(role)?.provider
    return provider ? `已解析 · ${provider}` : '自动（继承 profile）'
}

function modelSummary(role: AgentRoomRole): string {
    const model = bindingMap.value.get(role)?.model
    return model ? `已解析 · ${model}` : '自动（继承 profile）'
}

function bindingTone(role: AgentRoomRole): 'success' | 'warning' | 'info' {
    if (bindingMap.value.has(role)) return 'success'
    return role === 'delivery' ? 'info' : 'warning'
}

function bindingToneLabel(role: AgentRoomRole): string {
    if (bindingMap.value.has(role)) return '已绑定'
    return role === 'delivery' ? '系统交付' : '使用回退'
}

function isDirty(role: AgentRoomRole): boolean {
    const binding = bindingMap.value.get(role)
    const currentProfile = effectiveProfileName(role)
    const currentProvider = drafts.value[role].provider.trim() || undefined
    const currentModel = drafts.value[role].model.trim() || undefined
    const originalProfile = binding?.profileName ?? ''
    const originalProvider = binding?.provider || undefined
    const originalModel = binding?.model || undefined

    if (!binding) {
        if (!profilesLoaded.value) {
            return !!currentProfile || !!currentProvider || !!currentModel
        }
        return !!currentProfile && (drafts.value[role].profileMode !== 'active' || !!currentProvider || !!currentModel)
    }

    return currentProfile !== originalProfile || currentProvider !== originalProvider || currentModel !== originalModel
}

function canSave(role: AgentRoomRole): boolean {
    return !!effectiveProfileName(role) && isDirty(role) && !props.saving && !previewLoading.value[role] && !previewErrors.value[role]
}

function toggleEdit(role: AgentRoomRole) {
    expandedRole.value = expandedRole.value === role ? null : role
    if (expandedRole.value === role) void refreshInheritedTarget(role)
}

function handleSave(role: AgentRoomRole) {
    const profileName = effectiveProfileName(role)
    if (!profileName) return
    savingRole.value = role
    emit('save', {
        role,
        profileName,
        provider: drafts.value[role].provider.trim() || undefined,
        model: drafts.value[role].model.trim() || undefined,
    })
}

function handleProviderOverrideChange(role: AgentRoomRole) {
    window.setTimeout(() => refreshInheritedTarget(role), 0)
}

function inheritedSummary(role: AgentRoomRole): string {
    if (previewLoading.value[role]) return '解析 profile 默认模型中…'
    if (previewErrors.value[role]) return previewErrors.value[role]!
    const target = inheritedTargets.value[role]
    if (!target) return '选择 profile 后会自动解析 provider/model 并保存为快照。'
    return `将保存 provider=${target.provider || 'missing'} (${target.providerSource || 'unknown'}), model=${target.model || 'missing'} (${target.modelSource || 'unknown'})${target.hasApiKey ? '' : '；未检测到 API key'}`
}

function handleDelete(role: AgentRoomRole) {
    savingRole.value = role
    emit('delete', role)
    expandedRole.value = null
}

function handleKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') emit('close')
}

function quickModelOptions(role: AgentRoomRole): string[] {
    const provider = drafts.value[role].provider.trim()
    if (provider) {
        const group = appStore.modelGroups.find(item => item.provider === provider)
        return group?.models.slice(0, 6) ?? []
    }

    const seen = new Set<string>()
    const models: string[] = []
    for (const group of appStore.modelGroups) {
        for (const model of group.models) {
            if (seen.has(model)) continue
            seen.add(model)
            models.push(model)
            if (models.length >= 6) return models
        }
    }
    return models
}
</script>

<template>
    <Teleport to="body">
        <div v-if="visible" class="modal-backdrop" data-testid="role-binding-modal" @click.self="emit('close')" @keydown="handleKeydown">
            <div class="modal role-binding-modal">
                <div class="modal-header">
                    <h3>角色模型配置</h3>
                    <p class="modal-hint">不同角色可以绑定不同的 profile、provider 和 model。未设置时会按各角色的默认回退逻辑执行。</p>
                    <button class="modal-close" @click="emit('close')">✕</button>
                </div>

                <div v-if="profilesLoading" class="modal-loading">加载 profiles 中…</div>

                <div v-else class="role-card-list">
                    <div v-for="meta in roleMeta" :key="meta.role" class="role-card" :data-role="meta.role" :data-role-card="meta.role">
                        <div class="role-card-head">
                            <div class="role-card-title-block">
                                <div class="role-card-title-row">
                                    <span class="role-card-title">{{ meta.name }}</span>
                                    <NTag size="small" :type="bindingTone(meta.role)">{{ bindingToneLabel(meta.role) }}</NTag>
                                </div>
                                <div class="role-card-desc">{{ meta.description }}</div>
                            </div>
                            <NSpace>
                                <NButton size="small" secondary :data-role-edit="meta.role" @click="toggleEdit(meta.role)">{{ expandedRole === meta.role ? '收起' : '编辑' }}</NButton>
                                <NButton v-if="bindingMap.has(meta.role)" size="small" tertiary type="error" :data-role-reset="meta.role" :disabled="saving" @click="handleDelete(meta.role)">重置</NButton>
                            </NSpace>
                        </div>

                        <div class="role-card-summary">
                            <div class="summary-row">
                                <span class="summary-label">Profile</span>
                                <span class="summary-value">{{ profileSummary(meta.role) }}</span>
                            </div>
                            <div class="summary-row">
                                <span class="summary-label">Provider</span>
                                <span class="summary-value">{{ providerSummary(meta.role) }}</span>
                            </div>
                            <div class="summary-row">
                                <span class="summary-label">Model</span>
                                <span class="summary-value">{{ modelSummary(meta.role) }}</span>
                            </div>
                        </div>

                        <div class="role-card-fallback">{{ fallbackMessage(meta.role) }}</div>

                        <div v-if="expandedRole === meta.role" class="role-editor" :data-role-editor="meta.role">
                            <div class="editor-hint">留空 Provider / Model 时，继续继承所选 profile 的默认配置。</div>

                            <div v-if="profilesFailed" class="editor-warning">
                                Profiles 加载失败，可直接手动输入 profile name。
                            </div>

                            <div class="form-group">
                                <label class="form-label">Profile</label>
                                <NSelect
                                    v-if="profilesLoaded"
                                    :value="roleSelectValue(meta.role)"
                                    :options="profileOptions"
                                    filterable
                                    :clearable="false"
                                    :consistent-menu-width="false"
                                    :data-role-select="meta.role"
                                    @update:value="handleProfileSelect(meta.role, $event)"
                                />
                                <NInput
                                    v-if="drafts[meta.role].profileMode === 'custom' || !profilesLoaded"
                                    v-model:value="drafts[meta.role].customProfile"
                                    :data-role-input="meta.role"
                                    placeholder="输入 profile name"
                                    @blur="refreshInheritedTarget(meta.role)"
                                />
                            </div>

                            <div class="form-group">
                                <label class="form-label">Provider override</label>
                                <NSelect
                                    v-model:value="drafts[meta.role].provider"
                                    :data-role-provider-select="meta.role"
                                    :options="providerOptions"
                                    placeholder="自动（从 profile 继承）"
                                    clearable
                                    filterable
                                    :consistent-menu-width="false"
                                    @update:value="handleProviderOverrideChange(meta.role)"
                                />
                            </div>

                            <div class="form-group">
                                <label class="form-label">Model override</label>
                                <NInput
                                    v-model:value="drafts[meta.role].model"
                                    :data-role-model-input="meta.role"
                                    placeholder="自动（从 profile 继承）"
                                    @blur="refreshInheritedTarget(meta.role)"
                                />
                                <div v-if="quickModelOptions(meta.role).length" class="quick-models">
                                    <button
                                        v-for="model in quickModelOptions(meta.role)"
                                        :key="model"
                                        type="button"
                                        class="quick-model-chip"
                                        @click="drafts[meta.role].model = model; refreshInheritedTarget(meta.role)"
                                    >
                                        {{ model }}
                                    </button>
                                </div>
                            </div>

                            <div class="inherited-target" :class="{ error: !!previewErrors[meta.role] }">
                                {{ inheritedSummary(meta.role) }}
                            </div>

                            <div class="editor-actions">
                                <NButton size="small" @click="expandedRole = null">取消</NButton>
                                <NButton
                                    size="small"
                                    type="primary"
                                    class="btn-save-role"
                                    :data-role-save="meta.role"
                                    :disabled="!canSave(meta.role)"
                                    :loading="saving && savingRole === meta.role"
                                    @click="handleSave(meta.role)"
                                >
                                    {{ bindingMap.has(meta.role) ? '更新绑定' : '保存绑定' }}
                                </NButton>
                            </div>
                        </div>
                    </div>

                    <div v-if="profilesLoaded && profiles.length === 0" class="profiles-empty">
                        未发现 Hermes profiles。你仍然可以手动输入 profile name。
                    </div>
                </div>

                <div class="modal-actions">
                    <NButton @click="emit('close')">关闭</NButton>
                </div>
            </div>
        </div>
    </Teleport>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.modal-backdrop {
    position: fixed;
    inset: 0;
    z-index: 1100;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(0, 0, 0, 0.45);
}

.role-binding-modal {
    width: min(760px, calc(100vw - 32px));
    max-height: 88vh;
    overflow-y: auto;
    background: $bg-card;
    border-radius: $radius-lg;
    box-shadow: 0 12px 36px rgba(0, 0, 0, 0.22);
    padding: 24px;
}

.modal-header {
    position: relative;
    margin-bottom: 16px;

    h3 {
        margin: 0 0 6px;
        font-size: 16px;
        font-weight: 600;
        color: $text-primary;
    }
}

.modal-hint {
    margin: 0;
    padding: 8px 12px;
    font-size: 12px;
    line-height: 1.5;
    color: $text-muted;
    background: rgba(var(--accent-primary-rgb), 0.06);
    border-left: 3px solid var(--accent-primary, #6366f1);
    border-radius: 0 $radius-sm $radius-sm 0;
}

.modal-close {
    position: absolute;
    top: 0;
    right: 0;
    border: none;
    background: transparent;
    color: $text-muted;
    cursor: pointer;
    font-size: 16px;
}

.modal-loading,
.profiles-empty,
.editor-warning {
    padding: 12px;
    font-size: 12px;
    color: $text-muted;
    background: $bg-secondary;
    border-radius: $radius-md;
}

.role-card-list {
    display: flex;
    flex-direction: column;
    gap: 12px;
}

.role-card {
    border: 1px solid $border-color;
    border-radius: $radius-lg;
    background: $bg-card;
    padding: 16px;
}

.role-card-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 12px;
}

.role-card-title-block {
    min-width: 0;
}

.role-card-title-row {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 4px;
}

.role-card-title {
    font-size: 14px;
    font-weight: 600;
    color: $text-primary;
}

.role-card-desc {
    font-size: 12px;
    line-height: 1.5;
    color: $text-muted;
}

.role-card-summary {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 8px;
    margin-bottom: 10px;
}

.summary-row {
    padding: 10px 12px;
    border-radius: $radius-md;
    background: $bg-secondary;
}

.summary-label {
    display: block;
    margin-bottom: 4px;
    font-size: 11px;
    font-weight: 600;
    color: $text-muted;
    text-transform: uppercase;
    letter-spacing: 0.04em;
}

.summary-value {
    display: block;
    font-size: 12px;
    line-height: 1.5;
    color: $text-primary;
    word-break: break-word;
}

.role-card-fallback,
.editor-hint {
    font-size: 12px;
    line-height: 1.5;
    color: $text-muted;
}

.role-editor {
    margin-top: 14px;
    padding-top: 14px;
    border-top: 1px solid $border-color;
}

.form-group {
    margin-top: 12px;
}

.form-label {
    display: block;
    margin-bottom: 6px;
    font-size: 12px;
    color: $text-secondary;
}

.quick-models {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 8px;
}

.quick-model-chip {
    padding: 4px 8px;
    border: 1px solid $border-color;
    border-radius: 999px;
    background: $bg-card;
    color: $text-secondary;
    font-size: 11px;
    cursor: pointer;

    &:hover {
        border-color: var(--accent-primary, #6366f1);
        color: $text-primary;
    }
}

.inherited-target {
    margin-top: 12px;
    padding: 10px 12px;
    border: 1px solid rgba(var(--accent-primary-rgb), 0.22);
    border-radius: $radius-md;
    background: rgba(var(--accent-primary-rgb), 0.06);
    color: $text-secondary;
    font-size: 12px;
    line-height: 1.5;

    &.error {
        border-color: rgba(239, 68, 68, 0.35);
        background: rgba(239, 68, 68, 0.08);
        color: #ef4444;
    }
}

.editor-actions,
.modal-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 16px;
}

@media (max-width: 720px) {
    .role-binding-modal {
        padding: 18px;
    }

    .role-card-head,
    .role-card-title-row {
        flex-direction: column;
        align-items: flex-start;
    }

    .role-card-summary {
        grid-template-columns: 1fr;
    }
}
</style>
