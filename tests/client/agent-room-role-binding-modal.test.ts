// @vitest-environment jsdom
import { mount, flushPromises } from '@vue/test-utils'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { reactive } from 'vue'

import AgentRoomRoleBindingModal from '../../packages/client/src/components/hermes/agent-room/AgentRoomRoleBindingModal.vue'
import type { AgentRoomRoleBinding } from '../../packages/client/src/api/hermes/agent-room'
import type { HermesProfile } from '../../packages/client/src/api/hermes/profiles'

vi.mock('naive-ui', () => ({
    NButton: {
        template: '<button :disabled="disabled" @click="$emit(\'click\', $event)"><slot /></button>',
        props: ['disabled', 'loading', 'size', 'type', 'secondary', 'tertiary'],
        emits: ['click'],
    },
    NInput: {
        template: '<input :value="value" @input="$emit(\'update:value\', $event.target.value)" />',
        props: ['value', 'placeholder'],
        emits: ['update:value'],
    },
    NSelect: {
        template: `
            <select :value="value ?? ''" @change="$emit('update:value', $event.target.value)">
                <option v-for="option in options" :key="option.value" :value="option.value">{{ option.label }}</option>
            </select>
        `,
        props: ['value', 'options', 'placeholder', 'filterable', 'clearable', 'consistentMenuWidth'],
        emits: ['update:value'],
    },
    NTag: {
        template: '<span><slot /></span>',
        props: ['size', 'type'],
    },
    NSpace: {
        template: '<div><slot /></div>',
    },
}))

const mockState = reactive({
    profiles: [] as HermesProfile[],
    activeProfile: null as HermesProfile | null,
    activeProfileName: null as string | null,
    loading: false,
})

const mockFetchProfiles = vi.fn()

vi.mock('@/stores/hermes/profiles', () => ({
    useProfilesStore: () => ({
        profiles: mockState.profiles,
        activeProfile: mockState.activeProfile,
        activeProfileName: mockState.activeProfileName,
        loading: mockState.loading,
        fetchProfiles: mockFetchProfiles,
    }),
}))

vi.mock('@/stores/hermes/app', () => ({
    useAppStore: () => ({
        modelGroups: [
            { provider: 'openai', label: 'OpenAI', models: ['gpt-4o', 'gpt-4.1'] },
            { provider: 'anthropic', label: 'Anthropic', models: ['claude-3.5-sonnet', 'claude-sonnet-4.7'] },
        ],
    }),
}))

const now = '2026-01-01T00:00:00.000Z'

const sampleProfiles: HermesProfile[] = [
    { name: 'default', active: true, model: 'gpt-4', gateway: 'running', alias: '' },
    { name: 'kimi', active: false, model: 'kimi-for-coding', gateway: '127.0.0.1:8643', alias: 'kimi' },
    { name: 'glm', active: false, model: 'glm-4', gateway: '127.0.0.1:8644', alias: '' },
]

function makeBindings(input: Partial<Record<string, { profileName: string; provider?: string; model?: string }>> = {}): AgentRoomRoleBinding[] {
    return Object.entries(input).flatMap(([role, value]) => {
        if (!value) return []
        return [{
            id: `rb-${role}`,
            sessionId: 's1',
            role: role as AgentRoomRoleBinding['role'],
            profileName: value.profileName,
            provider: value.provider,
            model: value.model,
            createdAt: now,
        }]
    })
}

function setupStore(profiles: HermesProfile[] = sampleProfiles, activeName?: string) {
    mockState.profiles = profiles
    mockState.activeProfile = profiles.find(profile => profile.active) ?? null
    mockState.activeProfileName = activeName ?? (mockState.activeProfile?.name ?? null)
    mockState.loading = false
    mockFetchProfiles.mockResolvedValue(undefined)
}

async function mountModal(options: {
    visible?: boolean
    roleBindings?: AgentRoomRoleBinding[]
    saving?: boolean
    profiles?: HermesProfile[]
    fetchError?: boolean
} = {}) {
    if (options.fetchError) {
        mockFetchProfiles.mockRejectedValue(new Error('network error'))
        mockState.profiles = []
        mockState.activeProfile = null
        mockState.activeProfileName = null
    } else {
        setupStore(options.profiles ?? sampleProfiles)
    }

    const wrapper = mount(AgentRoomRoleBindingModal, {
        props: {
            visible: options.visible ?? true,
            roleBindings: options.roleBindings ?? [],
            saving: options.saving ?? false,
        },
        global: {
            stubs: {
                Teleport: { template: '<slot />' },
            },
        },
    })

    await flushPromises()
    return wrapper
}

