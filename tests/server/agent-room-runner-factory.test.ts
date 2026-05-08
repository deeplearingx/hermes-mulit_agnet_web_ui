import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
    createAgentRoomRunner,
    activeRunner,
    setActiveRunnerForTest,
    resetActiveRunnerForTest,
} from '../../packages/server/src/services/hermes/agent-room/runner'
import { createHermesAgentRuntime, DeterministicHermesRuntime } from '../../packages/server/src/services/hermes/agent-room/runner/runtime'

describe('AgentRoomRunner factory', () => {
    const savedRunnerEnv = process.env.AGENT_ROOM_RUNNER
    const savedRuntimeEnv = process.env.HERMES_AGENT_RUNTIME

    beforeEach(() => {
        // Isolate env vars so tests are deterministic regardless of CI/local env
        delete process.env.AGENT_ROOM_RUNNER
        delete process.env.HERMES_AGENT_RUNTIME
    })

    afterEach(() => {
        // Restore original env vars
        if (savedRunnerEnv === undefined) {
            delete process.env.AGENT_ROOM_RUNNER
        } else {
            process.env.AGENT_ROOM_RUNNER = savedRunnerEnv
        }
        if (savedRuntimeEnv === undefined) {
            delete process.env.HERMES_AGENT_RUNTIME
        } else {
            process.env.HERMES_AGENT_RUNTIME = savedRuntimeEnv
        }
        resetActiveRunnerForTest()
    })

    it('defaults to mock runner', () => {
        expect(createAgentRoomRunner().name).toBe('mock')
    })

    it('creates mock runner for mock mode', () => {
        expect(createAgentRoomRunner('mock').name).toBe('mock')
    })

    it('creates real runner for real mode', () => {
        expect(createAgentRoomRunner('real').name).toBe('real')
    })

    it('falls back to mock for unknown mode', () => {
        expect(createAgentRoomRunner('unknown').name).toBe('mock')
    })

    it('setActiveRunnerForTest replaces the active runner', () => {
        const fake = { name: 'real' as const, run: async () => {} }
        setActiveRunnerForTest(fake)
        expect(activeRunner).toBe(fake)
    })

    it('resetActiveRunnerForTest restores the default runner (env-cleared → mock)', () => {
        const fake = { name: 'real' as const, run: async () => {} }
        setActiveRunnerForTest(fake)
        resetActiveRunnerForTest()
        expect(activeRunner.name).toBe('mock')
    })

    it('resetActiveRunnerForTest respects AGENT_ROOM_RUNNER env', () => {
        process.env.AGENT_ROOM_RUNNER = 'real'
        resetActiveRunnerForTest()
        expect(activeRunner.name).toBe('real')
    })

    it('createHermesAgentRuntime returns deterministic runtime by default', () => {
        expect(createHermesAgentRuntime()).toBeInstanceOf(DeterministicHermesRuntime)
        expect(createHermesAgentRuntime('deterministic')).toBeInstanceOf(DeterministicHermesRuntime)
        expect(createHermesAgentRuntime('mock')).toBeInstanceOf(DeterministicHermesRuntime)
        expect(createHermesAgentRuntime('')).toBeInstanceOf(DeterministicHermesRuntime)
    })

    it('createHermesAgentRuntime falls back to deterministic until real runtime is implemented', () => {
        expect(createHermesAgentRuntime('real')).toBeInstanceOf(DeterministicHermesRuntime)
        expect(createHermesAgentRuntime('unknown')).toBeInstanceOf(DeterministicHermesRuntime)
    })
})
