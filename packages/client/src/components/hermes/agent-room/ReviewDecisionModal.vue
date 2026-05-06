<script setup lang="ts">
import { ref, computed, watch } from 'vue'

const props = defineProps<{
    visible: boolean
    taskTitle: string
    revisionRound: number
    maxRevisionRounds: number
}>()

const emit = defineEmits<{
    (e: 'close'): void
    (e: 'submit', data: { status: 'passed' | 'rejected'; comment: string }): void
}>()

const decision = ref<'passed' | 'rejected'>('passed')
const comment = ref('')
const commentInput = ref<HTMLTextAreaElement | null>(null)

const isAtLimit = computed(() => props.revisionRound + 1 >= props.maxRevisionRounds)
const remainingRounds = computed(() => Math.max(0, props.maxRevisionRounds - props.revisionRound - 1))

watch(() => props.visible, (v) => {
    if (v) {
        decision.value = 'passed'
        comment.value = ''
        setTimeout(() => commentInput.value?.focus(), 50)
    }
})

function handleSubmit() {
    emit('submit', {
        status: decision.value,
        comment: comment.value.trim(),
    })
    emit('close')
}

function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
        emit('close')
    } else if (e.key === 'Enter' && e.ctrlKey) {
        e.preventDefault()
        handleSubmit()
    }
}
</script>

<template>
    <Teleport to="body">
        <div v-if="visible" class="modal-overlay" @click.self="emit('close')" @keydown="handleKeydown">
            <div class="modal-content">
                <div class="modal-header">
                    <span class="modal-icon">🔍</span>
                    <h3>审核决策</h3>
                    <button class="modal-close" @click="emit('close')">✕</button>
                </div>
                <div class="modal-body">
                    <div class="task-info">
                        <span class="info-label">任务：</span>
                        <span class="info-value">{{ taskTitle }}</span>
                    </div>
                    <div class="round-info">
                        <span class="info-label">修改轮次：</span>
                        <span class="round-badge" :class="{ 'at-limit': isAtLimit }">
                            {{ revisionRound }}/{{ maxRevisionRounds }}
                        </span>
                        <span v-if="isAtLimit" class="limit-warning">
                            ⚠️ 已达上限，打回将需要用户决策
                        </span>
                        <span v-else class="round-remaining">
                            剩余 {{ remainingRounds }} 轮
                        </span>
                    </div>

                    <div class="decision-group">
                        <label class="decision-option" :class="{ selected: decision === 'passed' }">
                            <input type="radio" v-model="decision" value="passed" />
                            <span class="decision-icon">✅</span>
                            <span>通过</span>
                        </label>
                        <label class="decision-option" :class="{ selected: decision === 'rejected' }">
                            <input type="radio" v-model="decision" value="rejected" />
                            <span class="decision-icon">❌</span>
                            <span>打回修改</span>
                        </label>
                    </div>

                    <label class="field-label">
                        审核意见 <span class="optional">（可为空）</span>
                    </label>
                    <textarea
                        ref="commentInput"
                        v-model="comment"
                        class="field-textarea"
                        :placeholder="decision === 'rejected' ? '说明需要修改的原因...' : '审核通过备注...'"
                        rows="3"
                    />
                    <p class="hint">Ctrl+Enter 快速提交</p>
                </div>
                <div class="modal-footer">
                    <button class="btn-cancel" @click="emit('close')">取消</button>
                    <button
                        class="btn-submit"
                        :class="{ 'btn-reject': decision === 'rejected' }"
                        @click="handleSubmit"
                    >
                        {{ decision === 'passed' ? '确认通过' : '确认打回' }}
                    </button>
                </div>
            </div>
        </div>
    </Teleport>
</template>

<style scoped lang="scss">
.modal-overlay {
    position: fixed;
    inset: 0;
    z-index: 1000;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(0, 0, 0, 0.5);
    backdrop-filter: blur(2px);
}

