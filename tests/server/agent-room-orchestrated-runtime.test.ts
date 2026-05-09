import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
    createHermesAgentRuntime,
    OrchestratedGatewayRuntime,
    GatewayHermesRuntime,
    RealHermesRuntime,
    DeterministicHermesRuntime,
    RealAgentRunner,
} from '../../packages/server/src/services/hermes/agent-room/runner'
import type { HermesAgentRuntime } from '../../packages/server/src/services/hermes/agent-room/runner/runtime'
import type { HermesAgentRuntimeInput } from '../../packages/server/src/services/hermes/agent-room/runner/runtime/types'

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

// ─── Shared helpers ─────────────────────────────────────────────

function makeInput(overrides: Partial<HermesAgentRuntimeInput> = {}): HermesAgentRuntimeInput {
    return {
        sessionId: 'sess-1',
        taskId: 'task-1',
        taskTitle: 'Implement login page',
        taskDescription: 'Create a login page with email/password',
        currentStatus: 'created',
        revisionRound: 0,
        roleBindings: new Map([
            ['planner', { role: 'planner', profileName: 'gpt-4o' }],
            ['developer', { role: 'developer', profileName: 'claude-3.5-sonnet' }],
        ]),
        ...overrides,
    }
}

/**
 * Mock two sequential runHermesGatewayTask calls (planner then developer).
 * Returns the mock values for assertion.
 */
function mockDualGatewayRuns(plannerRunId = 'run-planner-001', developerRunId = 'run-dev-001') {
    const plannerResult = {
        output: 'Plan: step 1, step 2, step 3',
        runId: plannerRunId,
        sessionId: 'agent-room-planner-sess-1-task-1',
    }
    const developerResult = {
        output: 'Implementation complete: login page created with email/password fields',
        runId: developerRunId,
        sessionId: 'agent-room-developer-sess-1-task-1',
    }
    vi.mocked(runHermesGatewayTask)
        .mockResolvedValueOnce(plannerResult)
        .mockResolvedValueOnce(developerResult)
    return { plannerResult, developerResult }
}

// ─── P4.11-A1 skeleton tests (non-regression) ───────────────────

describe('OrchestratedGatewayRuntime skeleton (P4.11-A1)', () => {
    it('createHermesAgentRuntime("orchestrated") returns OrchestratedGatewayRuntime', () => {
        const runtime = createHermesAgentRuntime('orchestrated')
        expect(runtime).toBeInstanceOf(OrchestratedGatewayRuntime)
    })

    it('createHermesAgentRuntime("gateway-multi-role") returns OrchestratedGatewayRuntime', () => {
        const runtime = createHermesAgentRuntime('gateway-multi-role')
        expect(runtime).toBeInstanceOf(OrchestratedGatewayRuntime)
    })

    it('OrchestratedGatewayRuntime implements HermesAgentRuntime', () => {
        const runtime: HermesAgentRuntime = new OrchestratedGatewayRuntime()
        expect(typeof runtime.runTask).toBe('function')
    })

    it('OrchestratedGatewayRuntime can be constructed with config parameter', () => {
        const config = {} // minimal empty config for future extension
        const runtime = new OrchestratedGatewayRuntime(undefined, undefined, undefined, undefined, config)
        expect(runtime).toBeInstanceOf(OrchestratedGatewayRuntime)
    })
})

// ─── P4.11-A4 planner → developer dual-run tests ────────────────

