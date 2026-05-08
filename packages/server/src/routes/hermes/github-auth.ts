import Router from '@koa/router'
import * as ctrl from '../../controllers/hermes/github-auth'

// Public routes (no auth required) - for callback from GitHub
export const githubAuthPublicRoutes = new Router()
githubAuthPublicRoutes.get('/api/auth/github/callback', ctrl.callback)

// Protected routes (auth required)
export const githubAuthRoutes = new Router()
githubAuthRoutes.get('/api/auth/github/start', ctrl.start)
githubAuthRoutes.get('/api/auth/github/status', ctrl.status)
