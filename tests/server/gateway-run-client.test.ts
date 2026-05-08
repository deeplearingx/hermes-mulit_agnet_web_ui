import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ── Fake EventSource via vi.hoisted ──────────────────────────────
// vi.hoisted() ensures the variable is available in the hoisted vi.mock factory.

const { instances } = vi.hoisted(() => {
    const instances: Array<{
        url: string
        options: unknown
        onmessage: ((event: { data: string }) => void) | null
        onerror: ((error: unknown) => void) | null
        closed: boolean
    }> = []
    return { instances }
})

vi.mock('eventsource', () => ({
    EventSource: class FakeEventSource {
        url: string
        options: unknown
        onmessage: ((event: { data: string }) => void) | null = null
        onerror: ((error: unknown) => void) | null = null
        closed = false

        constructor(url: string, options?: unknown) {
            this.url = url
            this.options = options
            instances.push(this as any)
        }

        close() {
            this.closed = true
        }
    },
}))

import { extractGatewayOutput, runHermesGatewayTask } from '../../packages/server/src/services/hermes/gateway-run-client'

describe('gateway-run-client', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        instances.length = 0
    })

    afterEach(() => {
        vi.useRealTimers()
        vi.restoreAllMocks()
    })

    /**
     * Flush microtasks so the async runHermesGatewayTask has time to
     * create the EventSource after the mocked fetch resolves.
     */
    async function flushMicrotasks() {
        await new Promise(resolve => setImmediate(resolve))
    }

    function getLatestSource() {
        return instances[instances.length - 1]
    }

    function emitToSource(source: typeof instances[number], data: unknown) {
        source.onmessage?.({ data: JSON.stringify(data) })
    }

    function failSource(source: typeof instances[number], error = new Error('sse failed')) {
        source.onerror?.(error)
    }

    // ── extractGatewayOutput ─────────────────────────────────────

    describe('extractGatewayOutput', () => {
        it('extracts from event.output', () => {
            expect(extractGatewayOutput({ output: 'hello' })).toBe('hello')
        })

        it('extracts from event.data.output', () => {
            expect(extractGatewayOutput({ data: { output: 'nested' } })).toBe('nested')
        })

        it('extracts from event.result.output', () => {
            expect(extractGatewayOutput({ result: { output: 'from result' } })).toBe('from result')
        })

        it('extracts from event.message.content', () => {
            expect(extractGatewayOutput({ message: { content: 'from message' } })).toBe('from message')
        })

        it('returns null for empty/missing output', () => {
            expect(extractGatewayOutput({})).toBeNull()
            expect(extractGatewayOutput({ output: '' })).toBeNull()
            expect(extractGatewayOutput({ output: '   ' })).toBeNull()
        })

        it('trims whitespace from output', () => {
            expect(extractGatewayOutput({ output: '  hello  ' })).toBe('hello')
        })
    })

    // ── runHermesGatewayTask ─────────────────────────────────────

    describe('runHermesGatewayTask', () => {
        function mockFetchPostRun(runId = 'run-abc') {
            vi.spyOn(globalThis, 'fetch').mockResolvedValue(
                new Response(JSON.stringify({ run_id: runId }), { status: 200 }),
            )
        }

        // ── POST /v1/runs body ───────────────────────────────────

        it('POST /v1/runs sends correct body with input, instructions, conversation_history, session_id', async () => {
            mockFetchPostRun()

            const promise = runHermesGatewayTask({
                upstream: 'http://gateway.test',
                input: 'build login page',
                instructions: 'be thorough',
                conversationHistory: [{ role: 'user', content: 'hi' }],
                sessionId: 'sess-1',
                timeoutMs: 30000,
            })

            await flushMicrotasks()
            const source = getLatestSource()
            emitToSource(source, { event: 'run.completed', output: 'done' })

            await promise

            const fetchCall = vi.mocked(globalThis.fetch).mock.calls[0]
            expect(fetchCall[0]).toBe('http://gateway.test/v1/runs')

            const body = JSON.parse(fetchCall[1]!.body as string)
            expect(body.input).toBe('build login page')
            expect(body.instructions).toBe('be thorough')
            expect(body.conversation_history).toEqual([{ role: 'user', content: 'hi' }])
            expect(body.session_id).toBe('sess-1')
        })

        // ── Authorization header ─────────────────────────────────

        it('includes Authorization header when apiKey is provided', async () => {
            mockFetchPostRun()

            const promise = runHermesGatewayTask({
                upstream: 'http://gateway.test',
                apiKey: 'sk-test-123',
                input: 'task',
                timeoutMs: 30000,
            })

            await flushMicrotasks()
            const source = getLatestSource()
            emitToSource(source, { event: 'run.completed', output: 'done' })

            await promise

            const fetchCall = vi.mocked(globalThis.fetch).mock.calls[0]
            const headers = fetchCall[1]!.headers as Record<string, string>
            expect(headers['Authorization']).toBe('Bearer sk-test-123')
        })

        it('does not include Authorization header when apiKey is absent', async () => {
            mockFetchPostRun()

            const promise = runHermesGatewayTask({
                upstream: 'http://gateway.test',
                input: 'task',
                timeoutMs: 30000,
            })

            await flushMicrotasks()
            const source = getLatestSource()
            emitToSource(source, { event: 'run.completed', output: 'done' })

            await promise

            const fetchCall = vi.mocked(globalThis.fetch).mock.calls[0]
            const headers = fetchCall[1]!.headers as Record<string, string>
            expect(headers['Authorization']).toBeUndefined()
        })

        // ── Non-2xx throws ───────────────────────────────────────

        it('throws on non-2xx response from /v1/runs', async () => {
            vi.spyOn(globalThis, 'fetch').mockResolvedValue(
                new Response('Internal Server Error', { status: 500 }),
            )

            await expect(
                runHermesGatewayTask({
                    upstream: 'http://gateway.test',
                    input: 'task',
                    timeoutMs: 30000,
                }),
            ).rejects.toThrow(/Hermes Gateway run failed \(500\)/)
        })

        // ── Missing run_id ───────────────────────────────────────

        it('throws when response is missing run_id', async () => {
            vi.spyOn(globalThis, 'fetch').mockResolvedValue(
                new Response(JSON.stringify({ ok: true }), { status: 200 }),
            )

            await expect(
                runHermesGatewayTask({
                    upstream: 'http://gateway.test',
                    input: 'task',
                    timeoutMs: 30000,
                }),
            ).rejects.toThrow(/missing run_id/)
        })

        // ── run.completed output extraction ──────────────────────

        it('resolves with output from event.output', async () => {
            mockFetchPostRun('run-1')

            const promise = runHermesGatewayTask({
                upstream: 'http://gateway.test',
                input: 'task',
                timeoutMs: 30000,
            })

            await flushMicrotasks()
            const source = getLatestSource()
            emitToSource(source, { event: 'run.completed', output: 'result from output' })

            const result = await promise
            expect(result.output).toBe('result from output')
            expect(result.runId).toBe('run-1')
        })

        it('resolves with output from event.data.output', async () => {
            mockFetchPostRun('run-2')

            const promise = runHermesGatewayTask({
                upstream: 'http://gateway.test',
                input: 'task',
                timeoutMs: 30000,
            })

            await flushMicrotasks()
            const source = getLatestSource()
            emitToSource(source, { event: 'run.completed', data: { output: 'result from data' } })

            const result = await promise
            expect(result.output).toBe('result from data')
        })

        it('resolves with output from event.result.output', async () => {
            mockFetchPostRun('run-3')

            const promise = runHermesGatewayTask({
                upstream: 'http://gateway.test',
                input: 'task',
                timeoutMs: 30000,
            })

            await flushMicrotasks()
            const source = getLatestSource()
            emitToSource(source, { event: 'run.completed', result: { output: 'result from result' } })

            const result = await promise
            expect(result.output).toBe('result from result')
        })

        it('resolves with output from event.message.content', async () => {
            mockFetchPostRun('run-4')

            const promise = runHermesGatewayTask({
                upstream: 'http://gateway.test',
                input: 'task',
                timeoutMs: 30000,
            })

            await flushMicrotasks()
            const source = getLatestSource()
            emitToSource(source, { event: 'run.completed', message: { content: 'result from message' } })

            const result = await promise
            expect(result.output).toBe('result from message')
        })

        // ── Empty output from run.completed ──────────────────────

        it('throws when run.completed has empty output', async () => {
            mockFetchPostRun()

            const promise = runHermesGatewayTask({
                upstream: 'http://gateway.test',
                input: 'task',
                timeoutMs: 30000,
            })

            await flushMicrotasks()
            const source = getLatestSource()
            emitToSource(source, { event: 'run.completed', output: '' })

            await expect(promise).rejects.toThrow(/empty output/)
        })

        // ── run.completed closes SSE ─────────────────────────────

        it('closes EventSource after run.completed', async () => {
            mockFetchPostRun()

            const promise = runHermesGatewayTask({
                upstream: 'http://gateway.test',
                input: 'task',
                timeoutMs: 30000,
            })

            await flushMicrotasks()
            const source = getLatestSource()
            emitToSource(source, { event: 'run.completed', output: 'done' })

            await promise
            expect(source.closed).toBe(true)
        })

        // ── run.failed ───────────────────────────────────────────

        it('throws on run.failed event with error message', async () => {
            mockFetchPostRun()

            const promise = runHermesGatewayTask({
                upstream: 'http://gateway.test',
                input: 'task',
                timeoutMs: 30000,
            })

            await flushMicrotasks()
            const source = getLatestSource()
            emitToSource(source, { event: 'run.failed', error: 'agent crashed' })

            await expect(promise).rejects.toThrow('agent crashed')
        })

        it('throws on run.failed event with default message when no error field', async () => {
            mockFetchPostRun()

            const promise = runHermesGatewayTask({
                upstream: 'http://gateway.test',
                input: 'task',
                timeoutMs: 30000,
            })

            await flushMicrotasks()
            const source = getLatestSource()
            emitToSource(source, { event: 'run.failed' })

            await expect(promise).rejects.toThrow('Hermes Gateway run failed')
        })

        it('closes EventSource after run.failed', async () => {
            mockFetchPostRun()

            const promise = runHermesGatewayTask({
                upstream: 'http://gateway.test',
                input: 'task',
                timeoutMs: 30000,
            })

            await flushMicrotasks()
            const source = getLatestSource()
            emitToSource(source, { event: 'run.failed', error: 'boom' })

            await expect(promise).rejects.toThrow()
            expect(source.closed).toBe(true)
        })

        // ── SSE onerror ──────────────────────────────────────────

        it('throws on SSE connection error', async () => {
            mockFetchPostRun()

            const promise = runHermesGatewayTask({
                upstream: 'http://gateway.test',
                input: 'task',
                timeoutMs: 30000,
            })

            await flushMicrotasks()
            const source = getLatestSource()
            failSource(source)

            await expect(promise).rejects.toThrow(/SSE connection error/)
        })

        it('closes EventSource after SSE error', async () => {
            mockFetchPostRun()

            const promise = runHermesGatewayTask({
                upstream: 'http://gateway.test',
                input: 'task',
                timeoutMs: 30000,
            })

            await flushMicrotasks()
            const source = getLatestSource()
            failSource(source)

            await expect(promise).rejects.toThrow()
            expect(source.closed).toBe(true)
        })

        // ── Timeout ──────────────────────────────────────────────

        it('throws on timeout when no terminal SSE event arrives', async () => {
            vi.useFakeTimers()
            mockFetchPostRun()

            const promise = runHermesGatewayTask({
                upstream: 'http://gateway.test',
                input: 'task',
                timeoutMs: 5000,
            })

            // Attach rejection handler immediately to avoid unhandled rejection
            const caught = expect(promise).rejects.toThrow(/timed out after 5000ms/)

            // Flush microtasks so fetch resolves and EventSource is created
            await vi.advanceTimersByTimeAsync(0)

            // Advance past the timeout
            await vi.advanceTimersByTimeAsync(5000)

            await caught
        })

        it('closes EventSource after timeout', async () => {
            vi.useFakeTimers()
            mockFetchPostRun()

            const promise = runHermesGatewayTask({
                upstream: 'http://gateway.test',
                input: 'task',
                timeoutMs: 5000,
            })

            // Attach rejection handler immediately
            const caught = expect(promise).rejects.toThrow()

            await vi.advanceTimersByTimeAsync(0)
            await vi.advanceTimersByTimeAsync(5000)

            await caught
            expect(getLatestSource().closed).toBe(true)
        })

        // ── Timeout validation ───────────────────────────────────

        it('throws on NaN timeoutMs', async () => {
            await expect(
                runHermesGatewayTask({
                    upstream: 'http://gateway.test',
                    input: 'task',
                    timeoutMs: NaN,
                }),
            ).rejects.toThrow(/Invalid Gateway timeoutMs/)
        })

        it('throws on zero timeoutMs', async () => {
            await expect(
                runHermesGatewayTask({
                    upstream: 'http://gateway.test',
                    input: 'task',
                    timeoutMs: 0,
                }),
            ).rejects.toThrow(/Invalid Gateway timeoutMs/)
        })

        it('throws on negative timeoutMs', async () => {
            await expect(
                runHermesGatewayTask({
                    upstream: 'http://gateway.test',
                    input: 'task',
                    timeoutMs: -1000,
                }),
            ).rejects.toThrow(/Invalid Gateway timeoutMs/)
        })

        // ── Session ID generation ────────────────────────────────

        it('generates session_id when not provided', async () => {
            mockFetchPostRun()

            const promise = runHermesGatewayTask({
                upstream: 'http://gateway.test',
                input: 'task',
                timeoutMs: 30000,
            })

            await flushMicrotasks()
            const source = getLatestSource()
            emitToSource(source, { event: 'run.completed', output: 'done' })

            const result = await promise
            expect(result.sessionId).toBeTruthy()
            expect(typeof result.sessionId).toBe('string')
            expect(result.sessionId.length).toBeGreaterThan(0)
        })

        it('uses provided session_id', async () => {
            mockFetchPostRun()

            const promise = runHermesGatewayTask({
                upstream: 'http://gateway.test',
                input: 'task',
                sessionId: 'my-session',
                timeoutMs: 30000,
            })

            await flushMicrotasks()
            const source = getLatestSource()
            emitToSource(source, { event: 'run.completed', output: 'done' })

            const result = await promise
            expect(result.sessionId).toBe('my-session')
        })

        // ── SSE URL ──────────────────────────────────────────────

        it('opens EventSource to /v1/runs/:run_id/events', async () => {
            mockFetchPostRun('run-xyz')

            const promise = runHermesGatewayTask({
                upstream: 'http://gateway.test',
                input: 'task',
                timeoutMs: 30000,
            })

            await flushMicrotasks()
            const source = getLatestSource()
            expect(source.url).toBe('http://gateway.test/v1/runs/run-xyz/events')

            emitToSource(source, { event: 'run.completed', output: 'done' })
            await promise
        })

        // ── Non-JSON SSE events are ignored ──────────────────────

        it('ignores non-JSON SSE events and waits for valid terminal event', async () => {
            mockFetchPostRun()

            const promise = runHermesGatewayTask({
                upstream: 'http://gateway.test',
                input: 'task',
                timeoutMs: 30000,
            })

            await flushMicrotasks()
            const source = getLatestSource()

            // Send a non-JSON message directly via onmessage
            source.onmessage?.({ data: 'not json' })

            // Now send the valid terminal event
            emitToSource(source, { event: 'run.completed', output: 'finally done' })

            const result = await promise
            expect(result.output).toBe('finally done')
        })

        // ── onRawEvent callback ──────────────────────────────────

        it('invokes onRawEvent for every parsed SSE event', async () => {
            mockFetchPostRun('run-cb')

            const rawEvents: Record<string, unknown>[] = []
            const promise = runHermesGatewayTask({
                upstream: 'http://gateway.test',
                input: 'task',
                timeoutMs: 30000,
                onRawEvent: (event) => rawEvents.push(event),
            })

            await flushMicrotasks()
            const source = getLatestSource()

            emitToSource(source, { event: 'message.delta', delta: 'partial' })
            emitToSource(source, { event: 'run.completed', output: 'done' })

            await promise

            expect(rawEvents).toHaveLength(2)
            expect(rawEvents[0].event).toBe('message.delta')
            expect(rawEvents[1].event).toBe('run.completed')
        })

        it('onRawEvent errors are swallowed and do not break the flow', async () => {
            mockFetchPostRun('run-swallow')

            const promise = runHermesGatewayTask({
                upstream: 'http://gateway.test',
                input: 'task',
                timeoutMs: 30000,
                onRawEvent: () => {
                    throw new Error('diagnostic boom')
                },
            })

            await flushMicrotasks()
            const source = getLatestSource()

            emitToSource(source, { event: 'run.completed', output: 'still works' })

            const result = await promise
            expect(result.output).toBe('still works')
        })
    })
})
