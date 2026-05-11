// ─── Agent Room Runtime Matrix Smoke ────────────────────────────
// Validates the supported Agent Room runner/runtime configuration matrix.
// Deterministic runtime is always exercised locally. External runtimes are
// skipped with explicit reasons unless their required environment is present.

import { createAgentRoomRunner } from '../packages/server/src/services/hermes/agent-room/runner'
import type { AgentRoomRunnerContext } from '../packages/server/src/services/hermes/agent-room/runner'
import type { AgentRoomTask, AgentRoomTaskStatus, AgentRoomWorkflowEventType, AgentRoomRole } from '../packages/server/src/services/hermes/agent-room'

type MatrixCase = {
    name: string
    runtime: string
    requiredEnv?: string[]
}

const CASES: MatrixCase[] = [
    { name: 'deterministic local default', runtime: 'deterministic' },
    { name: 'gateway single role', runtime: 'gateway', requiredEnv: ['AGENT_ROOM_RUNTIME_MATRIX_GATEWAY'] },
    { name: 'gateway alias real', runtime: 'real', requiredEnv: ['AGENT_ROOM_RUNTIME_MATRIX_GATEWAY'] },
    { name: 'http bridge', runtime: 'http', requiredEnv: ['HERMES_AGENT_BASE_URL'] },
    { name: 'bridge alias', runtime: 'bridge', requiredEnv: ['HERMES_AGENT_BASE_URL'] },
    { name: 'orchestrated multi role', runtime: 'orchestrated', requiredEnv: ['AGENT_ROOM_RUNTIME_MATRIX_ORCHESTRATED'] },
    { name: 'gateway multi role alias', runtime: 'gateway-multi-role', requiredEnv: ['AGENT_ROOM_RUNTIME_MATRIX_ORCHESTRATED'] },
]

function missingEnv(requiredEnv: string[] | undefined): string[] {
    return (requiredEnv ?? []).filter(key => !process.env[key])
}

function makeContext(runtime: string): AgentRoomRunnerContext {
    const now = Date.now()
    const task: AgentRoomTask = {
        id: `task-${runtime}-${now}`,
        sessionId: `runtime-matrix-${runtime}-${now}`,
        title: `runtime matrix ${runtime}`,
        description: '请用一句话回复 runtime-matrix-ok。',
        status: 'created',
        assignedAgentId: process.env.AGENT_ROOM_ASSIGNED_AGENT_ID,
        revisionRound: 0,
        maxRevisionRounds: 1,
        createdAt: new Date(now).toISOString(),
        updatedAt: new Date(now).toISOString(),
    }
    const roleBindings = new Map<AgentRoomRole, { role: AgentRoomRole; profileName: string }>()
    if (runtime === 'orchestrated' || runtime === 'gateway-multi-role') {
        if (process.env.PLANNER_PROFILE) roleBindings.set('planner', { role: 'planner', profileName: process.env.PLANNER_PROFILE })
        if (process.env.DEVELOPER_PROFILE) roleBindings.set('developer', { role: 'developer', profileName: process.env.DEVELOPER_PROFILE })
        if (process.env.REVIEWER_PROFILE) roleBindings.set('reviewer', { role: 'reviewer', profileName: process.env.REVIEWER_PROFILE })
        if (process.env.DELIVERY_PROFILE) roleBindings.set('delivery', { role: 'delivery', profileName: process.env.DELIVERY_PROFILE })
    }

    return {
        sessionId: task.sessionId,
        taskId: task.id,
        task,
        roleBindings,
        updateTaskStatus: (_taskId: string, newStatus: AgentRoomTaskStatus) => ({ ...task, status: newStatus }),
        emitEventAndMessage: (
            _sessionId: string,
            _taskId: string,
            _type: AgentRoomWorkflowEventType,
            _agentRole: AgentRoomRole,
            _taskTitle: string,
            _payload?: Record<string, unknown>,
        ) => undefined,
        runInTransaction: (fn: () => void) => fn(),
        updateSessionTimestamp: (_sessionId: string) => undefined,
    }
}

async function runCase(testCase: MatrixCase): Promise<'passed' | 'skipped'> {
    const missing = missingEnv(testCase.requiredEnv)
    if (missing.length > 0) {
        console.log(`SKIP ${testCase.name}: missing ${missing.join(', ')}`)
        return 'skipped'
    }

    const previousRunner = process.env.AGENT_ROOM_RUNNER
    const previousRuntime = process.env.HERMES_AGENT_RUNTIME
    process.env.AGENT_ROOM_RUNNER = 'real'
    process.env.HERMES_AGENT_RUNTIME = testCase.runtime

    try {
        const runner = createAgentRoomRunner(process.env.AGENT_ROOM_RUNNER)
        const result = await runner.run(makeContext(testCase.runtime))
        if (!result?.steps?.length) {
            throw new Error('runner returned no workflow steps')
        }
        console.log(`PASS ${testCase.name}: steps=${result.steps.length}, status=${result.status ?? result.steps.at(-1)?.status ?? 'unknown'}`)
        return 'passed'
    } finally {
        if (previousRunner === undefined) delete process.env.AGENT_ROOM_RUNNER
        else process.env.AGENT_ROOM_RUNNER = previousRunner
        if (previousRuntime === undefined) delete process.env.HERMES_AGENT_RUNTIME
        else process.env.HERMES_AGENT_RUNTIME = previousRuntime
    }
}

async function main(): Promise<void> {
    console.log('─── Agent Room Runtime Matrix Smoke ───')
    console.log('Required deterministic matrix: AGENT_ROOM_RUNNER=real HERMES_AGENT_RUNTIME=deterministic')
    console.log('External gateway matrix: set AGENT_ROOM_RUNTIME_MATRIX_GATEWAY=1 and gateway env')
    console.log('External HTTP bridge matrix: set HERMES_AGENT_BASE_URL')
    console.log('External orchestrated matrix: set AGENT_ROOM_RUNTIME_MATRIX_ORCHESTRATED=1 and gateway env')
    console.log()

    let passed = 0
    let skipped = 0
    for (const testCase of CASES) {
        const result = await runCase(testCase)
        if (result === 'passed') passed += 1
        else skipped += 1
    }

    console.log()
    console.log(`Runtime matrix summary: passed=${passed}, skipped=${skipped}`)
}

main().catch(error => {
    console.error('FAIL runtime matrix smoke')
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
})