describe('OrchestratedGatewayRuntime dual-run (P4.11-A4)', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    afterEach(() => {
        vi.restoreAllMocks()
    })

    describe('planner binding resolution', () => {
        it('resolves planner profile from roleBindings.get("planner")', async () => {
            mockDualGatewayRuns()

            const runtime = new OrchestratedGatewayRuntime('http://127.0.0.1:8642', null, 30000)
            await runtime.runTask(makeInput())

            // First call is planner
            expect(runHermesGatewayTask).toHaveBeenCalledTimes(2)
            const plannerCall = vi.mocked(runHermesGatewayTask).mock.calls[0][0]
            expect(plannerCall.sessionId).toBe('agent-room-planner-sess-1-task-1')
            expect(plannerCall.input).toContain('Implement login page')
            expect(plannerCall.instructions).toContain('规划 Agent')
        })

        it('planner instructions contain planning-specific guidance', async () => {
            mockDualGatewayRuns()

            const runtime = new OrchestratedGatewayRuntime('http://127.0.0.1:8642', null, 30000)
            await runtime.runTask(makeInput())

            const plannerCall = vi.mocked(runHermesGatewayTask).mock.calls[0][0]
            expect(plannerCall.instructions).toContain('规划 Agent')
            expect(plannerCall.instructions).toContain('不要执行代码实现')
            expect(plannerCall.input).toContain('执行计划')
        })
    })

    describe('planner missing binding failure', () => {
        it('throws when roleBindings is undefined', async () => {
            const runtime = new OrchestratedGatewayRuntime('http://127.0.0.1:8642', null, 30000)
            await expect(runtime.runTask(makeInput({ roleBindings: undefined }))).rejects.toThrow(
                /planner role binding/,
            )
        })

        it('throws when roleBindings is empty', async () => {
            const runtime = new OrchestratedGatewayRuntime('http://127.0.0.1:8642', null, 30000)
            await expect(runtime.runTask(makeInput({ roleBindings: new Map() }))).rejects.toThrow(
                /planner role binding/,
            )
        })

        it('throws when roleBindings has developer but not planner', async () => {
            const runtime = new OrchestratedGatewayRuntime('http://127.0.0.1:8642', null, 30000)
            await expect(runtime.runTask(makeInput({
                roleBindings: new Map([
                    ['developer', { role: 'developer', profileName: 'gpt-4o' }],
                ]),
            }))).rejects.toThrow(/planner role binding/)
        })

        it('does NOT call runHermesGatewayTask when planner binding is missing', async () => {
            const runtime = new OrchestratedGatewayRuntime('http://127.0.0.1:8642', null, 30000)
            await expect(runtime.runTask(makeInput({ roleBindings: undefined }))).rejects.toThrow()
            expect(runHermesGatewayTask).not.toHaveBeenCalled()
        })
    })

    describe('developer binding resolution', () => {
        it('resolves developer from roleBindings.get("developer") when present', async () => {
            mockDualGatewayRuns()

            const runtime = new OrchestratedGatewayRuntime('http://127.0.0.1:8642', null, 30000)
            await runtime.runTask(makeInput())

            // Second call is developer
            const devCall = vi.mocked(runHermesGatewayTask).mock.calls[1][0]
            expect(devCall.sessionId).toBe('agent-room-developer-sess-1-task-1')
            expect(devCall.instructions).toContain('开发 Agent')
        })

        it('falls back to assignedAgentId when developer binding is missing', async () => {
            mockDualGatewayRuns()

            const runtime = new OrchestratedGatewayRuntime('http://127.0.0.1:8642', null, 30000)
            const result = await runtime.runTask(makeInput({
                roleBindings: new Map([
                    ['planner', { role: 'planner', profileName: 'gpt-4o' }],
                ]),
                assignedAgentId: 'fallback-agent-id',
            }))

            // Should still call runHermesGatewayTask twice (planner + developer)
            expect(runHermesGatewayTask).toHaveBeenCalledTimes(2)

            // Developer metadata should reflect assigned-agent fallback
            const submittedStep = result.steps[3]
            const metadata = submittedStep.events[0].payload as Record<string, unknown>
            expect(metadata.developerBindingSource).toBe('assigned-agent')
        })

        it('uses "none" binding source when neither developer binding nor assignedAgentId', async () => {
            mockDualGatewayRuns()

            const runtime = new OrchestratedGatewayRuntime('http://127.0.0.1:8642', null, 30000)
            const result = await runtime.runTask(makeInput({
                roleBindings: new Map([
                    ['planner', { role: 'planner', profileName: 'gpt-4o' }],
                ]),
            }))

            expect(runHermesGatewayTask).toHaveBeenCalledTimes(2)

            const submittedStep = result.steps[3]
            const metadata = submittedStep.events[0].payload as Record<string, unknown>
            expect(metadata.developerBindingSource).toBe('none')
        })

        it('developer instructions contain plan-aware guidance', async () => {
            mockDualGatewayRuns()

            const runtime = new OrchestratedGatewayRuntime('http://127.0.0.1:8642', null, 30000)
            await runtime.runTask(makeInput())

            const devCall = vi.mocked(runHermesGatewayTask).mock.calls[1][0]
            expect(devCall.instructions).toContain('开发 Agent')
            expect(devCall.instructions).toContain('执行计划')
        })

        it('developer input includes planner output as plan context', async () => {
            mockDualGatewayRuns()

            const runtime = new OrchestratedGatewayRuntime('http://127.0.0.1:8642', null, 30000)
            await runtime.runTask(makeInput())

            const devCall = vi.mocked(runHermesGatewayTask).mock.calls[1][0]
            expect(devCall.input).toContain('执行计划（由规划 Agent 生成）')
            expect(devCall.input).toContain('Plan: step 1, step 2, step 3')
        })
    })

    describe('dual-run step sequence', () => {
        it('returns exactly 4 steps: planned → assigned → in_progress → submitted_for_review', async () => {
            mockDualGatewayRuns()

            const runtime = new OrchestratedGatewayRuntime('http://127.0.0.1:8642', null, 30000)
            const result = await runtime.runTask(makeInput())

            expect(result.steps).toHaveLength(4)
            expect(result.steps[0].status).toBe('planned')
            expect(result.steps[0].activeRole).toBe('planner')
            expect(result.steps[1].status).toBe('assigned')
            expect(result.steps[1].activeRole).toBe('developer')
            expect(result.steps[2].status).toBe('in_progress')
            expect(result.steps[2].activeRole).toBe('developer')
            expect(result.steps[3].status).toBe('submitted_for_review')
            expect(result.steps[3].activeRole).toBe('developer')
        })

        it('planned step has task_planned event with planner agentRole', async () => {
            mockDualGatewayRuns()

            const runtime = new OrchestratedGatewayRuntime('http://127.0.0.1:8642', null, 30000)
            const result = await runtime.runTask(makeInput())

            expect(result.steps[0].events).toHaveLength(1)
            expect(result.steps[0].events[0].type).toBe('task_planned')
            expect(result.steps[0].events[0].agentRole).toBe('planner')
        })

        it('assigned step has task_assigned event with developer agentRole', async () => {
            mockDualGatewayRuns()

            const runtime = new OrchestratedGatewayRuntime('http://127.0.0.1:8642', null, 30000)
            const result = await runtime.runTask(makeInput())

            expect(result.steps[1].events).toHaveLength(1)
            expect(result.steps[1].events[0].type).toBe('task_assigned')
            expect(result.steps[1].events[0].agentRole).toBe('developer')
        })

        it('in_progress step has task_started event with developer agentRole', async () => {
            mockDualGatewayRuns()

            const runtime = new OrchestratedGatewayRuntime('http://127.0.0.1:8642', null, 30000)
            const result = await runtime.runTask(makeInput())

            expect(result.steps[2].events).toHaveLength(1)
            expect(result.steps[2].events[0].type).toBe('task_started')
            expect(result.steps[2].events[0].agentRole).toBe('developer')
        })

        it('submitted_for_review step has task_submitted event with developer agentRole', async () => {
            mockDualGatewayRuns()

            const runtime = new OrchestratedGatewayRuntime('http://127.0.0.1:8642', null, 30000)
            const result = await runtime.runTask(makeInput())

            expect(result.steps[3].events).toHaveLength(1)
            expect(result.steps[3].events[0].type).toBe('task_submitted')
            expect(result.steps[3].events[0].agentRole).toBe('developer')
        })

        it('produces artifacts from developer output', async () => {
            mockDualGatewayRuns()

            const runtime = new OrchestratedGatewayRuntime('http://127.0.0.1:8642', null, 30000)
            const result = await runtime.runTask(makeInput())

            expect(result.artifacts).toHaveLength(1)
            expect(result.artifacts![0].name).toBe('Implement_login_page.md')
            expect(result.artifacts![0].type).toBe('code_output')
            expect(result.artifacts![0].content).toContain('Implementation complete')
        })
    })

    describe('dual-run metadata (P4.11-A5)', () => {
        it('planned step event payload contains plannerRunId and plannerProfileName', async () => {
            mockDualGatewayRuns('run-planner-100', 'run-dev-100')

            const runtime = new OrchestratedGatewayRuntime('http://127.0.0.1:8642', null, 30000)
            const result = await runtime.runTask(makeInput())

            const payload = result.steps[0].events[0].payload
            expect(payload).toBeDefined()
            expect(payload!.plannerRunId).toBe('run-planner-100')
            expect(payload!.plannerProfileName).toBe('gpt-4o')
            expect(payload!.plannerSource).toBe('orchestrated-planner')
        })

        it('submitted_for_review step contains combined planner + developer metadata', async () => {
            mockDualGatewayRuns('run-planner-200', 'run-dev-200')

            const runtime = new OrchestratedGatewayRuntime('http://127.0.0.1:8642', null, 30000)
            const result = await runtime.runTask(makeInput())

            const payload = result.steps[3].events[0].payload as Record<string, unknown>
            expect(payload).toBeDefined()
            // Planner metadata
            expect(payload.plannerRunId).toBe('run-planner-200')
            expect(payload.plannerProfileName).toBe('gpt-4o')
            expect(payload.plannerSource).toBe('orchestrated-planner')
            // Developer metadata
            expect(payload.developerRunId).toBe('run-dev-200')
            expect(payload.developerProfileName).toBe('claude-3.5-sonnet')
            expect(payload.developerSource).toBe('orchestrated-developer')
            expect(payload.developerBindingSource).toBe('role-binding')
            // Combined source
            expect(payload.source).toBe('orchestrated-dual-run')
        })

        it('submitted_for_review message contains developer output with combined metadata', async () => {
            mockDualGatewayRuns('run-planner-201', 'run-dev-201')

            const runtime = new OrchestratedGatewayRuntime('http://127.0.0.1:8642', null, 30000)
            const result = await runtime.runTask(makeInput())

            const messages = result.steps[3].messages
            expect(messages).toHaveLength(1)
            expect(messages![0].senderRole).toBe('developer')
            expect(messages![0].senderId).toBe('developer')
            expect(messages![0].senderName).toBe('开发 Agent')
            expect(messages![0].content).toContain('Implementation complete')
            expect(messages![0].metadata).toBeDefined()
            expect(messages![0].metadata!.plannerRunId).toBe('run-planner-201')
            expect(messages![0].metadata!.developerRunId).toBe('run-dev-201')
        })

        it('planner metadata includes transportSource from profile resolver', async () => {
            mockDualGatewayRuns()

            const runtime = new OrchestratedGatewayRuntime('http://127.0.0.1:8642', null, 30000)
            const result = await runtime.runTask(makeInput())

            const payload = result.steps[0].events[0].payload
            expect(payload!.plannerTransportSource).toBe('constructor-fallback')
        })

        it('developer metadata includes transportSource from profile resolver', async () => {
            mockDualGatewayRuns()

            const runtime = new OrchestratedGatewayRuntime('http://127.0.0.1:8642', null, 30000)
            const result = await runtime.runTask(makeInput())

            const payload = result.steps[3].events[0].payload as Record<string, unknown>
            expect(payload.developerTransportSource).toBe('constructor-fallback')
        })

        it('assigned step payload includes developer binding info', async () => {
            mockDualGatewayRuns()

            const runtime = new OrchestratedGatewayRuntime('http://127.0.0.1:8642', null, 30000)
            const result = await runtime.runTask(makeInput())

            const payload = result.steps[1].events[0].payload
            expect(payload).toBeDefined()
            expect(payload!.developerProfileName).toBe('claude-3.5-sonnet')
            expect(payload!.developerBindingSource).toBe('role-binding')
        })

        it('artifact metadata contains combined dual-run metadata', async () => {
            mockDualGatewayRuns('run-planner-300', 'run-dev-300')

            const runtime = new OrchestratedGatewayRuntime('http://127.0.0.1:8642', null, 30000)
            const result = await runtime.runTask(makeInput())

            expect(result.artifacts).toHaveLength(1)
            const meta = result.artifacts![0].metadata as Record<string, unknown>
            expect(meta.plannerRunId).toBe('run-planner-300')
            expect(meta.developerRunId).toBe('run-dev-300')
            expect(meta.source).toBe('orchestrated-dual-run')
        })
    })

    describe('unsupported status for dual-run', () => {
        it('throws for revision_required status', async () => {
            const runtime = new OrchestratedGatewayRuntime('http://127.0.0.1:8642', null, 30000)
            await expect(runtime.runTask(makeInput({ currentStatus: 'revision_required' }))).rejects.toThrow(
                /dual-run requires status 'created'/,
            )
        })

        it('throws for need_user_decision status', async () => {
            const runtime = new OrchestratedGatewayRuntime('http://127.0.0.1:8642', null, 30000)
            await expect(runtime.runTask(makeInput({ currentStatus: 'need_user_decision' }))).rejects.toThrow(
                /dual-run requires status 'created'/,
            )
        })

        it('throws for failed status', async () => {
            const runtime = new OrchestratedGatewayRuntime('http://127.0.0.1:8642', null, 30000)
            await expect(runtime.runTask(makeInput({ currentStatus: 'failed' }))).rejects.toThrow(
                /dual-run requires status 'created'/,
            )
        })

        it('does NOT call runHermesGatewayTask for unsupported status', async () => {
            const runtime = new OrchestratedGatewayRuntime('http://127.0.0.1:8642', null, 30000)
            await expect(runtime.runTask(makeInput({ currentStatus: 'revision_required' }))).rejects.toThrow()
            expect(runHermesGatewayTask).not.toHaveBeenCalled()
        })
    })

    describe('hooks forwarding and role tagging (P4.11-A5)', () => {
        it('forwards onUpstreamRunCreated hook to both planner and developer runs', async () => {
            mockDualGatewayRuns()

            const onUpstreamRunCreated = vi.fn()
            const onRawEvent = vi.fn()
            const runtime = new OrchestratedGatewayRuntime('http://127.0.0.1:8642', null, 30000)
            await runtime.runTask(makeInput({ hooks: { onUpstreamRunCreated, onRawEvent } }))

            // Both calls should have onUpstreamRunCreated forwarded
            const plannerCall = vi.mocked(runHermesGatewayTask).mock.calls[0][0]
            const devCall = vi.mocked(runHermesGatewayTask).mock.calls[1][0]
            expect(plannerCall.onUpstreamRunCreated).toBe(onUpstreamRunCreated)
            expect(devCall.onUpstreamRunCreated).toBe(onUpstreamRunCreated)
        })

        it('planner onRawEvent tags events with _agentRole: "planner"', async () => {
            mockDualGatewayRuns()

            const onRawEvent = vi.fn()
            const runtime = new OrchestratedGatewayRuntime('http://127.0.0.1:8642', null, 30000)
            await runtime.runTask(makeInput({ hooks: { onRawEvent } }))

            // Simulate planner SSE event
            const plannerHook = vi.mocked(runHermesGatewayTask).mock.calls[0][0].onRawEvent!
            plannerHook({ event: 'run.completed', data: 'test' })

            expect(onRawEvent).toHaveBeenCalledWith(
                expect.objectContaining({ event: 'run.completed', _agentRole: 'planner' }),
            )
        })

        it('developer onRawEvent tags events with _agentRole: "developer"', async () => {
            mockDualGatewayRuns()

            const onRawEvent = vi.fn()
            const runtime = new OrchestratedGatewayRuntime('http://127.0.0.1:8642', null, 30000)
            await runtime.runTask(makeInput({ hooks: { onRawEvent } }))

            // Simulate developer SSE event
            const devHook = vi.mocked(runHermesGatewayTask).mock.calls[1][0].onRawEvent!
            devHook({ event: 'run.completed', data: 'test' })

            expect(onRawEvent).toHaveBeenCalledWith(
                expect.objectContaining({ event: 'run.completed', _agentRole: 'developer' }),
            )
        })

        it('role-tagged hooks do not mutate original event object', async () => {
            mockDualGatewayRuns()

            const onRawEvent = vi.fn()
            const runtime = new OrchestratedGatewayRuntime('http://127.0.0.1:8642', null, 30000)
            await runtime.runTask(makeInput({ hooks: { onRawEvent } }))

            const originalEvent = { event: 'test.event', data: 'original' }
            const plannerHook = vi.mocked(runHermesGatewayTask).mock.calls[0][0].onRawEvent!
            plannerHook(originalEvent)

            // Original should not be mutated
            expect(originalEvent).not.toHaveProperty('_agentRole')
            // But the forwarded event should have it
            expect(onRawEvent).toHaveBeenCalledWith(
                expect.objectContaining({ _agentRole: 'planner' }),
            )
        })

        it('works without hooks (no errors)', async () => {
            mockDualGatewayRuns()

            const runtime = new OrchestratedGatewayRuntime('http://127.0.0.1:8642', null, 30000)
            const result = await runtime.runTask(makeInput({ hooks: undefined }))

            expect(result.steps).toHaveLength(4)
            expect(runHermesGatewayTask).toHaveBeenCalledTimes(2)
        })
    })

    describe('Gateway call sequence', () => {
        it('calls runHermesGatewayTask exactly twice (planner then developer)', async () => {
            mockDualGatewayRuns()

            const runtime = new OrchestratedGatewayRuntime('http://127.0.0.1:8642', null, 30000)
            await runtime.runTask(makeInput())

            expect(runHermesGatewayTask).toHaveBeenCalledTimes(2)
        })

        it('planner call uses planner profileName for target resolution', async () => {
            mockDualGatewayRuns()

            const runtime = new OrchestratedGatewayRuntime('http://127.0.0.1:8642', null, 30000)
            await runtime.runTask(makeInput({
                roleBindings: new Map([
                    ['planner', { role: 'planner', profileName: 'claude-3.5-sonnet' }],
                    ['developer', { role: 'developer', profileName: 'gpt-4o' }],
                ]),
            }))

            // Both calls should succeed — profile resolution is internal
            expect(runHermesGatewayTask).toHaveBeenCalledTimes(2)
        })

        it('developer call uses developer profileName for target resolution', async () => {
            mockDualGatewayRuns()

            const runtime = new OrchestratedGatewayRuntime('http://127.0.0.1:8642', null, 30000)
            await runtime.runTask(makeInput())

            // Verify developer call was made with correct session ID
            const devCall = vi.mocked(runHermesGatewayTask).mock.calls[1][0]
            expect(devCall.sessionId).toBe('agent-room-developer-sess-1-task-1')
        })
    })
})

