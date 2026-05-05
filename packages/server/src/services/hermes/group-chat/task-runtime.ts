// ─── Task Runtime Service ────────────────────────────────────
// P10-4: Backend-driven task-event linkage.
// P12-5: taskAction-driven transitions (replaces hardcoded phase mapping).

import type { GroupRuntimeEvent } from './agent-clients'
import { resolveTaskTransition } from './task-dispatch'

interface TaskPatchResult {
    taskUpdated: boolean
    artifactCreated: boolean
}

/**
 * Fallback runtime event → task status machine for events WITHOUT taskAction.
 * Used when an agent runs via @mention (no explicit task dispatch).
 * Note: run_failed keeps the current phase (more useful for debugging).
 */
const FALLBACK_RUNTIME_EVENT_TO_TASK_PATCH: Record<string, {
    from: string[]
    to: string
    phase?: string
    keepPhase?: boolean
}> = {
    run_started: {
        from: ['draft', 'planning'],
        to: 'running',
        phase: 'coding',
    },
    run_completed: {
        from: ['running'],
        to: 'reviewing',
        phase: 'review',
    },
    run_failed: {
        from: ['draft', 'planning', 'running', 'reviewing'],
        to: 'failed',
        keepPhase: true,
    },
}

/**
 * Handle a runtime event from an agent.
 * Returns whether any state was changed (for broadcast optimization).
 *
 * P10-5: Uses payload.taskId when available, falls back to assigneeAgentId lookup.
 * P10-6: Artifact creation is idempotent (checks findArtifactByPath first).
 * P12-5: Uses payload.taskAction for precise transitions when available.
 */
export function handleAgentRuntimeEvent(
    storage: any,
    event: GroupRuntimeEvent,
): TaskPatchResult {
    const { roomId, agentId, type: eventType, payload } = event
    let taskUpdated = false
    let artifactCreated = false

    // 1. Find target task: prefer payload.taskId, fallback to assigneeAgentId
    const tasks = storage.getTasks(roomId) as any[]
    let targetTask: any = null

    if (payload?.taskId) {
        targetTask = tasks.find((t: any) => t.id === payload.taskId) ?? null
    }
    if (!targetTask) {
        targetTask = tasks.find((t: any) =>
            t.assigneeAgentId === agentId &&
            ['draft', 'planning', 'running', 'reviewing'].includes(t.status),
        ) ?? null
    }

    // 2. Apply task status machine
    // P12-5: Prefer taskAction-driven transitions from task-dispatch.ts
    const taskAction = payload?.taskAction as string | undefined
    let transition: { status: string; phase: string } | null = null

    if (taskAction) {
        transition = resolveTaskTransition(eventType, taskAction, targetTask?.status)
    }

    if (transition && targetTask) {
        const update: Record<string, any> = {
            status: transition.status,
            phase: transition.phase,
        }
        storage.updateTask(targetTask.id, update)
        taskUpdated = true
    } else if (!taskAction) {
        // Fallback: use legacy static mapping for mention-based events (no taskAction)
        const patch = FALLBACK_RUNTIME_EVENT_TO_TASK_PATCH[eventType]
        if (patch && targetTask && patch.from.includes(targetTask.status)) {
            const update: Record<string, any> = { status: patch.to }
            if (patch.phase) {
                update.phase = patch.phase
            }
            // keepPhase: don't change phase (e.g., for run_failed)
            storage.updateTask(targetTask.id, update)
            taskUpdated = true
        }
    }

    // 3. Artifact auto-creation (tool_call with file result)
    if (eventType === 'tool_call' && targetTask && payload?.result) {
        const result = payload.result
        if (typeof result === 'object' && result.path) {
            // P10-6: Idempotency check — don't create duplicate artifacts
            const existing = storage.findArtifactByPath(
                roomId, targetTask.id, agentId, result.path,
            )
            if (!existing) {
                storage.createArtifact(
                    roomId,
                    result.name || result.path.split('/').pop() || 'output',
                    result.type || 'file',
                    {
                        taskId: targetTask.id,
                        agentId,
                        path: result.path,
                        contentPreview: result.preview?.slice(0, 200),
                    },
                )
                artifactCreated = true
            }
        }
    }

    return { taskUpdated, artifactCreated }
}