.modal-content {
    width: 440px;
    max-width: 90vw;
    background: var(--vscode-editorWidget-background, #252526);
    border: 1px solid var(--vscode-widget-border, #3c3c3c);
    border-radius: 8px;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
    display: flex;
    flex-direction: column;
}

.modal-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 14px 16px;
    border-bottom: 1px solid var(--vscode-widget-border, #3c3c3c);

    .modal-icon {
        font-size: 18px;
    }

    h3 {
        margin: 0;
        font-size: 14px;
        font-weight: 600;
        color: var(--vscode-editor-foreground, #cccccc);
        flex: 1;
    }

    .modal-close {
        background: none;
        border: none;
        color: var(--vscode-descriptionForeground, #999999);
        cursor: pointer;
        font-size: 14px;
        padding: 2px 6px;
        border-radius: 3px;

        &:hover {
            background: var(--vscode-list-hoverBackground, #2a2d2e);
            color: var(--vscode-editor-foreground, #cccccc);
        }
    }
}

.modal-body {
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 12px;
}

.task-info,
.round-info {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 13px;
}

.info-label {
    color: var(--vscode-descriptionForeground, #999999);
    white-space: nowrap;
}

.info-value {
    color: var(--vscode-editor-foreground, #cccccc);
    font-weight: 600;
}

.round-badge {
    font-size: 11px;
    padding: 1px 6px;
    border-radius: 3px;
    background: rgba(255, 183, 77, 0.15);
    color: #ffb74d;
    font-weight: 600;

    &.at-limit {
        background: rgba(229, 115, 115, 0.15);
        color: #e57373;
    }
}

.limit-warning {
    font-size: 11px;
    color: #e57373;
    font-weight: 600;
}

.round-remaining {
    font-size: 11px;
    color: var(--vscode-descriptionForeground, #666666);
}

.decision-group {
    display: flex;
    gap: 8px;
}

.decision-option {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 10px 12px;
    border: 1px solid var(--vscode-widget-border, #3c3c3c);
    border-radius: 6px;
    cursor: pointer;
    font-size: 13px;
    color: var(--vscode-editor-foreground, #cccccc);
    transition: all 0.15s;

    input[type="radio"] {
        display: none;
    }

    .decision-icon {
        font-size: 16px;
    }

    &:hover {
        background: var(--vscode-list-hoverBackground, #2a2d2e);
    }

    &.selected {
        border-color: var(--vscode-focusBorder, #007fd4);
        background: rgba(0, 127, 212, 0.1);
    }
}

.field-label {
    font-size: 12px;
    font-weight: 600;
    color: var(--vscode-editor-foreground, #cccccc);

    .optional {
        color: var(--vscode-descriptionForeground, #999999);
        font-weight: 400;
    }
}

.field-textarea {
    padding: 6px 10px;
    border: 1px solid var(--vscode-input-border, #3c3c3c);
    border-radius: 4px;
    background: var(--vscode-input-background, #3c3c3c);
    color: var(--vscode-input-foreground, #cccccc);
    font-size: 13px;
    font-family: inherit;
    outline: none;
    resize: vertical;
    min-height: 60px;

    &:focus {
        border-color: var(--vscode-focusBorder, #007fd4);
    }
}

.hint {
    margin: 0;
    font-size: 11px;
    color: var(--vscode-descriptionForeground, #666666);
}

.modal-footer {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    padding: 12px 16px;
    border-top: 1px solid var(--vscode-widget-border, #3c3c3c);
}

.btn-cancel {
    padding: 5px 14px;
    border: 1px solid var(--vscode-widget-border, #3c3c3c);
    border-radius: 4px;
    background: transparent;
    color: var(--vscode-editor-foreground, #cccccc);
    cursor: pointer;
    font-size: 12px;

    &:hover {
        background: var(--vscode-list-hoverBackground, #2a2d2e);
    }
}

.btn-submit {
    padding: 5px 14px;
    border: none;
    border-radius: 4px;
    background: var(--vscode-button-background, #0e639c);
    color: var(--vscode-button-foreground, #ffffff);
    cursor: pointer;
    font-size: 12px;

    &:hover {
        background: var(--vscode-button-hoverBackground, #1177bb);
    }

    &.btn-reject {
        background: #d32f2f;

        &:hover {
            background: #b71c1c;
        }
    }
}
</style>
