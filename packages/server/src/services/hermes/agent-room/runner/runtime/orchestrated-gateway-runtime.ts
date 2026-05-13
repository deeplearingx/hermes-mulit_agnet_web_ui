// ─── Orchestrated Gateway Runtime ────────────────────────────────
// Multi-role orchestrated runtime that executes per-role Gateway runs
// for planner → developer → reviewer → delivery.
//
// P4.11-A3: Planner-only Gateway run.
// P4.11-A4: Planner → developer dual-run orchestration.
//   - Resolves planner profile from roleBindings.get('planner') with active profile fallback
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
// P2: Reviewer phase — extends multi-role pipeline to planner → developer → reviewer.
//   - Resolves reviewer profile from roleBindings.get('reviewer') with active profile fallback
//   - Executes reviewer Gateway run using developer output as review context
//   - Produces unified reviewer metadata (reviewerRunId, reviewerProfileName,
//     reviewDecision, reviewFeedback) compatible with manual submitReview path
//   - Final status: review_passed | revision_required | need_user_decision
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
    HermesAgentRuntimeStep,
    HermesAgentRuntimeArtifact,
    ReviewerDecision,
    ReviewerOutput,
} from './types'
import type { GatewayProfileResolver, GatewayRuntimeTarget } from './gateway-profile-resolver'
import { createDefaultGatewayProfileResolver } from './gateway-profile-resolver'
import { runHermesGatewayTask } from '../../../gateway-run-client'
import { inferProvider, inferProviderForProfile } from '../../../../../shared/infer-provider'
import { config } from '../../../../../config'
import { logger } from '../../../../logger'

const UPSTREAM = config.upstream.replace(/\/$/, '')

/** Default orchestrated timeout: 300s (up from 120s to accommodate real model latency). */
const DEFAULT_ORCHESTRATED_TIMEOUT_MS = 300_000

function parseEnvTimeoutMs(): number {
    const parsed = Number(process.env.HERMES_AGENT_TIMEOUT_MS ?? DEFAULT_ORCHESTRATED_TIMEOUT_MS)
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

type RoleBindingSource = 'role-binding' | 'assigned-agent' | 'env-assigned-agent' | 'active-profile'

interface ResolvedRoleBinding {
    profileName: string | undefined
    bindingSource: RoleBindingSource
    /** Optional explicit provider override from role binding. */
    provider?: string
    /** Optional explicit model override from role binding. */
    model?: string
}

function resolveActiveProfileFallback(input: HermesAgentRuntimeInput): ResolvedRoleBinding {
    if (input.assignedAgentId) {
        return { profileName: input.assignedAgentId, bindingSource: 'assigned-agent' }
    }
    if (process.env.AGENT_ROOM_ASSIGNED_AGENT_ID) {
        return { profileName: process.env.AGENT_ROOM_ASSIGNED_AGENT_ID, bindingSource: 'env-assigned-agent' }
    }
    return { profileName: undefined, bindingSource: 'active-profile' }
}

/**
 * Resolve a role profileName from explicit role binding or current active Hermes profile.
 *
 * Resolution priority:
 *   1. roleBindings.get(role) → explicit profileName
 *   2. task/input assignedAgentId
 *   3. AGENT_ROOM_ASSIGNED_AGENT_ID
 *   4. undefined, letting GatewayManager/default resolver pick the active profile
 */
function resolveExecutableRoleBinding(input: HermesAgentRuntimeInput, role: 'planner' | 'developer' | 'reviewer'): ResolvedRoleBinding {
    const binding = input.roleBindings?.get(role)
    if (binding) {
        return {
            profileName: binding.profileName,
            bindingSource: 'role-binding',
            provider: binding.provider,
            model: binding.model,
        }
    }
    return resolveActiveProfileFallback(input)
}

function displayProfileName(resolved: ResolvedRoleBinding): string {
    return resolved.profileName ?? '(active-profile)'
}

interface ResolvedGatewayRunTarget extends GatewayRuntimeTarget {
    providerInferred: boolean
}

/**
 * Resolve the final provider/model pair for a Gateway run.
 *
 * Priority:
 *   1. binding.provider / binding.model (explicit from role binding)
 *   2. If no model override, reuse profileResolver's provider
 *   3. If final model exists but provider is still missing → inferProviderForProfile() then inferProvider()
 *
 * Returns a new GatewayRuntimeTarget with the exact model/provider that should
 * be sent to /v1/runs.
 */
async function resolveGatewayRunTarget(
    target: GatewayRuntimeTarget,
    binding: ResolvedRoleBinding,
): Promise<ResolvedGatewayRunTarget> {
    const modelOverride = binding.model?.trim() || undefined
    const providerOverride = binding.provider?.trim() || undefined

    const finalModel = modelOverride ?? target.model
    let finalProvider = providerOverride
    let providerInferred = false

    if (!finalProvider && finalModel) {
        if (!modelOverride) {
            finalProvider = target.provider
        }
        if (!finalProvider) {
            finalProvider = await inferProviderForProfile(binding.profileName, finalModel)
        }
        if (!finalProvider) {
            finalProvider = await inferProvider(finalModel)
        }
        providerInferred = !!finalProvider
    }

    return {
        ...target,
        model: finalModel,
        provider: finalProvider,
        providerInferred,
    }
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
        '请优先给出可验证的最小实现结果，不要展开冗长推理。',
        '输出请控制在 1200 字以内，包含：执行结果、关键变更、验证建议、风险。',
        '不要代替审核 Agent 输出审核结论，不要伪造 reviewer/review JSON、approved 结论或验收结果。',
        '如果任务需要实际代码修改但当前运行环境不能修改文件，请明确说明限制和建议的最小补丁，不要长时间等待。',
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
        '不要代替审核 Agent 做验收，不要输出 reviewer 视角的结论或 JSON。',
        '输出必须简洁，不要输出长篇思考过程。',
        '请在 1200 字以内返回结果，避免生成过长内容导致 Gateway 超时。',
        '如果无法完成，快速返回阻塞原因和下一步，不要无限等待。',
        '请返回清晰的执行结果、关键步骤、产物说明和需要审核的内容。',
        `当前任务：${input.taskTitle}`,
    ].join('\n')
}


