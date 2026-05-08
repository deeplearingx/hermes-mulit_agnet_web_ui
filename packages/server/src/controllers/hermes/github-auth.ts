import { randomUUID } from 'crypto'
import { writeFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { logger } from '../../services/logger'

// --- GitHub OAuth Constants ---
const GITHUB_CLIENT_ID = process.env.GITHUB_OAUTH_CLIENT_ID || ''
const GITHUB_CLIENT_SECRET = process.env.GITHUB_OAUTH_CLIENT_SECRET || ''
const GITHUB_AUTHORIZATION_URL = 'https://github.com/login/oauth/authorize'
const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token'
const GITHUB_API_URL = 'https://api.github.com'
const REDIRECT_URI = process.env.GITHUB_OAUTH_REDIRECT_URI || 'http://localhost:8648/api/auth/github/callback'

// Session storage for OAuth state
interface GitHubOAuthSession {
  id: string
  state: string
  status: 'pending' | 'approved' | 'denied' | 'expired' | 'error'
  error?: string
  accessToken?: string
  username?: string
  createdAt: number
}

const sessions = new Map<string, GitHubOAuthSession>()

function cleanupExpiredSessions() {
  const now = Date.now()
  const SESSION_TIMEOUT = 10 * 60 * 1000 // 10 minutes
  sessions.forEach((session, id) => {
    if (now - session.createdAt > SESSION_TIMEOUT) {
      sessions.delete(id)
    }
  })
}

function getSessionTokenPath(): string {
  const home = homedir()
  return join(home, '.hermes-web-ui', '.token')
}

function ensureAppDir() {
  const appHome = join(homedir(), '.hermes-web-ui')
  if (!existsSync(appHome)) {
    mkdirSync(appHome, { recursive: true })
  }
  return appHome
}

export async function start(ctx: any) {
  // Check if GitHub OAuth is configured
  if (!GITHUB_CLIENT_ID || !GITHUB_CLIENT_SECRET) {
    ctx.status = 400
    ctx.body = { error: 'GitHub OAuth is not configured. Set GITHUB_OAUTH_CLIENT_ID and GITHUB_OAUTH_CLIENT_SECRET environment variables.' }
    return
  }

  cleanupExpiredSessions()

  const state = randomUUID()
  const sessionId = randomUUID()

  const session: GitHubOAuthSession = {
    id: sessionId,
    state,
    status: 'pending',
    createdAt: Date.now(),
  }
  sessions.set(sessionId, session)

  // Build GitHub OAuth authorization URL
  const params = new URLSearchParams({
    client_id: GITHUB_CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: 'read:user user:email',
    state,
  })

  const authUrl = `${GITHUB_AUTHORIZATION_URL}?${params.toString()}`

  ctx.body = {
    session_id: sessionId,
    authorization_url: authUrl,
    state,
  }
}

export async function callback(ctx: any) {
  const { code, state, session_id } = ctx.query

  if (!code || !state || !session_id) {
    ctx.status = 400
    ctx.body = { error: 'Missing required parameters: code, state, session_id' }
    return
  }

  const session = sessions.get(session_id)
  if (!session) {
    ctx.status = 404
    ctx.body = { error: 'Session not found or expired' }
    return
  }

  if (session.state !== state) {
    ctx.status = 400
    ctx.body = { error: 'Invalid state parameter' }
    return
  }

  try {
    // Exchange authorization code for access token
    const tokenRes = await fetch(GITHUB_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
      },
      body: new URLSearchParams({
        client_id: GITHUB_CLIENT_ID,
        client_secret: GITHUB_CLIENT_SECRET,
        code,
        redirect_uri: REDIRECT_URI,
      }),
    })

    if (!tokenRes.ok) {
      const errText = await tokenRes.text()
      logger.error('GitHub token exchange failed: %d %s', tokenRes.status, errText)
      session.status = 'error'
      session.error = 'Failed to exchange code for token'
      ctx.status = 502
      ctx.body = { error: 'Failed to exchange code for token' }
      return
    }

    const tokenData = await tokenRes.json() as { access_token?: string; error?: string; error_description?: string }

    if (tokenData.error) {
      session.status = 'denied'
      ctx.status = 400
      ctx.body = { error: tokenData.error_description || tokenData.error }
      return
    }

    const accessToken = tokenData.access_token!
    session.accessToken = accessToken
    session.status = 'approved'

    // Fetch user info to get username
    try {
      const userRes = await fetch(`${GITHUB_API_URL}/user`, {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Accept': 'application/vnd.github.v3+json',
        },
      })
      if (userRes.ok) {
        const userData = await userRes.json() as { login?: string }
        session.username = userData.login
      }
    } catch (err) {
      logger.warn(err, 'Failed to fetch GitHub user info')
    }

    ctx.body = {
      success: true,
      username: session.username,
    }
  } catch (err: any) {
    logger.error(err, 'GitHub OAuth callback error')
    session.status = 'error'
    session.error = err.message
    ctx.status = 500
    ctx.body = { error: err.message }
  }
}

export async function status(ctx: any) {
  const { session_id } = ctx.query

  if (!session_id) {
    ctx.status = 400
    ctx.body = { error: 'Missing session_id parameter' }
    return
  }

  const session = sessions.get(session_id)
  if (!session) {
    ctx.status = 404
    ctx.body = { error: 'Session not found or expired' }
    return
  }

  if (session.status === 'approved' && session.accessToken) {
    // Generate a session token for the web UI
    const sessionToken = randomUUID()
    
    // Save the GitHub access token and session token to auth file
    const appHome = ensureAppDir()
    const authData = {
      github_oauth: {
        access_token: session.accessToken,
        username: session.username,
        session_token: sessionToken,
      },
      updated_at: new Date().toISOString(),
    }
    
    try {
      const authFile = join(appHome, '.github_oauth.json')
      writeFileSync(authFile, JSON.stringify(authData, null, 2), { mode: 0o600 })
      
      // Also update the main token file to enable login
      const tokenFile = getSessionTokenPath()
      writeFileSync(tokenFile, sessionToken + '\n', { mode: 0o600 })
    } catch (err) {
      logger.error(err, 'Failed to save GitHub OAuth auth data')
    }

    ctx.body = {
      status: session.status,
      username: session.username,
      session_token: sessionToken,
    }
  } else {
    ctx.body = {
      status: session.status,
      error: session.error || null,
    }
  }
}