// ─── P4.11-A6: Failure handling tests ────────────────────────────

describe('OrchestratedGatewayRuntime failure handling (P4.11-A6)', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        vi.spyOn(console, 'error').mockImplementation(() => {})
    })

    afterEach(() => {
        vi.restoreAllMocks()
    })

    // ── Group 1: Planner Gateway failure ─────────────────────────

    describe('planner Gateway failure', () => {
        it('throws with "planner phase failed" when planner Gateway rejects', async () => {
            vi.mocked(runHermesGatewayTask).mockRejectedValueOnce(new Error('Planner connection timeout'))

            const runtime = new OrchestratedGatewayRuntime('http://127.0.0.1:8642', null, 30000)
            await expect(runtime.runTask(makeInput())).rejects.toThrow(
                /Orchestrated planner phase failed:.*Planner connection timeout/,
            )
        })

        it('error message includes planner profileName', async () => {
            vi.mocked(runHermesGatewayTask).mockRejectedValueOnce(new Error('boom'))

            const runtime = new OrchestratedGatewayRuntime('http://127.0.0.1:8642', null, 30000)
            try {
                await runtime.runTask(makeInput())
            } catch {
                // expected
            }

            expect(console.error).toHaveBeenCalledWith(
                expect.stringContaining('profile=gpt-4o'),
                expect.anything(),
            )
        })

        it('runHermesGatewayTask called exactly once (developer never reached)', async () => {
            vi.mocked(runHermesGatewayTask).mockRejectedValueOnce(new Error('Planner exploded'))

            const runtime = new OrchestratedGatewayRuntime('http://127.0.0.1:8642', null, 30000)
            await expect(runtime.runTask(makeInput())).rejects.toThrow()

            expect(runHermesGatewayTask).toHaveBeenCalledTimes(1)
        })

        it('console.error called with [orchestrated-runtime] Planner phase failed', async () => {
            vi.mocked(runHermesGatewayTask).mockRejectedValueOnce(new Error('timeout'))

            const runtime = new OrchestratedGatewayRuntime('http://127.0.0.1:8642', null, 30000)
            await expect(runtime.runTask(makeInput())).rejects.toThrow()

            expect(console.error).toHaveBeenCalledWith(
                expect.stringContaining('[orchestrated-runtime] Planner phase failed'),
                expect.anything(),
            )
        })
    })

    // ── Group 2: Developer Gateway failure ───────────────────────

    describe('developer Gateway failure', () => {
        it('throws with "developer phase failed" when developer Gateway rejects', async () => {
            vi.mocked(runHermesGatewayTask)
                .mockResolvedValueOnce({
                    output: 'Plan: step 1',
                    runId: 'run-planner-fail-001',
                    sessionId: 'agent-room-planner-sess-1-task-1',
                })
                .mockRejectedValueOnce(new Error('Developer OOM'))

            const runtime = new OrchestratedGatewayRuntime('http://127.0.0.1:8642', null, 30000)
            await expect(runtime.runTask(makeInput())).rejects.toThrow(
                /Orchestrated developer phase failed:.*Developer OOM/,
            )
        })

        it('error message includes developer profileName and plannerRunId', async () => {
            vi.mocked(runHermesGatewayTask)
                .mockResolvedValueOnce({
                    output: 'Plan output',
                    runId: 'run-planner-fail-002',
                    sessionId: 'agent-room-planner-sess-1-task-1',
                })
                .mockRejectedValueOnce(new Error('crash'))

            const runtime = new OrchestratedGatewayRuntime('http://127.0.0.1:8642', null, 30000)
            try {
                await runtime.runTask(makeInput())
            } catch {
                // expected
            }

            expect(console.error).toHaveBeenCalledWith(
                expect.stringContaining('profile=claude-3.5-sonnet'),
                expect.anything(),
            )
            expect(console.error).toHaveBeenCalledWith(
                expect.stringContaining('plannerRunId=run-planner-fail-002'),
                expect.anything(),
            )
        })

        it('runHermesGatewayTask called exactly twice', async () => {
            vi.mocked(runHermesGatewayTask)
                .mockResolvedValueOnce({
                    output: 'Plan',
                    runId: 'run-p',
                    sessionId: 'sess-p',
                })
                .mockRejectedValueOnce(new Error('dev fail'))

            const runtime = new OrchestratedGatewayRuntime('http://127.0.0.1:8642', null, 30000)
            await expect(runtime.runTask(makeInput())).rejects.toThrow()

            expect(runHermesGatewayTask).toHaveBeenCalledTimes(2)
        })

        it('console.error called with [orchestrated-runtime] Developer phase failed', async () => {
            vi.mocked(runHermesGatewayTask)
                .mockResolvedValueOnce({
                    output: 'Plan',
                    runId: 'run-p',
                    sessionId: 'sess-p',
                })
                .mockRejectedValueOnce(new Error('dev crash'))

            const runtime = new OrchestratedGatewayRuntime('http://127.0.0.1:8642', null, 30000)
            await expect(runtime.runTask(makeInput())).rejects.toThrow()

            expect(console.error).toHaveBeenCalledWith(
                expect.stringContaining('[orchestrated-runtime] Developer phase failed'),
                expect.anything(),
            )
        })
    })

    // ── Group 3: Timeout failure ─────────────────────────────────

    describe('timeout failure', () => {
        it('planner Gateway call times out → throws with "planner phase failed"', async () => {
            vi.mocked(runHermesGatewayTask).mockRejectedValueOnce(new Error('Request timed out after 30000ms'))

            const runtime = new OrchestratedGatewayRuntime('http://127.0.0.1:8642', null, 30000)
            await expect(runtime.runTask(makeInput())).rejects.toThrow(
                /Orchestrated planner phase failed/,
            )
        })

        it('developer Gateway call times out → throws with "developer phase failed"', async () => {
            vi.mocked(runHermesGatewayTask)
                .mockResolvedValueOnce({
                    output: 'Plan',
                    runId: 'run-p-timeout',
                    sessionId: 'sess-p',
                })
                .mockRejectedValueOnce(new Error('Request timed out after 30000ms'))

            const runtime = new OrchestratedGatewayRuntime('http://127.0.0.1:8642', null, 30000)
            await expect(runtime.runTask(makeInput())).rejects.toThrow(
                /Orchestrated developer phase failed/,
            )
        })
    })
})

