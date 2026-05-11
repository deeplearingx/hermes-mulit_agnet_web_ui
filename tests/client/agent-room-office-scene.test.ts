// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'

const shutdownEvent = 'shutdown'

vi.mock('phaser', () => {
  const mockedShutdownEvent = 'shutdown'

  class EventEmitterStub {
    private listeners = new Map<string, Array<() => void>>()

    once(event: string, cb: () => void) {
      this.listeners.set(event, [...(this.listeners.get(event) ?? []), cb])
      return this
    }

    emit(event: string) {
      const callbacks = this.listeners.get(event) ?? []
      this.listeners.delete(event)
      for (const cb of callbacks) cb()
      return this
    }
  }

  class SceneStub {
    events = new EventEmitterStub()

    constructor(public config?: unknown) {}
  }

  return {
    default: {
      Scene: SceneStub,
      Scenes: { Events: { SHUTDOWN: mockedShutdownEvent } },
      Math: { Clamp: (value: number, min: number, max: number) => Math.min(max, Math.max(min, value)) },
    },
  }
})

import {
  AgentRoomOfficeScene,
  shouldApplyAgentRoomStateUpdate,
} from '../../packages/client/src/components/hermes/agent-room/scenes/AgentRoomOfficeScene'

describe('AgentRoomOfficeScene lightweight smoke', () => {
  it('constructs without creating a Phaser game', () => {
    const scene = new AgentRoomOfficeScene('scene-smoke')
    expect(scene).toBeInstanceOf(AgentRoomOfficeScene)
  })

  it('filters state update events by instanceId', () => {
    expect(shouldApplyAgentRoomStateUpdate('scene-a', 'scene-a')).toBe(true)
    expect(shouldApplyAgentRoomStateUpdate('scene-a', 'scene-b')).toBe(false)
    expect(shouldApplyAgentRoomStateUpdate('scene-a', undefined)).toBe(false)
    expect(shouldApplyAgentRoomStateUpdate(undefined, 'scene-a')).toBe(false)
  })

  it('registers shutdown cleanup without starting WebGL/canvas runtime', () => {
    const scene = new AgentRoomOfficeScene('scene-cleanup')
    let cleanupCalled = 0
    scene.events.once(shutdownEvent, () => {
      cleanupCalled += 1
    })

    scene.events.emit(shutdownEvent)

    expect(cleanupCalled).toBe(1)
  })
})
