import { randomUUID } from 'node:crypto'
import type { Context } from 'koa'
import { config } from '../../config'
import { getGatewayManagerInstance } from '../../services/gateway-bootstrap'
import { updateUsage } from '../../db/hermes/usage-store'
import {
    createRunEvent,
    findByUpstreamRunId,
    getNextRunEventSequence,
    type AgentRoomRunEvent,
} from '../../db/hermes/agent-room-store'

function getGatewayManager() { return getGatewayManagerInstance() }

// --- run_id → session_id mapping (in-memory, ephemeral) ---

const runSessionMap = new Map<string, string>()

export function setRunSession(runId: string, sessionId: string): void {
  runSessionMap.set(runId, sessionId)
  // Auto-cleanup after 30 minutes
  setTimeout(() => runSessionMap.delete(runId), 30 * 60 * 1000)
}

export function getSessionForRun(runId: string): string | undefined {
  return runSessionMap.get(runId)
}

// --- Helpers ---

function isTransientGatewayError(err: any): boolean {
  const msg = String(err?.message || '')
  const causeCode = String(err?.cause?.code || '')
  return (
    causeCode === 'ECONNREFUSED' ||
    causeCode === 'ECONNRESET' ||
    /ECONNREFUSED|ECONNRESET|fetch failed|socket hang up/i.test(msg)
  )
}

async function waitForGatewayReady(upstream: string, timeoutMs: number = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  const healthUrl = `${upstream}/health`
  while (Date.now() < deadline) {
    try {
      const res = await fetch(healthUrl, {
        method: 'GET',
        signal: AbortSignal.timeout(1200),
      })
      if (res.ok) return true
    } catch { }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  return false
}

/** Resolve profile name from request */
function resolveProfile(ctx: Context): string {
  return ctx.get('x-hermes-profile') || (ctx.query.profile as string) || 'default'
}

/** Resolve upstream URL for a request based on profile header/query */
function resolveUpstream(ctx: Context): string {
  const mgr = getGatewayManager()
  if (mgr) {
    const profile = resolveProfile(ctx)
    if (profile && profile !== 'default') {
      return mgr.getUpstream(profile)
    }
    return mgr.getUpstream()
  }
  return config.upstream.replace(/\/$/, '')
}

function buildProxyHeaders(ctx: Context, upstream: string): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const [key, value] of Object.entries(ctx.headers)) {
    if (value == null) continue
    const lower = key.toLowerCase()
    if (lower === 'host') {
      headers['host'] = new URL(upstream).host
    } else if (lower === 'origin' || lower === 'referer' || lower === 'connection' || lower === 'authorization') {
      continue
    } else {
      const v = Array.isArray(value) ? value[0] : value
      if (v) headers[key] = v
    }
  }

  const mgr = getGatewayManager()
  if (mgr) {
    const apiKey = mgr.getApiKey(resolveProfile(ctx))
    if (apiKey) {
      headers['authorization'] = `Bearer ${apiKey}`
    }
  }

  return headers
}

// --- SSE stream interception ---

const SSE_EVENTS_PATH = /^\/v1\/runs\/([^/]+)\/events$/

// ─── SSE Event Normalization ────────────────────────────────────

/**
 * Normalize a raw SSE JSON payload into a structured AgentRoomRunEvent.
 * Returns null if the event cannot be associated with a known run.
 *
 * Association strategy:
 *  1. Look up run by upstream_run_id (data.run_id)
 *  2. If not found, use the run_id from the URL path as fallback
 *  3. If neither resolves, skip persistence (event is orphaned)
 */
function normalizeAndPersistSSEEvent(
  data: Record<string, unknown>,
  upstreamRunIdFromPath: string,
  profile: string,
): void {
  const upstreamRunId = String(data.run_id || upstreamRunIdFromPath)
  if (!upstreamRunId) return

  // Resolve local run association
  const localRun = findByUpstreamRunId(upstreamRunId)

  // Still handle run.completed usage tracking (backward compatible)
  if (data.event === 'run.completed' && data.usage) {
    const sessionId = localRun?.sessionId ?? getSessionForRun(upstreamRunId)
    if (sessionId) {
      updateUsage(sessionId, {
        inputTokens: (data.usage as any).input_tokens ?? 0,
        outputTokens: (data.usage as any).output_tokens ?? 0,
        cacheReadTokens: (data.usage as any).cache_read_tokens ?? 0,
        cacheWriteTokens: (data.usage as any).cache_write_tokens ?? 0,
        reasoningTokens: (data.usage as any).reasoning_tokens ?? 0,
        model: String(data.model || ''),
        profile,
      })
    }
  }

  // Persist event to agent_room_run_events (best-effort, never block SSE stream)
  try {
    const runId = localRun?.id ?? upstreamRunId
    const sessionId = localRun?.sessionId ?? getSessionForRun(upstreamRunId) ?? ''
    const taskId = localRun?.taskId ?? ''
    const sequence = getNextRunEventSequence(runId)

    const event: AgentRoomRunEvent = {
      id: randomUUID(),
      runId,
      sessionId,
      taskId,
      upstreamRunId: upstreamRunId || undefined,
      source: 'gateway_sse',
      sequence,
      eventType: String(data.event || 'unknown'),
      payload: data as Record<string, unknown>,
      createdAt: new Date().toISOString(),
    }
    createRunEvent(event)
  } catch {
    // Swallow: SSE persistence must never break the proxy stream
  }
}

