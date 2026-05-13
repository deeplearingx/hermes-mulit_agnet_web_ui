// @vitest-environment jsdom
import { mount, flushPromises } from '@vue/test-utils'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { reactive, ref } from 'vue'

import AgentRoomRoleBindingModal from '@/components/hermes/agent-room/AgentRoomRoleBindingModal.vue'
import type { AgentRoomRoleBinding } from '@/api/hermes/agent-room'
import type { HermesProfile } from '@/api/hermes/profiles'

// ─── Mock profiles store (reactive to match Pinia auto-unwrap) ──
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

const now = '2026-01-01T00:00:00.000Z'

const sampleProfiles: HermesProfile[] = [
    { name: 'default', active: true, model: 'gpt-4', gateway: 'running', alias: '' },
    { name: 'kimi', active: false, model: 'kimi-for-coding', gateway: '127.0.0.1:8643', alias: 'kimi' },
    { name: 'glm', active: false, model: 'glm-4', gateway: '127.0.0.1:8644', alias: '' },
]

function makeBindings(profileNames: Partial<Record<string, string>> = {}): AgentRoomRoleBinding[] {
    return Object.entries(profileNames).map(([role, profileName]) => ({
        id: `rb-${role}`,
        sessionId: 's1',
        role: role as AgentRoomRoleBinding['role'],
        profileName,
        createdAt: now,
    }))
}

function setupStore(profiles: HermesProfile[] = sampleProfiles, activeName?: string) {
    mockState.profiles = profiles
    mockState.activeProfile = profiles.find(p => p.active) ?? null
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
    showAdvanced?: boolean
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

    if (options.showAdvanced) {
        await wrapper.find('.btn-toggle-advanced').trigger('click')
        await flushPromises()
    }

    return wrapper
}

describe('AgentRoomRoleBindingModal — profile dropdown', () => {
    beforeEach(() => {
        setActivePinia(createPinia())
        vi.clearAllMocks()
    })

    it('shows profile select dropdown after opening', async () => {
        const wrapper = await mountModal({ showAdvanced: true })

        const selects = wrapper.findAll('select.profile-select')
        expect(selects.length).toBe(5)

        // Each select has active-profile option + profiles + custom option
        const firstSelect = selects[0]
        const options = firstSelect.findAll('option')
        // active-profile option + 3 profiles + 1 custom = 5
        expect(options.length).toBe(5)

        expect(options[0].text()).toContain('使用 active profile')

        // Profile options show name · model · gateway
        expect(options[1].text()).toContain('default')
        expect(options[1].text()).toContain('gpt-4')
        expect(options[1].text()).toContain('running')

        // kimi shows alias info (alias takes precedence over gateway in label)
        expect(options[2].text()).toContain('kimi')
        expect(options[2].text()).toContain('kimi-for-coding')

        // Custom option exists
        const customOption = options[options.length - 1]
        expect(customOption.text()).toContain('手动输入')
    })

    it('marks active profile with checkmark', async () => {
        const wrapper = await mountModal({ showAdvanced: true })

        const selects = wrapper.findAll('select.profile-select')
        const options = selects[0].findAll('option')

        // The "default" profile is active, should have ✓
        const defaultOption = options.find(o => o.attributes('value') === 'default')
        expect(defaultOption?.text()).toContain('✓')

        // The "kimi" profile is not active, should not have ✓
        const kimiOption = options.find(o => o.attributes('value') === 'kimi')
        expect(kimiOption?.text()).not.toContain('✓')
    })

    it('pre-selects bound profile when existing binding matches a profile', async () => {
        const bindings = makeBindings({ planner: 'kimi' })
        const wrapper = await mountModal({ roleBindings: bindings, showAdvanced: true })

        const selects = wrapper.findAll('select.profile-select')
        // planner is index 1 (conversation=0, planner=1)
        expect((selects[1].element as HTMLSelectElement).value).toBe('kimi')
    })

    it('falls back to custom input when bound profile not in profiles list', async () => {
        const bindings = makeBindings({ planner: 'unknown-profile' })
        const wrapper = await mountModal({ roleBindings: bindings, showAdvanced: true })

        // Should show custom input for planner
        const plannerInput = wrapper.find('input[data-role-input="planner"]')
        expect(plannerInput.exists()).toBe(true)
        expect((plannerInput.element as HTMLInputElement).value).toBe('unknown-profile')
    })

    it('switches to custom input when "手动输入" is selected', async () => {
        const wrapper = await mountModal({ showAdvanced: true })

        const plannerSelect = wrapper.find('select[data-role-select="planner"]')
        expect(plannerSelect.exists()).toBe(true)

        // Select custom option
        await plannerSelect.setValue('__custom__')

        // Should now show a text input for planner
        const plannerInput = wrapper.find('input[data-role-input="planner"]')
        expect(plannerInput.exists()).toBe(true)
    })

    it('emits save with selected profile name on bind click', async () => {
        const wrapper = await mountModal({ showAdvanced: true })

        const plannerSelect = wrapper.find('select[data-role-select="planner"]')
        await plannerSelect.setValue('kimi')

        const rows = wrapper.findAll('.role-row')
        const saveBtn = rows[1].find('.btn-save')
        await saveBtn.trigger('click')

        expect(wrapper.emitted('save')).toEqual([[{ role: 'planner', profileName: 'kimi' }]])
    })

    it('emits save with custom input value when in custom mode', async () => {
        const wrapper = await mountModal({ showAdvanced: true })

        const plannerSelect = wrapper.find('select[data-role-select="planner"]')
        await plannerSelect.setValue('__custom__')
        await flushPromises()

        const customInput = wrapper.find('input[data-role-input="planner"]')
        expect(customInput.exists()).toBe(true)
        await customInput.setValue('my-custom-profile')

        const rows = wrapper.findAll('.role-row')
        const saveBtn = rows[1].find('.btn-save')
        await saveBtn.trigger('click')

        expect(wrapper.emitted('save')).toEqual([[{ role: 'planner', profileName: 'my-custom-profile' }]])
    })
})