/**
 * Build reviewer-specific input text for the Gateway run.
 * Includes developer output as the artifact to review.
 * P5.2: Enforces JSON-only output protocol.
 */
function buildReviewerInput(input: HermesAgentRuntimeInput, developerOutput: string): string {
    const parts = [
        `任务标题：${input.taskTitle}`,
        `任务描述：${input.taskDescription}`,
        `当前阶段：${input.currentStatus}`,
        `修订轮次：${input.revisionRound}`,
        '',
        '--- 开发输出（由开发 Agent 生成）---',
        developerOutput,
        '--- 输出结束 ---',
        '',
        '请审核上述开发输出。你必须且只能返回以下 JSON 格式，不要添加任何其他文本：',
        '',
        '```json',
        '{',
        '  "decision": "approved | revision_required | need_user_decision",',
        '  "feedback": "审核反馈",',
        '  "issues": ["问题1", "问题2"],',
        '  "confidence": 0.0',
        '}',
        '```',
        '',
        '字段说明：',
        '- decision: 必须是 "approved"、"revision_required" 或 "need_user_decision" 之一',
        '- feedback: 必须非空，描述审核意见',
        '- issues: 可选，列出具体问题',
        '- confidence: 可选，0.0-1.0 的置信度',
    ]
    return parts.join('\n')
}

/**
 * Build reviewer-specific system instructions for the Gateway agent.
 * Constrains the agent to review only — no implementation.
 * P5.2: Enforces JSON-only output protocol.
 */
function buildReviewerInstructions(input: HermesAgentRuntimeInput): string {
    return [
        '你是 AgentRoom 中的审核 Agent。',
        '你只需要审核开发 Agent 的输出质量，不要执行代码实现。',
        '',
        '【输出协议 — 严格遵守】',
        '你必须且只能输出一个合法的 JSON 对象，不得包含任何其他文本、markdown 标记或解释。',
        'JSON schema：',
        '{ "decision": "approved|revision_required|need_user_decision", "feedback": "非空字符串", "issues": ["可选问题列表"], "confidence": 0.0 }',
        '',
        '如果你对实现有疑虑，请使用 revision_required 而非 approved。',
        '宁可误报也不要漏报——安全优先。',
        `当前任务：${input.taskTitle}`,
    ].join('\n')
}

/**
 * P2: Resolve the delivery profileName from roleBindings.
 * Returns null if no delivery binding exists — delivery Agent is optional.
 */
function resolveDeliveryBinding(input: HermesAgentRuntimeInput): string | null {
    const binding = input.roleBindings?.get('delivery')
    return binding?.profileName ?? null
}

/**
 * Resolve delivery binding with provider/model overrides.
 * Returns a ResolvedRoleBinding for final Gateway run target resolution.
 */
function resolveDeliveryBindingFull(input: HermesAgentRuntimeInput): ResolvedRoleBinding | null {
    const binding = input.roleBindings?.get('delivery')
    if (!binding?.profileName) return null
    return {
        profileName: binding.profileName,
        bindingSource: 'role-binding',
        provider: binding.provider,
        model: binding.model,
    }
}

/**
 * P2: Build delivery-specific input text for the Gateway run.
 * Provides the delivery Agent with planner plan, developer output, and reviewer feedback.
 */
function buildDeliveryInput(
    input: HermesAgentRuntimeInput,
    plannerOutput: string,
    developerOutput: string,
    reviewerFeedback: string,
): string {
    const lines = [
        `任务需求: ${input.taskDescription}`,
        '',
        '规划 Agent 输出:',
        plannerOutput,
        '',
        '开发 Agent 输出:',
        developerOutput,
        '',
        '审核 Agent 反馈:',
        reviewerFeedback,
        '',
        '请基于以上信息生成最终交付汇报。',
    ]
    return lines.join('\n')
}

/**
 * P2: Build delivery-specific system instructions for the Gateway agent.
 */
function buildDeliveryInstructions(_input: HermesAgentRuntimeInput): string {
    return '你是一个交付 Agent。请基于规划方案、开发输出和审核反馈，输出一份完整的最终交付文档。'
}

/**
 * Build developer-specific input text for a revision retry.
 * Includes task context, revision round, and previous review feedback
 * so the developer can address specific reviewer concerns.
 */
function buildRevisionDeveloperInput(input: HermesAgentRuntimeInput): string {
    const parts = [
        `任务标题：${input.taskTitle}`,
        `任务描述：${input.taskDescription}`,
        `当前阶段：${input.currentStatus}`,
        `修订轮次：${input.revisionRound}`,
    ]

    if (input.previousReviewFeedback) {
        parts.push(
            '',
            '--- 上一轮审核反馈（需要针对以下反馈进行修改）---',
            input.previousReviewFeedback,
            '--- 反馈结束 ---',
            '',
            '请根据上述审核反馈修改你的实现。重点解决审核者提出的问题，同时保持已有工作的完整性。',
        )
    } else {
        parts.push(
            '',
            '请重新实现任务，之前的工作因执行失败需要重试。',
        )
    }

    parts.push(
        '',
        '请返回清晰的执行结果、关键步骤、产物说明和需要审核的内容。',
        '不要代替审核 Agent 输出审核结论，不要伪造 reviewer/review JSON、approved 结论或验收结果。',
    )
    return parts.join('\n')
}

/**
 * Build developer-specific system instructions for a revision retry.
 * Constrains the agent to revision based on review feedback.
 */
function buildRevisionDeveloperInstructions(input: HermesAgentRuntimeInput): string {
    return [
        '你是 AgentRoom 中的开发 Agent，当前处于修订模式。',
        '你将收到上一轮审核的反馈，请根据反馈修改你的实现。',
        '不要重新执行整个任务，只需针对审核反馈进行修正。',
        '你只需要完成任务执行，不要输出 AgentRoom 状态机字段。',
        '不要代替审核 Agent 做验收，不要输出 reviewer 视角的结论或 JSON。',
        '请返回清晰的执行结果、关键步骤、产物说明和需要审核的内容。',
        `当前任务：${input.taskTitle}`,
        `修订轮次：${input.revisionRound}`,
    ].join('\n')
}