describe('AgentRoomRoleBindingModal', () => {
    beforeEach(() => {
        setActivePinia(createPinia())
        vi.clearAllMocks()
    })

    it('renders summary cards for all roles', async () => {
        const wrapper = await mountModal()

        const cards = wrapper.findAll('.role-card')
        expect(cards).toHaveLength(5)
        expect(wrapper.text()).toContain('规划 Agent')
        expect(wrapper.text()).toContain('开发 Agent')
        expect(wrapper.text()).toContain('审核 Agent')
    })

    it('shows fallback summaries when no bindings exist', async () => {
        const wrapper = await mountModal()

        expect(wrapper.text()).toContain('active profile · default')
        expect(wrapper.text()).toContain('任务 assigned profile / active profile')
        expect(wrapper.text()).toContain('系统交付')
    })

    it('shows bound profile/provider/model summaries', async () => {
        const wrapper = await mountModal({
            roleBindings: makeBindings({
                planner: { profileName: 'kimi', provider: 'openai', model: 'gpt-4o' },
            }),
        })

        const plannerCard = wrapper.findAll('.role-card')[1]
        expect(plannerCard.text()).toContain('kimi')
        expect(plannerCard.text()).toContain('Override · openai')
        expect(plannerCard.text()).toContain('Override · gpt-4o')
    })

    it('opens a single-role editor with profile/provider/model controls', async () => {
        const wrapper = await mountModal()

        await wrapper.get('[data-role-edit="planner"]').trigger('click')
        await flushPromises()

        const editor = wrapper.get('[data-role-editor="planner"]')
        expect(editor.findAll('select').length).toBeGreaterThanOrEqual(2)
        expect(editor.findAll('input').length).toBeGreaterThanOrEqual(1)
    })

    it('emits save with selected profile, provider, and model', async () => {
        const wrapper = await mountModal()

        await wrapper.get('[data-role-edit="planner"]').trigger('click')
        await flushPromises()

        await wrapper.get('[data-role-select="planner"]').setValue('kimi')
        await wrapper.get('[data-role-provider-select="planner"]').setValue('openai')
        await wrapper.get('[data-role-model-input="planner"]').setValue('gpt-4o')
        await wrapper.get('[data-role-save="planner"]').trigger('click')

        expect(wrapper.emitted('save')).toEqual([[{ role: 'planner', profileName: 'kimi', provider: 'openai', model: 'gpt-4o' }]])
    })

    it('supports custom profile input when manual option is selected', async () => {
        const wrapper = await mountModal()

        await wrapper.get('[data-role-edit="planner"]').trigger('click')
        await flushPromises()

        await wrapper.get('[data-role-select="planner"]').setValue('__custom__')
        await flushPromises()

        await wrapper.get('[data-role-input="planner"]').setValue('my-custom-profile')
        await wrapper.get('[data-role-save="planner"]').trigger('click')

        expect(wrapper.emitted('save')).toEqual([[{ role: 'planner', profileName: 'my-custom-profile' }]])
    })

    it('falls back to custom profile input when bound profile is missing from list', async () => {
        const wrapper = await mountModal({
            roleBindings: makeBindings({ planner: { profileName: 'unknown-profile' } }),
        })

        await wrapper.get('[data-role-edit="planner"]').trigger('click')
        await flushPromises()

        const profileSelect = wrapper.get('[data-role-select="planner"]')
        expect((profileSelect.element as HTMLSelectElement).value).toBe('__custom__')
        const customInput = wrapper.get('[data-role-input="planner"]')
        expect((customInput.element as HTMLInputElement).value).toBe('unknown-profile')
    })
    it('shows empty state when no profiles are returned', async () => {
        const wrapper = await mountModal({ profiles: [] })
        expect(wrapper.text()).toContain('未发现 Hermes profiles')
    })

    it('shows warning and manual input fallback when profile fetch fails', async () => {
        const wrapper = await mountModal({ fetchError: true })

        await wrapper.get('[data-role-edit="planner"]').trigger('click')
        await flushPromises()

        expect(wrapper.text()).toContain('Profiles 加载失败')
        expect(wrapper.find('[data-role-input="planner"]').exists()).toBe(true)
    })

    it('saves manual profile input when profile fetch fails', async () => {
        const wrapper = await mountModal({ fetchError: true })

        await wrapper.get('[data-role-edit="planner"]').trigger('click')
        await flushPromises()

        await wrapper.get('[data-role-input="planner"]').setValue('fallback-profile')
        await wrapper.get('[data-role-save="planner"]').trigger('click')

        expect(wrapper.emitted('save')).toEqual([[{ role: 'planner', profileName: 'fallback-profile' }]])
    })

    it('emits delete for a bound role', async () => {
        const wrapper = await mountModal({
            roleBindings: makeBindings({ planner: { profileName: 'kimi' } }),
        })

        await wrapper.get('[data-role-reset="planner"]').trigger('click')

        expect(wrapper.emitted('delete')).toEqual([['planner']])
    })

    it('disables save when an existing binding is unchanged', async () => {
        const wrapper = await mountModal({
            roleBindings: makeBindings({ planner: { profileName: 'kimi' } }),
        })

        await wrapper.get('[data-role-edit="planner"]').trigger('click')
        await flushPromises()

        const saveButton = wrapper.get('[data-role-save="planner"]')
        expect(saveButton.attributes('disabled')).toBeDefined()
    })

    it('enables save after changing bound values', async () => {
        const wrapper = await mountModal({
            roleBindings: makeBindings({ planner: { profileName: 'kimi' } }),
        })

        await wrapper.get('[data-role-edit="planner"]').trigger('click')
        await flushPromises()

        await wrapper.get('[data-role-provider-select="planner"]').setValue('anthropic')

        const saveButton = wrapper.get('[data-role-save="planner"]')
        expect(saveButton.attributes('disabled')).toBeUndefined()
    })
})