describe('AgentRoomRoleBindingModal — empty & error states', () => {
    beforeEach(() => {
        setActivePinia(createPinia())
        vi.clearAllMocks()
    })

    it('shows empty state when no profiles are returned', async () => {
        const wrapper = await mountModal({ profiles: [], showAdvanced: true })

        expect(wrapper.text()).toContain('未发现 Hermes profiles')
    })

    it('still allows manual input save when no profiles exist', async () => {
        const wrapper = await mountModal({ profiles: [], showAdvanced: true })

        // With empty profiles, select is shown; switch to custom
        const plannerSelect = wrapper.find('select[data-role-select="planner"]')
        await plannerSelect.setValue('__custom__')
        await flushPromises()

        const customInput = wrapper.find('input[data-role-input="planner"]')
        expect(customInput.exists()).toBe(true)
        await customInput.setValue('manual-profile')

        const rows = wrapper.findAll('.role-row')
        const saveBtn = rows[1].find('.btn-save')
        await saveBtn.trigger('click')

        expect(wrapper.emitted('save')).toEqual([[{ role: 'planner', profileName: 'manual-profile' }]])
    })

    it('shows custom inputs when fetch throws and still allows save', async () => {
        const wrapper = await mountModal({ fetchError: true, showAdvanced: true })

        // When fetch rejects, profilesLoaded stays false → each role gets text input
        const inputs = wrapper.findAll('input.profile-input')
        expect(inputs.length).toBe(5)

        const plannerInput = wrapper.find('input[data-role-input="planner"]')
        await plannerInput.setValue('fallback-profile')

        const rows = wrapper.findAll('.role-row')
        const saveBtn = rows[1].find('.btn-save')
        await saveBtn.trigger('click')

        expect(wrapper.emitted('save')).toEqual([[{ role: 'planner', profileName: 'fallback-profile' }]])
    })
})

describe('AgentRoomRoleBindingModal — delete binding', () => {
    beforeEach(() => {
        setActivePinia(createPinia())
        vi.clearAllMocks()
    })

    it('emits delete for a bound role', async () => {
        const bindings = makeBindings({ planner: 'kimi' })
        const wrapper = await mountModal({ roleBindings: bindings, showAdvanced: true })

        const rows = wrapper.findAll('.role-row')
        const deleteBtn = rows[1].find('.btn-delete')
        await deleteBtn.trigger('click')

        expect(wrapper.emitted('delete')).toEqual([['planner']])
    })
})

describe('AgentRoomRoleBindingModal — dirty state', () => {
    beforeEach(() => {
        setActivePinia(createPinia())
        vi.clearAllMocks()
    })

    it('disables save when selection is not dirty and already bound', async () => {
        const bindings = makeBindings({ planner: 'kimi' })
        const wrapper = await mountModal({ roleBindings: bindings, showAdvanced: true })

        const rows = wrapper.findAll('.role-row')
        const saveBtn = rows[1].find('.btn-save')

        // kimi is already bound, selecting kimi again = not dirty → disabled
        expect(saveBtn.attributes('disabled')).toBeDefined()
    })

    it('enables save when selection changes from bound value', async () => {
        const bindings = makeBindings({ planner: 'kimi' })
        const wrapper = await mountModal({ roleBindings: bindings, showAdvanced: true })

        const plannerSelect = wrapper.find('select[data-role-select="planner"]')
        await plannerSelect.setValue('default')

        const rows = wrapper.findAll('.role-row')
        const saveBtn = rows[1].find('.btn-save')

        expect(saveBtn.attributes('disabled')).toBeUndefined()
    })
})
