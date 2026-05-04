<script setup lang="ts">
import { ref, watch, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useMessage, NButton, NSpace, NInput, NInputNumber, NSwitch, NTag, NSelect } from 'naive-ui'
import { useGroupChatStore } from '@/stores/hermes/group-chat'
import { useAppStore } from '@/stores/hermes/app'
import type { RoomAgent, AgentOverride } from '@/api/hermes/group-chat'

const props = defineProps<{ agent: RoomAgent | null; roomId: string }>()
const emit = defineEmits<{ close: [] }>()

const { t } = useI18n()
const message = useMessage()
const store = useGroupChatStore()
const appStore = useAppStore()

const providerOptions = computed(() =>
    appStore.modelGroups.map(g => ({ label: g.label || g.provider, value: g.provider }))
)

const loading = ref(false)
const saving = ref(false)
const form = ref<AgentOverride>({})
const skillInput = ref('')

watch(() => props.agent, async (agent) => {
    if (!agent) {
        form.value = {}
        skillInput.value = ''
        return
    }
    loading.value = true
    try {
        const data = await store.loadAgentOverride(props.roomId, agent.agentId)
        form.value = { ...data }
    } catch {
        form.value = {}
    } finally {
        loading.value = false
    }
}, { immediate: true })

function addSkill() {
    const s = skillInput.value.trim()
    if (!s) return
    if (!form.value.skillsAllowList) form.value.skillsAllowList = []
    if (!form.value.skillsAllowList.includes(s)) form.value.skillsAllowList.push(s)
    skillInput.value = ''
}

function removeSkill(skill: string) {
    form.value.skillsAllowList = form.value.skillsAllowList?.filter(s => s !== skill)
}

async function handleSave() {
    if (!props.agent) return
    saving.value = true
    try {
        // Strip empty strings so backend treats them as "unset"
        const payload: AgentOverride = {}
        if (form.value.model?.trim()) payload.model = form.value.model.trim()
        if (form.value.provider?.trim()) payload.provider = form.value.provider.trim()
        if (form.value.systemPrompt?.trim()) payload.systemPrompt = form.value.systemPrompt.trim()
        if (form.value.contextEnabled !== undefined) payload.contextEnabled = form.value.contextEnabled
        if (form.value.triggerTokens != null) payload.triggerTokens = form.value.triggerTokens
        if (form.value.maxHistoryTokens != null) payload.maxHistoryTokens = form.value.maxHistoryTokens
        if (form.value.tailMessageCount != null) payload.tailMessageCount = form.value.tailMessageCount
        if (form.value.skillsAllowList?.length) payload.skillsAllowList = form.value.skillsAllowList

        await store.saveAgentOverride(props.roomId, props.agent.agentId, payload)
        message.success(t('common.saved'))
        emit('close')
    } catch {
        message.error(t('common.saveFailed'))
    } finally {
        saving.value = false
    }
}
</script>

