import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RealHermesRuntime } from '../../packages/server/src/services/hermes/agent-room/runner/runtime/real-hermes-runtime'
import { createHermesAgentRuntime } from '../../packages/server/src/services/hermes/agent-room/runner/runtime'
import type { HermesAgentRuntimeInput } from '../../packages/server/src/services/hermes/agent-room/runner/runtime/types'

describe('RealHermesRuntime', () => {
    const savedBaseUrl = process.env.HERMES_AGENT_BASE_URL
    const savedTimeout = process.env.HERMES_AGENT_TIMEOUT_MS

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

    beforeEach(() => {
        delete process.env.HERMES_AGENT_BASE_URL
        delete process.env.HERMES_AGENT_TIMEOUT_MS
    })

    afterEach(() => {
        // Restore original env vars
        if (savedBaseUrl === undefined) {
            delete process.env.HERMES_AGENT_BASE_URL
        } else {
            process.env.HERMES_AGENT_BASE_URL = savedBaseUrl
        }
        if (savedTimeout === undefined) {
            delete process.env.HERMES_AGENT_TIMEOUT_MS
        } else {
            process.env.HERMES_AGENT_TIMEOUT_MS = savedTimeout
        }
        vi.restoreAllMocks()
    })

    it('throws when baseUrl is empty', async () => {
        const runtime = new RealHermesRuntime('')
        await expect(runtime.runTask(makeInput())).rejects.toThrow(/HERMES_AGENT_BASE_URL/)
    })

    it('throws when baseUrl is not set (default)', async () => {
        const runtime = new RealHermesRuntime()
        await expect(runtime.runTask(makeInput())).rejects.toThrow(/HERMES_AGENT_BASE_URL/)
    })

    it('POSTs to /agent-room/run-task with correct request body', async () => {
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            new Response(JSON.stringify({
                steps: [
                    {
                        status: 'planned',
                        events: [{ type: 'task_planned', agentRole: 'planner' }],
                        messages: [{ senderRole: 'planner', content: 'ok' }],
                    },
                ],
            }), { status: 200 }),
        )

        const runtime = new RealHermesRuntime('https://agent.example.com')
        await runtime.runTask(makeInput({ taskTitle: 'Build Login', assignedAgentId: 'dev-1' }))

        expect(fetchSpy).toHaveBeenCalledOnce()
        const [url, options] = fetchSpy.mock.calls[0]
        expect(url).toBe('https://agent.example.com/agent-room/run-task')
        expect(options?.method).toBe('POST')
        expect(options?.headers).toEqual({ 'content-type': 'application/json' })

        const body = JSON.parse(options?.body as string)
        expect(body.sessionId).toBe('session-1')
        expect(body.taskId).toBe('task-1')
        expect(body.title).toBe('Build Login')
        expect(body.description).toBe('A test task')
        expect(body.currentStatus).toBe('created')
        expect(body.assignedAgentId).toBe('dev-1')
        expect(body.revisionRound).toBe(0)
    })

    it('returns parsed output on HTTP 200 with valid response', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            new Response(JSON.stringify({
                steps: [
                    {
                        status: 'planned',
                        events: [{ type: 'task_planned', agentRole: 'planner' }],
                        messages: [{ senderRole: 'planner', senderId: 'planner', senderName: '规划 Agent', content: 'planned' }],
                    },
                    {
                        status: 'assigned',
                        events: [{ type: 'task_assigned', agentRole: 'developer' }],
                    },
                ],
                artifacts: [{ name: 'plan.md', type: 'code', content: '# Plan' }],
            }), { status: 200 }),
        )

        const runtime = new RealHermesRuntime('https://agent.example.com')
        const output = await runtime.runTask(makeInput())

        expect(output.steps).toHaveLength(2)
        expect(output.steps[0].status).toBe('planned')
        expect(output.steps[0].events[0].type).toBe('task_planned')
        expect(output.steps[0].messages![0].content).toBe('planned')
        expect(output.artifacts).toHaveLength(1)
        expect(output.artifacts![0].name).toBe('plan.md')
    })

    it('throws on HTTP non-2xx response', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            new Response('Internal Server Error', { status: 500 }),
        )

        const runtime = new RealHermesRuntime('https://agent.example.com')
        await expect(runtime.runTask(makeInput())).rejects.toThrow(/HTTP 500/)
    })

    it('throws on HTTP 404 response', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            new Response('Not Found', { status: 404 }),
        )

        const runtime = new RealHermesRuntime('https://agent.example.com')
        await expect(runtime.runTask(makeInput())).rejects.toThrow(/HTTP 404/)
    })

    it('throws when response is not an object', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            new Response('"just a string"', { status: 200 }),
        )

        const runtime = new RealHermesRuntime('https://agent.example.com')
        await expect(runtime.runTask(makeInput())).rejects.toThrow(/expected object/)
    })

    it('throws when response has no steps array', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            new Response(JSON.stringify({ artifacts: [] }), { status: 200 }),
        )

        const runtime = new RealHermesRuntime('https://agent.example.com')
        await expect(runtime.runTask(makeInput())).rejects.toThrow(/steps must be array/)
    })

    it('throws when step has no status', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            new Response(JSON.stringify({
                steps: [{ events: [{ type: 'task_planned', agentRole: 'planner' }] }],
            }), { status: 200 }),
        )

        const runtime = new RealHermesRuntime('https://agent.example.com')
        await expect(runtime.runTask(makeInput())).rejects.toThrow(/steps\[0\]\.status is required/)
    })

    it('throws when step has empty events array', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            new Response(JSON.stringify({
                steps: [{ status: 'planned', events: [] }],
            }), { status: 200 }),
        )

        const runtime = new RealHermesRuntime('https://agent.example.com')
        await expect(runtime.runTask(makeInput())).rejects.toThrow(/steps\[0\]\.events must be non-empty array/)
    })

    it('throws when event is missing type or agentRole', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            new Response(JSON.stringify({
                steps: [{ status: 'planned', events: [{ type: 'task_planned' }] }],
            }), { status: 200 }),
        )

        const runtime = new RealHermesRuntime('https://agent.example.com')
        await expect(runtime.runTask(makeInput())).rejects.toThrow(/requires type and agentRole/)
    })

    it('strips trailing slash from baseUrl', async () => {
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            new Response(JSON.stringify({
                steps: [{ status: 'planned', events: [{ type: 'task_planned', agentRole: 'planner' }] }],
            }), { status: 200 }),
        )

        const runtime = new RealHermesRuntime('https://agent.example.com/')
        await runtime.runTask(makeInput())

        const [url] = fetchSpy.mock.calls[0]
        expect(url).toBe('https://agent.example.com/agent-room/run-task')
    })

    it('createHermesAgentRuntime("real") returns RealHermesRuntime', () => {
        const runtime = createHermesAgentRuntime('real')
        expect(runtime).toBeInstanceOf(RealHermesRuntime)
    })
})
