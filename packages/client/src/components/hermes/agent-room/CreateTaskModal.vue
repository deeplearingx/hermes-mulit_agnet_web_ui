<script setup lang="ts">
import { ref, watch } from 'vue'

const props = defineProps<{
    visible: boolean
    loading?: boolean
}>()

const emit = defineEmits<{
    (e: 'close'): void
    (e: 'submit', data: { title: string; description: string }): void
}>()

const title = ref('')
const description = ref('')
const titleInput = ref<HTMLInputElement | null>(null)

watch(() => props.visible, (v) => {
    if (v) {
        title.value = ''
        description.value = ''
        // Auto-focus title input after DOM update
        setTimeout(() => titleInput.value?.focus(), 50)
    }
})

function handleSubmit() {
    const t = title.value.trim()
    if (!t) return
    emit('submit', { title: t, description: description.value.trim() })
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
                    <span class="modal-icon">📋</span>
                    <h3>创建新任务</h3>
                    <button class="modal-close" @click="emit('close')">✕</button>
                </div>
                <div class="modal-body">
                    <label class="field-label">
                        任务标题 <span class="required">*</span>
                    </label>
                    <input
                        ref="titleInput"
                        v-model="title"
                        class="field-input"
                        placeholder="输入任务标题..."
                        @keydown.enter.prevent="handleSubmit"
                    />
                    <label class="field-label">
                        任务描述 <span class="optional">（可选）</span>
                    </label>
                    <textarea
                        v-model="description"
                        class="field-textarea"
                        placeholder="输入任务描述..."
                        rows="4"
                    />
                    <p class="hint">Ctrl+Enter 快速提交</p>
                </div>
                <div class="modal-footer">
                    <button class="btn-cancel" @click="emit('close')">取消</button>
                    <button class="btn-submit" :disabled="props.loading || !title.trim()" @click="handleSubmit">
                        创建任务
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
    width: 420px;
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
    gap: 8px;
}

.field-label {
    font-size: 12px;
    font-weight: 600;
    color: var(--vscode-editor-foreground, #cccccc);
    margin-bottom: 2px;

    .required {
        color: #e57373;
    }

    .optional {
        color: var(--vscode-descriptionForeground, #999999);
        font-weight: 400;
    }
}

.field-input {
    padding: 6px 10px;
    border: 1px solid var(--vscode-input-border, #3c3c3c);
    border-radius: 4px;
    background: var(--vscode-input-background, #3c3c3c);
    color: var(--vscode-input-foreground, #cccccc);
    font-size: 13px;
    font-family: inherit;
    outline: none;

    &:focus {
        border-color: var(--vscode-focusBorder, #007fd4);
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
    min-height: 80px;

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

    &:hover:not(:disabled) {
        background: var(--vscode-button-hoverBackground, #1177bb);
    }

    &:disabled {
        opacity: 0.5;
        cursor: not-allowed;
    }
}
</style>
