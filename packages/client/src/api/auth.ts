import { request } from './client'

export interface AuthStatus {
  hasPasswordLogin: boolean
  username: string | null
}

export async function fetchAuthStatus(): Promise<AuthStatus> {
  const res = await fetch('/api/auth/status')
  if (!res.ok) throw new Error('Failed to fetch auth status')
  return res.json()
}

export async function loginWithPassword(username: string, password: string): Promise<string> {
  const res = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new Error(data.error || 'Login failed')
  }
  const data = await res.json()
  return data.token
}

export async function setupPassword(username: string, password: string): Promise<void> {
  return request('/api/auth/setup', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  })
}

export async function changePassword(currentPassword: string, newPassword: string): Promise<void> {
  return request('/api/auth/change-password', {
    method: 'POST',
    body: JSON.stringify({ currentPassword, newPassword }),
  })
}

export async function changeUsername(currentPassword: string, newUsername: string): Promise<void> {
  return request('/api/auth/change-username', {
    method: 'POST',
    body: JSON.stringify({ currentPassword, newUsername }),
  })
}

export async function removePassword(): Promise<void> {
  return request('/api/auth/password', {
    method: 'DELETE',
  })
}

export interface GitHubOAuthStartResponse {
  session_id: string
  authorization_url: string
  state: string
}

export interface GitHubOAuthStatusResponse {
  status: 'pending' | 'approved' | 'denied' | 'expired' | 'error'
  username?: string
  session_token?: string
  error?: string | null
}

export async function startGitHubOAuth(): Promise<GitHubOAuthStartResponse> {
  const res = await fetch('/api/auth/github/start')
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new Error(data.error || 'Failed to start GitHub OAuth')
  }
  return res.json()
}

export async function getGitHubOAuthStatus(sessionId: string): Promise<GitHubOAuthStatusResponse> {
  const res = await fetch(`/api/auth/github/status?session_id=${encodeURIComponent(sessionId)}`)
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new Error(data.error || 'Failed to get OAuth status')
  }
  return res.json()
}
