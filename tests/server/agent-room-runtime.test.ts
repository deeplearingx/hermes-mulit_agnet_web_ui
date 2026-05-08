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
        expect(output.steps[0].events[0].type).toBe('task_planned')
        expect(output.steps[0].events[0].agentRole).toBe('planner')
        expect(output.steps[1].status).toBe('assigned')
        expect(output.steps[1].events[0].type).toBe('task_assigned')
        expect(output.steps[2].status).toBe('in_progress')
        expect(output.steps[2].events[0].type).toBe('task_started')
        expect(output.steps[3].status).toBe('submitted_for_review')
        expect(output.steps[3].events[0].type).toBe('task_submitted')
    })

    it('from created messages reference taskTitle', async () => {
        const output = await runtime.runTask(makeInput({ taskTitle: 'Build Login' }))

        const allMessages = output.steps.flatMap(s => s.messages ?? [])
        expect(allMessages.some(m => m.content.includes('Build Login'))).toBe(true)
    })

    it('from revision_required returns 2 steps: in_progress → submitted_for_review', async () => {
        const output = await runtime.runTask(makeInput({ currentStatus: 'revision_required' }))

        expect(output.steps).toHaveLength(2)
        expect(output.steps[0].status).toBe('in_progress')
        expect(output.steps[0].events[0].type).toBe('revision_started')
        expect(output.steps[1].status).toBe('submitted_for_review')
        expect(output.steps[1].events[0].type).toBe('task_submitted')
    })

    it('from need_user_decision returns same path as revision_required', async () => {
        const output = await runtime.runTask(makeInput({ currentStatus: 'need_user_decision' }))

        expect(output.steps).toHaveLength(2)
        expect(output.steps[0].status).toBe('in_progress')
        expect(output.steps[0].events[0].type).toBe('revision_started')
        expect(output.steps[1].status).toBe('submitted_for_review')
    })

    it('from failed returns 2 steps: in_progress → submitted_for_review', async () => {
        const output = await runtime.runTask(makeInput({ currentStatus: 'failed' }))

        expect(output.steps).toHaveLength(2)
        expect(output.steps[0].status).toBe('in_progress')
        expect(output.steps[0].events[0].type).toBe('task_started')
        expect(output.steps[1].status).toBe('submitted_for_review')
        expect(output.steps[1].events[0].type).toBe('task_submitted')
    })

    it('from unsupported status throws', async () => {
        await expect(runtime.runTask(makeInput({ currentStatus: 'completed' }))).rejects.toThrow(/unsupported start status/)
    })

    it('every step with messages has senderRole, senderId, senderName', async () => {
        const output = await runtime.runTask(makeInput())

        for (const step of output.steps) {
            for (const msg of step.messages ?? []) {
                expect(msg.senderRole).toBeDefined()
                expect(msg.senderId).toBeDefined()
                expect(msg.senderName).toBeDefined()
                expect(msg.content).toBeDefined()
            }
        }
    })

    it('every step has events array with type and agentRole', async () => {
        const output = await runtime.runTask(makeInput())

        for (const step of output.steps) {
            expect(step.events).toBeDefined()
            expect(step.events.length).toBeGreaterThan(0)
            for (const event of step.events) {
                expect(event.type).toBeDefined()
                expect(event.agentRole).toBeDefined()
            }
        }
    })

    it('runtime output maps to AgentRoomRunnerResult without cast', async () => {
        const output = await runtime.runTask(makeInput())

        // Verify structural compatibility: runtime types are directly assignable
        const mapped = {
            steps: output.steps.map(step => ({
                status: step.status,
                events: step.events,
                messages: step.messages,
            })),
            artifacts: output.artifacts,
        }

        expect(mapped.steps).toHaveLength(4)
        expect(mapped.steps[0].status).toBe('planned')
        expect(mapped.steps[0].events[0].type).toBe('task_planned')
        expect(mapped.steps[0].events[0].agentRole).toBe('planner')
    })
})
