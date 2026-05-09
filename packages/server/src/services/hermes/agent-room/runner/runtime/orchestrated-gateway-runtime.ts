// ─── Orchestrated Gateway Runtime ────────────────────────────────
// Multi-role orchestrated runtime that executes per-role Gateway runs
// for planner → developer → reviewer → delivery.
//
// P4.11-A3: Planner-only Gateway run.
// P4.11-A4: Planner → developer dual-run orchestration.
//   - Resolves planner profile from roleBindings.get('planner')
//   - Executes planner Gateway run, captures output as plan
//   - Resolves developer profile from roleBindings.get('developer')
//     with fallback to assignedAgentId (matching GatewayHermesRuntime convention)
//   - Executes developer Gateway run using planner output as plan context
//   - Produces: planned → assigned → in_progress → submitted_for_review
//
// P4.11-A5: Observability for dual-run path.
//   - Preserves gateway_sse and runner sources
//   - Attaches _agentRole dimension in raw event payload
//   - Persists both planner and developer Gateway raw events
//   - Metadata includes plannerRunId, developerRunId, plannerProfileName, developerProfileName
//   - run.upstreamRunId ends with developer's run ID (last-wins, developer is primary execution role)
//
// Design decisions:
//   - Does NOT extend GatewayHermesRuntime (composition over inheritance)
//   - Does NOT modify GatewayHermesRuntime (single-role runtime stays clean)
//   - Does NOT modify the facade state machine protocol
//   - OrchestratedRuntimeConfig is a minimal interface reservation for
//     future per-role configuration

import type {
    HermesAgentRuntime,
    HermesAgentRuntimeInput,
    HermesAgentRuntimeOutput,
    HermesAgentRuntimeHooks,
    HermesAgentRuntimeMetadata,
} from './types'
import type { GatewayProfileResolver, GatewayRuntimeTarget } from './gateway-profile-resolver'
import { createDefaultGatewayProfileResolver } from './gateway-profile-resolver'
import { runHermesGatewayTask } from '../../../gateway-run-client'
import { config } from '../../../../../config'

const UPSTREAM = config.upstream.replace(/\/$/, '')

function parseEnvTimeoutMs(): number {
    const parsed = Number(process.env.HERMES_AGENT_TIMEOUT_MS ?? 120000)
    if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`Invalid HERMES_AGENT_TIMEOUT_MS: "${process.env.HERMES_AGENT_TIMEOUT_MS}"`)
    }
    return parsed
}

function assertValidTimeoutMs(value: number): void {
    if (!Number.isFinite(value) || value <= 0) {
        throw new Error(`Invalid timeoutMs: ${value}`)
    }
}

/**
 * Sanitize a title for use as a filename.
 */
function safeTitle(title: string): string {
    return title.replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]/g, '_').slice(0, 50)
}

/**
 * Minimal configuration interface for orchestrated multi-role runs.
 * Reserved for future batches — currently empty to avoid premature abstraction.
 */
export interface OrchestratedRuntimeConfig {
    // Reserved for future batches — per-role orchestration configuration
}

/**
 * Resolve the planner profileName from roleBindings.
 * Throws explicitly if the planner binding is missing.
 */
function resolvePlannerBinding(input: HermesAgentRuntimeInput): string {
    const binding = input.roleBindings?.get('planner')
    if (!binding) {
        throw new Error(
            'OrchestratedGatewayRuntime requires a planner role binding. ' +
            'Ensure roleBindings.get("planner") is set before starting an orchestrated run.',
        )
    }
    return binding.profileName
}

/**
 * Resolve the developer profileName from roleBindings with fallback.
 *
 * Resolution priority (matching GatewayHermesRuntime convention):
 *   1. roleBindings.get('developer') → profileName
 *   2. assignedAgentId fallback
 *   3. undefined (constructor defaults via profile resolver)
 */
