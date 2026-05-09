// ─── Gateway Profile Resolver ───────────────────────────────────
// Resolves a profileName to a GatewayRuntimeTarget containing
// upstream, apiKey, model, provider, and transportSource.
//
// The resolver is DB-free: role binding resolution (sessionId + role → profileName)
// is handled by the service/runtime layer. The resolver only maps
// profileName → Gateway target via GatewayManager or constructor fallback.
//
// Resolution priority:
//   1. GatewayManager: if available, resolve upstream/apiKey from profileName.
//   2. Constructor fallback: use constructor upstream/apiKey.

import { getGatewayManagerInstance } from '../../../../gateway-bootstrap'

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
    /**
     * How the upstream/apiKey transport was resolved.
     * - 'gateway-manager': resolved via GatewayManager.getUpstream/getApiKey
     * - 'constructor-fallback': fell back to constructor upstream/apiKey
     */
    transportSource?: 'gateway-manager' | 'constructor-fallback'
}

/**
 * Resolves a profileName to a GatewayRuntimeTarget.
 * The resolver is pure: no DB access, no side effects.
 */
export type GatewayProfileResolver = (
    profileName: string | undefined,
    fallbackUpstream: string,
    fallbackApiKey?: string | null,
) => GatewayRuntimeTarget

/**
 * Create the default profile resolver.
 *
 * Resolution priority:
 *   1. GatewayManager: if available, resolve upstream/apiKey from profileName.
 *   2. Constructor fallback: use constructor upstream/apiKey.
 */
export function createDefaultGatewayProfileResolver(): GatewayProfileResolver {
    return (profileName, fallbackUpstream, fallbackApiKey) => {
        const mgr = getGatewayManagerInstance()

        if (mgr && profileName) {
            return {
                upstream: mgr.getUpstream(profileName),
                apiKey: mgr.getApiKey(profileName) ?? fallbackApiKey ?? null,
                transportSource: 'gateway-manager',
            }
        }

        if (mgr && !profileName) {
            return {
                upstream: mgr.getUpstream() || fallbackUpstream,
                apiKey: mgr.getApiKey() ?? fallbackApiKey ?? null,
                transportSource: 'gateway-manager',
            }
        }

        // No manager — use constructor fallbacks
        return {
            upstream: fallbackUpstream,
            apiKey: fallbackApiKey ?? null,
            transportSource: 'constructor-fallback',
        }
    }
}
