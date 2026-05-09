// ─── Gateway Profile Resolver ───────────────────────────────────
// Resolves an AgentRoom assignedAgentId to a GatewayRuntimeTarget
// containing upstream, apiKey, model, and provider.
//
// Resolution priority:
//   1. Role binding (sessionId + 'developer' role → agentId → profileName)
//   2. assignedAgentId direct mapping
//   3. Constructor fallback
//
// The default resolver uses GatewayManager (if available) to look up
// profile-specific upstream/apiKey. When GatewayManager is not
// initialized (e.g. in tests or standalone scripts), it falls back
// to the constructor-provided upstream/apiKey.

import { getGatewayManagerInstance } from '../../../../gateway-bootstrap'
import { getRoleBindingBySessionAndRole } from '../../../../../db/hermes/agent-room-store'

/**
 * Resolved target for a Gateway run.
 * Passed to runHermesGatewayTask() — never contains apiKey directly
 * in metadata; apiKey is only used for the Authorization header.
 */
export interface GatewayRuntimeTarget {
    upstream: string
    apiKey?: string | null
    model?: string
    provider?: string
    /** The profile name resolved from assignedAgentId (for metadata). */
    profileName?: string
    /**
     * How this target was resolved.
     * - 'role-binding': resolved via agent_room_role_bindings table
     * - 'gateway-manager': resolved via GatewayManager.getUpstream/getApiKey
     * - 'constructor-fallback': fell back to constructor upstream/apiKey
     */
    resolutionSource?: 'role-binding' | 'gateway-manager' | 'constructor-fallback'
}

/**
 * Optional context passed to the resolver for role binding lookup.
 */
export interface GatewayProfileResolverContext {
    sessionId?: string
}

/**
 * Resolves an assignedAgentId to a GatewayRuntimeTarget.
 */
export type GatewayProfileResolver = (
    assignedAgentId: string | undefined,
    fallbackUpstream: string,
    fallbackApiKey?: string | null,
    context?: GatewayProfileResolverContext,
) => GatewayRuntimeTarget

/**
 * Create the default profile resolver.
 *
 * Resolution priority:
 *   1. Role binding: if sessionId is provided, look up agent_room_role_bindings
 *      for role='developer'. If found, use binding.agentId as profileName.
 *   2. assignedAgentId: if set, treat it as profileName.
 *   3. GatewayManager: if available, resolve upstream/apiKey from profileName.
 *   4. Constructor fallback: use constructor upstream/apiKey.
 */
export function createDefaultGatewayProfileResolver(): GatewayProfileResolver {
    return (assignedAgentId, fallbackUpstream, fallbackApiKey, context) => {
        const mgr = getGatewayManagerInstance()

        // Priority 1: Role binding lookup (graceful degradation if table missing)
        let profileName: string | undefined
        let resolutionSource: GatewayRuntimeTarget['resolutionSource']

        if (context?.sessionId) {
            try {
                const binding = getRoleBindingBySessionAndRole(context.sessionId, 'developer')
                if (binding) {
                    profileName = binding.agentId
                    resolutionSource = 'role-binding'
                }
            } catch {
                // Table may not exist yet — fall through to assignedAgentId
            }
        }

        // Priority 2: assignedAgentId direct mapping
        if (!profileName) {
            profileName = assignedAgentId || undefined
        }

        // Priority 3+4: GatewayManager or constructor fallback
        if (mgr && profileName) {
            return {
                upstream: mgr.getUpstream(profileName),
                apiKey: mgr.getApiKey(profileName) ?? fallbackApiKey ?? null,
                profileName,
                resolutionSource: resolutionSource ?? 'gateway-manager',
            }
        }

        if (mgr && !profileName) {
            return {
                upstream: mgr.getUpstream() || fallbackUpstream,
                apiKey: mgr.getApiKey() ?? fallbackApiKey ?? null,
                resolutionSource: resolutionSource ?? 'gateway-manager',
            }
        }

        // No manager — use constructor fallbacks
        return {
            upstream: fallbackUpstream,
            apiKey: fallbackApiKey ?? null,
            profileName,
            resolutionSource: resolutionSource ?? 'constructor-fallback',
        }
    }
}
