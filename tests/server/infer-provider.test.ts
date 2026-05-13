import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock config-helpers to control custom_providers
vi.mock('../../packages/server/src/services/config-helpers', () => ({
    readConfigYaml: vi.fn(),
    readConfigYamlForProfile: vi.fn(),
}))

import { readConfigYaml, readConfigYamlForProfile } from '../../packages/server/src/services/config-helpers'
import { inferProvider } from '../../packages/server/src/services/hermes/group-chat/infer-provider'
import { inferProviderForProfile } from '../../packages/server/src/shared/infer-provider'

const mockReadConfig = readConfigYaml as ReturnType<typeof vi.fn>
const mockReadConfigForProfile = readConfigYamlForProfile as ReturnType<typeof vi.fn>

describe('inferProvider', () => {
    beforeEach(() => {
        mockReadConfig.mockResolvedValue({})
        mockReadConfigForProfile.mockResolvedValue({})
    })

    it('returns undefined for empty model name', async () => {
        expect(await inferProvider('')).toBeUndefined()
    })

    it('matches built-in provider from PROVIDER_PRESETS', async () => {
        // deepseek is in PROVIDER_PRESETS with models ['deepseek-v4-flash', 'deepseek-v4-pro']
        const result = await inferProvider('deepseek-v4-flash')
        expect(result).toBe('deepseek')
    })

    it('matches custom provider by model field', async () => {
        mockReadConfig.mockResolvedValue({
            custom_providers: [
                { name: 'my-ark', model: 'MiniMax-M2.7', base_url: 'https://ark.example.com' },
            ],
        })
        const result = await inferProvider('MiniMax-M2.7')
        expect(result).toBe('custom:my-ark')
    })

    it('matches custom provider by models object keys', async () => {
        mockReadConfig.mockResolvedValue({
            custom_providers: [
                { name: 'my-provider', models: { 'custom-model-x': {} }, base_url: 'https://example.com' },
            ],
        })
        const result = await inferProvider('custom-model-x')
        expect(result).toBe('custom:my-provider')
    })

    it('returns undefined for unknown model', async () => {
        const result = await inferProvider('totally-unknown-model-xyz')
        expect(result).toBeUndefined()
    })

    it('matches custom provider from the bound profile config', async () => {
        mockReadConfigForProfile.mockResolvedValue({
            custom_providers: [
                { name: 'kimi', model: 'Kimi-K2.6', base_url: 'https://ark.example.com' },
            ],
        })

        const result = await inferProviderForProfile('kimi', 'Kimi-K2.6')
        expect(result).toBe('custom:kimi')
        expect(mockReadConfigForProfile).toHaveBeenCalledWith('kimi')
    })

    it('falls back to built-in provider catalog when the bound profile has no custom provider match', async () => {
        mockReadConfigForProfile.mockResolvedValue({ custom_providers: [] })

        const result = await inferProviderForProfile('kimi', 'deepseek-v4-flash')
        expect(result).toBe('deepseek')
    })

    it('reads the explicit default profile instead of active-profile fallback', async () => {
        mockReadConfigForProfile.mockResolvedValue({
            custom_providers: [
                { name: 'default-ark', model: 'Kimi-K2.6', base_url: 'https://ark.example.com' },
            ],
        })

        const result = await inferProviderForProfile('default', 'Kimi-K2.6')
        expect(result).toBe('custom:default-ark')
        expect(mockReadConfigForProfile).toHaveBeenCalledWith('default')
    })
})
