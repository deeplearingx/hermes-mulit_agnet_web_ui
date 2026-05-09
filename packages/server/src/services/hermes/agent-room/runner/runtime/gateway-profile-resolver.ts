// ─── Gateway Profile Resolver ───────────────────────────────────
// Resolves an AgentRoom assignedAgentId to a GatewayRuntimeTarget
// containing upstream, apiKey, model, and provider.
//
// The default resolver uses GatewayManager (if available) to look up
// profile-specific upstream/apiKey. When GatewayManager is not
// initialized (e.g. in tests or standalone scripts), it falls back
// to the constructor-provided upstream/apiKey.

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
    /** The profile name resolved from assignedAgentId (for metadata). */
    profileName?: string
    /**
     * How this target was resolved.
     * - 'gateway-manager': resolved via GatewayManager.getUpstream/getApiKey
     * - 'constructor-fallback': fell back to constructor upstream/apiKey
     */
    resolutionSource?: 'gateway-manager' | 'constructor-fallback'
}

/**
 * Resolves an assignedAgentId to a GatewayRuntimeTarget.
 */
export type GatewayProfileResolver = (
    assignedAgentId: string | undefined,
    fallbackUpstream: string,
    fallbackApiKey?: string | null,
) => GatewayRuntimeTarget

/**
 * Create the default profile resolver.
 *
 * Resolution logic:
 *   1. If assignedAgentId is set, treat it as profileName.
 *   2. If GatewayManager is available, use manager.getUpstream(profileName)
 *      and manager.getApiKey(profileName).
 *   3. If GatewayManager is not available, fall back to constructor
 *      upstream/apiKey.
 */
export function createDefaultGatewayProfileResolver(): GatewayProfileResolver {
    return (assignedAgentId, fallbackUpstream, fallbackApiKey) => {
        // NOTE: assignedAgentId is currently interpreted directly as profileName.
        // This is a temporary mapping until P4.8.2 introduces a proper agent binding table.
        const profileName = assignedAgentId || undefined
        const mgr = getGatewayManagerInstance()

        if (mgr && profileName) {
            return {
                upstream: mgr.getUpstream(profileName),
                apiKey: mgr.getApiKey(profileName) ?? fallbackApiKey ?? null,
                profileName,
                resolutionSource: 'gateway-manager',
            }
        }

        if (mgr && !profileName) {
            return {
                upstream: mgr.getUpstream() || fallbackUpstream,
                apiKey: mgr.getApiKey() ?? fallbackApiKey ?? null,
                resolutionSource: 'gateway-manager',
            }
        }

        // No manager — use constructor fallbacks
        return {
            upstream: fallbackUpstream,
            apiKey: fallbackApiKey ?? null,
            profileName,
            resolutionSource: 'constructor-fallback',
        }
    }
}
