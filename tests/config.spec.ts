import { describe, expect, it, vi } from 'vitest'
import {
  BUILT_IN_FREE_VISION_BASE_URL,
  BUILT_IN_FREE_VISION_CREDENTIAL,
  BUILT_IN_FREE_VISION_KEY,
  BUILT_IN_FREE_VISION_MODEL,
  DEFAULT_VISION_USER_AGENT,
  isBuiltInFreeVisionProvider,
  prepareWatchedSettingsGeneration,
  retainedStorageHistory,
  resolveConfig,
} from '../src/config.ts'

describe('resolveConfig', () => {
  it('applies install-and-use free vision defaults', () => {
    const config = resolveConfig({})
    expect(config.provider.baseUrl).toBe(BUILT_IN_FREE_VISION_BASE_URL)
    expect(config.provider.credential).toBe(BUILT_IN_FREE_VISION_CREDENTIAL)
    expect(BUILT_IN_FREE_VISION_KEY).toBe('https://agent-vision.anionex.me')
    expect(config.provider.model).toBe(BUILT_IN_FREE_VISION_MODEL)
    expect(config.provider.protocol).toBe('openai')
    expect(config.provider.anthropicThinking).toBe('omit')
    expect(config.provider.userAgent).toBe(DEFAULT_VISION_USER_AGENT)
    expect(config.provider.stream).toBe(false)
    expect(config.language).toBe('zh')
    expect(config.hardTimeoutSeconds).toBe(180)
    expect(config.sessionMaxConcurrency).toBe(6)
    expect(config.minAvailableSeconds).toBe(20)
    expect(config.maxImageBytes).toBe(4194304)
    expect(config.maxImagePixels).toBe(20000000)
    expect(isBuiltInFreeVisionProvider(config.provider)).toBe(true)
    expect(config.concurrency).toBe(4)
    expect(config.runtime.mode).toBe('managed')
    expect(config.runtime.python).toBeUndefined()
    expect(config.storageDir).toBeUndefined()
    expect(config.storageHistory).toEqual([])
    expect(config.allowedDirs).toEqual([])
    expect(config.imageInputVariants).toEqual({ enabled: true, providers: [], autoSwitch: true, hidden: true })
  })

  it('normalizes image-input variant settings', () => {
    const config = resolveConfig({
      imageInputVariants: {
        enabled: false,
        providers: [' deepseek-official ', '  ', 'glm'],
      },
    })
    expect(config.imageInputVariants).toEqual({ enabled: false, providers: ['deepseek-official', 'glm'], autoSwitch: true, hidden: true })
    expect(resolveConfig({ imageInputVariants: {} }).imageInputVariants).toEqual({ enabled: true, providers: [], autoSwitch: true, hidden: true })
    expect(resolveConfig({ imageInputVariants: { hidden: true } }).imageInputVariants.hidden).toBe(true)
  })

  it('retains prior storage roots across resolved Settings generations', () => {
    expect(retainedStorageHistory(
      { storageDir: '/storage/c', storageHistory: ['/storage/a'] },
      { storageDir: '/storage/b', storageHistory: ['/storage/a'] },
    )).toEqual(['/storage/a', '/storage/b'])
    expect(retainedStorageHistory(
      { storageDir: '/storage/a' },
      { storageDir: '/storage/a', storageHistory: ['/storage/b'] },
    )).toEqual(['/storage/b'])
  })

  it('keeps read-only or failed history writeback from blocking live Settings activation', async () => {
    const previous = { storageDir: '/storage/a' }
    const next = { storageDir: '/storage/b' }
    const readOnlyPersist = vi.fn(async () => {})

    await expect(prepareWatchedSettingsGeneration(next, previous, false, readOnlyPersist))
      .resolves.toEqual({
        config: { storageDir: '/storage/b', storageHistory: ['/storage/a'] },
        requiresDurableStorageHistory: true,
      })
    expect(readOnlyPersist).not.toHaveBeenCalled()

    const failure = new Error('read-only provider')
    const failedPersist = vi.fn(async () => { throw failure })
    await expect(prepareWatchedSettingsGeneration(next, previous, true, failedPersist))
      .resolves.toEqual({
        config: { storageDir: '/storage/b', storageHistory: ['/storage/a'] },
        requiresDurableStorageHistory: true,
        persistenceError: failure,
      })
  })

  it('does not treat an omitted empty history as a writeback requirement', async () => {
    const persist = vi.fn(async () => {})

    await expect(prepareWatchedSettingsGeneration(
      { storageDir: '/storage/a', concurrency: 2 },
      { storageDir: '/storage/a', concurrency: 1 },
      false,
      persist,
    )).resolves.toEqual({ config: { storageDir: '/storage/a', concurrency: 2 } })
    expect(persist).not.toHaveBeenCalled()
  })

  it('waits for the persisted Settings generation after internal history writeback succeeds', async () => {
    const persist = vi.fn(async () => {})

    await expect(prepareWatchedSettingsGeneration(
      { storageDir: '/storage/b' },
      { storageDir: '/storage/a' },
      true,
      persist,
    )).resolves.toEqual({})
    expect(persist).toHaveBeenCalledWith(['/storage/a'])
  })

  it('normalizes the provider URL and credential', () => {
    const config = resolveConfig({
      provider: {
        baseUrl: 'https://example.com/v1/',
        credential: 'MY_VISION_KEY',
        model: 'model-x',
        protocol: 'anthropic',
        anthropicThinking: 'disabled',
        userAgent: 'custom-vision-client/2.0',
        stream: true,
      },
      language: 'en',
      runtime: { mode: 'external', agentVisionToolkitPath: '/tmp/toolkit', python: 'python3.12' },
      storageDir: ' /tmp/dsh-vision-toolkit ',
      storageHistory: [' /previous/storage ', '/tmp/dsh-vision-toolkit', '/previous/storage', '  '],
      allowedDirs: ['~/Pictures'],
    })
    expect(config.provider.baseUrl).toBe('https://example.com/v1')
    expect(config.provider.credential).toBe('MY_VISION_KEY')
    expect(config.runtime.agentVisionToolkitPath).toBe('/tmp/toolkit')
    expect(config.storageDir).toBe('/tmp/dsh-vision-toolkit')
    expect(config.storageHistory).toEqual(['/previous/storage'])
    expect(config.provider.protocol).toBe('anthropic')
    expect(config.provider.anthropicThinking).toBe('disabled')
    expect(config.provider.userAgent).toBe('custom-vision-client/2.0')
    expect(config.provider.stream).toBe(true)
    expect(config.allowedDirs).toEqual(['~/Pictures'])
    expect(resolveConfig({ storageDir: '   ' }).storageDir).toBeUndefined()
  })

  it('keeps the v0.1.10 Moondream default recognized as the built-in free provider', () => {
    const config = resolveConfig({
      provider: {
        baseUrl: BUILT_IN_FREE_VISION_BASE_URL,
        credential: BUILT_IN_FREE_VISION_CREDENTIAL,
        model: 'moondream-3.1',
        protocol: 'openai',
      },
    })
    expect(isBuiltInFreeVisionProvider(config.provider)).toBe(true)
  })

  it('rejects a non-http baseUrl', () => {
    expect(() => resolveConfig({ provider: { baseUrl: 'ftp://x' } }))
      .toThrowError(/provider\.baseUrl/)
  })

  it('rejects an invalid credential reference', () => {
    expect(() => resolveConfig({ provider: { credential: 'not a ref!' } }))
      .toThrowError(/credential/)
  })

  it('rejects an empty model', () => {
    expect(() => resolveConfig({ provider: { model: '  ' } }))
      .toThrowError(/provider\.model/)
  })

  it('rejects an empty User-Agent', () => {
    expect(() => resolveConfig({ provider: { userAgent: '  ' } }))
      .toThrowError(/provider\.userAgent/)
  })

  it('rejects an unsupported Anthropic thinking mode', () => {
    expect(() => resolveConfig({ provider: { anthropicThinking: 'manual' as 'omit' } }))
      .toThrowError(/provider\.anthropicThinking/)
  })

  it('rejects an unsupported provider protocol', () => {
    expect(() => resolveConfig({ provider: { protocol: 'responses' as 'openai' } }))
      .toThrowError(/provider\.protocol/)
  })

  it('rejects unsupported language and limits', () => {
    expect(() => resolveConfig({ language: 'fr' as 'zh' })).toThrowError(/language/)
    expect(() => resolveConfig({ hardTimeoutSeconds: 0 })).toThrowError(/hardTimeoutSeconds/)
    expect(() => resolveConfig({ sessionMaxConcurrency: 0 })).toThrowError(/sessionMaxConcurrency/)
    expect(() => resolveConfig({ minAvailableSeconds: 0 })).toThrowError(/minAvailableSeconds/)
    expect(() => resolveConfig({ maxImageBytes: 1 })).toThrowError(/maxImageBytes/)
    expect(() => resolveConfig({ maxImagePixels: 0 })).toThrowError(/maxImagePixels/)
    expect(() => resolveConfig({ concurrency: 0 })).toThrowError(/concurrency/)
  })

  it('accepts managed runtime without a local checkout path', () => {
    expect(resolveConfig({ runtime: { mode: 'managed' } }).runtime).toEqual({ mode: 'managed' })
  })

  it('rejects contradictory or empty runtime settings', () => {
    expect(() => resolveConfig({ runtime: { mode: 'external', agentVisionToolkitPath: '  ' } })).toThrowError(/agentVisionToolkitPath/)
    expect(() => resolveConfig({ runtime: { mode: 'external' } })).toThrowError(/agentVisionToolkitPath/)
    expect(() => resolveConfig({ runtime: { mode: 'managed', agentVisionToolkitPath: '/tmp/toolkit' } })).toThrowError(/only valid/)
    expect(() => resolveConfig({ runtime: { python: '  ' } })).toThrowError(/runtime\.python/)
  })
})

