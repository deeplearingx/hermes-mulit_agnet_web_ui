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
            ['reviewer', { role: 'reviewer', profileName: 'gpt-4o' }],
        ]),
        ...overrides,
    }
}

/**
 * Mock three sequential runHermesGatewayTask calls (planner → developer → reviewer).
 * Returns the mock values for assertion.
 */
// P5.2: JSON reviewer output protocol constants for tests
const APPROVED_REVIEWER_JSON = JSON.stringify({
    decision: 'approved',
    feedback: 'Implementation meets requirements',
    issues: [],
    confidence: 0.95,
})

const REVISION_REQUIRED_REVIEWER_JSON = JSON.stringify({
    decision: 'revision_required',
    feedback: 'Implementation needs changes',
    issues: ['Missing error handling'],
    confidence: 0.8,
})

const NEED_USER_DECISION_REVIEWER_JSON = JSON.stringify({
    decision: 'need_user_decision',
    feedback: 'Cannot determine correctness',
    issues: ['Ambiguous requirements'],
    confidence: 0.3,
})

function mockDualGatewayRuns(plannerRunId = 'run-planner-001', developerRunId = 'run-dev-001', reviewerRunId = 'run-reviewer-001') {
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
    const reviewerResult = {
        output: APPROVED_REVIEWER_JSON,
        runId: reviewerRunId,
        sessionId: 'agent-room-reviewer-sess-1-task-1',
    }
    vi.mocked(runHermesGatewayTask)
        .mockResolvedValueOnce(plannerResult)
        .mockResolvedValueOnce(developerResult)
        .mockResolvedValueOnce(reviewerResult)
    return { plannerResult, developerResult, reviewerResult }
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

            // First call is planner, then developer, then reviewer
            expect(runHermesGatewayTask).toHaveBeenCalledTimes(3)
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
                    ['reviewer', { role: 'reviewer', profileName: 'gpt-4o' }],
                ]),
                assignedAgentId: 'fallback-agent-id',
            }))

            // Should call runHermesGatewayTask three times (planner + developer + reviewer)
            expect(runHermesGatewayTask).toHaveBeenCalledTimes(3)

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
                    ['reviewer', { role: 'reviewer', profileName: 'gpt-4o' }],
                ]),
            }))

            expect(runHermesGatewayTask).toHaveBeenCalledTimes(3)

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
        it('returns exactly 5 steps: planned → assigned → in_progress → submitted_for_review → review_passed', async () => {
            mockDualGatewayRuns()

            const runtime = new OrchestratedGatewayRuntime('http://127.0.0.1:8642', null, 30000)
            const result = await runtime.runTask(makeInput())

            expect(result.steps).toHaveLength(5)
            expect(result.steps[0].status).toBe('planned')
            expect(result.steps[0].activeRole).toBe('planner')
            expect(result.steps[1].status).toBe('assigned')
            expect(result.steps[1].activeRole).toBe('developer')
            expect(result.steps[2].status).toBe('in_progress')
            expect(result.steps[2].activeRole).toBe('developer')
            expect(result.steps[3].status).toBe('submitted_for_review')
            expect(result.steps[3].activeRole).toBe('developer')
            expect(result.steps[4].status).toBe('review_passed')
            expect(result.steps[4].activeRole).toBe('reviewer')
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

        it('produces artifacts from developer output and reviewer report', async () => {
            mockDualGatewayRuns()

            const runtime = new OrchestratedGatewayRuntime('http://127.0.0.1:8642', null, 30000)
            const result = await runtime.runTask(makeInput())

            expect(result.artifacts).toHaveLength(2)
            expect(result.artifacts![0].name).toBe('Implement_login_page.md')
            expect(result.artifacts![0].type).toBe('code_output')
            expect(result.artifacts![0].content).toContain('Implementation complete')
            expect(result.artifacts![1].name).toBe('Implement_login_page-review.md')
            expect(result.artifacts![1].type).toBe('review_report')
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
            expect(payload.source).toBe('orchestrated-triple-run')
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

        it('artifact metadata contains combined triple-run metadata', async () => {
            mockDualGatewayRuns('run-planner-300', 'run-dev-300')

            const runtime = new OrchestratedGatewayRuntime('http://127.0.0.1:8642', null, 30000)
            const result = await runtime.runTask(makeInput())

            expect(result.artifacts).toHaveLength(2)
            const meta = result.artifacts![0].metadata as Record<string, unknown>
            expect(meta.plannerRunId).toBe('run-planner-300')
            expect(meta.developerRunId).toBe('run-dev-300')
            expect(meta.source).toBe('orchestrated-triple-run')
        })
    })

    describe('unsupported status', () => {
        it('throws for planning status (not implemented)', async () => {
            const runtime = new OrchestratedGatewayRuntime('http://127.0.0.1:8642', null, 30000)
            await expect(runtime.runTask(makeInput({ currentStatus: 'planned' }))).rejects.toThrow(
                /OrchestratedGatewayRuntime only supports/,
            )
        })

        it('does NOT call runHermesGatewayTask for unsupported status', async () => {
            const runtime = new OrchestratedGatewayRuntime('http://127.0.0.1:8642', null, 30000)
            await expect(runtime.runTask(makeInput({ currentStatus: 'planned' }))).rejects.toThrow()
            expect(runHermesGatewayTask).not.toHaveBeenCalled()
        })
    })

    describe('hooks forwarding and role tagging (P4.11-A5)', () => {
        it('forwards onUpstreamRunCreated hook to planner, developer, and reviewer runs (P5.1: wrapped with role context)', async () => {
            mockDualGatewayRuns()

            const onUpstreamRunCreated = vi.fn()
            const onRawEvent = vi.fn()
            const runtime = new OrchestratedGatewayRuntime('http://127.0.0.1:8642', null, 30000)
            await runtime.runTask(makeInput({ hooks: { onUpstreamRunCreated, onRawEvent } }))

            // All three calls should have onUpstreamRunCreated forwarded (P5.1: wrapped with role context)
            const plannerCall = vi.mocked(runHermesGatewayTask).mock.calls[0][0]
            const devCall = vi.mocked(runHermesGatewayTask).mock.calls[1][0]
            const reviewerCall = vi.mocked(runHermesGatewayTask).mock.calls[2][0]

            // P5.1: Hooks are now wrapped (not the same reference), but still functional
            expect(plannerCall.onUpstreamRunCreated).toBeTypeOf('function')
            expect(devCall.onUpstreamRunCreated).toBeTypeOf('function')
            expect(reviewerCall.onUpstreamRunCreated).toBeTypeOf('function')

            // Verify the wrapper injects role context when called
            plannerCall.onUpstreamRunCreated?.('run-planner-001')
            expect(onUpstreamRunCreated).toHaveBeenCalledWith('run-planner-001', { role: 'planner' })

            devCall.onUpstreamRunCreated?.('run-dev-001')
            expect(onUpstreamRunCreated).toHaveBeenCalledWith('run-dev-001', { role: 'developer' })

            reviewerCall.onUpstreamRunCreated?.('run-reviewer-001')
            expect(onUpstreamRunCreated).toHaveBeenCalledWith('run-reviewer-001', { role: 'reviewer' })
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

            expect(result.steps).toHaveLength(5)
            expect(runHermesGatewayTask).toHaveBeenCalledTimes(3)
        })
    })

    describe('Gateway call sequence', () => {
        it('calls runHermesGatewayTask exactly three times (planner → developer → reviewer)', async () => {
            mockDualGatewayRuns()

            const runtime = new OrchestratedGatewayRuntime('http://127.0.0.1:8642', null, 30000)
            await runtime.runTask(makeInput())

            expect(runHermesGatewayTask).toHaveBeenCalledTimes(3)
        })

        it('planner call uses planner profileName for target resolution', async () => {
            mockDualGatewayRuns()

            const runtime = new OrchestratedGatewayRuntime('http://127.0.0.1:8642', null, 30000)
            await runtime.runTask(makeInput({
                roleBindings: new Map([
                    ['planner', { role: 'planner', profileName: 'claude-3.5-sonnet' }],
                    ['developer', { role: 'developer', profileName: 'gpt-4o' }],
                    ['reviewer', { role: 'reviewer', profileName: 'gpt-4o' }],
                ]),
            }))

            // All three calls should succeed — profile resolution is internal
            expect(runHermesGatewayTask).toHaveBeenCalledTimes(3)
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

        const plannerRunId = 'run-planner-e2e-001'
        const developerRunId = 'run-dev-e2e-001'
        const reviewerRunId = 'run-reviewer-e2e-001'

        let callCount = 0
        vi.mocked(runHermesGatewayTask).mockImplementation(async (params: any) => {
            callCount++
            if (callCount === 1) {
                if (params.onUpstreamRunCreated) {
                    params.onUpstreamRunCreated(plannerRunId)
                }
                if (params.onRawEvent) {
                    params.onRawEvent({ event: 'run.created', data: { id: plannerRunId } })
                }
                return {
                    output: 'Detailed plan: step 1, step 2, step 3',
                    runId: plannerRunId,
                    sessionId: `agent-room-planner-${params.sessionId}`,
                }
            }
            if (callCount === 2) {
                // Developer run
                if (params.onUpstreamRunCreated) {
                    params.onUpstreamRunCreated(developerRunId)
                }
                if (params.onRawEvent) {
                    params.onRawEvent({ event: 'run.completed', data: { id: developerRunId } })
                }
                return {
                    output: 'Implementation complete: feature built successfully',
                    runId: developerRunId,
                    sessionId: `agent-room-developer-${params.sessionId}`,
                }
            }
            // Reviewer run
            if (params.onUpstreamRunCreated) {
                params.onUpstreamRunCreated(reviewerRunId)
            }
            if (params.onRawEvent) {
                params.onRawEvent({ event: 'run.completed', data: { id: reviewerRunId } })
            }
            return {
                output: APPROVED_REVIEWER_JSON,
                runId: reviewerRunId,
                sessionId: `agent-room-reviewer-${params.sessionId}`,
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

        // Need to set all role bindings for triple-run
        svc.setRoleBinding(session.id, 'planner', 'gpt-4o')
        svc.setRoleBinding(session.id, 'developer', 'claude-3.5-sonnet')
        svc.setRoleBinding(session.id, 'reviewer', 'gpt-4o')

        const run = svc.startWorkflow(session.id, task.id)

        // Run should be returned immediately
        expect(['queued', 'running']).toContain(run.status)

        // Wait for background execution to complete
        await vi.waitFor(() => {
            const updatedRun = svc.getRun(run.id)!
            expect(updatedRun.status).toBe('completed')
        }, { timeout: 5000 })

        // Task should reach review_passed (reviewer approved)
        const finalTask = svc.listTasks(session.id).find(t => t.id === task.id)!
        expect(finalTask.status).toBe('review_passed')

        // Metadata should include plannerRunId, developerRunId, and reviewerRunId
        const artifacts = svc.listTaskArtifacts(session.id, task.id)
        expect(artifacts).toHaveLength(2)
        // Find code_output artifact (listArtifactsByTask returns DESC order, review_report may come first)
        const codeArtifact = artifacts.find(a => a.type === 'code_output')!
        const meta = codeArtifact.metadata as Record<string, unknown>
        expect(meta.plannerRunId).toBe(plannerRunId)
        expect(meta.developerRunId).toBe(developerRunId)
        expect(meta.source).toBe('orchestrated-triple-run')

        // P1.3.d: upstreamRunId semantics
        // plannerRunId should differ from developerRunId
        expect(meta.plannerRunId).not.toBe(meta.developerRunId)
        // run.upstreamRunId should equal the reviewer's run ID (last-wins, reviewer is last run)
        const completedRun = svc.getRun(run.id)!
        expect(completedRun.upstreamRunId).toBe(reviewerRunId)

        // P1.3.b.1: developer binding source should be 'role-binding' when developer binding is set
        expect(meta.developerBindingSource).toBe('role-binding')
        expect(meta.developerProfileName).toBe('claude-3.5-sonnet')

        // P1.3.f: artifact metadata must NOT contain sensitive keys
        const sensitiveKeys = ['apiKey', 'Authorization', 'token', 'secret', 'password', 'key', 'credential', 'apikey', 'auth', 'bearer']
        const metaKeys = Object.keys(meta).map(k => k.toLowerCase())
        const metaValues = JSON.stringify(meta).toLowerCase()
        for (const sensitive of sensitiveKeys) {
            expect(metaKeys).not.toContain(sensitive)
            expect(metaValues).not.toContain(sensitive)
        }

        // run_events should have gateway_sse source with _agentRole dimension
        const runEvents = svc.listRunEventsByRun(run.id)
        const gatewayEvents = runEvents.filter(e => e.source === 'gateway_sse')
        expect(gatewayEvents.length).toBeGreaterThanOrEqual(3)

        // P1.3.e: gateway_sse events must have _agentRole dimension from role-tagged hooks
        const plannerGatewayEvents = gatewayEvents.filter(
            e => (e.payload as Record<string, unknown>)?._agentRole === 'planner',
        )
        const developerGatewayEvents = gatewayEvents.filter(
            e => (e.payload as Record<string, unknown>)?._agentRole === 'developer',
        )
        const reviewerGatewayEvents = gatewayEvents.filter(
            e => (e.payload as Record<string, unknown>)?._agentRole === 'reviewer',
        )
        expect(plannerGatewayEvents.length).toBeGreaterThanOrEqual(1)
        expect(developerGatewayEvents.length).toBeGreaterThanOrEqual(1)
        expect(reviewerGatewayEvents.length).toBeGreaterThanOrEqual(1)

        // Runner step events should be persisted (5 steps now)
        const runnerEvents = runEvents.filter(e => e.source === 'runner')
        expect(runnerEvents.length).toBeGreaterThanOrEqual(5)

        resetActiveRunnerForTest()
    })

    it('orchestrated mode: task transitions created → planned → assigned → in_progress → submitted_for_review → review_passed', async () => {
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
            if (callCount === 2) {
                return {
                    output: 'Dev output',
                    runId: 'run-d-seq',
                    sessionId: 'sess-d',
                }
            }
            return {
                output: APPROVED_REVIEWER_JSON,
                runId: 'run-r-seq',
                sessionId: 'sess-r',
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
        svc.setRoleBinding(session.id, 'reviewer', 'gpt-4o')

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
        expect(eventTypes).toContain('review_passed')

        // Final task status
        const finalTask = svc.listTasks(session.id).find(t => t.id === task.id)!
        expect(finalTask.status).toBe('review_passed')

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

    // ── Group 6: planner missing binding E2E (P1.3.a) ────────────

    it('P1.3.a: planner missing binding → run fails, task stays created, no artifacts', async () => {
        const { runHermesGatewayTask } = await import('../../packages/server/src/services/hermes/gateway-run-client')

        // Mock should NOT be called — planner binding missing causes immediate rejection
        vi.mocked(runHermesGatewayTask).mockResolvedValue({
            output: 'should not be called',
            runId: 'should-not-be-called',
            sessionId: 'should-not',
        })

        const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
        const { setActiveRunnerForTest, resetActiveRunnerForTest } = await import(
            '../../packages/server/src/services/hermes/agent-room/runner'
        )

        const runtime = new OrchestratedGatewayRuntime('http://127.0.0.1:8642', null, 30000)
        setActiveRunnerForTest(new RealAgentRunner(runtime))

        const session = svc.createSession('Planner Missing E2E')
        // Create task WITHOUT setting planner role binding
        const task = svc.createTask(session.id, 'No Planner', 'Task without planner binding')

        const run = svc.startWorkflow(session.id, task.id)

        await vi.waitFor(() => {
            const updatedRun = svc.getRun(run.id)!
            expect(updatedRun.status).toBe('failed')
        }, { timeout: 5000 })

        // Run errorMessage must contain "planner"
        const failedRun = svc.getRun(run.id)!
        expect(failedRun.errorMessage).not.toBeNull()
        expect(failedRun.errorMessage!.toLowerCase()).toContain('planner')

        // Task remains in "created" — no partial advancement
        const finalTask = svc.listTasks(session.id).find(t => t.id === task.id)!
        expect(finalTask.status).toBe('created')

        // No artifacts created
        const artifacts = svc.listTaskArtifacts(session.id, task.id)
        expect(artifacts).toHaveLength(0)

        // runHermesGatewayTask should not have been called
        expect(runHermesGatewayTask).not.toHaveBeenCalled()

        resetActiveRunnerForTest()
    })

    // ── Group 7: developer fallback E2E (P1.3.b.2, P1.3.b.3) ────

    it('P1.3.b.2: developer fallback to assignedAgentId when no developer binding', async () => {
        const { runHermesGatewayTask } = await import('../../packages/server/src/services/hermes/gateway-run-client')

        let callCount = 0
        vi.mocked(runHermesGatewayTask).mockImplementation(async (_params: any) => {
            callCount++
            if (callCount === 1) {
                return { output: 'Plan output', runId: 'run-fb-2-p', sessionId: 'sess-fb-2-p' }
            }
            if (callCount === 2) {
                return { output: 'Dev output', runId: 'run-fb-2-d', sessionId: 'sess-fb-2-d' }
            }
            return { output: APPROVED_REVIEWER_JSON, runId: 'run-fb-2-r', sessionId: 'sess-fb-2-r' }
        })

        const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
        const { setActiveRunnerForTest, resetActiveRunnerForTest } = await import(
            '../../packages/server/src/services/hermes/agent-room/runner'
        )

        const runtime = new OrchestratedGatewayRuntime('http://127.0.0.1:8642', null, 30000)
        setActiveRunnerForTest(new RealAgentRunner(runtime))

        const session = svc.createSession('Dev Fallback E2E')
        // Only planner and reviewer bindings, no developer binding
        svc.setRoleBinding(session.id, 'planner', 'gpt-4o')
        svc.setRoleBinding(session.id, 'reviewer', 'gpt-4o')
        // Task with assignedAgentId for fallback
        const task = svc.createTask(session.id, 'Task', 'Description', 'fallback-agent-id')

        const run = svc.startWorkflow(session.id, task.id)

        await vi.waitFor(() => {
            const updatedRun = svc.getRun(run.id)!
            expect(updatedRun.status).toBe('completed')
        }, { timeout: 5000 })

        // Developer binding source should be 'assigned-agent'
        const artifacts = svc.listTaskArtifacts(session.id, task.id)
        expect(artifacts).toHaveLength(2)
        const codeArtifact = artifacts.find(a => a.type === 'code_output')!
        const meta = codeArtifact.metadata as Record<string, unknown>
        expect(meta.developerBindingSource).toBe('assigned-agent')
        expect(meta.developerProfileName).toBe('fallback-agent-id')

        resetActiveRunnerForTest()
    })

    it('P1.3.b.3: developer fallback to "none" when neither binding nor assignedAgentId', async () => {
        const { runHermesGatewayTask } = await import('../../packages/server/src/services/hermes/gateway-run-client')

        let callCount = 0
        vi.mocked(runHermesGatewayTask).mockImplementation(async (_params: any) => {
            callCount++
            if (callCount === 1) {
                return { output: 'Plan output', runId: 'run-fb-3-p', sessionId: 'sess-fb-3-p' }
            }
            if (callCount === 2) {
                return { output: 'Dev output', runId: 'run-fb-3-d', sessionId: 'sess-fb-3-d' }
            }
            return { output: APPROVED_REVIEWER_JSON, runId: 'run-fb-3-r', sessionId: 'sess-fb-3-r' }
        })

        const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
        const { setActiveRunnerForTest, resetActiveRunnerForTest } = await import(
            '../../packages/server/src/services/hermes/agent-room/runner'
        )

        const runtime = new OrchestratedGatewayRuntime('http://127.0.0.1:8642', null, 30000)
        setActiveRunnerForTest(new RealAgentRunner(runtime))

        const session = svc.createSession('Dev None E2E')
        // Only planner and reviewer bindings, no developer binding and no assignedAgentId
        svc.setRoleBinding(session.id, 'planner', 'gpt-4o')
        svc.setRoleBinding(session.id, 'reviewer', 'gpt-4o')
        const task = svc.createTask(session.id, 'Task', 'Description')

        const run = svc.startWorkflow(session.id, task.id)

        await vi.waitFor(() => {
            const updatedRun = svc.getRun(run.id)!
            expect(updatedRun.status).toBe('completed')
        }, { timeout: 5000 })

        // Developer binding source should be 'none'
        const artifacts = svc.listTaskArtifacts(session.id, task.id)
        expect(artifacts).toHaveLength(2)
        const codeArtifact = artifacts.find(a => a.type === 'code_output')!
        const meta = codeArtifact.metadata as Record<string, unknown>
        expect(meta.developerBindingSource).toBe('none')

        resetActiveRunnerForTest()
    })

    // ── Group 8: planner output injection (P1.3.c) ────────────────

    it('P1.3.c: developer input includes planner output and plan wrapper text', async () => {
        const { runHermesGatewayTask } = await import('../../packages/server/src/services/hermes/gateway-run-client')

        const plannerOutput = 'Detailed architectural plan: step A, step B, step C'
        const developerCallParams: any[] = []

        vi.mocked(runHermesGatewayTask).mockImplementation(async (params: any) => {
            developerCallParams.push(params)
            if (developerCallParams.length === 1) {
                return { output: plannerOutput, runId: 'run-p1-3c-p', sessionId: 'sess-p1-3c-p' }
            }
            if (developerCallParams.length === 2) {
                return { output: 'Dev output', runId: 'run-p1-3c-d', sessionId: 'sess-p1-3c-d' }
            }
            return { output: APPROVED_REVIEWER_JSON, runId: 'run-p1-3c-r', sessionId: 'sess-p1-3c-r' }
        })

        const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
        const { setActiveRunnerForTest, resetActiveRunnerForTest } = await import(
            '../../packages/server/src/services/hermes/agent-room/runner'
        )

        const runtime = new OrchestratedGatewayRuntime('http://127.0.0.1:8642', null, 30000)
        setActiveRunnerForTest(new RealAgentRunner(runtime))

        const session = svc.createSession('Planner Injection E2E')
        svc.setRoleBinding(session.id, 'planner', 'gpt-4o')
        svc.setRoleBinding(session.id, 'developer', 'claude-3.5-sonnet')
        svc.setRoleBinding(session.id, 'reviewer', 'gpt-4o')
        const task = svc.createTask(session.id, 'Task', 'Description')

        const run = svc.startWorkflow(session.id, task.id)

        await vi.waitFor(() => {
            const updatedRun = svc.getRun(run.id)!
            expect(updatedRun.status).toBe('completed')
        }, { timeout: 5000 })

        // runHermesGatewayTask should have been called exactly three times
        expect(runHermesGatewayTask).toHaveBeenCalledTimes(3)

        // Second call (developer) must include planner output and plan wrapper text
        const devCall = developerCallParams[1]
        expect(devCall.input).toContain(plannerOutput)
        expect(devCall.input).toContain('执行计划')
        expect(devCall.input).toContain('计划结束')

        resetActiveRunnerForTest()
    })
})

// ─── P0.2: Full-chain smoke (created → planner → developer → reviewer → deliverTask → completed) ──

describe('P0.2: Full-chain smoke — real Gateway orchestrated path with delivery', () => {
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

    it('P0.2: full chain created → planner → developer → reviewer → review_passed → deliverTask → completed', async () => {
        const { runHermesGatewayTask } = await import('../../packages/server/src/services/hermes/gateway-run-client')

        const plannerRunId = 'run-planner-p02-001'
        const developerRunId = 'run-dev-p02-001'
        const reviewerRunId = 'run-reviewer-p02-001'

        let callCount = 0
        vi.mocked(runHermesGatewayTask).mockImplementation(async (params: any) => {
            callCount++
            if (callCount === 1) {
                // Planner phase
                if (params.onUpstreamRunCreated) params.onUpstreamRunCreated(plannerRunId)
                if (params.onRawEvent) {
                    params.onRawEvent({ event: 'run.created', data: { id: plannerRunId } })
                    params.onRawEvent({ event: 'run.completed', data: { id: plannerRunId } })
                }
                return {
                    output: 'Detailed plan: step 1 - design DB schema, step 2 - implement API, step 3 - write tests',
                    runId: plannerRunId,
                    sessionId: `agent-room-planner-${params.sessionId}`,
                }
            }
            if (callCount === 2) {
                // Developer phase
                if (params.onUpstreamRunCreated) params.onUpstreamRunCreated(developerRunId)
                if (params.onRawEvent) {
                    params.onRawEvent({ event: 'run.created', data: { id: developerRunId } })
                    params.onRawEvent({ event: 'run.completed', data: { id: developerRunId } })
                }
                return {
                    output: 'Implementation complete: all three steps implemented and tested',
                    runId: developerRunId,
                    sessionId: `agent-room-developer-${params.sessionId}`,
                }
            }
            // Reviewer phase
            if (params.onUpstreamRunCreated) params.onUpstreamRunCreated(reviewerRunId)
            if (params.onRawEvent) {
                params.onRawEvent({ event: 'run.created', data: { id: reviewerRunId } })
                params.onRawEvent({ event: 'run.completed', data: { id: reviewerRunId } })
            }
            return {
                output: APPROVED_REVIEWER_JSON,
                runId: reviewerRunId,
                sessionId: `agent-room-reviewer-${params.sessionId}`,
            }
        })

        const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
        const { setActiveRunnerForTest, resetActiveRunnerForTest } = await import(
            '../../packages/server/src/services/hermes/agent-room/runner'
        )

        const runtime = new OrchestratedGatewayRuntime('http://127.0.0.1:8642', null, 30000)
        setActiveRunnerForTest(new RealAgentRunner(runtime))

        // ── Step 1: Create session + task + role bindings ──────────
        const session = svc.createSession('P0.2 Full-Chain Smoke')
        const task = svc.createTask(session.id, 'P0.2 Feature', 'Implement feature with full-chain orchestrated runtime')
        expect(task.status).toBe('created')

        // Set all three role bindings (planner, developer, reviewer)
        svc.setRoleBinding(session.id, 'planner', 'gpt-4o')
        svc.setRoleBinding(session.id, 'developer', 'claude-3.5-sonnet')
        svc.setRoleBinding(session.id, 'reviewer', 'gpt-4o')

        // ── Step 2: Verify all three role bindings resolved ────────
        const bindings = svc.listRoleBindings(session.id)
        const bindingRoles = bindings.map(b => b.role)
        expect(bindingRoles).toContain('planner')
        expect(bindingRoles).toContain('developer')
        expect(bindingRoles).toContain('reviewer')

        const plannerBinding = bindings.find(b => b.role === 'planner')!
        const developerBinding = bindings.find(b => b.role === 'developer')!
        const reviewerBinding = bindings.find(b => b.role === 'reviewer')!
        expect(plannerBinding.profileName).toBe('gpt-4o')
        expect(developerBinding.profileName).toBe('claude-3.5-sonnet')
        expect(reviewerBinding.profileName).toBe('gpt-4o')

        // ── Step 3: Run orchestrated workflow (planner → developer → reviewer) ──
        const run = svc.startWorkflow(session.id, task.id)
        expect(['queued', 'running']).toContain(run.status)

        // Wait for background execution to complete
        await vi.waitFor(() => {
            const updatedRun = svc.getRun(run.id)!
            expect(updatedRun.status).toBe('completed')
        }, { timeout: 10000 })

        // ── Step 4: Verify task reached review_passed ──────────────
        const taskAfterWorkflow = svc.listTasks(session.id).find(t => t.id === task.id)!
        expect(taskAfterWorkflow.status).toBe('review_passed')

        // ── Step 5: Verify planner/developer/reviewer profile resolution ──
        // Check that runHermesGatewayTask was called exactly 3 times
        expect(runHermesGatewayTask).toHaveBeenCalledTimes(3)

        const plannerCall = vi.mocked(runHermesGatewayTask).mock.calls[0][0]
        const devCall = vi.mocked(runHermesGatewayTask).mock.calls[1][0]
        const reviewerCall = vi.mocked(runHermesGatewayTask).mock.calls[2][0]

        // Verify session IDs contain role prefixes (profile resolution succeeded)
        expect(plannerCall.sessionId).toContain('agent-room-planner-')
        expect(devCall.sessionId).toContain('agent-room-developer-')
        expect(reviewerCall.sessionId).toContain('agent-room-reviewer-')

        // Verify instructions contain role-specific guidance (proving profile parsed correctly)
        expect(plannerCall.instructions).toContain('规划 Agent')
        expect(devCall.instructions).toContain('开发 Agent')
        expect(reviewerCall.instructions).toContain('审核 Agent')

        // ── Step 6: Verify run_events contain _agentRole ───────────
        const runEvents = svc.listRunEventsByRun(run.id)

        // Gateway SSE events should have _agentRole dimension
        const gatewayEvents = runEvents.filter(e => e.source === 'gateway_sse')
        expect(gatewayEvents.length).toBeGreaterThanOrEqual(3)

        const plannerGatewayEvents = gatewayEvents.filter(
            e => (e.payload as Record<string, unknown>)?._agentRole === 'planner',
        )
        const developerGatewayEvents = gatewayEvents.filter(
            e => (e.payload as Record<string, unknown>)?._agentRole === 'developer',
        )
        const reviewerGatewayEvents = gatewayEvents.filter(
            e => (e.payload as Record<string, unknown>)?._agentRole === 'reviewer',
        )
        expect(plannerGatewayEvents.length).toBeGreaterThanOrEqual(1)
        expect(developerGatewayEvents.length).toBeGreaterThanOrEqual(1)
        expect(reviewerGatewayEvents.length).toBeGreaterThanOrEqual(1)

        // Runner step events should have activeRole in payload
        const runnerStepEvents = runEvents.filter(e => e.source === 'runner')
        expect(runnerStepEvents.length).toBeGreaterThanOrEqual(5)

        const stepRoles = runnerStepEvents.map(e => (e.payload as Record<string, unknown>)?.activeRole)
        expect(stepRoles).toContain('planner')
        expect(stepRoles).toContain('developer')
        expect(stepRoles).toContain('reviewer')

        // ── Step 7: Verify artifacts contain code_output and review_report ──
        const artifactsBeforeDelivery = svc.listTaskArtifacts(session.id, task.id)
        expect(artifactsBeforeDelivery.length).toBeGreaterThanOrEqual(2)

        const codeArtifact = artifactsBeforeDelivery.find(a => a.type === 'code_output')
        const reviewArtifact = artifactsBeforeDelivery.find(a => a.type === 'review_report')

        expect(codeArtifact).toBeDefined()
        expect(codeArtifact!.content).toContain('Implementation complete')
        expect(reviewArtifact).toBeDefined()
        expect(reviewArtifact!.content).toContain('Implementation meets requirements')

        // Verify artifact metadata contains orchestrated triple-run source
        const codeMeta = codeArtifact!.metadata as Record<string, unknown>
        expect(codeMeta.source).toBe('orchestrated-triple-run')
        expect(codeMeta.plannerRunId).toBe(plannerRunId)
        expect(codeMeta.developerRunId).toBe(developerRunId)
        expect(codeMeta.plannerProfileName).toBe('gpt-4o')
        expect(codeMeta.developerProfileName).toBe('claude-3.5-sonnet')

        // ── Step 8: Manual deliverTask() ───────────────────────────
        const deliveredTask = svc.deliverTask(session.id, task.id, 'manual')
        expect(deliveredTask).not.toBeNull()
        expect(deliveredTask!.status).toBe('completed')

        // ── Step 9: Verify final_delivery artifact exists ──────────
        const artifactsAfterDelivery = svc.listTaskArtifacts(session.id, task.id)
        const finalDeliveryArtifact = artifactsAfterDelivery.find(a => a.type === 'final_delivery')
        expect(finalDeliveryArtifact).toBeDefined()
        expect(finalDeliveryArtifact!.name).toContain('交付结果')
        expect(finalDeliveryArtifact!.content).toContain('手动')
        expect(finalDeliveryArtifact!.content).toContain('任务「P0.2 Feature」已完成交付')

        const deliveryMeta = finalDeliveryArtifact!.metadata as Record<string, unknown>
        expect(deliveryMeta.deliveryMode).toBe('manual')

        // ── Step 10: Verify task.status = completed ────────────────
        const finalTask = svc.listTasks(session.id).find(t => t.id === task.id)!
        expect(finalTask.status).toBe('completed')

        // ── Step 11: Verify metadata does NOT contain secrets ──────
        const sensitiveKeys = ['apiKey', 'Authorization', 'token', 'secret', 'password', 'key', 'credential', 'apikey', 'auth', 'bearer']

        // Check code_output artifact metadata
        for (const sensitive of sensitiveKeys) {
            const codeMetaKeys = Object.keys(codeMeta).map(k => k.toLowerCase())
            const codeMetaValues = JSON.stringify(codeMeta).toLowerCase()
            expect(codeMetaKeys).not.toContain(sensitive)
            expect(codeMetaValues).not.toContain(sensitive)
        }

        // Check review_report artifact metadata
        const reviewMeta = reviewArtifact!.metadata as Record<string, unknown>
        for (const sensitive of sensitiveKeys) {
            const reviewMetaKeys = Object.keys(reviewMeta).map(k => k.toLowerCase())
            const reviewMetaValues = JSON.stringify(reviewMeta).toLowerCase()
            expect(reviewMetaKeys).not.toContain(sensitive)
            expect(reviewMetaValues).not.toContain(sensitive)
        }

        // Check final_delivery artifact metadata
        for (const sensitive of sensitiveKeys) {
            const deliveryMetaKeys = Object.keys(deliveryMeta).map(k => k.toLowerCase())
            const deliveryMetaValues = JSON.stringify(deliveryMeta).toLowerCase()
            expect(deliveryMetaKeys).not.toContain(sensitive)
            expect(deliveryMetaValues).not.toContain(sensitive)
        }

        // Check run_events payload doesn't leak secrets
        for (const evt of runEvents) {
            const payload = JSON.stringify(evt.payload ?? {}).toLowerCase()
            for (const sensitive of sensitiveKeys) {
                expect(payload).not.toContain(sensitive)
            }
        }

        // ── Step 12: Verify delivery workflow events ───────────────
        const allEvents = svc.listWorkflowEvents(session.id)
        const taskEvents = allEvents.filter(e => e.taskId === task.id)
        const eventTypes = taskEvents.map(e => e.type)

        expect(eventTypes).toContain('task_created')
        expect(eventTypes).toContain('task_planned')
        expect(eventTypes).toContain('task_assigned')
        expect(eventTypes).toContain('task_started')
        expect(eventTypes).toContain('task_submitted')
        expect(eventTypes).toContain('review_passed')
        expect(eventTypes).toContain('delivery_started')
        expect(eventTypes).toContain('delivery_completed')

        resetActiveRunnerForTest()
    })
})

// ─── P1.1-P1.5: autoDelivery unified semantic tests ──────────────

describe('P1.1-P1.5: autoDelivery unified semantic — orchestrated runner', () => {
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

    /**
     * Helper: mock 3 sequential gateway runs (planner → developer → reviewer) and
     * set up the orchestrated runner with role bindings.
     * Returns the service module and session/task for further assertions.
     */
    async function setupOrchestratedChain(autoDelivery: boolean) {
        const { runHermesGatewayTask } = await import('../../packages/server/src/services/hermes/gateway-run-client')

        const plannerRunId = 'run-planner-auto-001'
        const developerRunId = 'run-dev-auto-001'
        const reviewerRunId = 'run-reviewer-auto-001'

        let callCount = 0
        vi.mocked(runHermesGatewayTask).mockImplementation(async (params: any) => {
            callCount++
            if (callCount === 1) {
                if (params.onUpstreamRunCreated) params.onUpstreamRunCreated(plannerRunId)
                if (params.onRawEvent) {
                    params.onRawEvent({ event: 'run.created', data: { id: plannerRunId } })
                    params.onRawEvent({ event: 'run.completed', data: { id: plannerRunId } })
                }
                return {
                    output: 'Plan: step 1 - design, step 2 - implement, step 3 - test',
                    runId: plannerRunId,
                    sessionId: `agent-room-planner-${params.sessionId}`,
                }
            }
            if (callCount === 2) {
                if (params.onUpstreamRunCreated) params.onUpstreamRunCreated(developerRunId)
                if (params.onRawEvent) {
                    params.onRawEvent({ event: 'run.created', data: { id: developerRunId } })
                    params.onRawEvent({ event: 'run.completed', data: { id: developerRunId } })
                }
                return {
                    output: 'Implementation complete: all steps done',
                    runId: developerRunId,
                    sessionId: `agent-room-developer-${params.sessionId}`,
                }
            }
            // Reviewer phase — approved
            if (params.onUpstreamRunCreated) params.onUpstreamRunCreated(reviewerRunId)
            if (params.onRawEvent) {
                params.onRawEvent({ event: 'run.created', data: { id: reviewerRunId } })
                params.onRawEvent({ event: 'run.completed', data: { id: reviewerRunId } })
            }
            return {
                output: APPROVED_REVIEWER_JSON,
                runId: reviewerRunId,
                sessionId: `agent-room-reviewer-${params.sessionId}`,
            }
        })

        const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
        const { setActiveRunnerForTest, resetActiveRunnerForTest } = await import(
            '../../packages/server/src/services/hermes/agent-room/runner'
        )

        const runtime = new OrchestratedGatewayRuntime('http://127.0.0.1:8642', null, 30000)
        setActiveRunnerForTest(new RealAgentRunner(runtime))

        const session = svc.createSession('Auto Delivery Test')
        const task = svc.createTask(session.id, 'Auto Feature', 'Test auto delivery')

        svc.setRoleBinding(session.id, 'planner', 'gpt-4o')
        svc.setRoleBinding(session.id, 'developer', 'claude-3.5-sonnet')
        svc.setRoleBinding(session.id, 'reviewer', 'gpt-4o')

        if (autoDelivery) {
            svc.updateSessionConfig(session.id, { autoDeliveryEnabled: true })
        }

        return { svc, session, task, resetActiveRunnerForTest }
    }

    it('autoDeliveryEnabled=true: orchestrated reviewer approval auto-delivers to completed', async () => {
        const { svc, session, task, resetActiveRunnerForTest } = await setupOrchestratedChain(true)

        // Run workflow (planner → developer → reviewer → review_passed)
        const run = svc.startWorkflow(session.id, task.id)
        expect(['queued', 'running']).toContain(run.status)

        // Wait for background execution to complete
        await vi.waitFor(() => {
            const updatedRun = svc.getRun(run.id)!
            expect(updatedRun.status).toBe('completed')
        }, { timeout: 10000 })

        // Task should be auto-delivered to completed
        const updatedTask = svc.getTask(task.id)!
        expect(updatedTask.status).toBe('completed')

        // final_delivery artifact should exist with auto delivery mode
        const artifacts = svc.listTaskArtifacts(session.id, task.id)
        const finalDelivery = artifacts.find(a => a.type === 'final_delivery')
        expect(finalDelivery).toBeDefined()
        expect(finalDelivery!.metadata!.deliveryMode).toBe('auto')
        expect(finalDelivery!.content).toContain('自动')

        // Workflow events should include delivery_started + delivery_completed
        const events = svc.listWorkflowEvents(session.id)
        const taskEvents = events.filter(e => e.taskId === task.id)
        const eventTypes = taskEvents.map(e => e.type)
        expect(eventTypes).toContain('review_passed')
        expect(eventTypes).toContain('delivery_started')
        expect(eventTypes).toContain('delivery_completed')

        resetActiveRunnerForTest()
    })

    it('autoDeliveryEnabled=false: orchestrated reviewer approval stays in review_passed', async () => {
        const { svc, session, task, resetActiveRunnerForTest } = await setupOrchestratedChain(false)

        // Run workflow (planner → developer → reviewer → review_passed)
        const run = svc.startWorkflow(session.id, task.id)
        expect(['queued', 'running']).toContain(run.status)

        // Wait for background execution to complete
        await vi.waitFor(() => {
            const updatedRun = svc.getRun(run.id)!
            expect(updatedRun.status).toBe('completed')
        }, { timeout: 10000 })

        // Task should stay in review_passed (no auto-delivery)
        const updatedTask = svc.getTask(task.id)!
        expect(updatedTask.status).toBe('review_passed')

        // No final_delivery artifact
        const artifacts = svc.listTaskArtifacts(session.id, task.id)
        const finalDelivery = artifacts.find(a => a.type === 'final_delivery')
        expect(finalDelivery).toBeUndefined()

        // Workflow events should NOT include delivery events
        const events = svc.listWorkflowEvents(session.id)
        const taskEvents = events.filter(e => e.taskId === task.id)
        const eventTypes = taskEvents.map(e => e.type)
        expect(eventTypes).toContain('review_passed')
        expect(eventTypes).not.toContain('delivery_started')
        expect(eventTypes).not.toContain('delivery_completed')

        resetActiveRunnerForTest()
    })

    it('autoDelivery orchestrator path shares same deliverTaskCore logic as manual submitReview', async () => {
        const { svc, session, task, resetActiveRunnerForTest } = await setupOrchestratedChain(true)

        const run = svc.startWorkflow(session.id, task.id)
        await vi.waitFor(() => {
            const updatedRun = svc.getRun(run.id)!
            expect(updatedRun.status).toBe('completed')
        }, { timeout: 10000 })

        // Verify the auto-delivery artifact has the same structure as manual delivery
        const artifacts = svc.listTaskArtifacts(session.id, task.id)
        const finalDelivery = artifacts.find(a => a.type === 'final_delivery')!

        // Same fields as manual deliverTask
        expect(finalDelivery.name).toContain('交付结果')
        expect(finalDelivery.content).toContain('已完成交付')
        expect(finalDelivery.metadata).toHaveProperty('deliveryMode')
        expect(finalDelivery.metadata).toHaveProperty('revisionRound')
        expect(finalDelivery.metadata).toHaveProperty('maxRevisionRounds')
        expect(finalDelivery.metadata).toHaveProperty('reviewFeedback')
        expect(finalDelivery.metadata).toHaveProperty('deliveredAt')

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

// ─── P5.3: Auto reviewer writes to agent_room_reviews ──────────

describe('P5.3: Auto reviewer writes to agent_room_reviews', () => {
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

    /**
     * Helper: mock 3 gateway runs with a given reviewer JSON output.
     * Returns the service module and session/task for assertions.
     */
    async function setupWithReviewerJson(reviewerJson: string) {
        const { runHermesGatewayTask } = await import('../../packages/server/src/services/hermes/gateway-run-client')

        let callCount = 0
        vi.mocked(runHermesGatewayTask).mockImplementation(async (params: any) => {
            callCount++
            if (callCount === 1) {
                return { output: 'Plan output', runId: 'run-p53-p', sessionId: 'sess-p' }
            }
            if (callCount === 2) {
                return { output: 'Dev output', runId: 'run-p53-d', sessionId: 'sess-d' }
            }
            return { output: reviewerJson, runId: 'run-p53-r', sessionId: 'sess-r' }
        })

        const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
        const { setActiveRunnerForTest, resetActiveRunnerForTest } = await import(
            '../../packages/server/src/services/hermes/agent-room/runner'
        )

        const runtime = new OrchestratedGatewayRuntime('http://127.0.0.1:8642', null, 30000)
        setActiveRunnerForTest(new RealAgentRunner(runtime))

        const session = svc.createSession('P5.3 Review Test')
        const task = svc.createTask(session.id, 'P5.3 Task', 'Test auto reviewer reviews table')
        svc.setRoleBinding(session.id, 'planner', 'gpt-4o')
        svc.setRoleBinding(session.id, 'developer', 'claude-3.5-sonnet')
        svc.setRoleBinding(session.id, 'reviewer', 'reviewer-profile')

        const run = svc.startWorkflow(session.id, task.id)

        await vi.waitFor(() => {
            const updatedRun = svc.getRun(run.id)!
            expect(updatedRun.status).toBe('completed')
        }, { timeout: 10000 })

        return { svc, session, task, resetActiveRunnerForTest }
    }

    it('auto reviewer approved → reviews table has status="passed"', async () => {
        const { svc, session, task, resetActiveRunnerForTest } = await setupWithReviewerJson(APPROVED_REVIEWER_JSON)

        const reviews = svc.listReviews(session.id)
        const taskReviews = reviews.filter(r => r.taskId === task.id)
        expect(taskReviews).toHaveLength(1)
        expect(taskReviews[0].status).toBe('passed')

        resetActiveRunnerForTest()
    })

    it('auto reviewer revision_required → reviews table has status="rejected"', async () => {
        const { svc, session, task, resetActiveRunnerForTest } = await setupWithReviewerJson(REVISION_REQUIRED_REVIEWER_JSON)

        const reviews = svc.listReviews(session.id)
        const taskReviews = reviews.filter(r => r.taskId === task.id)
        expect(taskReviews).toHaveLength(1)
        expect(taskReviews[0].status).toBe('rejected')

        resetActiveRunnerForTest()
    })

    it('auto reviewer need_user_decision → reviews table has status="rejected"', async () => {
        const { svc, session, task, resetActiveRunnerForTest } = await setupWithReviewerJson(NEED_USER_DECISION_REVIEWER_JSON)

        const reviews = svc.listReviews(session.id)
        const taskReviews = reviews.filter(r => r.taskId === task.id)
        expect(taskReviews).toHaveLength(1)
        expect(taskReviews[0].status).toBe('rejected')

        resetActiveRunnerForTest()
    })

    it('auto reviewer record reviewerAgentId is reviewer profileName', async () => {
        const { svc, session, task, resetActiveRunnerForTest } = await setupWithReviewerJson(APPROVED_REVIEWER_JSON)

        const reviews = svc.listReviews(session.id)
        const taskReviews = reviews.filter(r => r.taskId === task.id)
        expect(taskReviews[0].reviewerAgentId).toBe('reviewer-profile')

        resetActiveRunnerForTest()
    })

    it('auto reviewer record comment is reviewFeedback', async () => {
        const { svc, session, task, resetActiveRunnerForTest } = await setupWithReviewerJson(REVISION_REQUIRED_REVIEWER_JSON)

        const reviews = svc.listReviews(session.id)
        const taskReviews = reviews.filter(r => r.taskId === task.id)
        expect(taskReviews[0].comment).toBe('Implementation needs changes')

        resetActiveRunnerForTest()
    })

    it('auto reviewer record metadata contains expected fields', async () => {
        const { svc, session, task, resetActiveRunnerForTest } = await setupWithReviewerJson(REVISION_REQUIRED_REVIEWER_JSON)

        const reviews = svc.listReviews(session.id)
        const taskReviews = reviews.filter(r => r.taskId === task.id)
        const meta = taskReviews[0].metadata

        expect(meta).toBeDefined()
        expect(meta!.source).toBe('orchestrated-reviewer')
        expect(meta!.reviewerRunId).toBe('run-p53-r')
        expect(meta!.reviewerProfileName).toBe('reviewer-profile')
        expect(meta!.reviewDecision).toBe('revision_required')
        expect(meta!.reviewFeedback).toBe('Implementation needs changes')
        expect(meta!.reviewIssues).toEqual(['Missing error handling'])
        expect(meta!.reviewConfidence).toBe(0.8)

        resetActiveRunnerForTest()
    })

    it('retry path reads auto reviewer rejected feedback from reviews table', async () => {
        const { svc, session, task, resetActiveRunnerForTest } = await setupWithReviewerJson(REVISION_REQUIRED_REVIEWER_JSON)

        // Verify the review was written
        const reviews = svc.listReviews(session.id)
        const taskReviews = reviews.filter(r => r.taskId === task.id)
        expect(taskReviews).toHaveLength(1)
        expect(taskReviews[0].status).toBe('rejected')
        expect(taskReviews[0].comment).toBe('Implementation needs changes')

        // The task should be in revision_required state
        const updatedTask = svc.getTask(task.id)!
        expect(updatedTask.status).toBe('revision_required')

        // Verify the store has the rejected review readable for retry
        const store = await import('../../packages/server/src/db/hermes/agent-room-store')
        const storeReviews = store.listReviewsByTask(task.id)
        const rejected = storeReviews.filter(r => r.status === 'rejected')
        expect(rejected).toHaveLength(1)
        expect(rejected[0].comment).toBe('Implementation needs changes')

        resetActiveRunnerForTest()
    })

    it('manual submitReview and auto reviewer share same reviews table, no conflict', async () => {
        const { runHermesGatewayTask } = await import('../../packages/server/src/services/hermes/gateway-run-client')

        let callCount = 0
        vi.mocked(runHermesGatewayTask).mockImplementation(async (_params: any) => {
            callCount++
            if (callCount === 1) {
                return { output: 'Plan output', runId: 'run-conflict-p', sessionId: 'sess-p' }
            }
            if (callCount === 2) {
                return { output: 'Dev output', runId: 'run-conflict-d', sessionId: 'sess-d' }
            }
            return { output: REVISION_REQUIRED_REVIEWER_JSON, runId: 'run-conflict-r', sessionId: 'sess-r' }
        })

        const svc = await import('../../packages/server/src/services/hermes/agent-room/index')
        const { setActiveRunnerForTest, resetActiveRunnerForTest } = await import(
            '../../packages/server/src/services/hermes/agent-room/runner'
        )

        const runtime = new OrchestratedGatewayRuntime('http://127.0.0.1:8642', null, 30000)
        setActiveRunnerForTest(new RealAgentRunner(runtime))

        const session = svc.createSession('Conflict Test')
        const task = svc.createTask(session.id, 'Conflict Task', 'Test coexistence')
        svc.setRoleBinding(session.id, 'planner', 'gpt-4o')
        svc.setRoleBinding(session.id, 'developer', 'claude-3.5-sonnet')
        svc.setRoleBinding(session.id, 'reviewer', 'auto-reviewer')

        const run = svc.startWorkflow(session.id, task.id)

        await vi.waitFor(() => {
            const updatedRun = svc.getRun(run.id)!
            expect(updatedRun.status).toBe('completed')
        }, { timeout: 10000 })

        // Auto reviewer wrote a rejected review
        let reviews = svc.listReviews(session.id)
        let taskReviews = reviews.filter(r => r.taskId === task.id)
        expect(taskReviews).toHaveLength(1)
        expect(taskReviews[0].status).toBe('rejected')
        expect(taskReviews[0].reviewerAgentId).toBe('auto-reviewer')

        // Task is in revision_required — do retry + submit for review again
        svc.retryTask(session.id, task.id)
        // Move to submitted_for_review
        svc.updateTaskStatusInSession(session.id, task.id, 'submitted_for_review')

        // Manual submitReview (human reviewer)
        svc.submitReview(session.id, task.id, 'human-reviewer', 'passed', 'LGTM')

        reviews = svc.listReviews(session.id)
        taskReviews = reviews.filter(r => r.taskId === task.id)
        expect(taskReviews).toHaveLength(2)

        // First review is auto reviewer (rejected)
        expect(taskReviews[0].reviewerAgentId).toBe('auto-reviewer')
        expect(taskReviews[0].status).toBe('rejected')
        expect(taskReviews[0].metadata).toBeDefined()
        expect(taskReviews[0].metadata!.source).toBe('orchestrated-reviewer')

        // Second review is human reviewer (passed)
        expect(taskReviews[1].reviewerAgentId).toBe('human-reviewer')
        expect(taskReviews[1].status).toBe('passed')

        resetActiveRunnerForTest()
    })
})