function resolveDeveloperBinding(input: HermesAgentRuntimeInput): {
    profileName: string | undefined
    bindingSource: 'role-binding' | 'assigned-agent' | 'none'
} {
    const binding = input.roleBindings?.get('developer')
    if (binding) {
        return { profileName: binding.profileName, bindingSource: 'role-binding' }
    }
    if (input.assignedAgentId) {
        return { profileName: input.assignedAgentId, bindingSource: 'assigned-agent' }
    }
    return { profileName: undefined, bindingSource: 'none' }
}

/**
 * Build planner-specific input text for the Gateway run.
 * Focuses on planning context — does not ask for code implementation.
 */
function buildPlannerInput(input: HermesAgentRuntimeInput): string {
    const parts = [
        `任务标题：${input.taskTitle}`,
        `任务描述：${input.taskDescription}`,
        `当前阶段：${input.currentStatus}`,
        `修订轮次：${input.revisionRound}`,
        '',
        '请为该任务制定详细的执行计划，包括关键步骤、技术方案和潜在风险。',
    ]
    return parts.join('\n')
}

/**
 * Build planner-specific system instructions for the Gateway agent.
 * Constrains the agent to planning only — no code implementation.
 */
function buildPlannerInstructions(input: HermesAgentRuntimeInput): string {
    return [
        '你是 AgentRoom 中的规划 Agent。',
        '你的职责是为任务制定清晰的执行计划，不要执行代码实现。',
        '请返回详细的执行计划、关键步骤、技术方案和潜在风险。',
        `当前任务：${input.taskTitle}`,
    ].join('\n')
}

/**
 * Build developer-specific input text for the Gateway run.
 * Includes task context, planner plan, revision round, and output requirements.
 */
function buildDeveloperInput(input: HermesAgentRuntimeInput, plannerPlan: string): string {
    const parts = [
        `任务标题：${input.taskTitle}`,
        `任务描述：${input.taskDescription}`,
        `当前阶段：${input.currentStatus}`,
        `修订轮次：${input.revisionRound}`,
        '',
        '--- 执行计划（由规划 Agent 生成）---',
        plannerPlan,
        '--- 计划结束 ---',
        '',
        '请根据上述执行计划，完成任务的具体实现。',
        '请返回清晰的执行结果、关键步骤、产物说明和需要审核的内容。',
    ]
    return parts.join('\n')
}

/**
 * Build developer-specific system instructions for the Gateway agent.
 * Constrains the agent to execute based on the provided plan.
 */
function buildDeveloperInstructions(input: HermesAgentRuntimeInput): string {
    return [
        '你是 AgentRoom 中的开发 Agent。',
        '你将收到由规划 Agent 制定的执行计划，请根据计划完成任务实现。',
        '你只需要完成任务执行，不要输出 AgentRoom 状态机字段。',
        '请返回清晰的执行结果、关键步骤、产物说明和需要审核的内容。',
        `当前任务：${input.taskTitle}`,
    ].join('\n')
}

/**
 * Create role-tagged hook wrappers for observability.
 *
 * - onUpstreamRunCreated: forwarded as-is (caller handles upstreamRunId binding)
 * - onRawEvent: wraps event with _agentRole dimension before forwarding
 *
 * This ensures both planner and developer SSE events are persisted as gateway_sse
 * run_events with role attribution in the payload.
 */
function createRoleTaggedHooks(
    baseHooks: HermesAgentRuntimeHooks | undefined,
    role: 'planner' | 'developer',
): HermesAgentRuntimeHooks | undefined {
    if (!baseHooks) return undefined
    return {
        onUpstreamRunCreated: baseHooks.onUpstreamRunCreated,
        onRawEvent: baseHooks.onRawEvent
            ? (event: Record<string, unknown>) => {
                // Attach role dimension to the raw event payload
                baseHooks.onRawEvent!({ ...event, _agentRole: role })
            }
            : undefined,
    }
}

