import { describe, expect, it } from 'vitest'
import { DeterministicHermesRuntime } from '../../packages/server/src/services/hermes/agent-room/runner/runtime/deterministic-runtime'
import type { HermesAgentRuntimeInput } from '../../packages/server/src/services/hermes/agent-room/runner/runtime/types'

describe('Hermes Agent Runtime Contract', () => {
    const runtime = new DeterministicHermesRuntime()

    function makeInput(overrides: Partial<HermesAgentRuntimeInput> = {}): HermesAgentRuntimeInput {
        return {
            taskTitle: 'Test Task',
            taskDescription: 'A test task',
            currentStatus: 'created',
            sessionId: 'session-1',
            taskId: 'task-1',
            revisionRound: 0,
            ...overrides,
        }
    }

    it('from created returns 4 steps: planned → assigned → in_progress → submitted_for_review', async () => {
        const output = await runtime.runTask(makeInput())

        expect(output.steps).toHaveLength(4)
        expect(output.steps[0].status).toBe('planned')
        expect(output.steps[0].eventType).toBe('task_planned')
        expect(output.steps[0].agentRole).toBe('planner')
        expect(output.steps[1].status).toBe('assigned')
        expect(output.steps[1].eventType).toBe('task_assigned')
        expect(output.steps[2].status).toBe('in_progress')
        expect(output.steps[2].eventType).toBe('task_started')
        expect(output.steps[3].status).toBe('submitted_for_review')
        expect(output.steps[3].eventType).toBe('task_submitted')
    })

    it('from created messages reference taskTitle', async () => {
        const output = await runtime.runTask(makeInput({ taskTitle: 'Build Login' }))

        const messages = output.steps.filter(s => s.message).map(s => s.message!.content)
        expect(messages.some(m => m.includes('Build Login'))).toBe(true)
    })

    it('from revision_required returns 2 steps: in_progress → submitted_for_review', async () => {
        const output = await runtime.runTask(makeInput({ currentStatus: 'revision_required' }))

        expect(output.steps).toHaveLength(2)
        expect(output.steps[0].status).toBe('in_progress')
        expect(output.steps[0].eventType).toBe('revision_started')
        expect(output.steps[1].status).toBe('submitted_for_review')
        expect(output.steps[1].eventType).toBe('task_submitted')
    })

    it('from need_user_decision returns same path as revision_required', async () => {
        const output = await runtime.runTask(makeInput({ currentStatus: 'need_user_decision' }))

        expect(output.steps).toHaveLength(2)
        expect(output.steps[0].status).toBe('in_progress')
        expect(output.steps[0].eventType).toBe('revision_started')
        expect(output.steps[1].status).toBe('submitted_for_review')
    })

    it('from failed returns 2 steps: in_progress → submitted_for_review', async () => {
        const output = await runtime.runTask(makeInput({ currentStatus: 'failed' }))

        expect(output.steps).toHaveLength(2)
        expect(output.steps[0].status).toBe('in_progress')
        expect(output.steps[0].eventType).toBe('task_started')
        expect(output.steps[1].status).toBe('submitted_for_review')
        expect(output.steps[1].eventType).toBe('task_submitted')
    })

    it('from unsupported status throws', async () => {
        await expect(runtime.runTask(makeInput({ currentStatus: 'completed' }))).rejects.toThrow(/unsupported start status/)
    })

    it('every step with message has senderRole, senderId, senderName', async () => {
        const output = await runtime.runTask(makeInput())

        for (const step of output.steps) {
            if (step.message) {
                expect(step.message.senderRole).toBeDefined()
                expect(step.message.senderId).toBeDefined()
                expect(step.message.senderName).toBeDefined()
                expect(step.message.content).toBeDefined()
            }
        }
    })

    it('every step has eventType and agentRole', async () => {
        const output = await runtime.runTask(makeInput())

        for (const step of output.steps) {
            expect(step.eventType).toBeDefined()
            expect(step.agentRole).toBeDefined()
            expect(step.status).toBeDefined()
        }
    })
})