/**
 * Parse a single SSE event block and extract the JSON data line.
 * Returns the parsed object or null.
 */
function parseSSEEventBlock(block: string): Record<string, unknown> | null {
  const lines = block.split('\n')
  for (const line of lines) {
    if (!line.startsWith('data: ')) continue
    try {
      return JSON.parse(line.slice(6))
    } catch { /* not JSON, skip */ }
  }
  return null
}

/**
 * Stream an SSE response while intercepting ALL standard events for persistence.
 * Preserves existing run.completed usage tracking behavior.
 */
async function streamSSE(ctx: Context, res: Response, profile: string, upstreamRunId: string): Promise<void> {
  if (!res.body) {
    ctx.res.end()
    return
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      // Forward raw bytes to client immediately
      ctx.res.write(value)

      // Also decode for interception
      buffer += decoder.decode(value, { stream: true })

      // Process complete SSE blocks (delimited by double newline)
      let newlineIdx: number
      while ((newlineIdx = buffer.indexOf('\n\n')) !== -1) {
        const eventBlock = buffer.slice(0, newlineIdx)
        buffer = buffer.slice(newlineIdx + 2)
        const data = parseSSEEventBlock(eventBlock)
        if (data) {
          normalizeAndPersistSSEEvent(data, upstreamRunId, profile)
        }
      }
    }

    // Process remaining buffer
    if (buffer.trim()) {
      const data = parseSSEEventBlock(buffer)
      if (data) {
        normalizeAndPersistSSEEvent(data, upstreamRunId, profile)
      }
    }
  } finally {
    ctx.res.end()
  }
}

// --- Main proxy function ---

export async function proxy(ctx: Context) {
  const profile = resolveProfile(ctx)
  const upstream = resolveUpstream(ctx)
  const upstreamPath = ctx.path.replace(/^\/api\/hermes\/v1/, '/v1').replace(/^\/api\/hermes/, '/api')
  const params = new URLSearchParams(ctx.search || '')
  params.delete('token')
  const search = params.toString()
  const url = `${upstream}${upstreamPath}${search ? `?${search}` : ''}`

  const headers = buildProxyHeaders(ctx, upstream)

  try {
    let body: string | undefined
    if (ctx.req.method !== 'GET' && ctx.req.method !== 'HEAD') {
      // @koa/bodyparser parses JSON into ctx.request.body but doesn't store rawBody
      // by default. Re-serialize the parsed body to get the string form.
      const parsed = (ctx as any).request.body
      if (typeof parsed === 'string') {
        body = parsed
      } else if (parsed && typeof parsed === 'object') {
        body = JSON.stringify(parsed)
      }
    }

    const requestInit: RequestInit = { method: ctx.req.method, headers, body }

    let res: Response
    try {
      res = await fetch(url, requestInit)
    } catch (err: any) {
      if (isTransientGatewayError(err) && await waitForGatewayReady(upstream)) {
        res = await fetch(url, requestInit)
      } else {
        throw err
      }
    }

    // Set response headers
    res.headers.forEach((value, key) => {
      const lower = key.toLowerCase()
      if (lower !== 'transfer-encoding' && lower !== 'connection') {
        ctx.set(key, value)
      }
    })
    ctx.status = res.status

    // Intercept POST /v1/runs to capture run_id → session_id mapping
    if (ctx.req.method === 'POST' && /\/v1\/runs$/.test(upstreamPath) && body) {
      try {
        const parsed = JSON.parse(body)
        if (parsed.session_id) {
          const resBody = await res.text()
          ctx.res.write(resBody)
          ctx.res.end()

          try {
            const result = JSON.parse(resBody)
            if (result.run_id) {
              setRunSession(result.run_id, parsed.session_id)
            }
          } catch { /* response not JSON, ignore */ }
          return
        }
      } catch { /* body not JSON, fall through to normal stream */ }
      // No session_id in body — fall through to normal response handling below
    }

    // Intercept SSE streams for /v1/runs/{id}/events
    const sseMatch = upstreamPath.match(SSE_EVENTS_PATH)
    if (sseMatch) {
      const upstreamRunId = sseMatch[1]
      await streamSSE(ctx, res, profile, upstreamRunId)
      return
    }

    // Default: pipe response body directly
    if (res.body) {
      const reader = res.body.getReader()
      const pump = async () => {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          ctx.res.write(value)
        }
        ctx.res.end()
      }
      await pump()
    } else {
      ctx.res.end()
    }
  } catch (err: any) {
    if (!ctx.res.headersSent) {
      ctx.status = 502
      ctx.set('Content-Type', 'application/json')
      ctx.body = { error: { message: `Proxy error: ${err.message}` } }
    } else {
      ctx.res.end()
    }
  }
}