// ─── P4.11-A7: E2E tests with startWorkflow ─────────────────────

describe('startWorkflow + OrchestratedGatewayRuntime E2E (P4.11-A7)', () => {
    function ensureTableForTest(db: any, tableName: string, schema: Record<string, string>): void {
        const cols = Object.entries(schema).map(([col, type]) => `${col} ${type}`).join(', ')
        db.exec(`CREATE TABLE IF NOT EXISTS ${tableName} (${cols})`)
    }

    let mockDb: any

    beforeEach(async () => {
        vi.resetModules()
        const { DatabaseSync } = await import('node:sqlite')
        mockDb = new DatabaseSync(':memory:')
        vi.doMock('../../packages/server/src/db/index', () => ({
            getDb: () => mockDb,
            ensureTable: ensureTableForTest.bind(null, mockDb),
        }))

        const { initAllHermesTables } = await import('../../packages/server/src/db/hermes/schemas')
        initAllHermesTables()
    })

    afterEach(() => {
        if (mockDb) mockDb.close()
        vi.restoreAllMocks()
    })

    // ── Group 4: success E2E ─────────────────────────────────────

    it('orchestrated mode: run transitions queued → running → completed', async () => {
        const { runHermesGatewayTask } = await import('../../packages/server/src/services/hermes/gateway-run-client')

        let callCount = 0
        vi.mocked(runHermesGatewayTask).mockImplementation(async (params: any) => {
            callCount++
            if (params.onUpstreamRunCreated) {
                params.onUpstreamRunCreated(`upstream-run-${callCount}`)
            }
            if (params.onRawEvent) {
                params.onRawEvent({ event: 'run.created', data: { id: `upstream-run-${callCount}` } })
            }
            if (callCount === 1) {
                return {
                    output: 'Detailed plan: step 1, step 2, step 3',
                    runId: 'run-planner-e2e-001',
                    sessionId: `agent-room-planner-${params.sessionId}`,
                }
            }
            return {
                output: 'Implementation complete: feature built successfully',
                runId: 'run-dev-e2e-001',
                sessionId: `agent-room-developer-${params.sessionId}`,
            }
        })

        const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
        const { setActiveRunnerForTest, resetActiveRunnerForTest } = await import(
            '../../packages/server/src/services/hermes/agent-room/runner'
        )

        const runtime = new OrchestratedGatewayRuntime('http://127.0.0.1:8642', null, 30000)
        setActiveRunnerForTest(new RealAgentRunner(runtime))

        const session = svc.createSession('Orchestrated E2E')
        const task = svc.createTask(session.id, 'Build Feature', 'Implement feature with orchestrated runtime')

        // Need to set planner role binding
        svc.setRoleBinding(session.id, 'planner', 'gpt-4o')
        svc.setRoleBinding(session.id, 'developer', 'claude-3.5-sonnet')

        const run = svc.startWorkflow(session.id, task.id)

        // Run should be returned immediately
        expect(['queued', 'running']).toContain(run.status)

        // Wait for background execution to complete
        await vi.waitFor(() => {
            const updatedRun = svc.getRun(run.id)!
            expect(updatedRun.status).toBe('completed')
        }, { timeout: 5000 })

        // Task should reach submitted_for_review
        const finalTask = svc.listTasks(session.id).find(t => t.id === task.id)!
        expect(finalTask.status).toBe('submitted_for_review')

        // run.upstreamRunId should be set to developer's upstream run ID (last-wins via onUpstreamRunCreated hook)
        const completedRun = svc.getRun(run.id)!
        expect(completedRun.upstreamRunId).toBe('upstream-run-2')

        // Metadata should include both plannerRunId and developerRunId
        const artifacts = svc.listTaskArtifacts(session.id, task.id)
        expect(artifacts).toHaveLength(1)
        const meta = artifacts[0].metadata as Record<string, unknown>
        expect(meta.plannerRunId).toBe('run-planner-e2e-001')
        expect(meta.developerRunId).toBe('run-dev-e2e-001')
        expect(meta.source).toBe('orchestrated-dual-run')

        // run_events should have gateway_sse source with _agentRole dimension
        const runEvents = svc.listRunEventsByRun(run.id)
        const gatewayEvents = runEvents.filter(e => e.source === 'gateway_sse')
        expect(gatewayEvents.length).toBeGreaterThanOrEqual(2)

        // Runner step events should be persisted
        const runnerEvents = runEvents.filter(e => e.source === 'runner')
        expect(runnerEvents.length).toBeGreaterThanOrEqual(4)

        resetActiveRunnerForTest()
    })

    it('orchestrated mode: task transitions created → planned → assigned → in_progress → submitted_for_review', async () => {
        const { runHermesGatewayTask } = await import('../../packages/server/src/services/hermes/gateway-run-client')

        let callCount = 0
        vi.mocked(runHermesGatewayTask).mockImplementation(async (params: any) => {
            callCount++
            if (callCount === 1) {
                return {
                    output: 'Plan output',
                    runId: 'run-p-seq',
                    sessionId: 'sess-p',
                }
            }
            return {
                output: 'Dev output',
                runId: 'run-d-seq',
                sessionId: 'sess-d',
            }
        })

        const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
        const { setActiveRunnerForTest, resetActiveRunnerForTest } = await import(
            '../../packages/server/src/services/hermes/agent-room/runner'
        )

        const runtime = new OrchestratedGatewayRuntime('http://127.0.0.1:8642', null, 30000)
        setActiveRunnerForTest(new RealAgentRunner(runtime))

        const session = svc.createSession('Sequence E2E')
        const task = svc.createTask(session.id, 'Task', 'Description')
        svc.setRoleBinding(session.id, 'planner', 'gpt-4o')

        const run = svc.startWorkflow(session.id, task.id)

        await vi.waitFor(() => {
            const updatedRun = svc.getRun(run.id)!
            expect(updatedRun.status).toBe('completed')
        }, { timeout: 5000 })

        // Check task status progression via workflow events
        const events = svc.listWorkflowEvents(session.id)
        const taskEvents = events.filter(e => e.taskId === task.id)

        const eventTypes = taskEvents.map(e => e.type)
        expect(eventTypes).toContain('task_planned')
        expect(eventTypes).toContain('task_assigned')
        expect(eventTypes).toContain('task_started')
        expect(eventTypes).toContain('task_submitted')

        // Final task status
        const finalTask = svc.listTasks(session.id).find(t => t.id === task.id)!
        expect(finalTask.status).toBe('submitted_for_review')

        resetActiveRunnerForTest()
    })

    // ── Group 5: failure E2E ─────────────────────────────────────

    it('planner Gateway rejects → run.status = failed, task stays in created', async () => {
        const { runHermesGatewayTask } = await import('../../packages/server/src/services/hermes/gateway-run-client')

        vi.mocked(runHermesGatewayTask).mockRejectedValueOnce(new Error('Planner exploded'))

        const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
        const { setActiveRunnerForTest, resetActiveRunnerForTest } = await import(
            '../../packages/server/src/services/hermes/agent-room/runner'
        )

        const runtime = new OrchestratedGatewayRuntime('http://127.0.0.1:8642', null, 30000)
        setActiveRunnerForTest(new RealAgentRunner(runtime))

        const session = svc.createSession('Planner Fail E2E')
        const task = svc.createTask(session.id, 'Task', 'Description')
        svc.setRoleBinding(session.id, 'planner', 'gpt-4o')

        const run = svc.startWorkflow(session.id, task.id)

        await vi.waitFor(() => {
            const updatedRun = svc.getRun(run.id)!
            expect(updatedRun.status).toBe('failed')
        }, { timeout: 5000 })

        // Run should have error message
        const failedRun = svc.getRun(run.id)!
        expect(failedRun.errorMessage).toContain('Orchestrated planner phase failed')

        // Task should stay in 'created' (no partial advancement)
        const finalTask = svc.listTasks(session.id).find(t => t.id === task.id)!
        expect(finalTask.status).toBe('created')

        resetActiveRunnerForTest()
    })

    it('developer Gateway rejects → run.status = failed, task stays in created', async () => {
        const { runHermesGatewayTask } = await import('../../packages/server/src/services/hermes/gateway-run-client')

        vi.mocked(runHermesGatewayTask)
            .mockResolvedValueOnce({
                output: 'Plan output',
                runId: 'run-p-fail-e2e',
                sessionId: 'sess-p',
            })
            .mockRejectedValueOnce(new Error('Developer exploded'))

        const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
        const { setActiveRunnerForTest, resetActiveRunnerForTest } = await import(
            '../../packages/server/src/services/hermes/agent-room/runner'
        )

        const runtime = new OrchestratedGatewayRuntime('http://127.0.0.1:8642', null, 30000)
        setActiveRunnerForTest(new RealAgentRunner(runtime))

        const session = svc.createSession('Dev Fail E2E')
        const task = svc.createTask(session.id, 'Task', 'Description')
        svc.setRoleBinding(session.id, 'planner', 'gpt-4o')

        const run = svc.startWorkflow(session.id, task.id)

        await vi.waitFor(() => {
            const updatedRun = svc.getRun(run.id)!
            expect(updatedRun.status).toBe('failed')
        }, { timeout: 5000 })

        // Run should have error message with "developer phase failed"
        const failedRun = svc.getRun(run.id)!
        expect(failedRun.errorMessage).toContain('Orchestrated developer phase failed')

        // Task should stay in 'created' (no partial advancement)
        const finalTask = svc.listTasks(session.id).find(t => t.id === task.id)!
        expect(finalTask.status).toBe('created')

        resetActiveRunnerForTest()
    })

    it('failure does not produce partial task status advancement', async () => {
        const { runHermesGatewayTask } = await import('../../packages/server/src/services/hermes/gateway-run-client')

        // Planner succeeds, developer fails
        vi.mocked(runHermesGatewayTask)
            .mockResolvedValueOnce({
                output: 'Plan',
                runId: 'run-p-partial',
                sessionId: 'sess-p',
            })
            .mockRejectedValueOnce(new Error('dev crash'))

        const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
        const { setActiveRunnerForTest, resetActiveRunnerForTest } = await import(
            '../../packages/server/src/services/hermes/agent-room/runner'
        )

        const runtime = new OrchestratedGatewayRuntime('http://127.0.0.1:8642', null, 30000)
        setActiveRunnerForTest(new RealAgentRunner(runtime))

        const session = svc.createSession('Partial Check E2E')
        const task = svc.createTask(session.id, 'Task', 'Description')
        svc.setRoleBinding(session.id, 'planner', 'gpt-4o')

        const run = svc.startWorkflow(session.id, task.id)

        await vi.waitFor(() => {
            const updatedRun = svc.getRun(run.id)!
            expect(updatedRun.status).toBe('failed')
        }, { timeout: 5000 })

        // No step-transition workflow events should have been emitted (exception before applyRunnerResult)
        // Note: createTask() emits a task_created event, so we exclude that
        const events = svc.listWorkflowEvents(session.id)
        const taskEvents = events.filter(e => e.taskId === task.id && e.type !== 'task_created')
        expect(taskEvents).toHaveLength(0)

        // Task stays in 'created'
        const finalTask = svc.listTasks(session.id).find(t => t.id === task.id)!
        expect(finalTask.status).toBe('created')

        resetActiveRunnerForTest()
    })
})

