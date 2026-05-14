import { buildProviderModelMap } from './providers'
import { readConfigYaml, readConfigYamlForProfile } from '../services/config-helpers'

function normalizeNonEmpty(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : undefined
}

export function getProfileDefaultModel(config: Record<string, any> | null | undefined): string | undefined {
    const modelSection = config?.model
    if (typeof modelSection === 'string') {
        return normalizeNonEmpty(modelSection)
    }
    if (modelSection && typeof modelSection === 'object') {
        return normalizeNonEmpty(modelSection.default)
    }
    return undefined
}

export function getProfileDefaultProvider(config: Record<string, any> | null | undefined): string | undefined {
    const modelSection = config?.model
    if (modelSection && typeof modelSection === 'object') {
        return normalizeNonEmpty(modelSection.provider)
    }
    return undefined
}

export function getProfileProviderKeys(config: Record<string, any> | null | undefined): string[] {
    const providers = config?.providers
    if (!providers || typeof providers !== 'object') return []
    return Object.keys(providers)
}

export function hasProfileProviderEntry(config: Record<string, any> | null | undefined, provider: string | undefined): boolean {
    if (!provider) return false
    return getProfileProviderKeys(config).includes(provider)
}

export function matchCustomProvider(modelName: string, config: Record<string, any> | null | undefined): string | undefined {
    const customProviders: Array<{ name?: string; model?: string; models?: Record<string, any> }> =
        Array.isArray(config?.custom_providers) ? config.custom_providers : []
    for (const cp of customProviders) {
        const cpModels = Object.keys(cp.models || {})
        if (cp.model === modelName || cpModels.includes(modelName)) {
            return cp.name ? `custom:${cp.name}` : 'custom'
        }
    }
    return undefined
}

export function matchBuiltInProvider(modelName: string): string | undefined {
    const catalog = buildProviderModelMap()
    for (const [provider, models] of Object.entries(catalog)) {
        if (models.includes(modelName)) return provider
    }
    return undefined
}

function matchProfileDefaultProvider(modelName: string, config: Record<string, any> | null | undefined): string | undefined {
    const defaultProvider = getProfileDefaultProvider(config)
    if (!defaultProvider) return undefined

    const defaultModel = getProfileDefaultModel(config)
    if (!defaultModel || defaultModel === modelName) {
        return defaultProvider
    }
    return undefined
}

export function inferProviderFromConfig(modelName: string, config: Record<string, any> | null | undefined): string | undefined {
    if (!modelName) return undefined

    const explicitDefaultProvider = matchProfileDefaultProvider(modelName, config)
    if (explicitDefaultProvider) return explicitDefaultProvider

    const customProvider = matchCustomProvider(modelName, config)
    if (customProvider) return customProvider

    return undefined
}

/**
 * Infer the provider key for a given model name.
 * Priority:
 *   1. active profile default model.provider when it applies to the selected model
 *   2. custom_providers in active profile config (exact model match)
 *   3. Built-in PROVIDER_PRESETS catalog
 *   4. undefined (caller falls back to Gateway/default handling)
 */
export async function inferProvider(modelName: string): Promise<string | undefined> {
    if (!modelName) return undefined

    try {
        const provider = inferProviderFromConfig(modelName, await readConfigYaml())
        if (provider) return provider
    } catch {
        // ignore config read errors
    }

    return matchBuiltInProvider(modelName)
}

/**
 * Infer the provider key for a given model name using the specified Hermes profile first,
 * then fall back to the built-in provider catalog.
 */
export async function inferProviderForProfile(profileName: string | undefined, modelName: string): Promise<string | undefined> {
    if (!modelName) return undefined

    try {
        const provider = inferProviderFromConfig(modelName, await readConfigYamlForProfile(profileName))
        if (provider) return provider
    } catch {
        // ignore config read errors
    }

    return matchBuiltInProvider(modelName)
}