<template>
    <Teleport to="body">
        <div v-if="agent" class="modal-backdrop" @click.self="emit('close')">
            <div class="modal agent-settings-modal">
                <div class="modal-header">
                    <h3>{{ agent.name }} — {{ t('groupChat.agentSettings') }}</h3>
                    <p class="override-hint">{{ t('groupChat.agentSettingsHint') }}</p>
                </div>

                <div v-if="loading" class="modal-loading">{{ t('common.loading') }}</div>
                <template v-else>
                    <!-- Basic -->
                    <div class="section-title">{{ t('groupChat.overrideBasic') }}</div>
                    <div class="form-group">
                        <label class="form-label">{{ t('groupChat.overrideModel') }}</label>
                        <NInput v-model:value="form.model" :placeholder="t('groupChat.overrideModelPlaceholder')" clearable />
                    </div>
                    <div class="form-group">
                        <label class="form-label">{{ t('groupChat.overrideProvider') }}</label>
                        <NSelect
                            v-model:value="form.provider"
                            :options="providerOptions"
                            :placeholder="t('groupChat.overrideProviderPlaceholder')"
                            clearable
                            filterable
                        />
                    </div>

                    <!-- Skills -->
                    <div class="section-title">{{ t('groupChat.overrideSkills') }}</div>
                    <div class="form-group">
                        <label class="form-label">{{ t('groupChat.overrideSkillsAllowList') }}</label>
                        <div class="skill-tags">
                            <NTag
                                v-for="s in form.skillsAllowList"
                                :key="s"
                                closable
                                size="small"
                                @close="removeSkill(s)"
                            >{{ s }}</NTag>
                        </div>
                        <div class="skill-input-row">
                            <NInput
                                v-model:value="skillInput"
                                :placeholder="t('groupChat.overrideSkillPlaceholder')"
                                @keydown.enter.prevent="addSkill"
                            />
                            <NButton size="small" @click="addSkill">{{ t('common.add') }}</NButton>
                        </div>
                    </div>

                    <!-- Context -->
                    <div class="section-title">{{ t('groupChat.overrideContext') }}</div>
                    <div class="form-group">
                        <label class="form-label">{{ t('groupChat.overrideSystemPrompt') }}</label>
                        <NInput v-model:value="form.systemPrompt" type="textarea" :rows="3" :placeholder="t('groupChat.overrideSystemPromptPlaceholder')" clearable />
                    </div>
                    <div class="form-group form-inline">
                        <label class="form-label">{{ t('groupChat.overrideContextEnabled') }}</label>
                        <NSwitch v-model:value="form.contextEnabled" />
                    </div>
                    <div class="form-group">
                        <label class="form-label">{{ t('groupChat.triggerTokens') }}</label>
                        <NInputNumber v-model:value="form.triggerTokens" :min="1000" :step="10000" :placeholder="t('groupChat.overrideInherit')" clearable style="width:100%" />
                    </div>
                    <div class="form-group">
                        <label class="form-label">{{ t('groupChat.maxHistoryTokens') }}</label>
                        <NInputNumber v-model:value="form.maxHistoryTokens" :min="1000" :step="1000" :placeholder="t('groupChat.overrideInherit')" clearable style="width:100%" />
                    </div>
                    <div class="form-group">
                        <label class="form-label">{{ t('groupChat.tailMessageCount') }}</label>
                        <NInputNumber v-model:value="form.tailMessageCount" :min="1" :step="5" :placeholder="t('groupChat.overrideInherit')" clearable style="width:100%" />
                    </div>
                </template>

                <div class="modal-actions">
                    <NSpace justify="end">
                        <NButton @click="emit('close')">{{ t('common.cancel') }}</NButton>
                        <NButton type="primary" :loading="saving" :disabled="loading" @click="handleSave">{{ t('common.save') }}</NButton>
                    </NSpace>
                </div>
            </div>
        </div>
    </Teleport>
</template>

<style scoped lang="scss">
@use "@/styles/variables" as *;

.modal-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.4);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1100;
}

.agent-settings-modal {
    background: $bg-card;
    border-radius: $radius-lg;
    padding: 24px;
    width: 440px;
    max-width: 92vw;
    max-height: 85vh;
    overflow-y: auto;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.14);
}

.modal-header {
    margin-bottom: 16px;

    h3 {
        font-size: 15px;
        font-weight: 600;
        color: $text-primary;
        margin: 0 0 6px;
    }
}

.override-hint {
    font-size: 12px;
    color: $text-muted;
    margin: 0;
    padding: 6px 10px;
    background: rgba(var(--accent-primary-rgb), 0.06);
    border-left: 3px solid var(--accent-primary, #6366f1);
    border-radius: 0 $radius-sm $radius-sm 0;
}

.section-title {
    font-size: 11px;
    font-weight: 600;
    color: $text-muted;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin: 16px 0 8px;
    padding-bottom: 4px;
    border-bottom: 1px solid $border-color;
}

.form-group {
    margin-bottom: 12px;
}

.form-inline {
    display: flex;
    align-items: center;
    justify-content: space-between;
}

.form-label {
    display: block;
    font-size: 12px;
    color: $text-secondary;
    margin-bottom: 4px;
}

.skill-tags {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-bottom: 6px;
    min-height: 24px;
}

.skill-input-row {
    display: flex;
    gap: 6px;
}

.modal-loading {
    padding: 24px 0;
    text-align: center;
    color: $text-muted;
    font-size: 13px;
}

.modal-actions {
    margin-top: 16px;
}
</style>
