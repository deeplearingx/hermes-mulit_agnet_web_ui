import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HermesAgentRuntimeInput } from '../../packages/server/src/services/hermes/agent-room/runner/runtime/types'
import { createHermesAgentRuntime } from '../../packages/server/src/services/hermes/agent-room/runner/runtime'
import { GatewayHermesRuntime } from '../../packages/server/src/services/hermes/agent-room/runner/runtime/gateway-hermes-runtime'

// Mock the gateway-run-client module — keep real extractGatewayOutput
vi.mock('../../packages/server/src/services/hermes/gateway-run-client', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../packages/server/src/services/hermes/gateway-run-client')>()
    return {
        ...actual,
        runHermesGatewayTask: vi.fn(),
    }
})

// Mock the config module
vi.mock('../../packages/server/src/config', () => ({
    config: {
        upstream: 'http://127.0.0.1:9999',
    },
}))

import { runHermesGatewayTask } from '../../packages/server/src/services/hermes/gateway-run-client'

describe('GatewayHermesRuntime', () => {
    function makeInput(overrides: Partial<HermesAgentRuntimeInput> = {}): HermesAgentRuntimeInput {
        return {
            sessionId: 'sess-1',
            taskId: 'task-1',
            taskTitle: 'Implement login page',
            taskDescription: 'Create a login page with email/password',
            currentStatus: 'created',
            assignedAgentId: 'dev-agent',
            revisionRound: 0,
            ...overrides,
        }
    }

    beforeEach(() => {
        vi.clearAllMocks()
    })

    afterEach(() => {
        vi.restoreAllMocks()
    })

    it('createHermesAgentRuntime("real") returns GatewayHermesRuntime', () => {
        const runtime = createHermesAgentRuntime('real')
        expect(runtime).toBeInstanceOf(GatewayHermesRuntime)
    })

    it('createHermesAgentRuntime("gateway") returns GatewayHermesRuntime', () => {
        const runtime = createHermesAgentRuntime('gateway')
        expect(runtime).toBeInstanceOf(GatewayHermesRuntime)
    })

    it('calls runHermesGatewayTask with correct /v1/runs body', async () => {
        vi.mocked(runHermesGatewayTask).mockResolvedValue({
            output: 'Task completed successfully',
            runId: 'run-abc',
            sessionId: 'agent-room-sess-1-task-1',
        })

        const runtime = new GatewayHermesRuntime('http://127.0.0.1:8642', null, 30000)
        await runtime.runTask(makeInput())

        expect(runHermesGatewayTask).toHaveBeenCalledWith(expect.objectContaining({
            upstream: 'http://127.0.0.1:8642',
            apiKey: null,
            input: expect.stringContaining('Implement login page'),
            instructions: expect.stringContaining('AgentRoom'),
            sessionId: 'agent-room-sess-1-task-1',
            timeoutMs: 30000,
        }))
    })

    it('input text contains taskTitle, taskDescription, currentStatus, revisionRound', async () => {
        vi.mocked(runHermesGatewayTask).mockResolvedValue({
            output: 'Done',
            runId: 'run-1',
            sessionId: 'agent-room-sess-1-task-1',
        })

        const runtime = new GatewayHermesRuntime('http://127.0.0.1:8642', null, 30000)
        await runtime.runTask(makeInput({ currentStatus: 'revision_required', revisionRound: 2 }))

        const callArgs = vi.mocked(runHermesGatewayTask).mock.calls[0][0]
        expect(callArgs.input).toContain('Implement login page')
        expect(callArgs.input).toContain('Create a login page with email/password')
        expect(callArgs.input).toContain('revision_required')
        expect(callArgs.input).toContain('2')
    })

    describe('created path: 4 steps', () => {
        it('returns planned → assigned → in_progress → submitted_for_review', async () => {
            vi.mocked(runHermesGatewayTask).mockResolvedValue({
                output: 'Login page implemented',
                runId: 'run-100',
                sessionId: 'agent-room-sess-1-task-1',
            })

            const runtime = new GatewayHermesRuntime('http://127.0.0.1:8642', null, 30000)
            const result = await runtime.runTask(makeInput())

            expect(result.steps).toHaveLength(4)
            expect(result.steps[0].status).toBe('planned')
            expect(result.steps[1].status).toBe('assigned')
            expect(result.steps[2].status).toBe('in_progress')
            expect(result.steps[3].status).toBe('submitted_for_review')
        })

        it('submitted_for_review step carries runId, source, profileName, bindingSource, and transportSource metadata', async () => {
            vi.mocked(runHermesGatewayTask).mockResolvedValue({
                output: 'Login page implemented',
                runId: 'run-100',
                sessionId: 'agent-room-sess-1-task-1',
            })

            const runtime = new GatewayHermesRuntime('http://127.0.0.1:8642', null, 30000)
            const result = await runtime.runTask(makeInput())

            const finalStep = result.steps[3]
            expect(finalStep.events[0].payload).toEqual(expect.objectContaining({ runId: 'run-100', source: 'hermes-gateway', profileName: 'dev-agent', bindingSource: 'assigned-agent', transportSource: 'constructor-fallback', model: expect.any(String), provider: expect.any(String) }))
            expect(finalStep.messages![0].metadata).toEqual(expect.objectContaining({ runId: 'run-100', source: 'hermes-gateway', profileName: 'dev-agent', bindingSource: 'assigned-agent', transportSource: 'constructor-fallback', model: expect.any(String), provider: expect.any(String) }))
        })

        it('artifact type is code_output with runId, profileName, bindingSource, and transportSource metadata', async () => {
            vi.mocked(runHermesGatewayTask).mockResolvedValue({
                output: 'Login page implemented',
                runId: 'run-100',
                sessionId: 'agent-room-sess-1-task-1',
            })

            const runtime = new GatewayHermesRuntime('http://127.0.0.1:8642', null, 30000)
            const result = await runtime.runTask(makeInput())

            expect(result.artifacts).toHaveLength(1)
            expect(result.artifacts![0].type).toBe('code_output')
            expect(result.artifacts![0].content).toBe('Login page implemented')
            expect(result.artifacts![0].metadata).toEqual(expect.objectContaining({ runId: 'run-100', source: 'hermes-gateway', profileName: 'dev-agent', bindingSource: 'assigned-agent', transportSource: 'constructor-fallback', model: expect.any(String), provider: expect.any(String) }))
        })

        it('planned step has planner agentRole', async () => {
            vi.mocked(runHermesGatewayTask).mockResolvedValue({
                output: 'Done',
                runId: 'run-1',
                sessionId: 'agent-room-sess-1-task-1',
            })

            const runtime = new GatewayHermesRuntime('http://127.0.0.1:8642', null, 30000)
            const result = await runtime.runTask(makeInput())

            expect(result.steps[0].events[0].type).toBe('task_planned')
            expect(result.steps[0].events[0].agentRole).toBe('planner')
        })
    })

    describe('revision_required path: 2 steps', () => {
        it('returns in_progress → submitted_for_review', async () => {
            vi.mocked(runHermesGatewayTask).mockResolvedValue({
                output: 'Revised login page',
                runId: 'run-200',
                sessionId: 'agent-room-sess-1-task-1',
            })

            const runtime = new GatewayHermesRuntime('http://127.0.0.1:8642', null, 30000)
            const result = await runtime.runTask(makeInput({ currentStatus: 'revision_required', revisionRound: 1 }))

            expect(result.steps).toHaveLength(2)
            expect(result.steps[0].status).toBe('in_progress')
            expect(result.steps[1].status).toBe('submitted_for_review')
        })

        it('in_progress step has revision_started event', async () => {
            vi.mocked(runHermesGatewayTask).mockResolvedValue({
                output: 'Revised',
                runId: 'run-200',
                sessionId: 'agent-room-sess-1-task-1',
            })

            const runtime = new GatewayHermesRuntime('http://127.0.0.1:8642', null, 30000)
            const result = await runtime.runTask(makeInput({ currentStatus: 'revision_required' }))

            expect(result.steps[0].events[0].type).toBe('revision_started')
        })
    })

    describe('need_user_decision path: 2 steps', () => {
        it('returns in_progress → submitted_for_review with revision_started', async () => {
            vi.mocked(runHermesGatewayTask).mockResolvedValue({
                output: 'Addressed feedback',
                runId: 'run-300',
                sessionId: 'agent-room-sess-1-task-1',
            })

            const runtime = new GatewayHermesRuntime('http://127.0.0.1:8642', null, 30000)
            const result = await runtime.runTask(makeInput({ currentStatus: 'need_user_decision' }))

            expect(result.steps).toHaveLength(2)
            expect(result.steps[0].status).toBe('in_progress')
            expect(result.steps[0].events[0].type).toBe('revision_started')
            expect(result.steps[1].status).toBe('submitted_for_review')
        })
    })

    describe('failed path: 2 steps', () => {
        it('returns in_progress → submitted_for_review with task_started event', async () => {
            vi.mocked(runHermesGatewayTask).mockResolvedValue({
                output: 'Retried successfully',
                runId: 'run-400',
                sessionId: 'agent-room-sess-1-task-1',
            })

            const runtime = new GatewayHermesRuntime('http://127.0.0.1:8642', null, 30000)
            const result = await runtime.runTask(makeInput({ currentStatus: 'failed' }))

            expect(result.steps).toHaveLength(2)
            expect(result.steps[0].status).toBe('in_progress')
            expect(result.steps[0].events[0].type).toBe('task_started')
            expect(result.steps[1].status).toBe('submitted_for_review')
        })
    })

    describe('run.failed rollback', () => {
        it('throws when runHermesGatewayTask rejects (run.failed)', async () => {
            vi.mocked(runHermesGatewayTask).mockRejectedValue(new Error('Hermes Gateway run failed'))

            const runtime = new GatewayHermesRuntime('http://127.0.0.1:8642', null, 30000)
            await expect(runtime.runTask(makeInput())).rejects.toThrow('Hermes Gateway run failed')
        })

        it('throws when runHermesGatewayTask rejects with timeout', async () => {
            vi.mocked(runHermesGatewayTask).mockRejectedValue(new Error('Hermes Gateway run timed out after 30000ms'))

            const runtime = new GatewayHermesRuntime('http://127.0.0.1:8642', null, 30000)
            await expect(runtime.runTask(makeInput())).rejects.toThrow(/timed out/)
        })
    })

    describe('output mapping', () => {
        it('final output text appears in submitted_for_review message', async () => {
            vi.mocked(runHermesGatewayTask).mockResolvedValue({
                output: 'The login page has been implemented with OAuth2 support.',
                runId: 'run-500',
                sessionId: 'agent-room-sess-1-task-1',
            })

            const runtime = new GatewayHermesRuntime('http://127.0.0.1:8642', null, 30000)
            const result = await runtime.runTask(makeInput())

            const finalStep = result.steps[result.steps.length - 1]
            expect(finalStep.messages![0].content).toBe('The login page has been implemented with OAuth2 support.')
        })

        it('artifact name is sanitized taskTitle + .md', async () => {
            vi.mocked(runHermesGatewayTask).mockResolvedValue({
                output: 'Done',
                runId: 'run-600',
                sessionId: 'agent-room-sess-1-task-1',
            })

            const runtime = new GatewayHermesRuntime('http://127.0.0.1:8642', null, 30000)
            const result = await runtime.runTask(makeInput({ taskTitle: 'Fix bug #123!' }))

            expect(result.artifacts![0].name).toBe('Fix_bug__123_.md')
        })

        it('every step with messages has senderRole, senderId, senderName', async () => {
            vi.mocked(runHermesGatewayTask).mockResolvedValue({
                output: 'Done',
                runId: 'run-700',
                sessionId: 'agent-room-sess-1-task-1',
            })

            const runtime = new GatewayHermesRuntime('http://127.0.0.1:8642', null, 30000)
            const result = await runtime.runTask(makeInput())

            for (const step of result.steps) {
                if (step.messages) {
                    for (const msg of step.messages) {
                        expect(msg.senderRole).toBeDefined()
                        expect(msg.senderId).toBeDefined()
                        expect(msg.senderName).toBeDefined()
                    }
                }
            }
        })

        it('every step has events array with type and agentRole', async () => {
            vi.mocked(runHermesGatewayTask).mockResolvedValue({
                output: 'Done',
                runId: 'run-800',
                sessionId: 'agent-room-sess-1-task-1',
            })

            const runtime = new GatewayHermesRuntime('http://127.0.0.1:8642', null, 30000)
            const result = await runtime.runTask(makeInput())

            for (const step of result.steps) {
                expect(step.events).toBeDefined()
                expect(step.events.length).toBeGreaterThan(0)
                for (const event of step.events) {
                    expect(event.type).toBeDefined()
                    expect(event.agentRole).toBeDefined()
                }
            }
        })
    })

    describe('unsupported status rejection', () => {
        it('throws on submitted_for_review status before calling Gateway', async () => {
            const runtime = new GatewayHermesRuntime('http://127.0.0.1:8642', null, 30000)
            await expect(
                runtime.runTask(makeInput({ currentStatus: 'submitted_for_review' })),
            ).rejects.toThrow(/Unsupported AgentRoom task status/)
            expect(runHermesGatewayTask).not.toHaveBeenCalled()
        })

        it('throws on completed status before calling Gateway', async () => {
            const runtime = new GatewayHermesRuntime('http://127.0.0.1:8642', null, 30000)
            await expect(
                runtime.runTask(makeInput({ currentStatus: 'completed' })),
            ).rejects.toThrow(/Unsupported AgentRoom task status/)
            expect(runHermesGatewayTask).not.toHaveBeenCalled()
        })

        it('throws on delivering status before calling Gateway', async () => {
            const runtime = new GatewayHermesRuntime('http://127.0.0.1:8642', null, 30000)
            await expect(
                runtime.runTask(makeInput({ currentStatus: 'delivering' })),
            ).rejects.toThrow(/Unsupported AgentRoom task status/)
            expect(runHermesGatewayTask).not.toHaveBeenCalled()
        })

        it('throws on in_progress status before calling Gateway', async () => {
            const runtime = new GatewayHermesRuntime('http://127.0.0.1:8642', null, 30000)
            await expect(
                runtime.runTask(makeInput({ currentStatus: 'in_progress' })),
            ).rejects.toThrow(/Unsupported AgentRoom task status/)
            expect(runHermesGatewayTask).not.toHaveBeenCalled()
        })
    })

    describe('timeout validation', () => {
        it('throws on NaN timeoutMs from env', () => {
            const original = process.env.HERMES_AGENT_TIMEOUT_MS
            try {
                process.env.HERMES_AGENT_TIMEOUT_MS = 'abc'
                expect(() => new GatewayHermesRuntime('http://127.0.0.1:8642', null)).toThrow(/Invalid HERMES_AGENT_TIMEOUT_MS/)
            } finally {
                if (original === undefined) {
                    delete process.env.HERMES_AGENT_TIMEOUT_MS
                } else {
                    process.env.HERMES_AGENT_TIMEOUT_MS = original
                }
            }
        })

        it('throws on zero timeoutMs', () => {
            expect(() => new GatewayHermesRuntime('http://127.0.0.1:8642', null, 0)).toThrow(/Invalid timeoutMs/)
        })

        it('throws on negative timeoutMs', () => {
            expect(() => new GatewayHermesRuntime('http://127.0.0.1:8642', null, -1000)).toThrow(/Invalid timeoutMs/)
        })
    })

    describe('extractGatewayOutput', () => {
        it('extracts from event.output', async () => {
            const { extractGatewayOutput } = await import('../../packages/server/src/services/hermes/gateway-run-client')
            expect(extractGatewayOutput({ output: 'hello' })).toBe('hello')
        })

        it('extracts from event.data.output', async () => {
            const { extractGatewayOutput } = await import('../../packages/server/src/services/hermes/gateway-run-client')
            expect(extractGatewayOutput({ data: { output: 'nested' } })).toBe('nested')
        })

        it('extracts from event.result.output', async () => {
            const { extractGatewayOutput } = await import('../../packages/server/src/services/hermes/gateway-run-client')
            expect(extractGatewayOutput({ result: { output: 'from result' } })).toBe('from result')
        })

        it('extracts from event.message.content', async () => {
            const { extractGatewayOutput } = await import('../../packages/server/src/services/hermes/gateway-run-client')
            expect(extractGatewayOutput({ message: { content: 'from message' } })).toBe('from message')
        })

        it('returns null for empty/missing output', async () => {
            const { extractGatewayOutput } = await import('../../packages/server/src/services/hermes/gateway-run-client')
            expect(extractGatewayOutput({})).toBeNull()
            expect(extractGatewayOutput({ output: '' })).toBeNull()
            expect(extractGatewayOutput({ output: '   ' })).toBeNull()
        })
    })

    describe('profile resolver', () => {
        it('uses resolver-returned upstream/apiKey/model/provider', async () => {
            vi.mocked(runHermesGatewayTask).mockResolvedValue({
                output: 'done',
                runId: 'run-resolved',
                sessionId: 'agent-room-sess-1-task-1',
            })

            const resolver = vi.fn(() => ({
                upstream: 'http://profile-gateway:9999',
                apiKey: 'sk-profile-key',
                model: 'claude-sonnet-4-20250514',
                provider: 'anthropic',
            }))

            const runtime = new GatewayHermesRuntime('http://127.0.0.1:8642', null, 30000, resolver)
            await runtime.runTask(makeInput())

            // Resolver is now DB-free: called with (profileName, fallbackUpstream, fallbackApiKey)
            // profileName is resolved from roleBindings (none in makeInput) → falls back to assignedAgentId
            expect(resolver).toHaveBeenCalledWith('dev-agent', 'http://127.0.0.1:8642', null)

            const call = vi.mocked(runHermesGatewayTask).mock.calls[0][0]
            expect(call.upstream).toBe('http://profile-gateway:9999')
            expect(call.apiKey).toBe('sk-profile-key')
            expect(call.model).toBe('claude-sonnet-4-20250514')
            expect(call.provider).toBe('anthropic')
        })

        it('passes assignedAgentId as profileName to resolver when no roleBindings', async () => {
            vi.mocked(runHermesGatewayTask).mockResolvedValue({
                output: 'done',
                runId: 'run-1',
                sessionId: 'agent-room-sess-1-task-1',
            })

            const resolver = vi.fn(() => ({
                upstream: 'http://127.0.0.1:8642',
                apiKey: null,
            }))

            const runtime = new GatewayHermesRuntime('http://127.0.0.1:8642', null, 30000, resolver)
            await runtime.runTask(makeInput({ assignedAgentId: 'my-agent' }))

            expect(resolver).toHaveBeenCalledWith('my-agent', 'http://127.0.0.1:8642', null)
        })

        it('uses roleBindings developer profileName over assignedAgentId', async () => {
            vi.mocked(runHermesGatewayTask).mockResolvedValue({
                output: 'done',
                runId: 'run-rb',
                sessionId: 'agent-room-sess-1-task-1',
            })

            const resolver = vi.fn(() => ({
                upstream: 'http://127.0.0.1:8642',
                apiKey: null,
                model: 'gpt-4o',
                provider: 'openai',
                transportSource: 'gateway-manager' as const,
            }))

            const roleBindings = new Map([
                ['developer' as const, { role: 'developer' as const, profileName: 'custom-dev-profile' }],
            ])

            const runtime = new GatewayHermesRuntime('http://127.0.0.1:8642', null, 30000, resolver)
            const result = await runtime.runTask(makeInput({ roleBindings }))

            // profileName comes from roleBindings, not resolver
            expect(resolver).toHaveBeenCalledWith('custom-dev-profile', 'http://127.0.0.1:8642', null)
            expect(result.artifacts![0].metadata).toEqual({
                runId: 'run-rb',
                source: 'hermes-gateway',
                profileName: 'custom-dev-profile',
                model: 'gpt-4o',
                provider: 'openai',
                bindingSource: 'role-binding',
                transportSource: 'gateway-manager',
                roleBindings: { developer: 'custom-dev-profile' },
            })
        })

        it('includes profileName/model/provider/bindingSource/transportSource in artifact metadata', async () => {
            vi.mocked(runHermesGatewayTask).mockResolvedValue({
                output: 'done',
                runId: 'run-meta',
                sessionId: 'agent-room-sess-1-task-1',
            })

            const resolver = () => ({
                upstream: 'http://127.0.0.1:8642',
                apiKey: null,
                model: 'gpt-4o',
                provider: 'openai',
                transportSource: 'gateway-manager' as const,
            })

            const runtime = new GatewayHermesRuntime('http://127.0.0.1:8642', null, 30000, resolver)
            const result = await runtime.runTask(makeInput())

            // profileName comes from runtime's assignedAgentId fallback (no roleBindings in makeInput)
            expect(result.artifacts![0].metadata).toEqual({
                runId: 'run-meta',
                source: 'hermes-gateway',
                profileName: 'dev-agent',
                model: 'gpt-4o',
                provider: 'openai',
                bindingSource: 'assigned-agent',
                transportSource: 'gateway-manager',
            })
        })

        it('apiKey never appears in metadata', async () => {
            vi.mocked(runHermesGatewayTask).mockResolvedValue({
                output: 'done',
                runId: 'run-no-key',
                sessionId: 'agent-room-sess-1-task-1',
            })

            const resolver = () => ({
                upstream: 'http://127.0.0.1:8642',
                apiKey: 'sk-secret-123',
                transportSource: 'gateway-manager' as const,
            })

            const runtime = new GatewayHermesRuntime('http://127.0.0.1:8642', null, 30000, resolver)
            const result = await runtime.runTask(makeInput())

            const metadata = result.artifacts![0].metadata as Record<string, unknown>
            expect(metadata.apiKey).toBeUndefined()
            expect(JSON.stringify(metadata)).not.toContain('sk-secret-123')
        })

        it('fallback resolver returns bindingSource=assigned-agent and transportSource=constructor-fallback', async () => {
            vi.mocked(runHermesGatewayTask).mockResolvedValue({
                output: 'done',
                runId: 'run-fb',
                sessionId: 'agent-room-sess-1-task-1',
            })

            const runtime = new GatewayHermesRuntime('http://127.0.0.1:8642', null, 30000)
            const result = await runtime.runTask(makeInput())

            expect(result.artifacts![0].metadata).toEqual(expect.objectContaining({
                runId: 'run-fb',
                source: 'hermes-gateway',
                profileName: 'dev-agent',
                bindingSource: 'assigned-agent',
                transportSource: 'constructor-fallback',
            }))
        })

        it('resolver error propagates and produces no steps', async () => {
            const resolver = () => {
                throw new Error('profile not found')
            }

            const runtime = new GatewayHermesRuntime('http://127.0.0.1:8642', null, 30000, resolver)
            await expect(runtime.runTask(makeInput())).rejects.toThrow('profile not found')
            expect(runHermesGatewayTask).not.toHaveBeenCalled()
        })

        it('fails fast before gateway call when provider cannot be resolved', async () => {
            const resolver = vi.fn(() => ({
                upstream: 'http://127.0.0.1:8642',
                apiKey: null,
                transportSource: 'constructor-fallback' as const,
            }))

            const runtime = new GatewayHermesRuntime('http://127.0.0.1:8642', null, 30000, resolver)
            await expect(runtime.runTask(makeInput({
                roleBindings: new Map([
                    ['developer' as const, { role: 'developer' as const, profileName: 'glm', model: 'totally-unknown-model-xyz' }],
                ]),
            }))).rejects.toThrow(/Agent Room model resolution failed/)
            expect(runHermesGatewayTask).not.toHaveBeenCalled()
        })

        it('no resolver uses default fallback (constructor upstream/apiKey)', async () => {
            vi.mocked(runHermesGatewayTask).mockResolvedValue({
                output: 'done',
                runId: 'run-fallback',
                sessionId: 'agent-room-sess-1-task-1',
            })

            // No resolver passed — uses createDefaultGatewayProfileResolver()
            const runtime = new GatewayHermesRuntime('http://127.0.0.1:8642', 'sk-fallback', 30000)
            await runtime.runTask(makeInput({ assignedAgentId: undefined }))

            const call = vi.mocked(runHermesGatewayTask).mock.calls[0][0]
            expect(call.upstream).toBe('http://127.0.0.1:8642')
            expect(call.apiKey).toBe('sk-fallback')
        })
    })
})