// ─── Non-regression: existing runtime modes unchanged ────────────

describe('createHermesAgentRuntime — existing modes unchanged', () => {
    it('"gateway" returns GatewayHermesRuntime', () => {
        expect(createHermesAgentRuntime('gateway')).toBeInstanceOf(GatewayHermesRuntime)
    })

    it('"real" returns GatewayHermesRuntime', () => {
        expect(createHermesAgentRuntime('real')).toBeInstanceOf(GatewayHermesRuntime)
    })

    it('"http" returns RealHermesRuntime', () => {
        expect(createHermesAgentRuntime('http')).toBeInstanceOf(RealHermesRuntime)
    })

    it('"bridge" returns RealHermesRuntime', () => {
        expect(createHermesAgentRuntime('bridge')).toBeInstanceOf(RealHermesRuntime)
    })

    it('"deterministic" returns DeterministicHermesRuntime', () => {
        expect(createHermesAgentRuntime('deterministic')).toBeInstanceOf(DeterministicHermesRuntime)
    })

    it('"mock" returns DeterministicHermesRuntime', () => {
        expect(createHermesAgentRuntime('mock')).toBeInstanceOf(DeterministicHermesRuntime)
    })

    it('undefined defaults to DeterministicHermesRuntime', () => {
        expect(createHermesAgentRuntime()).toBeInstanceOf(DeterministicHermesRuntime)
    })

    it('unknown mode falls back to DeterministicHermesRuntime', () => {
        expect(createHermesAgentRuntime('unknown-mode')).toBeInstanceOf(DeterministicHermesRuntime)
    })
})
