import { buildProviderModelMap } from '../../../shared/providers'
import { readConfigYaml } from '../../config-helpers'

/**
 * Infer the provider key for a given model name.
 * Priority:
 *   1. custom_providers in config.yaml (exact model match)
 *   2. Built-in PROVIDER_PRESETS catalog
 *   3. undefined (caller falls back to Gateway default)
 */
export async function inferProvider(modelName: string): Promise<string | undefined> {
    if (!modelName) return undefined

    // 1. Check custom_providers in active profile config
    try {
        const config = await readConfigYaml()
        const customProviders: Array<{ name?: string; model?: string; models?: Record<string, any> }> =
            Array.isArray(config?.custom_providers) ? config.custom_providers : []
        for (const cp of customProviders) {
            const cpModels = Object.keys(cp.models || {})
            if (cp.model === modelName || cpModels.includes(modelName)) {
                const key = cp.name ? `custom:${cp.name}` : 'custom'
                return key
            }
        }
    } catch {
        // ignore config read errors
    }

    // 2. Built-in provider catalog
    const catalog = buildProviderModelMap()
    for (const [provider, models] of Object.entries(catalog)) {
        if (models.includes(modelName)) return provider
    }

    return undefined
}