describe('resolveConfig providers', () => {
  it('resolves an ordered provider pool with inherited limits', () => {
    const config = resolveConfig({
      providers: [
        { name: 'A', baseUrl: 'https://a.example/v1', credential: 'KEY_A', model: 'model-a' },
        { name: 'B', baseUrl: 'https://b.example/v1', credential: 'KEY_B', model: 'model-b', attempts: 5, concurrency: 2 },
      ],
      maxImageBytes: 1048576,
      maxImagePixels: 8000000,
      concurrency: 6,
    })
    expect(config.providers).toHaveLength(2)
    const [a, b] = config.providers
    expect(a).toMatchObject({
      name: 'A', enabled: true, baseUrl: 'https://a.example/v1', model: 'model-a',
      maxImageBytes: 1048576, maxImagePixels: 8000000, concurrency: 6, attempts: 3,
      t1Seconds: 90, t2Seconds: 90,
    })
    expect(b).toMatchObject({ name: 'B', attempts: 5, concurrency: 2, enabled: true })
    expect(config.provider.baseUrl).toBe('https://a.example/v1')
    expect(config.provider.model).toBe('model-a')
  })

  it('keeps disabled providers valid with blank connection fields', () => {
    const config = resolveConfig({
      providers: [
        { name: 'on', baseUrl: 'https://on.example/v1', credential: 'KEY', model: 'm' },
        { name: 'off', enabled: false },
      ],
    })
    expect(config.providers[1]).toMatchObject({ enabled: false, baseUrl: BUILT_IN_FREE_VISION_BASE_URL })
    expect(config.provider.baseUrl).toBe('https://on.example/v1')
  })

  it('rejects an enabled provider with an empty connection field', () => {
    expect(() => resolveConfig({ providers: [{ name: 'x', model: 'm', credential: 'KEY' }] }))
      .toThrowError(/providers\[0\]\.baseUrl/)
    expect(() => resolveConfig({ providers: [{ name: 'x', baseUrl: 'https://x.example/v1', credential: 'KEY' }] }))
      .toThrowError(/providers\[0\]\.model/)
    expect(() => resolveConfig({ providers: [{ name: 'x', baseUrl: 'https://x.example/v1', model: 'm' }] }))
      .toThrowError(/providers\[0\]\.credential/)
  })

  it('falls back to the legacy provider when providers is empty', () => {
    const config = resolveConfig({ provider: { baseUrl: 'https://legacy.example/v1', credential: 'KEY', model: 'm' } })
    expect(config.providers).toHaveLength(1)
    expect(config.providers[0]).toMatchObject({ baseUrl: 'https://legacy.example/v1', model: 'm', enabled: true })
  })
})
