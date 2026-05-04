// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { nextTick } from 'vue'

// ─── Mock fetch ──────────────────────────────────────────
const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

vi.mock('@/router', () => ({
  default: {
    currentRoute: { value: { name: 'hermes.groupChat' } },
    replace: vi.fn(),
  },
}))

import { getAgentOverride, putAgentOverride } from '../../packages/client/src/api/hermes/group-chat'
import { setApiKey } from '../../packages/client/src/api/client'

// ─── API Tests ───────────────────────────────────────────
describe('group-chat override API', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.clearAllMocks()
    setApiKey('test-token')
  })

  it('getAgentOverride unwraps { override } envelope from server response', async () => {
    const override = { model: 'gpt-4o', contextEnabled: true }
    mockFetch.mockResolvedValue({ ok: true, status: 200, json: () => ({ override }) })

    const result = await getAgentOverride('room-1', 'agent-1')

    expect(mockFetch).toHaveBeenCalledOnce()
    const [url] = mockFetch.mock.calls[0]
    expect(url).toBe('/api/hermes/group-chat/rooms/room-1/agents/agent-1/override')
    expect(result).toEqual(override)
  })

  it('getAgentOverride returns {} when server returns { override: null }', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200, json: () => ({ override: null }) })
    const result = await getAgentOverride('room-1', 'agent-1')
    expect(result).toEqual({})
  })

  it('putAgentOverride calls PUT with JSON body and unwraps { override } response', async () => {
    const payload = { model: 'claude-3-5-sonnet', systemPrompt: 'You are helpful.' }
    mockFetch.mockResolvedValue({ ok: true, status: 200, json: () => ({ override: payload }) })

    const result = await putAgentOverride('room-1', 'agent-1', payload)

    expect(mockFetch).toHaveBeenCalledOnce()
    const [url, opts] = mockFetch.mock.calls[0]
    expect(url).toBe('/api/hermes/group-chat/rooms/room-1/agents/agent-1/override')
    expect(opts.method).toBe('PUT')
    expect(JSON.parse(opts.body)).toEqual(payload)
    expect(result).toEqual(payload)
  })

  it('putAgentOverride sends empty object when no fields set', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200, json: () => ({ override: {} }) })

    await putAgentOverride('room-2', 'agent-2', {})

    const [, opts] = mockFetch.mock.calls[0]
    expect(JSON.parse(opts.body)).toEqual({})
  })
})

// ─── Store Tests ─────────────────────────────────────────
import { setActivePinia, createPinia } from 'pinia'
import { useGroupChatStore } from '../../packages/client/src/stores/hermes/group-chat'

// Mock socket.io-client so store can be imported without real sockets
vi.mock('socket.io-client', () => ({
  io: vi.fn(() => ({
    connected: false,
    on: vi.fn(),
    emit: vi.fn(),
    disconnect: vi.fn(),
  })),
}))

describe('group-chat store override actions', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
    vi.clearAllMocks()
    setApiKey('test-token')
  })

  it('loadAgentOverride unwraps envelope and returns flat AgentOverride', async () => {
    const override = { model: 'gpt-4o', triggerTokens: 50000 }
    mockFetch.mockResolvedValue({ ok: true, status: 200, json: () => ({ override }) })

    const store = useGroupChatStore()
    const result = await store.loadAgentOverride('room-1', 'agent-1')

    expect(result).toEqual(override)
    const [url] = mockFetch.mock.calls[0]
    expect(url).toContain('/override')
  })

  it('saveAgentOverride unwraps envelope and returns saved AgentOverride', async () => {
    const payload = { systemPrompt: 'Be concise.', contextEnabled: false }
    mockFetch.mockResolvedValue({ ok: true, status: 200, json: () => ({ override: payload }) })

    const store = useGroupChatStore()
    const result = await store.saveAgentOverride('room-1', 'agent-1', payload)

    expect(result).toEqual(payload)
    const [url, opts] = mockFetch.mock.calls[0]
    expect(url).toContain('/override')
    expect(opts.method).toBe('PUT')
  })

  it('loadAgentOverride for different rooms does not cross-contaminate', async () => {
    const overrideA = { model: 'gpt-4o' }
    const overrideB = { model: 'claude-3-5-sonnet' }
    mockFetch
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => ({ override: overrideA }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => ({ override: overrideB }) })

    const store = useGroupChatStore()
    const a = await store.loadAgentOverride('room-A', 'agent-1')
    const b = await store.loadAgentOverride('room-B', 'agent-1')

    expect(a.model).toBe('gpt-4o')
    expect(b.model).toBe('claude-3-5-sonnet')
    expect(mockFetch.mock.calls[0][0]).toContain('room-A')
    expect(mockFetch.mock.calls[1][0]).toContain('room-B')
  })
})