/**
 * Valid decision values for validation.
 */
const VALID_DECISIONS: ReadonlySet<string> = new Set<ReviewerDecision>([
    'approved', 'revision_required', 'need_user_decision',
])

/**
 * P5.2: Parse reviewer output using JSON-first strategy with safe fallback.
 *
 * Strategy:
 *   1. Try to parse as JSON — if valid and decision is legal, use it directly
 *   2. If JSON is valid but decision is missing or invalid → default revision_required
 *   3. If JSON is invalid → default revision_required, NEVER approved
 *   4. If feedback is empty in JSON → fill with raw output
 *
 * Design principle: safety-first. A real model may output ambiguous text like
 * "这个实现未通过，需要修改" which contains "通过" but is clearly revision_required.
 * JSON protocol eliminates this class of false positives.
 */
export function parseReviewerOutput(output: string): ReviewerOutput {
    const trimmed = output.trim()

    // ── Step 1: Try JSON parse ────────────────────────────────────
    let parsed: Record<string, unknown> | null = null
    try {
        // Handle markdown-wrapped JSON: ```json\n{...}\n```
        const jsonMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/)
        const jsonStr = jsonMatch ? jsonMatch[1].trim() : trimmed
        parsed = JSON.parse(jsonStr) as Record<string, unknown>
    } catch {
        // Not valid JSON — will fall through to text fallback
        parsed = null
    }

    // ── Step 2: Valid JSON path ───────────────────────────────────
    if (parsed && typeof parsed === 'object') {
        const rawDecision = parsed.decision
        const rawFeedback = parsed.feedback
        const rawIssues = parsed.issues
        const rawConfidence = parsed.confidence

        // Validate decision
        const decision: ReviewerDecision =
            (typeof rawDecision === 'string' && VALID_DECISIONS.has(rawDecision))
                ? rawDecision as ReviewerDecision
                : 'revision_required'  // missing or invalid decision → safe default

        // Validate feedback — empty feedback gets filled with raw output
        const feedback: string =
            (typeof rawFeedback === 'string' && rawFeedback.trim().length > 0)
                ? rawFeedback.trim()
                : trimmed

        // Validate issues (optional) — empty array → undefined
        const filteredIssues =
            (Array.isArray(rawIssues) && rawIssues.every(i => typeof i === 'string'))
                ? rawIssues.filter(i => i.trim().length > 0)
                : undefined
        const issues: string[] | undefined =
            (filteredIssues && filteredIssues.length > 0) ? filteredIssues : undefined

        // Validate confidence (optional)
        const confidence: number | undefined =
            (typeof rawConfidence === 'number' && Number.isFinite(rawConfidence))
                ? Math.max(0, Math.min(1, rawConfidence))
                : undefined

        return { decision, feedback, issues, confidence }
    }

    // ── Step 3: Non-JSON fallback → revision_required (NEVER approved) ─
    // Safety: even if raw text contains "approved" or "通过", we cannot trust
    // a model that didn't follow the JSON protocol.
    return {
        decision: 'revision_required',
        feedback: trimmed,
    }
}

/**
 * Create role-tagged hook wrappers for observability.
 *
 * P5.1: onUpstreamRunCreated now injects role context so the service layer
 * can bind the upstream run_id to the correct role_run by role name
 * instead of relying on sequential index.
 *
 * - onUpstreamRunCreated: wraps call with { role } context
 * - onRawEvent: wraps event with _agentRole dimension before forwarding
 *
 * This ensures both planner and developer SSE events are persisted as gateway_sse
 * run_events with role attribution in the payload.
 */
