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
// P2: Reviewer phase — extends multi-role pipeline to planner → developer → reviewer.
//   - Resolves reviewer profile from roleBindings.get('reviewer')
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
    ReviewerDecision,
    ReviewerOutput,
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
 * Resolve the reviewer profileName from roleBindings.
 * Throws explicitly if the reviewer binding is missing (reviewer phase is mandatory
 * in full pipeline mode).
 */
function resolveReviewerBinding(input: HermesAgentRuntimeInput): string {
    const binding = input.roleBindings?.get('reviewer')
    if (!binding) {
        throw new Error(
            'OrchestratedGatewayRuntime reviewer phase requires a reviewer role binding. ' +
            'Ensure roleBindings.get("reviewer") is set before starting an orchestrated run.',
        )
    }
    return binding.profileName
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
    role: 'planner' | 'developer' | 'reviewer',
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

        // ── Phase 3: Reviewer run ────────────────────────────────

        // Step 7: Resolve reviewer binding — fail explicitly if missing
        const reviewerProfileName = resolveReviewerBinding(input)

        // Step 8: Resolve reviewer Gateway target via profile resolver
        const reviewerTarget = this.profileResolver(
            reviewerProfileName,
            this.upstream,
            this.apiKey,
        )

        // Step 9: Execute reviewer Gateway run using developer output as review context
        const reviewerSessionId = `agent-room-reviewer-${input.sessionId}-${input.taskId}`
        const reviewerHooks = createRoleTaggedHooks(input.hooks, 'reviewer')

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
            console.error(
                `[orchestrated-runtime] Reviewer phase failed (profile=${reviewerProfileName}, developerRunId=${developerResult.runId}, task=${input.taskId}):`,
                err?.message ?? err,
            )
            throw new Error(
                `Orchestrated reviewer phase failed: ${err?.message ?? err}`,
            )
        }

        // ── Build output ──────────────────────────────────────────

        // Step 10: P5.2 — Parse reviewer output using JSON protocol
        const reviewerParsed = parseReviewerOutput(reviewerResult.output)
        const reviewDecision = reviewerParsed.decision
        const reviewFeedback = reviewerParsed.feedback

        // P6.3: reviewerDecision is returned in the output instead of hook call.
        // applyRunnerResult() will write the review record in the same transaction.

        // Step 11: Build dual-run metadata
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

        // Unified reviewer metadata — compatible with manual submitReview path
        // P5.2: includes issues and confidence from structured JSON output
        const reviewerMetadata: HermesAgentRuntimeMetadata = {
            reviewerRunId: reviewerResult.runId,
            reviewerProfileName,
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

        // Combined metadata for observability
        const combinedMetadata: Record<string, unknown> = {
            ...plannerMetadata,
            ...developerMetadata,
            ...reviewerMetadata,
            source: 'orchestrated-triple-run',
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

        // Step 13: Return ordered steps: planned → assigned → in_progress → submitted_for_review → review_final
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
                                reviewerProfileName,
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
                                reviewerProfileName,
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
                                    reviewerProfileName,
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
                                    reviewerProfileName,
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
                                    reviewerProfileName,
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
                                    reviewerProfileName,
                                    reviewDecision,
                                },
                            }],
                        },
                    ]),
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
            ],
            // P6.3: Carry reviewer decision data for transactional review creation
            reviewerDecision: {
                sessionId: input.sessionId,
                taskId: input.taskId,
                reviewerProfileName,
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

        const { profileName: developerProfileName, bindingSource: developerBindingSource } =
            resolveDeveloperBinding(input)

        const developerTarget = this.profileResolver(
            developerProfileName,
            this.upstream,
            this.apiKey,
        )

        const developerSessionId = `agent-room-developer-${input.sessionId}-${input.taskId}-rev${input.revisionRound}`
        const developerHooks = createRoleTaggedHooks(input.hooks, 'developer')

        const developerResult = await runHermesGatewayTask({
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

        // ── Phase 2: Reviewer run ────────────────────────────────

        const reviewerProfileName = resolveReviewerBinding(input)

        const reviewerTarget = this.profileResolver(
            reviewerProfileName,
            this.upstream,
            this.apiKey,
        )

        const reviewerSessionId = `agent-room-reviewer-${input.sessionId}-${input.taskId}-rev${input.revisionRound}`
        const reviewerHooks = createRoleTaggedHooks(input.hooks, 'reviewer')

        const reviewerResult = await runHermesGatewayTask({
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

        // ── Build output ──────────────────────────────────────────

        // P5.2 — Parse reviewer output using JSON protocol
        const reviewerParsed = parseReviewerOutput(reviewerResult.output)
        const reviewDecision = reviewerParsed.decision
        const reviewFeedback = reviewerParsed.feedback

        // P6.3: reviewerDecision is returned in the output instead of hook call.
        // applyRunnerResult() will write the review record in the same transaction.

        const developerMetadata: HermesAgentRuntimeMetadata = {
            developerRunId: developerResult.runId,
            developerProfileName: developerProfileName ?? '(default)',
            developerSource: 'orchestrated-developer-revision',
            developerBindingSource,
            revisionRound: input.revisionRound,
            previousReviewFeedback: input.previousReviewFeedback,
        }
        if (developerTarget.model) developerMetadata.developerModel = developerTarget.model
        if (developerTarget.provider) developerMetadata.developerProvider = developerTarget.provider

        const reviewerMetadata: HermesAgentRuntimeMetadata = {
            reviewerRunId: reviewerResult.runId,
            reviewerProfileName,
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
                                reviewerProfileName,
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
                                reviewerProfileName,
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
                                    reviewerProfileName,
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
                                    reviewerProfileName,
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
                                    reviewerProfileName,
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
                                    reviewerProfileName,
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
                reviewerProfileName,
                reviewDecision,
                reviewFeedback,
                reviewerRunId: reviewerResult.runId,
                reviewIssues: reviewerParsed.issues,
                reviewConfidence: reviewerParsed.confidence,
            },
        }
    }
}
