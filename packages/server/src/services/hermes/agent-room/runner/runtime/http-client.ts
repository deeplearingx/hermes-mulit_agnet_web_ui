// ─── HTTP Client for Hermes Agent Runtime ──────────────────────
// Thin wrapper around native fetch with timeout and error handling.
// Node >= 23.0.0 provides native fetch — no external dependency needed.

/**
 * POST JSON to a URL with timeout.
 * Throws on non-2xx response or timeout.
 */
export async function postJson(url: string, body: unknown, timeoutMs: number): Promise<unknown> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
            signal: controller.signal,
        })

        const text = await res.text()

        if (!res.ok) {
            throw new Error(`Hermes runtime HTTP ${res.status}: ${text}`)
        }

        return text ? JSON.parse(text) : {}
    } finally {
        clearTimeout(timer)
    }
}