// ─── AgentSettingsModal reopen regression ────────────────
import { mount } from '@vue/test-utils'
import { ref } from 'vue'
import { createPinia as createPinia2, setActivePinia as setActivePinia2 } from 'pinia'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (k: string) => k }),
}))
vi.mock('naive-ui', () => ({
  useMessage: () => ({ success: vi.fn(), error: vi.fn() }),
  NButton: { template: '<button><slot /></button>' },
  NSpace: { template: '<div><slot /></div>' },
  NInput: { template: '<input />', props: ['modelValue'], emits: ['update:modelValue'] },
  NInputNumber: { template: '<input />', props: ['modelValue'], emits: ['update:modelValue'] },
  NSwitch: { template: '<input type="checkbox" />', props: ['modelValue'], emits: ['update:modelValue'] },
  NTag: { template: '<span><slot /></span>', props: ['closable'], emits: ['close'] },
  NSelect: { template: '<select />', props: ['value', 'options'], emits: ['update:value'] },
}))

vi.mock('@/stores/hermes/app', () => ({
  useAppStore: () => ({ modelGroups: [] }),
}))

import AgentSettingsModal from '@/components/hermes/group-chat/AgentSettingsModal.vue'

describe('AgentSettingsModal reopen regression', () => {
  beforeEach(() => {
    setActivePinia2(createPinia2())
    localStorage.clear()
    vi.clearAllMocks()
    setApiKey('test-token')
  })

  it('form resets to {} when agent prop becomes null (close)', async () => {
    const agent = { id: 'a1', name: 'Bot', roomId: 'r1', agentId: 'a1', profile: 'p', description: '', invited: 0 }
    mockFetch.mockResolvedValue({ ok: true, status: 200, json: () => ({ override: { model: 'gpt-4o' } }) })

    const agentRef = ref(agent)
    const wrapper = mount(AgentSettingsModal, {
      props: { agent: agentRef.value, roomId: 'r1' },
      global: { plugins: [createPinia2()] },
    })
    await nextTick(); await nextTick()

    // Close: set agent to null
    await wrapper.setProps({ agent: null })
    await nextTick()

    // form should be cleared — component internal state reset
    // Verify by reopening: next load should fetch fresh data, not stale model
    mockFetch.mockResolvedValue({ ok: true, status: 200, json: () => ({ override: { model: 'claude-3-5-sonnet' } }) })
    await wrapper.setProps({ agent: agentRef.value })
    await nextTick(); await nextTick()

    // fetch called twice: once on open, once on reopen
    expect(mockFetch).toHaveBeenCalledTimes(2)
  })

  it('reopen with same agent triggers a fresh loadAgentOverride call', async () => {
    const agent = { id: 'a2', name: 'Bot2', roomId: 'r1', agentId: 'a2', profile: 'p', description: '', invited: 0 }
    mockFetch
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => ({ override: { model: 'first-model' } }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => ({ override: { model: 'second-model' } }) })

    const wrapper = mount(AgentSettingsModal, {
      props: { agent, roomId: 'r1' },
      global: { plugins: [createPinia2()] },
    })
    await nextTick(); await nextTick()

    // Close then reopen same agent
    await wrapper.setProps({ agent: null })
    await nextTick()
    await wrapper.setProps({ agent })
    await nextTick(); await nextTick()

    expect(mockFetch).toHaveBeenCalledTimes(2)
    expect(mockFetch.mock.calls[1][0]).toContain('/agents/a2/override')
  })
})