/**
 * Orchestrated Gateway runtime.
 *
 * P4.11-A4 behavior: executes planner → developer dual-run Gateway orchestration.
 *   1. Resolve planner binding → execute planner Gateway run
 *   2. Resolve developer binding → execute developer Gateway run with planner output
 *   3. Return ordered steps: planned → assigned → in_progress → submitted_for_review
 *
 * P4.11-A5 observability:
 *   - Both planner and developer SSE events persisted via role-tagged hooks
 *   - Metadata includes plannerRunId, developerRunId, plannerProfileName, developerProfileName
 *   - run.upstreamRunId ends with developer's run ID (developer is primary execution role)
 */
export class OrchestratedGatewayRuntime implements HermesAgentRuntime {
    private readonly profileResolver: GatewayProfileResolver

    constructor(
        private readonly upstream = UPSTREAM,
        private readonly apiKey?: string | null,
        private readonly timeoutMs = parseEnvTimeoutMs(),
        profileResolver?: GatewayProfileResolver,
        // Config reserved for future batches — accepted but not yet used
        private readonly _config?: OrchestratedRuntimeConfig,
    ) {
        assertValidTimeoutMs(this.timeoutMs)
        this.profileResolver = profileResolver ?? createDefaultGatewayProfileResolver()
    }

