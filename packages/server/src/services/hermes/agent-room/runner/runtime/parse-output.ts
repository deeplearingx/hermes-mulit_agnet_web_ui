// ─── Runtime Output Parser ─────────────────────────────────────
// Validates the raw JSON response from an external Hermes agent service.
// Performs structural validation AND enum value-domain validation.
// Status/event semantic validation (state machine transitions) is still
// handled by the service facade (validateRunnerStep).

import type { HermesAgentRuntimeOutput } from './types'
import type {
    AgentRoomTaskStatus,
    AgentRoomWorkflowEventType,
    AgentRoomRole,
    AgentRoomMessageType,
    AgentRoomArtifactType,
} from '../../index'

const VALID_TASK_STATUSES: ReadonlySet<string> = new Set<AgentRoomTaskStatus>([
    'created', 'planned', 'assigned', 'in_progress', 'submitted_for_review',
    'review_passed', 'review_rejected', 'revision_required', 'delivering',
    'completed', 'failed', 'need_user_decision',
])

const VALID_EVENT_TYPES: ReadonlySet<string> = new Set<AgentRoomWorkflowEventType>([
    'task_created', 'task_planned', 'task_assigned', 'task_started', 'task_submitted',
    'review_passed', 'review_rejected', 'revision_started', 'delivery_started',
    'delivery_completed', 'task_failed', 'need_user_decision',
])

const VALID_ROLES: ReadonlySet<string> = new Set<AgentRoomRole>([
    'conversation', 'planner', 'developer', 'reviewer', 'delivery',
])

const VALID_MESSAGE_TYPES: ReadonlySet<string> = new Set<AgentRoomMessageType>([
    'user_message', 'agent_message', 'task_event', 'review_result', 'final_delivery', 'error',
])

const VALID_ARTIFACT_TYPES: ReadonlySet<string> = new Set<AgentRoomArtifactType>([
    'final_delivery', 'code_output', 'review_report', 'log', 'other',
])

function assertEnum(
    value: unknown,
    validSet: ReadonlySet<string>,
    fieldPath: string,
): void {
    if (typeof value !== 'string' || !validSet.has(value)) {
        throw new Error(
            `Invalid Hermes runtime output: ${fieldPath}="${value}" is not one of: ${[...validSet].join(', ')}`,
        )
    }
}

/**
 * Parse and validate raw JSON into HermesAgentRuntimeOutput.
 * Throws descriptive errors for malformed or enum-invalid responses.
 */
export function parseHermesRuntimeOutput(raw: unknown): HermesAgentRuntimeOutput {
    if (!raw || typeof raw !== 'object') {
        throw new Error('Invalid Hermes runtime output: expected object')
    }

    const output = raw as Partial<HermesAgentRuntimeOutput>

    if (!Array.isArray(output.steps)) {
        throw new Error('Invalid Hermes runtime output: steps must be array')
    }

    for (const [index, step] of output.steps.entries()) {
        const stepPath = `steps[${index}]`

        if (!step.status) {
            throw new Error(`Invalid Hermes runtime output: ${stepPath}.status is required`)
        }
        assertEnum(step.status, VALID_TASK_STATUSES, `${stepPath}.status`)

        if (!Array.isArray(step.events) || step.events.length === 0) {
            throw new Error(`Invalid Hermes runtime output: ${stepPath}.events must be non-empty array`)
        }

        for (const [eventIndex, event] of step.events.entries()) {
            const eventPath = `${stepPath}.events[${eventIndex}]`

            if (!event.type || !event.agentRole) {
                throw new Error(
                    `Invalid Hermes runtime output: ${eventPath} requires type and agentRole`,
                )
            }
            assertEnum(event.type, VALID_EVENT_TYPES, `${eventPath}.type`)
            assertEnum(event.agentRole, VALID_ROLES, `${eventPath}.agentRole`)
        }

        if (step.messages) {
            for (const [msgIndex, msg] of step.messages.entries()) {
                const msgPath = `${stepPath}.messages[${msgIndex}]`

                if (msg.senderRole) {
                    assertEnum(msg.senderRole, VALID_ROLES, `${msgPath}.senderRole`)
                }
                if (msg.type) {
                    assertEnum(msg.type, VALID_MESSAGE_TYPES, `${msgPath}.type`)
                }
            }
        }
    }

    if (output.artifacts) {
        for (const [artIndex, art] of output.artifacts.entries()) {
            const artPath = `artifacts[${artIndex}]`

            if (!art.name || !art.type || !art.content) {
                throw new Error(
                    `Invalid Hermes runtime output: ${artPath} requires name, type, and content`,
                )
            }
            assertEnum(art.type, VALID_ARTIFACT_TYPES, `${artPath}.type`)
        }
    }

    return output as HermesAgentRuntimeOutput
}
