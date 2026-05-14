// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import AgentRoomTaskPanel from '../../packages/client/src/components/hermes/agent-room/AgentRoomTaskPanel.vue'
import type {
    AgentRoomAgent,
    AgentRoomArtifact,
    AgentRoomRoleBinding,
    AgentRoomTask,
    AgentRoomTaskStatus,
} from '../../packages/client/src/api/hermes/agent-room'

const now = '2026-01-01T00:00:00.000Z'

const agents: AgentRoomAgent[] = [
    { id: 'planner', name: 'Planner', role: 'planner', description: 'plans work' },
    { id: 'developer', name: 'Developer', role: 'developer', description: 'implements work' },
    { id: 'reviewer', name: 'Reviewer', role: 'reviewer', description: 'reviews work' },
]

const requiredBindings: AgentRoomRoleBinding[] = [
    { id: 'rb-planner', sessionId: 's1', role: 'planner', profileName: 'planner-profile', createdAt: now },
    { id: 'rb-reviewer', sessionId: 's1', role: 'reviewer', profileName: 'reviewer-profile', createdAt: now },
]

function makeTask(status: AgentRoomTaskStatus, overrides: Partial<AgentRoomTask> = {}): AgentRoomTask {
    return {
        id: 'task-1',
        sessionId: 's1',
        title: `${status} task`,
        description: 'Task description',
        status,
        revisionRound: 1,
        maxRevisionRounds: 3,
        createdAt: now,
        updatedAt: now,
        ...overrides,
    }
}

function mountPanel(options: {
    task?: AgentRoomTask
    roleBindings?: AgentRoomRoleBinding[]
    artifacts?: AgentRoomArtifact[]
    actionLoadingTaskId?: string | null
} = {}) {
    const task = options.task ?? makeTask('created')

    return mount(AgentRoomTaskPanel, {
        props: {
            tasks: [task],
            reviews: [],
            workflowEvents: [],
            agents,
            artifacts: options.artifacts ?? [],
            roleBindings: options.roleBindings ?? requiredBindings,
            runs: [],
            activeTaskId: task.id,
            actionLoadingTaskId: options.actionLoadingTaskId ?? null,
        },
    })
}

describe('AgentRoomTaskPanel actions', () => {
    it('starts a created task with configured role bindings', async () => {
        const wrapper = mountPanel({ task: makeTask('created') })

        const action = wrapper.get('button.action-btn')
        expect(action.text()).toContain('🚀 启动工作流')

        await action.trigger('click')

        expect(wrapper.emitted('run-workflow')).toEqual([['task-1']])
        expect(wrapper.emitted('open-review')).toBeUndefined()
        expect(wrapper.emitted('deliver-task')).toBeUndefined()
    })

    it('allows created task start with warning fallbacks when planner or reviewer binding is missing', async () => {
        const wrapper = mountPanel({
            task: makeTask('created'),
            roleBindings: [requiredBindings[0]],
        })

        const action = wrapper.get('button.action-btn')
        expect(action.text()).toContain('🚀 启动工作流')
        expect(wrapper.text()).toContain('未绑定，将使用当前默认 Hermes profile')

        await action.trigger('click')

        expect(wrapper.emitted('run-workflow')).toEqual([['task-1']])
    })


    it('shows developer assigned-profile fallback and system delivery fallback as non-blocking hints', async () => {
        const wrapper = mountPanel({
            task: makeTask('created', { assignedAgentId: 'kimi' }),
            roleBindings: [],
        })

        expect(wrapper.text()).toContain('未绑定，将使用任务分配 profile: kimi')
        expect(wrapper.text()).toContain('未绑定，将使用系统交付')
        expect(wrapper.text()).toContain('Planner')
        expect(wrapper.text()).toContain('Developer')
        expect(wrapper.text()).toContain('Reviewer')
        expect(wrapper.text()).toContain('kimi')

        const action = wrapper.get('button.action-btn')
        await action.trigger('click')

        expect(wrapper.emitted('run-workflow')).toEqual([['task-1']])
    })

    it('emits review, delivery, retry, and decision-continuation actions by task status', async () => {
        const cases: Array<{
            status: AgentRoomTaskStatus
            expectedText: string
            expectedEvent: string
        }> = [
            { status: 'submitted_for_review', expectedText: '🔍 审核', expectedEvent: 'open-review' },
            { status: 'review_passed', expectedText: '📦 系统生成交付', expectedEvent: 'deliver-task' },
            { status: 'revision_required', expectedText: '🔄 重新开发 (第1轮)', expectedEvent: 'run-workflow' },
            { status: 'need_user_decision', expectedText: '🔄 继续修改 (第1/3轮已用尽)', expectedEvent: 'run-workflow' },
            { status: 'failed', expectedText: '🔄 重新开始', expectedEvent: 'run-workflow' },
        ]

        for (const testCase of cases) {
            const wrapper = mountPanel({ task: makeTask(testCase.status) })

            const action = wrapper.get('button.action-btn')
            expect(action.text()).toContain(testCase.expectedText)

            await action.trigger('click')

            expect(wrapper.emitted(testCase.expectedEvent)).toEqual([['task-1']])
        }
    })

    it('does not emit actions while the active task action is loading', async () => {
        const wrapper = mountPanel({
            task: makeTask('submitted_for_review'),
            actionLoadingTaskId: 'task-1',
        })

        const action = wrapper.get('button.action-btn')
        expect(action.attributes('disabled')).toBeDefined()

        await action.trigger('click')

        expect(wrapper.emitted('open-review')).toBeUndefined()
    })
})

describe('AgentRoomTaskPanel artifacts', () => {
    it('renders stable artifact icons by artifact type and falls back for other artifacts', () => {
        const artifacts: AgentRoomArtifact[] = [
            { id: 'a1', sessionId: 's1', taskId: 'task-1', name: 'Final', type: 'final_delivery', createdAt: now },
            { id: 'a2', sessionId: 's1', taskId: 'task-1', name: 'Code', type: 'code_output', createdAt: now },
            { id: 'a3', sessionId: 's1', taskId: 'task-1', name: 'Review', type: 'review_report', createdAt: now },
            { id: 'a4', sessionId: 's1', taskId: 'task-1', name: 'Log', type: 'log', createdAt: now },
            { id: 'a5', sessionId: 's1', taskId: 'task-1', name: 'Other', type: 'other', createdAt: now },
        ]
        const wrapper = mountPanel({ task: makeTask('review_passed'), artifacts })

        const icons = wrapper.findAll('.artifact-icon').map(icon => icon.text())

        expect(icons).toEqual(['🎉', '💻', '📋', '📄', '📎'])
    })
})
