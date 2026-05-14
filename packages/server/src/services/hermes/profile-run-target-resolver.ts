import { readConfigYamlForProfile } from '../config-helpers'
import {
    getProfileDefaultModel,
    getProfileDefaultProvider,
    getProfileProviderKeys,
    hasProfileProviderEntry,
    inferProvider,
    inferProviderForProfile,
    matchBuiltInProvider,
    matchCustomProvider,
} from '../../shared/infer-provider'
import { getGatewayManagerInstance } from '../gateway-bootstrap'

export type GatewayTransportSource = 'gateway-manager' | 'constructor-fallback'
export type ModelResolutionSource = 'override' | 'gateway-manager' | 'profile.model.default' | 'none'
export type ProviderResolutionSource =
    | 'override'
    | 'gateway-manager'
    | 'profile.model.provider'
    | 'custom_providers'
    | 'providers-map'
    | 'built-in-catalog'
    | 'none'

export interface GatewayRuntimeTarget {
    upstream: string
    apiKey?: string | null
    model?: string
    provider?: string
    transportSource?: GatewayTransportSource
}

export interface ProfileRunTargetDiagnostics {
    profileName?: string
    hasProfileConfig: boolean
    hasModelDefault: boolean
    hasModelProvider: boolean
    providerKeys: string[]
    customProviderMatched: boolean
    builtInProviderMatched: boolean
    attemptedProfileInference: boolean
    attemptedGenericInference: boolean
}

export interface ResolvedProfileRunTarget extends GatewayRuntimeTarget {
    modelSource: ModelResolutionSource
    providerSource: ProviderResolutionSource
    providerInferred: boolean
    diagnostics: ProfileRunTargetDiagnostics
}

export interface ResolveProfileRunTargetOptions {
    profileName?: string
    fallbackUpstream: string
    fallbackApiKey?: string | null
    modelOverride?: string
    providerOverride?: string
    baseTarget?: GatewayRuntimeTarget
}

function normalize(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : undefined
}

export async function resolveProfileRunTarget(options: ResolveProfileRunTargetOptions): Promise<ResolvedProfileRunTarget> {
    const profileName = normalize(options.profileName)
    const modelOverride = normalize(options.modelOverride)
    const providerOverride = normalize(options.providerOverride)
    const mgr = getGatewayManagerInstance()
    const baseTarget = options.baseTarget

    let upstream = baseTarget?.upstream ?? options.fallbackUpstream
    let apiKey = baseTarget?.apiKey ?? options.fallbackApiKey ?? null
    let transportSource: GatewayTransportSource = baseTarget?.transportSource ?? 'constructor-fallback'
    let gatewayModel = normalize(baseTarget?.model)
    let gatewayProvider = normalize(baseTarget?.provider)

    if (!baseTarget && mgr) {
        upstream = profileName ? mgr.getUpstream(profileName) : (mgr.getUpstream() || options.fallbackUpstream)
        apiKey = profileName ? (mgr.getApiKey(profileName) ?? options.fallbackApiKey ?? null) : (mgr.getApiKey() ?? options.fallbackApiKey ?? null)
        gatewayModel = normalize(profileName ? mgr.getModel(profileName) : mgr.getModel())
        gatewayProvider = normalize(profileName ? mgr.getProvider(profileName) : mgr.getProvider())
        transportSource = 'gateway-manager'
    }

    const profileConfig = await readConfigYamlForProfile(profileName)
    const profileDefaultModel = getProfileDefaultModel(profileConfig)
    const profileDefaultProvider = getProfileDefaultProvider(profileConfig)
    const providerKeys = getProfileProviderKeys(profileConfig)

    let modelSource: ModelResolutionSource = 'none'
    let providerSource: ProviderResolutionSource = 'none'
    let finalModel = modelOverride
    let finalProvider = providerOverride
    let customProviderMatched = false
    let builtInProviderMatched = false
    let attemptedProfileInference = false
    let attemptedGenericInference = false

    if (finalModel) {
        modelSource = 'override'
    } else if (gatewayModel) {
        finalModel = gatewayModel
        modelSource = 'gateway-manager'
    } else if (profileDefaultModel) {
        finalModel = profileDefaultModel
        modelSource = 'profile.model.default'
    }

    if (finalProvider) {
        providerSource = 'override'
    } else if (!modelOverride && gatewayProvider) {
        finalProvider = gatewayProvider
        providerSource = 'gateway-manager'
    }

    if (!finalProvider && finalModel) {
        if (profileDefaultProvider && (!profileDefaultModel || profileDefaultModel === finalModel)) {
            finalProvider = profileDefaultProvider
            providerSource = 'profile.model.provider'
        }
    }

    if (!finalProvider && finalModel) {
        const customProvider = matchCustomProvider(finalModel, profileConfig)
        if (customProvider) {
            finalProvider = customProvider
            providerSource = 'custom_providers'
            customProviderMatched = true
        }
    }

    if (!finalProvider && finalModel) {
        attemptedProfileInference = true
        const inferred = await inferProviderForProfile(profileName, finalModel)
        if (inferred) {
            finalProvider = inferred
            if (hasProfileProviderEntry(profileConfig, inferred)) {
                providerSource = 'providers-map'
            } else if (inferred === profileDefaultProvider) {
                providerSource = 'profile.model.provider'
            } else if (inferred.startsWith('custom:')) {
                providerSource = 'custom_providers'
                customProviderMatched = true
            } else {
                providerSource = 'built-in-catalog'
                builtInProviderMatched = true
            }
        }
    }

    if (!finalProvider && finalModel) {
        attemptedGenericInference = true
        const inferred = await inferProvider(finalModel)
        if (inferred) {
            finalProvider = inferred
            if (hasProfileProviderEntry(profileConfig, inferred)) {
                providerSource = 'providers-map'
            } else if (matchBuiltInProvider(finalModel) === inferred) {
                providerSource = 'built-in-catalog'
                builtInProviderMatched = true
            } else {
                providerSource = inferred.startsWith('custom:') ? 'custom_providers' : 'built-in-catalog'
                customProviderMatched = inferred.startsWith('custom:')
                builtInProviderMatched = !inferred.startsWith('custom:')
            }
        }
    }

    return {
        upstream,
        apiKey,
        model: finalModel,
        provider: finalProvider,
        transportSource,
        modelSource,
        providerSource,
        providerInferred: providerSource === 'custom_providers' || providerSource === 'providers-map' || providerSource === 'built-in-catalog',
        diagnostics: {
            profileName,
            hasProfileConfig: Object.keys(profileConfig).length > 0,
            hasModelDefault: !!profileDefaultModel,
            hasModelProvider: !!profileDefaultProvider,
            providerKeys,
            customProviderMatched,
            builtInProviderMatched,
            attemptedProfileInference,
            attemptedGenericInference,
        },
    }
}

export function assertResolvedProfileRunTarget(
    target: ResolvedProfileRunTarget,
    context: { role: string; profileName?: string },
): void {
    if (!target.model || !target.provider) {
        const profileLabel = context.profileName ?? '(active-profile)'
        throw new Error(
            `Agent Room model resolution failed [role=${context.role}, profile=${profileLabel}, model=${target.model ?? 'missing'}, provider=${target.provider ?? 'missing'}, modelSource=${target.modelSource}, providerSource=${target.providerSource}]: ` +
            'cannot determine an inference provider before starting the Gateway run. Set role binding provider/model or fix the Hermes profile config (model.provider, providers map, or custom_providers).',
        )
    }
}
