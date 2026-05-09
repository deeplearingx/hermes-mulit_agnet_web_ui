// ─── Gateway Hermes Agent Runtime ──────────────────────────────
// Integrates with the Hermes Gateway via the standard /v1/runs protocol.
// This is the PRIMARY runtime for HERMES_AGENT_RUNTIME=real|gateway.
//
// Does NOT touch DB, service state machine, or frontend.
// Does NOT require hermes-agent to understand AgentRoom status fields.
//
// Flow:
//   1. Build input/instructions from HermesAgentRuntimeInput
//   2. Call runHermesGatewayTask() (POST /v1/runs + SSE /events)
//   3. Map run.completed.output → HermesAgentRuntimeOutput (ordered steps)
//
// The AgentRoom facade (applyRunnerResult) handles all DB mutations
// and state machine validation.

import type { HermesAgentRuntime, HermesAgentRuntimeInput, HermesAgentRuntimeOutput } from './types'
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
 * Validate that the task status is one of the supported start statuses.
 * Must be called BEFORE invoking the Gateway to avoid wasting a round-trip.
 */
function assertSupportedStartStatus(status: HermesAgentRuntimeInput['currentStatus']): void {
    if (
        status !== 'created' &&
        status !== 'revision_required' &&
        status !== 'need_user_decision' &&
        status !== 'failed'
    ) {
        throw new Error(
            `Unsupported AgentRoom task status for GatewayHermesRuntime: ${status}. ` +
            `Expected one of: created, revision_required, need_user_decision, failed`,
        )
    }
}

/**
 * Build the input text for the Gateway run.
 * Includes task context and lightweight workflow context (status, revision round),
 * but does not require the agent to output AgentRoom status fields.
 */
function buildTaskInput(input: HermesAgentRuntimeInput): string {
    const parts = [
        `任务标题：${input.taskTitle}`,
        `任务描述：${input.taskDescription}`,
        `当前阶段：${input.currentStatus}`,
        `修订轮次：${input.revisionRound}`,
        '',
        '请执行该任务，并返回清晰的执行结果、关键步骤、产物说明和需要审核的内容。',
    ]
    return parts.join('\n')
}

/**
 * Build system instructions for the Gateway agent.
 * Constrains the agent to return execution results only.
 */
function buildAgentRoomInstructions(input: HermesAgentRuntimeInput): string {
    return [
        '你是 AgentRoom 中的开发 Agent。',
        '你只需要完成任务执行，不要输出 AgentRoom 状态机字段。',
        '请返回清晰的执行结果、关键步骤、产物说明和需要审核的内容。',
        `当前任务：${input.taskTitle}`,
    ].join('\n')
}

/**
 * Sanitize a title for use as a filename.
 */
function safeTitle(title: string): string {
    return title.replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]/g, '_').slice(0, 50)
}

export class GatewayHermesRuntime implements HermesAgentRuntime {
    private readonly profileResolver: GatewayProfileResolver

    constructor(
        private readonly upstream = UPSTREAM,
        private readonly apiKey?: string | null,
        private readonly timeoutMs = parseEnvTimeoutMs(),
        profileResolver?: GatewayProfileResolver,
    ) {
        assertValidTimeoutMs(this.timeoutMs)
        this.profileResolver = profileResolver ?? createDefaultGatewayProfileResolver()
    }

    async runTask(input: HermesAgentRuntimeInput): Promise<HermesAgentRuntimeOutput> {
        // Fail fast on unsupported statuses BEFORE calling the Gateway.
        assertSupportedStartStatus(input.currentStatus)

        // Resolve target from role binding / assignedAgentId → profileName → upstream/apiKey/model/provider.
        const target = this.profileResolver(input.assignedAgentId, this.upstream, this.apiKey, { sessionId: input.sessionId, role: 'developer' })

        const gatewaySessionId = `agent-room-${input.sessionId}-${input.taskId}`

        const result = await runHermesGatewayTask({
            upstream: target.upstream,
            apiKey: target.apiKey,
            input: buildTaskInput(input),
            instructions: buildAgentRoomInstructions(input),
            sessionId: gatewaySessionId,
            timeoutMs: this.timeoutMs,
            model: target.model,
            provider: target.provider,
        })

        return this.buildOutput(input, result.output, result.runId, target)
    }