function createRoleTaggedHooks(
    baseHooks: HermesAgentRuntimeHooks | undefined,
    role: 'planner' | 'developer' | 'reviewer' | 'delivery',
): HermesAgentRuntimeHooks | undefined {
    if (!baseHooks) return undefined
    return {
        // P5.1: Inject role context into onUpstreamRunCreated so the service layer
        // can bind upstream_run_id to the correct role_run by role name.
        onUpstreamRunCreated: baseHooks.onUpstreamRunCreated
            ? (upstreamRunId: string) => {
                baseHooks.onUpstreamRunCreated!(upstreamRunId, { role })
            }
            : undefined,
        onRawEvent: baseHooks.onRawEvent
            ? (event: Record<string, unknown>) => {
                // Attach role dimension to the raw event payload
                baseHooks.onRawEvent!({ ...event, _agentRole: role })
            }
            : undefined,
        // P6.3: onReviewerDecision no longer forwarded — reviewerDecision is returned in output
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
        // Route to retry path for revision/retry statuses
        const retryStatuses = ['revision_required', 'need_user_decision', 'failed']
        if (retryStatuses.includes(input.currentStatus)) {
            return this.runRetryPath(input)
        }

        if (input.currentStatus !== 'created') {
            throw new Error(
                `OrchestratedGatewayRuntime only supports 'created', 'revision_required', 'need_user_decision', 'failed'. Got '${input.currentStatus}'.`,
            )
        }

        // ── Phase 1: Planner run (created path) ───────────────────

        // Step 1: Resolve planner binding or fall back to the current active Hermes profile
        const plannerBinding = resolveExecutableRoleBinding(input, 'planner')
        const plannerProfileName = plannerBinding.profileName

        // Step 2: Resolve planner Gateway target via profile resolver + binding overrides
        const plannerTargetRaw = this.profileResolver(
            plannerProfileName,
            this.upstream,
            this.apiKey,
        )
        const plannerTarget = await resolveGatewayRunTarget(plannerTargetRaw, plannerBinding)

        // Step 3: Execute planner Gateway run with role-tagged hooks
        const plannerSessionId = `agent-room-planner-${input.sessionId}-${input.taskId}`
        const plannerHooks = createRoleTaggedHooks(input.hooks, 'planner')
        logger.info({
            role: 'planner',
            profile: displayProfileName(plannerBinding),
            source: plannerBinding.bindingSource,
            model: plannerTarget.model,
            provider: plannerTarget.provider,
            providerInferred: plannerTarget.providerInferred,
        }, '[orchestrated-runtime] Resolved planner Gateway target')

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
            const plannerDiag = {
                role: 'planner',
                profile: displayProfileName(plannerBinding),
                source: plannerBinding.bindingSource,
                sessionId: plannerSessionId,
                timeoutMs: this.timeoutMs,
                taskId: input.taskId,
            }
            logger.error(
                { err, ...plannerDiag },
                '[orchestrated-runtime] Planner phase failed',
            )
            throw new Error(
                `Orchestrated planner phase failed [role=planner, profile=${plannerDiag.profile}, source=${plannerDiag.source}, sessionId=${plannerDiag.sessionId}, timeoutMs=${plannerDiag.timeoutMs}, taskId=${plannerDiag.taskId}]: ${err?.message ?? err}`,
            )
        }

        // ── Phase 2: Developer run ────────────────────────────────

        // Step 4: Resolve developer binding — fallback to assignedAgentId or defaults
        const developerBinding = resolveExecutableRoleBinding(input, 'developer')
        const { profileName: developerProfileName, bindingSource: developerBindingSource } = developerBinding

        // Step 5: Resolve developer Gateway target via profile resolver + binding overrides
        const developerTargetRaw = this.profileResolver(
            developerProfileName,
            this.upstream,
            this.apiKey,
        )
        const developerTarget = await resolveGatewayRunTarget(developerTargetRaw, developerBinding)

        // Step 6: Execute developer Gateway run with planner output as plan context
        const developerSessionId = `agent-room-developer-${input.sessionId}-${input.taskId}`
        const developerHooks = createRoleTaggedHooks(input.hooks, 'developer')
        logger.info({
            role: 'developer',
            profile: displayProfileName(developerBinding),
            source: developerBindingSource,
            model: developerTarget.model,
            provider: developerTarget.provider,
            providerInferred: developerTarget.providerInferred,
        }, '[orchestrated-runtime] Resolved developer Gateway target')

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
            const diag = {
                role: 'developer',
                profile: displayProfileName(developerBinding),
                source: developerBindingSource,
                sessionId: developerSessionId,
                timeoutMs: this.timeoutMs,
                plannerRunId: plannerResult.runId,
                taskId: input.taskId,
            }
            logger.error(
                { err, ...diag },
                '[orchestrated-runtime] Developer phase failed',
            )
            throw new Error(
                `Orchestrated developer phase failed [role=developer, profile=${diag.profile}, source=${diag.source}, sessionId=${diag.sessionId}, timeoutMs=${diag.timeoutMs}, plannerRunId=${diag.plannerRunId}, taskId=${diag.taskId}]: ${err?.message ?? err}`,
            )
        }

        // ── Phase 3: Reviewer run ────────────────────────────────

        // Step 7: Resolve reviewer binding or fall back to the current active Hermes profile
        const reviewerBinding = resolveExecutableRoleBinding(input, 'reviewer')
        const reviewerProfileName = reviewerBinding.profileName

        // Step 8: Resolve reviewer Gateway target via profile resolver + binding overrides
        const reviewerTargetRaw = this.profileResolver(
            reviewerProfileName,
            this.upstream,
            this.apiKey,
        )
        const reviewerTarget = await resolveGatewayRunTarget(reviewerTargetRaw, reviewerBinding)

        // Step 9: Execute reviewer Gateway run using developer output as review context
        const reviewerSessionId = `agent-room-reviewer-${input.sessionId}-${input.taskId}`
        const reviewerHooks = createRoleTaggedHooks(input.hooks, 'reviewer')
        logger.info({
            role: 'reviewer',
            profile: displayProfileName(reviewerBinding),
            source: reviewerBinding.bindingSource,
            model: reviewerTarget.model,
            provider: reviewerTarget.provider,
            providerInferred: reviewerTarget.providerInferred,
        }, '[orchestrated-runtime] Resolved reviewer Gateway target')

        let reviewerResult: Awaited<ReturnType<typeof runHermesGatewayTask>>
        try {
            reviewerResult = await runHermesGatewayTask({
                upstream: reviewerTarget.upstream,
                apiKey: reviewerTarget.apiKey,
                input: buildReviewerInput(input, developerResult.output),
                instructions: buildReviewerInstructions(input),
                sessionId: reviewerSessionId,
                timeoutMs: this.timeoutMs,
                model: reviewerTarget.model,
                provider: reviewerTarget.provider,
                onUpstreamRunCreated: reviewerHooks?.onUpstreamRunCreated,
                onRawEvent: reviewerHooks?.onRawEvent,
            })
        } catch (err: any) {
            logger.error(
                { err, profile: displayProfileName(reviewerBinding), source: reviewerBinding.bindingSource, developerRunId: developerResult.runId, taskId: input.taskId },
                '[orchestrated-runtime] Reviewer phase failed',
            )
            throw new Error(
                `Orchestrated reviewer phase failed: ${err?.message ?? err}`,
            )
        }

        // ── Phase 4: Delivery run (P2 — optional, only when approved + delivery binding) ──

        // Step 10: P5.2 — Parse reviewer output using JSON protocol
        const reviewerParsed = parseReviewerOutput(reviewerResult.output)
        const reviewDecision = reviewerParsed.decision
        const reviewFeedback = reviewerParsed.feedback

        // P6.3: reviewerDecision is returned in the output instead of hook call.
        // applyRunnerResult() will write the review record in the same transaction.

        // P2: Run delivery Gateway if approved and delivery binding exists
        let deliveryRunId: string | undefined
        let deliveryOutput: string | undefined
        let deliveryProfile: string | null = null

        if (reviewDecision === 'approved') {
            const deliveryBindingFull = resolveDeliveryBindingFull(input)
            deliveryProfile = deliveryBindingFull?.profileName ?? null
            if (deliveryProfile && deliveryBindingFull) {
                const deliveryTargetRaw = this.profileResolver(
                    deliveryProfile,
                    this.upstream,
                    this.apiKey,
                )
                const deliveryTarget = await resolveGatewayRunTarget(deliveryTargetRaw, deliveryBindingFull)
                const deliverySessionId = `agent-room-delivery-${input.sessionId}-${input.taskId}`
                const deliveryHooks = createRoleTaggedHooks(input.hooks, 'delivery')
                logger.info({
                    role: 'delivery',
                    profile: deliveryProfile,
                    source: deliveryBindingFull.bindingSource,
                    model: deliveryTarget.model,
                    provider: deliveryTarget.provider,
                    providerInferred: deliveryTarget.providerInferred,
                }, '[orchestrated-runtime] Resolved delivery Gateway target')

                try {
                    const deliveryResult = await runHermesGatewayTask({
                        upstream: deliveryTarget.upstream,
                        apiKey: deliveryTarget.apiKey,
                        input: buildDeliveryInput(input, plannerResult.output, developerResult.output, reviewFeedback),
                        instructions: buildDeliveryInstructions(input),
                        sessionId: deliverySessionId,
                        timeoutMs: this.timeoutMs,
                        model: deliveryTarget.model,
                        provider: deliveryTarget.provider,
                        onUpstreamRunCreated: deliveryHooks?.onUpstreamRunCreated,
                        onRawEvent: deliveryHooks?.onRawEvent,
                    })
                    deliveryRunId = deliveryResult.runId
                    deliveryOutput = deliveryResult.output
                } catch (err: any) {
                    logger.error(
                        { err, profile: deliveryProfile, taskId: input.taskId },
                        '[orchestrated-runtime] Delivery phase failed',
                    )
                    throw new Error(
                        `Orchestrated delivery phase failed: ${err?.message ?? err}`,
                    )
                }
            }
        }

        // ── Build output ──────────────────────────────────────────

        // Step 11: Build dual-run metadata
        const plannerMetadata: HermesAgentRuntimeMetadata = {
            plannerRunId: plannerResult.runId,
            plannerProfileName: displayProfileName(plannerBinding),
            plannerBindingSource: plannerBinding.bindingSource,
            plannerSource: 'orchestrated-planner',
        }
        if (plannerTarget.model) plannerMetadata.plannerModel = plannerTarget.model
        if (plannerTarget.provider) plannerMetadata.plannerProvider = plannerTarget.provider
        if (plannerTarget.transportSource) {
            plannerMetadata.plannerTransportSource = plannerTarget.transportSource
        }

        const developerMetadata: HermesAgentRuntimeMetadata = {
            developerRunId: developerResult.runId,
            developerProfileName: displayProfileName(developerBinding),
            developerSource: 'orchestrated-developer',
            developerBindingSource,
        }
        if (developerTarget.model) developerMetadata.developerModel = developerTarget.model
        if (developerTarget.provider) developerMetadata.developerProvider = developerTarget.provider
        if (developerTarget.transportSource) {
            developerMetadata.developerTransportSource = developerTarget.transportSource
        }

        // Unified reviewer metadata — compatible with manual submitReview path
        // P5.2: includes issues and confidence from structured JSON output
        const reviewerMetadata: HermesAgentRuntimeMetadata = {
            reviewerRunId: reviewerResult.runId,
            reviewerProfileName: displayProfileName(reviewerBinding),
            reviewerBindingSource: reviewerBinding.bindingSource,
            reviewDecision,
            reviewFeedback,
            reviewIssues: reviewerParsed.issues,
            reviewConfidence: reviewerParsed.confidence,
            reviewerSource: 'orchestrated-reviewer',
        }
        if (reviewerTarget.model) reviewerMetadata.reviewerModel = reviewerTarget.model
        if (reviewerTarget.provider) reviewerMetadata.reviewerProvider = reviewerTarget.provider
        if (reviewerTarget.transportSource) {
            reviewerMetadata.reviewerTransportSource = reviewerTarget.transportSource
        }

        // P2: Delivery metadata when delivery Agent was executed
        const deliveryMetadata: HermesAgentRuntimeMetadata = {}
        if (deliveryRunId) {
            deliveryMetadata.deliveryRunId = deliveryRunId
            deliveryMetadata.deliveryProfileName = deliveryProfile ?? undefined
            deliveryMetadata.deliverySource = 'orchestrated-delivery'
        }

        // Combined metadata for observability
        const combinedMetadata: Record<string, unknown> = {
            ...plannerMetadata,
            ...developerMetadata,
            ...reviewerMetadata,
            ...deliveryMetadata,
            source: deliveryRunId ? 'orchestrated-quadruple-run' : 'orchestrated-triple-run',
        }

        const title = input.taskTitle
        const safeName = safeTitle(title)

        // Step 12: Map reviewer decision to AgentRoom final status and event type
        type ReviewFinalStatus = 'review_passed' | 'revision_required' | 'need_user_decision'
        type ReviewEventType = 'review_passed' | 'review_rejected' | 'revision_started' | 'need_user_decision'

        const decisionStatusMap: Record<typeof reviewDecision, { status: ReviewFinalStatus; eventType: ReviewEventType }> = {
            approved: { status: 'review_passed', eventType: 'review_passed' },
            revision_required: { status: 'revision_required', eventType: 'revision_started' },
            need_user_decision: { status: 'need_user_decision', eventType: 'need_user_decision' },
        }

        const finalStatus = decisionStatusMap[reviewDecision]

        // P2: Build delivery steps when delivery Agent executed
        const hasDelivery = !!deliveryRunId
        const deliverySteps: HermesAgentRuntimeStep[] = hasDelivery ? [
            {
                status: 'delivering' as const,
                activeRole: 'delivery' as const,
                events: [{
                    type: 'delivery_started' as const,
                    agentRole: 'delivery' as const,
                    payload: { deliveryRunId, deliveryProfile },
                }],
            },
            {
                status: 'completed' as const,
                activeRole: 'delivery' as const,
                events: [{
                    type: 'delivery_completed' as const,
                    agentRole: 'delivery' as const,
                    payload: { deliveryRunId, deliveryProfile },
                }],
                messages: [{
                    senderRole: 'delivery' as const,
                    senderId: 'delivery',
                    senderName: '交付 Agent',
                    type: 'final_delivery' as const,
                    content: deliveryOutput ?? '',
                    metadata: { deliveryRunId, deliveryProfile },
                }],
            },
        ] : []

        // Step 13: Return ordered steps: planned → assigned → in_progress → submitted_for_review → review_final → (delivery)
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
                            developerProfileName: displayProfileName(developerBinding),
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
                // P2 reviewer decision: for non-approved decisions, state machine
                // requires submitted_for_review → review_rejected → revision_required|need_user_decision.
                // For approved, submitted_for_review → review_passed is a direct valid transition.
                ...(reviewDecision === 'approved'
                    ? [{
                        status: 'review_passed' as const,
                        activeRole: 'reviewer' as const,
                        events: [{
                            type: 'review_passed' as const,
                            agentRole: 'reviewer' as const,
                            payload: {
                                reviewerRunId: reviewerResult.runId,
                                reviewerProfileName: displayProfileName(reviewerBinding),
                                reviewerBindingSource: reviewerBinding.bindingSource,
                                reviewDecision,
                                reviewFeedback,
                            },
                        }],
                        messages: [{
                            senderRole: 'reviewer' as const,
                            senderId: 'reviewer',
                            senderName: '审核 Agent',
                            type: 'review_result' as const,
                            content: reviewFeedback,
                            metadata: {
                                reviewerRunId: reviewerResult.runId,
                                reviewerProfileName: displayProfileName(reviewerBinding),
                                reviewerBindingSource: reviewerBinding.bindingSource,
                                reviewDecision,
                            },
                        }],
                    }]
                    : [
                        // Intermediate transient step: review_rejected
                        {
                            status: 'review_rejected' as const,
                            activeRole: 'reviewer' as const,
                            events: [{
                                type: 'review_rejected' as const,
                                agentRole: 'reviewer' as const,
                                payload: {
                                    reviewerRunId: reviewerResult.runId,
                                    reviewerProfileName: displayProfileName(reviewerBinding),
                                    reviewerBindingSource: reviewerBinding.bindingSource,
                                    reviewDecision,
                                    reviewFeedback,
                                    revisionRound: input.revisionRound,
                                },
                            }],
                            messages: [{
                                senderRole: 'reviewer' as const,
                                senderId: 'reviewer',
                                senderName: '审核 Agent',
                                type: 'review_result' as const,
                                content: `❌ 审核驳回：${reviewFeedback}`,
                                metadata: {
                                    reviewerRunId: reviewerResult.runId,
                                    reviewerProfileName: displayProfileName(reviewerBinding),
                                    reviewerBindingSource: reviewerBinding.bindingSource,
                                    reviewDecision,
                                },
                            }],
                        },
                        // Final step: revision_required or need_user_decision
                        {
                            status: finalStatus.status,
                            activeRole: 'reviewer' as const,
                            events: [{
                                type: finalStatus.eventType,
                                agentRole: 'reviewer' as const,
                                payload: {
                                    reviewerRunId: reviewerResult.runId,
                                    reviewerProfileName: displayProfileName(reviewerBinding),
                                    reviewerBindingSource: reviewerBinding.bindingSource,
                                    reviewDecision,
                                    reviewFeedback,
                                    revisionRound: input.revisionRound,
                                },
                            }],
                            messages: [{
                                senderRole: 'reviewer' as const,
                                senderId: 'reviewer',
                                senderName: '审核 Agent',
                                type: 'review_result' as const,
                                content: reviewDecision === 'need_user_decision'
                                    ? `⚠️ 任务需要用户决策：${reviewFeedback}`
                                    : `需要修改：${reviewFeedback}`,
                                metadata: {
                                    reviewerRunId: reviewerResult.runId,
                                    reviewerProfileName: displayProfileName(reviewerBinding),
                                    reviewerBindingSource: reviewerBinding.bindingSource,
                                    reviewDecision,
                                },
                            }],
                        },
                    ]),
                // P2: Delivery steps when delivery Agent executed
                ...deliverySteps,
            ],
            artifacts: [
                {
                    name: `${safeName}.md`,
                    type: 'code_output',
                    content: developerResult.output,
                    metadata: combinedMetadata,
                },
                {
                    name: `${safeName}-review.md`,
                    type: 'review_report',
                    content: reviewFeedback,
                    metadata: {
                        reviewerRunId: reviewerResult.runId,
                        reviewerProfileName,
                        reviewDecision,
                    },
                },
                // P2: final_delivery artifact when delivery Agent executed
                ...(hasDelivery ? [{
                    name: `${safeName} — 交付结果`,
                    type: 'final_delivery' as const,
                    content: deliveryOutput ?? '',
                    metadata: {
                        deliveryRunId,
                        deliveryProfile,
                        source: 'orchestrated-delivery',
                    } as Record<string, unknown>,
                } as HermesAgentRuntimeArtifact] : []),
            ],
            // P6.3: Carry reviewer decision data for transactional review creation
            reviewerDecision: {
                sessionId: input.sessionId,
                taskId: input.taskId,
                reviewerProfileName: displayProfileName(reviewerBinding),
                reviewDecision,
                reviewFeedback,
                reviewerRunId: reviewerResult.runId,
                reviewIssues: reviewerParsed.issues,
                reviewConfidence: reviewerParsed.confidence,
            },
        }
    }

    /**
     * P3: Retry path for revision_required, need_user_decision, and failed.
     * Skips planner phase — executes developer (with review feedback context) → reviewer.
     *
     * Context inheritance:
     *   - planner metadata: NOT inherited (planner skipped)
     *   - developer metadata: NEW (new upstream run ID)
     *   - reviewer metadata: NEW (new upstream run ID)
     *   - revisionRound: managed by service-layer state machine
     *   - previousReviewFeedback: from store (last rejected review comment)
     */
    private async runRetryPath(input: HermesAgentRuntimeInput): Promise<HermesAgentRuntimeOutput> {
        // ── Phase 1: Developer revision run ──────────────────────

        const developerBinding = resolveExecutableRoleBinding(input, 'developer')
        const { profileName: developerProfileName, bindingSource: developerBindingSource } = developerBinding

        const developerTargetRaw = this.profileResolver(
            developerProfileName,
            this.upstream,
            this.apiKey,
        )
        const developerTarget = await resolveGatewayRunTarget(developerTargetRaw, developerBinding)

        const developerSessionId = `agent-room-developer-${input.sessionId}-${input.taskId}-rev${input.revisionRound}`
        const developerHooks = createRoleTaggedHooks(input.hooks, 'developer')
        logger.info({
            role: 'developer',
            profile: displayProfileName(developerBinding),
            source: developerBindingSource,
            model: developerTarget.model,
            provider: developerTarget.provider,
            providerInferred: developerTarget.providerInferred,
            retry: true,
        }, '[orchestrated-runtime] Resolved retry developer Gateway target')

        let developerResult: Awaited<ReturnType<typeof runHermesGatewayTask>>
        try {
            developerResult = await runHermesGatewayTask({
                upstream: developerTarget.upstream,
                apiKey: developerTarget.apiKey,
                input: buildRevisionDeveloperInput(input),
                instructions: buildRevisionDeveloperInstructions(input),
                sessionId: developerSessionId,
                timeoutMs: this.timeoutMs,
                model: developerTarget.model,
                provider: developerTarget.provider,
                onUpstreamRunCreated: developerHooks?.onUpstreamRunCreated,
                onRawEvent: developerHooks?.onRawEvent,
            })
        } catch (err: any) {
            const diag = {
                role: 'developer',
                profile: displayProfileName(developerBinding),
                source: developerBindingSource,
                sessionId: developerSessionId,
                timeoutMs: this.timeoutMs,
                revisionRound: input.revisionRound,
                taskId: input.taskId,
            }
            logger.error(
                { err, ...diag },
                '[orchestrated-runtime] Retry developer phase failed',
            )
            throw new Error(
                `Orchestrated retry developer phase failed [role=developer, profile=${diag.profile}, source=${diag.source}, sessionId=${diag.sessionId}, timeoutMs=${diag.timeoutMs}, revisionRound=${diag.revisionRound}, taskId=${diag.taskId}]: ${err?.message ?? err}`,
            )
        }

        // ── Phase 2: Reviewer run ────────────────────────────────

        const reviewerBinding = resolveExecutableRoleBinding(input, 'reviewer')

        const reviewerProfileName = reviewerBinding.profileName

        const reviewerTargetRaw = this.profileResolver(
            reviewerProfileName,
            this.upstream,
            this.apiKey,
        )
        const reviewerTarget = await resolveGatewayRunTarget(reviewerTargetRaw, reviewerBinding)

        const reviewerSessionId = `agent-room-reviewer-${input.sessionId}-${input.taskId}-rev${input.revisionRound}`
        const reviewerHooks = createRoleTaggedHooks(input.hooks, 'reviewer')
        logger.info({
            role: 'reviewer',
            profile: displayProfileName(reviewerBinding),
            source: reviewerBinding.bindingSource,
            model: reviewerTarget.model,
            provider: reviewerTarget.provider,
            providerInferred: reviewerTarget.providerInferred,
            retry: true,
        }, '[orchestrated-runtime] Resolved retry reviewer Gateway target')

        let reviewerResult: Awaited<ReturnType<typeof runHermesGatewayTask>>
        try {
            reviewerResult = await runHermesGatewayTask({
                upstream: reviewerTarget.upstream,
                apiKey: reviewerTarget.apiKey,
                input: buildReviewerInput(input, developerResult.output),
                instructions: buildReviewerInstructions(input),
                sessionId: reviewerSessionId,
                timeoutMs: this.timeoutMs,
                model: reviewerTarget.model,
                provider: reviewerTarget.provider,
                onUpstreamRunCreated: reviewerHooks?.onUpstreamRunCreated,
                onRawEvent: reviewerHooks?.onRawEvent,
            })
        } catch (err: any) {
            const diag = {
                role: 'reviewer',
                profile: displayProfileName(reviewerBinding),
                source: reviewerBinding.bindingSource,
                sessionId: reviewerSessionId,
                timeoutMs: this.timeoutMs,
                revisionRound: input.revisionRound,
                developerRunId: developerResult.runId,
                taskId: input.taskId,
            }
            logger.error(
                { err, ...diag },
                '[orchestrated-runtime] Retry reviewer phase failed',
            )
            throw new Error(
                `Orchestrated retry reviewer phase failed [role=reviewer, profile=${diag.profile}, source=${diag.source}, sessionId=${diag.sessionId}, timeoutMs=${diag.timeoutMs}, revisionRound=${diag.revisionRound}, developerRunId=${diag.developerRunId}, taskId=${diag.taskId}]: ${err?.message ?? err}`,
            )
        }

        // ── Build output ──────────────────────────────────────────

        // P5.2 — Parse reviewer output using JSON protocol
        const reviewerParsed = parseReviewerOutput(reviewerResult.output)
        const reviewDecision = reviewerParsed.decision
        const reviewFeedback = reviewerParsed.feedback

        // P6.3: reviewerDecision is returned in the output instead of hook call.
        // applyRunnerResult() will write the review record in the same transaction.

        const developerMetadata: HermesAgentRuntimeMetadata = {
            developerRunId: developerResult.runId,
            developerProfileName: displayProfileName(developerBinding),
            developerSource: 'orchestrated-developer-revision',
            developerBindingSource,
            revisionRound: input.revisionRound,
            previousReviewFeedback: input.previousReviewFeedback,
        }
        if (developerTarget.model) developerMetadata.developerModel = developerTarget.model
        if (developerTarget.provider) developerMetadata.developerProvider = developerTarget.provider

        const reviewerMetadata: HermesAgentRuntimeMetadata = {
            reviewerRunId: reviewerResult.runId,
            reviewerProfileName: displayProfileName(reviewerBinding),
            reviewerBindingSource: reviewerBinding.bindingSource,
            reviewDecision,
            reviewFeedback,
            reviewIssues: reviewerParsed.issues,
            reviewConfidence: reviewerParsed.confidence,
            reviewerSource: 'orchestrated-reviewer-revision',
        }
        if (reviewerTarget.model) reviewerMetadata.reviewerModel = reviewerTarget.model
        if (reviewerTarget.provider) reviewerMetadata.reviewerProvider = reviewerTarget.provider

        const combinedMetadata: Record<string, unknown> = {
            ...developerMetadata,
            ...reviewerMetadata,
            source: 'orchestrated-revision-retry',
        }

        const title = input.taskTitle
        const safeName = safeTitle(title)

        type ReviewFinalStatus = 'review_passed' | 'revision_required' | 'need_user_decision'
        type ReviewEventType = 'review_passed' | 'review_rejected' | 'revision_started' | 'need_user_decision'

        const decisionStatusMap: Record<typeof reviewDecision, { status: ReviewFinalStatus; eventType: ReviewEventType }> = {
            approved: { status: 'review_passed', eventType: 'review_passed' },
            revision_required: { status: 'revision_required', eventType: 'revision_started' },
            need_user_decision: { status: 'need_user_decision', eventType: 'need_user_decision' },
        }

        const finalStatus = decisionStatusMap[reviewDecision]

        return {
            steps: [
                {
                    status: 'in_progress',
                    activeRole: 'developer',
                    events: [{
                        type: input.currentStatus === 'failed' ? 'task_started' : 'revision_started',
                        agentRole: 'developer',
                        payload: { revisionRound: input.revisionRound },
                    }],
                    messages: [{
                        senderRole: 'developer',
                        senderId: 'developer',
                        senderName: '开发 Agent',
                        content: input.previousReviewFeedback
                            ? `开始修订（第 ${input.revisionRound} 轮），针对审核反馈进行修改。`
                            : `开始重试任务「${title}」（之前执行失败）。`,
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
                ...(reviewDecision === 'approved'
                    ? [{
                        status: 'review_passed' as const,
                        activeRole: 'reviewer' as const,
                        events: [{
                            type: 'review_passed' as const,
                            agentRole: 'reviewer' as const,
                            payload: {
                                reviewerRunId: reviewerResult.runId,
                                reviewerProfileName: displayProfileName(reviewerBinding),
                                reviewerBindingSource: reviewerBinding.bindingSource,
                                reviewDecision,
                                reviewFeedback,
                            },
                        }],
                        messages: [{
                            senderRole: 'reviewer' as const,
                            senderId: 'reviewer',
                            senderName: '审核 Agent',
                            type: 'review_result' as const,
                            content: reviewFeedback,
                            metadata: {
                                reviewerRunId: reviewerResult.runId,
                                reviewerProfileName: displayProfileName(reviewerBinding),
                                reviewerBindingSource: reviewerBinding.bindingSource,
                                reviewDecision,
                            },
                        }],
                    }]
                    : [
                        {
                            status: 'review_rejected' as const,
                            activeRole: 'reviewer' as const,
                            events: [{
                                type: 'review_rejected' as const,
                                agentRole: 'reviewer' as const,
                                payload: {
                                    reviewerRunId: reviewerResult.runId,
                                    reviewerProfileName: displayProfileName(reviewerBinding),
                                    reviewerBindingSource: reviewerBinding.bindingSource,
                                    reviewDecision,
                                    reviewFeedback,
                                    revisionRound: input.revisionRound,
                                },
                            }],
                            messages: [{
                                senderRole: 'reviewer' as const,
                                senderId: 'reviewer',
                                senderName: '审核 Agent',
                                type: 'review_result' as const,
                                content: `❌ 审核驳回：${reviewFeedback}`,
                                metadata: {
                                    reviewerRunId: reviewerResult.runId,
                                    reviewerProfileName: displayProfileName(reviewerBinding),
                                    reviewerBindingSource: reviewerBinding.bindingSource,
                                    reviewDecision,
                                },
                            }],
                        },
                        {
                            status: finalStatus.status,
                            activeRole: 'reviewer' as const,
                            events: [{
                                type: finalStatus.eventType,
                                agentRole: 'reviewer' as const,
                                payload: {
                                    reviewerRunId: reviewerResult.runId,
                                    reviewerProfileName: displayProfileName(reviewerBinding),
                                    reviewerBindingSource: reviewerBinding.bindingSource,
                                    reviewDecision,
                                    reviewFeedback,
                                    revisionRound: input.revisionRound,
                                },
                            }],
                            messages: [{
                                senderRole: 'reviewer' as const,
                                senderId: 'reviewer',
                                senderName: '审核 Agent',
                                type: 'review_result' as const,
                                content: reviewDecision === 'need_user_decision'
                                    ? `⚠️ 任务需要用户决策：${reviewFeedback}`
                                    : `需要修改：${reviewFeedback}`,
                                metadata: {
                                    reviewerRunId: reviewerResult.runId,
                                    reviewerProfileName: displayProfileName(reviewerBinding),
                                    reviewerBindingSource: reviewerBinding.bindingSource,
                                    reviewDecision,
                                },
                            }],
                        },
                    ]),
            ],
            artifacts: [
                {
                    name: `${safeName}-rev${input.revisionRound}.md`,
                    type: 'code_output',
                    content: developerResult.output,
                    metadata: combinedMetadata,
                },
                {
                    name: `${safeName}-rev${input.revisionRound}-review.md`,
                    type: 'review_report',
                    content: reviewFeedback,
                    metadata: {
                        reviewerRunId: reviewerResult.runId,
                        reviewerProfileName,
                        reviewDecision,
                        revisionRound: input.revisionRound,
                    },
                },
            ],
            // P6.3: Carry reviewer decision data for transactional review creation
            reviewerDecision: {
                sessionId: input.sessionId,
                taskId: input.taskId,
                reviewerProfileName: displayProfileName(reviewerBinding),
                reviewDecision,
                reviewFeedback,
                reviewerRunId: reviewerResult.runId,
                reviewIssues: reviewerParsed.issues,
                reviewConfidence: reviewerParsed.confidence,
            },
        }
    }
}
