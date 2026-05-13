import { buildProviderModelMap } from './providers'
import { readConfigYaml, readConfigYamlForProfile } from '../services/config-helpers'

function matchCustomProvider(modelName: string, config: Record<string, any> | null | undefined): string | undefined {
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

function matchBuiltInProvider(modelName: string): string | undefined {
    const catalog = buildProviderModelMap()
    for (const [provider, models] of Object.entries(catalog)) {
        if (models.includes(modelName)) return provider
    }
    return undefined
}

/**
 * Infer the provider key for a given model name.
 * Priority:
 *   1. custom_providers in active profile config (exact model match)
 *   2. Built-in PROVIDER_PRESETS catalog
 *   3. undefined (caller falls back to Gateway default)
 */
export async function inferProvider(modelName: string): Promise<string | undefined> {
    if (!modelName) return undefined

    try {
        const provider = matchCustomProvider(modelName, await readConfigYaml())
        if (provider) return provider
    } catch {
        // ignore config read errors
    }

    return matchBuiltInProvider(modelName)
}

/**
 * Infer the provider key for a given model name using the specified Hermes profile first,
 * then fall back to the built-in provider catalog.
 * This mirrors group chat's last-mile resolution semantics more closely while still
 * preferring profile-local custom providers when available.
 */
export async function inferProviderForProfile(profileName: string | undefined, modelName: string): Promise<string | undefined> {
    if (!modelName) return undefined

    try {
        const provider = matchCustomProvider(modelName, await readConfigYamlForProfile(profileName))
        if (provider) return provider
    } catch {
        // ignore config read errors
    }

    return matchBuiltInProvider(modelName)
}