    /**
     * Map Gateway output into AgentRoom ordered steps.
     * Generates the correct step chain based on currentStatus.
     * Includes profileName/model/provider in metadata (never apiKey).
     */
    private buildOutput(
        input: HermesAgentRuntimeInput,
        finalOutput: string,
        runId: string,
        target: GatewayRuntimeTarget,
    ): HermesAgentRuntimeOutput {
        const title = input.taskTitle
        const metadata: Record<string, unknown> = { runId, source: 'hermes-gateway' }
        if (target.profileName) metadata.profileName = target.profileName
        if (target.model) metadata.model = target.model
        if (target.provider) metadata.provider = target.provider
        if (target.bindingSource) metadata.bindingSource = target.bindingSource
        if (target.transportSource) metadata.transportSource = target.transportSource
        const safeName = safeTitle(title)

        // Revision/retry path: revision_required | need_user_decision | failed → in_progress → submitted_for_review
        if (
            input.currentStatus === 'revision_required' ||
            input.currentStatus === 'need_user_decision' ||
            input.currentStatus === 'failed'
        ) {
            const startEvent = input.currentStatus === 'failed'
                ? { type: 'task_started' as const, agentRole: 'developer' as const }
                : { type: 'revision_started' as const, agentRole: 'developer' as const }

            const startMessage = input.currentStatus === 'failed'
                ? `重新执行失败任务「${title}」`
                : `开始根据反馈修改任务「${title}」`

            return {
                steps: [
                    {
                        status: 'in_progress',
                        events: [startEvent],
                        messages: [{
                            senderRole: 'developer',
                            senderId: 'developer',
                            senderName: '开发 Agent',
                            content: startMessage,
                        }],
                    },
                    {
                        status: 'submitted_for_review',
                        events: [{
                            type: 'task_submitted',
                            agentRole: 'developer',
                            payload: metadata,
                        }],
                        messages: [{
                            senderRole: 'developer',
                            senderId: 'developer',
                            senderName: '开发 Agent',
                            type: 'agent_message',
                            content: finalOutput,
                            metadata,
                        }],
                    },
                ],
                artifacts: [{
                    name: `${safeName}.md`,
                    type: 'code_output',
                    content: finalOutput,
                    metadata,
                }],
            }
        }

        // Only 'created' is allowed as the default path.
        // All other statuses are unsupported — reject explicitly to surface misuse early.
        if (input.currentStatus !== 'created') {
            throw new Error(
                `Unsupported AgentRoom task status for GatewayHermesRuntime: ${input.currentStatus}. ` +
                `Expected one of: created, revision_required, need_user_decision, failed`,
            )
        }

        // Default path: created → planned → assigned → in_progress → submitted_for_review
        return {
            steps: [
                {
                    status: 'planned',
                    events: [{ type: 'task_planned', agentRole: 'planner' }],
                    messages: [{
                        senderRole: 'planner',
                        senderId: 'planner',
                        senderName: '规划 Agent',
                        content: `已为任务「${title}」生成执行计划，并准备交给开发 Agent。`,
                    }],
                },
                {
                    status: 'assigned',
                    events: [{ type: 'task_assigned', agentRole: 'developer' }],
                },
                {
                    status: 'in_progress',
                    events: [{ type: 'task_started', agentRole: 'developer' }],
                    messages: [{
                        senderRole: 'developer',
                        senderId: 'developer',
                        senderName: '开发 Agent',
                        content: `开始通过 Hermes Gateway 执行任务「${title}」。`,
                    }],
                },
                {
                    status: 'submitted_for_review',
                    events: [{
                        type: 'task_submitted',
                        agentRole: 'developer',
                        payload: metadata,
                    }],
                    messages: [{
                        senderRole: 'developer',
                        senderId: 'developer',
                        senderName: '开发 Agent',
                        type: 'agent_message',
                        content: finalOutput,
                        metadata,
                    }],
                },
            ],
            artifacts: [{
                name: `${safeName}.md`,
                type: 'code_output',
                content: finalOutput,
                metadata,
            }],
        }
    }
}