    async runTask(input: HermesAgentRuntimeInput): Promise<HermesAgentRuntimeOutput> {
        // Only 'created' is supported for orchestrated dual-run.
        // Other statuses require different step sequences (not yet implemented).
        if (input.currentStatus !== 'created') {
            throw new Error(
                `OrchestratedGatewayRuntime dual-run requires status 'created', got '${input.currentStatus}'. ` +
                'Revision/retry step sequences are not yet implemented.',
            )
        }

        // ── Phase 1: Planner run ──────────────────────────────────

        // Step 1: Resolve planner binding — fail explicitly if missing
        const plannerProfileName = resolvePlannerBinding(input)

        // Step 2: Resolve planner Gateway target via profile resolver
        const plannerTarget = this.profileResolver(
            plannerProfileName,
            this.upstream,
            this.apiKey,
        )

        // Step 3: Execute planner Gateway run with role-tagged hooks
        const plannerSessionId = `agent-room-planner-${input.sessionId}-${input.taskId}`
        const plannerHooks = createRoleTaggedHooks(input.hooks, 'planner')

        let plannerResult: Awaited<ReturnType<typeof runHermesGatewayTask>>
        try {
            plannerResult = await runHermesGatewayTask({
                upstream: plannerTarget.upstream,
                apiKey: plannerTarget.apiKey,
                input: buildPlannerInput(input),
                instructions: buildPlannerInstructions(input),
                sessionId: plannerSessionId,
                timeoutMs: this.timeoutMs,
                model: plannerTarget.model,
                provider: plannerTarget.provider,
                onUpstreamRunCreated: plannerHooks?.onUpstreamRunCreated,
                onRawEvent: plannerHooks?.onRawEvent,
            })
        } catch (err: any) {
            console.error(
                `[orchestrated-runtime] Planner phase failed (profile=${plannerProfileName}, task=${input.taskId}):`,
                err?.message ?? err,
            )
            throw new Error(
                `Orchestrated planner phase failed: ${err?.message ?? err}`,
            )
        }

        // ── Phase 2: Developer run ────────────────────────────────

        // Step 4: Resolve developer binding — fallback to assignedAgentId or defaults
        const { profileName: developerProfileName, bindingSource: developerBindingSource } =
            resolveDeveloperBinding(input)

        // Step 5: Resolve developer Gateway target via profile resolver
        const developerTarget = this.profileResolver(
            developerProfileName,
            this.upstream,
            this.apiKey,
        )

        // Step 6: Execute developer Gateway run with planner output as plan context
        const developerSessionId = `agent-room-developer-${input.sessionId}-${input.taskId}`
        const developerHooks = createRoleTaggedHooks(input.hooks, 'developer')

        let developerResult: Awaited<ReturnType<typeof runHermesGatewayTask>>
        try {
            developerResult = await runHermesGatewayTask({
                upstream: developerTarget.upstream,
                apiKey: developerTarget.apiKey,
                input: buildDeveloperInput(input, plannerResult.output),
                instructions: buildDeveloperInstructions(input),
                sessionId: developerSessionId,
                timeoutMs: this.timeoutMs,
                model: developerTarget.model,
                provider: developerTarget.provider,
                onUpstreamRunCreated: developerHooks?.onUpstreamRunCreated,
                onRawEvent: developerHooks?.onRawEvent,
            })
        } catch (err: any) {
            console.error(
                `[orchestrated-runtime] Developer phase failed (profile=${developerProfileName ?? '(default)'}, plannerRunId=${plannerResult.runId}, task=${input.taskId}):`,
                err?.message ?? err,
            )
            throw new Error(
                `Orchestrated developer phase failed: ${err?.message ?? err}`,
            )
        }

        // ── Build output ──────────────────────────────────────────

        // Step 7: Build dual-run metadata
        const plannerMetadata: HermesAgentRuntimeMetadata = {
            plannerRunId: plannerResult.runId,
            plannerProfileName,
            plannerSource: 'orchestrated-planner',
        }
        if (plannerTarget.model) plannerMetadata.plannerModel = plannerTarget.model
        if (plannerTarget.provider) plannerMetadata.plannerProvider = plannerTarget.provider
        if (plannerTarget.transportSource) {
            plannerMetadata.plannerTransportSource = plannerTarget.transportSource
        }

        const developerMetadata: HermesAgentRuntimeMetadata = {
            developerRunId: developerResult.runId,
            developerProfileName: developerProfileName ?? '(default)',
            developerSource: 'orchestrated-developer',
            developerBindingSource,
        }
        if (developerTarget.model) developerMetadata.developerModel = developerTarget.model
        if (developerTarget.provider) developerMetadata.developerProvider = developerTarget.provider
        if (developerTarget.transportSource) {
            developerMetadata.developerTransportSource = developerTarget.transportSource
        }

        // Combined metadata for the final submitted_for_review step
        const combinedMetadata: Record<string, unknown> = {
            ...plannerMetadata,
            ...developerMetadata,
            source: 'orchestrated-dual-run',
        }

        const title = input.taskTitle
        const safeName = safeTitle(title)

        // Step 8: Return ordered steps: planned → assigned → in_progress → submitted_for_review
        return {
            steps: [
                {
                    status: 'planned',
                    activeRole: 'planner',
                    events: [{
                        type: 'task_planned',
                        agentRole: 'planner',
                        payload: plannerMetadata as Record<string, unknown>,
                    }],
                    messages: [{
                        senderRole: 'planner',
                        senderId: 'planner',
                        senderName: '规划 Agent',
                        content: plannerResult.output,
                        metadata: plannerMetadata as Record<string, unknown>,
                    }],
                },
                {
                    status: 'assigned',
                    activeRole: 'developer',
                    events: [{
                        type: 'task_assigned',
                        agentRole: 'developer',
                        payload: {
                            developerProfileName: developerProfileName ?? '(default)',
                            developerBindingSource,
                        },
                    }],
                },
                {
                    status: 'in_progress',
                    activeRole: 'developer',
                    events: [{
                        type: 'task_started',
                        agentRole: 'developer',
                    }],
                    messages: [{
                        senderRole: 'developer',
                        senderId: 'developer',
                        senderName: '开发 Agent',
                        content: `开始根据规划 Agent 的执行计划实现任务「${title}」。`,
                    }],
                },
                {
                    status: 'submitted_for_review',
                    activeRole: 'developer',
                    events: [{
                        type: 'task_submitted',
                        agentRole: 'developer',
                        payload: combinedMetadata,
                    }],
                    messages: [{
                        senderRole: 'developer',
                        senderId: 'developer',
                        senderName: '开发 Agent',
                        type: 'agent_message',
                        content: developerResult.output,
                        metadata: combinedMetadata,
                    }],
                },
            ],
            artifacts: [{
                name: `${safeName}.md`,
                type: 'code_output',
                content: developerResult.output,
                metadata: combinedMetadata,
            }],
        }
    }
}
