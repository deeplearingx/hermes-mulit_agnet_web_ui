import { describe, expect, it } from 'vitest'
import { createAgentRoomRunner } from '../../packages/server/src/services/hermes/agent-room/runner'

describe('AgentRoomRunner factory', () => {
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
})
