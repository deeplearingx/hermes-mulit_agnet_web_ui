import { afterEach, describe, expect, it } from 'vitest'
import {
    createAgentRoomRunner,
    activeRunner,
    setActiveRunnerForTest,
    resetActiveRunnerForTest,
} from '../../packages/server/src/services/hermes/agent-room/runner'

describe('AgentRoomRunner factory', () => {
    afterEach(() => {
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

    it('resetActiveRunnerForTest restores the default runner', () => {
        const fake = { name: 'real' as const, run: async () => {} }
        setActiveRunnerForTest(fake)
        resetActiveRunnerForTest()
        expect(activeRunner.name).toBe('mock')
    })
})
