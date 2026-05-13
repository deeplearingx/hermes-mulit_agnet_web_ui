import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
    createAgentRoomRunner,
    activeRunner,
    setActiveRunnerForTest,
    resetActiveRunnerForTest,
} from '../../packages/server/src/services/hermes/agent-room/runner'
import {
    createHermesAgentRuntime,
    DeterministicHermesRuntime,
    RealHermesRuntime,
    GatewayHermesRuntime,
    OrchestratedGatewayRuntime,
} from '../../packages/server/src/services/hermes/agent-room/runner/runtime'

describe('AgentRoomRunner factory', () => {
    const savedRunnerEnv = process.env.AGENT_ROOM_RUNNER
    const savedRuntimeEnv = process.env.HERMES_AGENT_RUNTIME
    const savedNodeEnv = process.env.NODE_ENV

    beforeEach(() => {
        // Isolate env vars so tests are deterministic regardless of CI/local env
        delete process.env.AGENT_ROOM_RUNNER
        delete process.env.HERMES_AGENT_RUNTIME
        process.env.NODE_ENV = 'test'
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
        if (savedNodeEnv === undefined) {
            delete process.env.NODE_ENV
        } else {
            process.env.NODE_ENV = savedNodeEnv
        }
    })

    it('defaults to mock runner in test environment', () => {
        process.env.NODE_ENV = 'test'
        expect(createAgentRoomRunner().name).toBe('mock')
    })

    it('defaults to real runner outside test environment', () => {
        process.env.NODE_ENV = 'production'
        expect(createAgentRoomRunner().name).toBe('real')
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

    it('resetActiveRunnerForTest restores the test default runner (env-cleared → mock)', () => {
        const fake = { name: 'real' as const, run: async () => {} }
        setActiveRunnerForTest(fake)
        resetActiveRunnerForTest()
        if (savedNodeEnv === undefined) {
            delete process.env.NODE_ENV
        } else {
            process.env.NODE_ENV = savedNodeEnv
        }
        expect(activeRunner.name).toBe('mock')
    })

    it('resetActiveRunnerForTest respects AGENT_ROOM_RUNNER env', () => {
        process.env.AGENT_ROOM_RUNNER = 'real'
        resetActiveRunnerForTest()
        if (savedNodeEnv === undefined) {
            delete process.env.NODE_ENV
        } else {
            process.env.NODE_ENV = savedNodeEnv
        }
        expect(activeRunner.name).toBe('real')
    })

    it('createHermesAgentRuntime returns deterministic runtime by default in test environment', () => {
        process.env.NODE_ENV = 'test'
        expect(createHermesAgentRuntime()).toBeInstanceOf(DeterministicHermesRuntime)
        expect(createHermesAgentRuntime('deterministic')).toBeInstanceOf(DeterministicHermesRuntime)
        expect(createHermesAgentRuntime('mock')).toBeInstanceOf(DeterministicHermesRuntime)
        expect(createHermesAgentRuntime('')).toBeInstanceOf(DeterministicHermesRuntime)
    })

    it('createHermesAgentRuntime returns orchestrated runtime by default outside test environment', () => {
        process.env.NODE_ENV = 'production'
        expect(createHermesAgentRuntime()).toBeInstanceOf(OrchestratedGatewayRuntime)
    })

    it('createHermesAgentRuntime("real") returns GatewayHermesRuntime (primary)', () => {
        expect(createHermesAgentRuntime('real')).toBeInstanceOf(GatewayHermesRuntime)
    })

    it('createHermesAgentRuntime("gateway") returns GatewayHermesRuntime', () => {
        expect(createHermesAgentRuntime('gateway')).toBeInstanceOf(GatewayHermesRuntime)
    })

    it('createHermesAgentRuntime("http") returns RealHermesRuntime (custom bridge)', () => {
        expect(createHermesAgentRuntime('http')).toBeInstanceOf(RealHermesRuntime)
    })

    it('createHermesAgentRuntime("bridge") returns RealHermesRuntime (custom bridge)', () => {
        expect(createHermesAgentRuntime('bridge')).toBeInstanceOf(RealHermesRuntime)
    })

    it('createHermesAgentRuntime falls back to deterministic for unknown mode', () => {
        expect(createHermesAgentRuntime('unknown')).toBeInstanceOf(DeterministicHermesRuntime)
    })
})
