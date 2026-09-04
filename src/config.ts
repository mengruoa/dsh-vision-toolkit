/**
 * Plugin configuration: provider endpoint and credential reference, output
 * language, limits, and the external upstream runtime location. Secrets never
 * live here — `provider.credential` is a DSH Credential reference resolved per
 * operation through `ctx.credentials`.
 * @module dsh-vision-toolkit/config
 */

import z from '@deepseek-ai/schemastery'
import type Schema from '@deepseek-ai/schemastery'
import { credentialRef, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { VisionToolkitError } from './errors.ts'
import {
  BUILT_IN_FREE_VISION_BASE_URL,
  BUILT_IN_FREE_VISION_CREDENTIAL,
  BUILT_IN_FREE_VISION_MODEL,
} from './defaults.ts'

export {
  BUILT_IN_FREE_VISION_BASE_URL,
  BUILT_IN_FREE_VISION_CREDENTIAL,
  BUILT_IN_FREE_VISION_KEY,
  BUILT_IN_FREE_VISION_MODEL,
} from './defaults.ts'

/**
 * The namespace pattern the removed `settingsNamespace` helper enforced.
 * dsh 0.1.2-alpha dropped that export; importing a missing named export is a
 * module-evaluation error that stops the host from booting, so the check is
 * inlined here instead of imported. The namespace is a static string, so no
 * runtime dependency on `@deepseek-ai/dsh-settings` is needed.
 */
const SETTINGS_NAMESPACE_PATTERN = /^[a-z][a-z0-9-]*$/

/** Settings document namespace owned by this plugin. */
export const VISION_TOOLKIT_SETTINGS_NAMESPACE = 'vision-toolkit' as SettingsNamespace

if (!SETTINGS_NAMESPACE_PATTERN.test(VISION_TOOLKIT_SETTINGS_NAMESPACE)) {
  throw new TypeError(`settings namespace "${VISION_TOOLKIT_SETTINGS_NAMESPACE}" must match ${String(SETTINGS_NAMESPACE_PATTERN)}`)
}

/** Browser-compatible default shared with the vendored Python client. */
export const DEFAULT_VISION_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

const BUILT_IN_FREE_VISION_MODEL_ALIASES = new Set([
  BUILT_IN_FREE_VISION_MODEL,
  'gemini-3.7-flash',
  'qwen/qwen3.6-27b',
  'qwen3.6-27b',
  'gemma-4-26b-a4b-it',
  'gemma-4-26b',
  '@cf/google/gemma-4-26b-a4b-it',
  '@cf/moondream/moondream3.1-9B-A2B',
  'moondream',
  'moondream-3.1',
  'moondream3.1-9B-A2B',
])

/** One online vision provider in the failover pool. */
export interface VisionProviderConfig {
  /** Stable unique id used to derive the auto-generated credential name. */
  id?: string
  /** Display label shown in Settings; defaults to the model name. */
  name?: string
  /** Whether this provider participates in the failover pool (default true). */
  enabled?: boolean
  /** Provider API base URL. */
  baseUrl?: string
  /** DSH Credential reference holding the API key (an environment-style name). */
  credential?: string
  /** Multimodal model name. */
  model?: string
  /** Vision request protocol: OpenAI Chat Completions or Anthropic Messages. */
  protocol?: 'openai' | 'anthropic'
  /** Anthropic thinking field behavior; `omit` leaves model defaults untouched. */
  anthropicThinking?: 'omit' | 'disabled' | 'adaptive'
  /** Outbound User-Agent for provider requests and connection tests. */
  userAgent?: string
  /** Whether to request a streamed (SSE) completion instead of one JSON response (default false). */
  stream?: boolean
  /** t1: per-request hedge threshold in seconds. A single request exceeding t1 keeps running while the next provider starts in parallel. */
  t1Seconds?: number
  /** t2: per-provider cumulative cutoff in seconds. Total accumulated request time reaching t2 terminates the provider. */
  t2Seconds?: number
  /** Per-provider maximum input image bytes; larger images skip to a later provider or are compressed. */
  maxImageBytes?: number
  /** Per-provider maximum decoded pixel count per input image. */
  maxImagePixels?: number
  /** Per-provider in-flight request cap; an exhausted provider is skipped in favor of the next one. */
  concurrency?: number
  /** Total attempts against this provider before failing over to the next one (default 3). */
  attempts?: number
}

/** Full user-facing configuration; every field defaults at the schema boundary. */
export interface VisionToolkitConfig {
  provider?: {
    /** Provider API base URL. */
    baseUrl?: string
    /** DSH Credential reference holding the API key (an environment-style name). */
    credential?: string
    /** Multimodal model name. */
    model?: string
    /** Vision request protocol: OpenAI Chat Completions or Anthropic Messages. */
    protocol?: 'openai' | 'anthropic'
    /** Anthropic thinking field behavior; `omit` leaves model defaults untouched. */
    anthropicThinking?: 'omit' | 'disabled' | 'adaptive'
    /** Outbound User-Agent for provider requests and connection tests. */
    userAgent?: string
    /** Whether to request a streamed (SSE) completion instead of one JSON response (default false). */
    stream?: boolean
  }
  /** Ordered online vision providers; array order is the failover priority. */
  providers?: VisionProviderConfig[]
  /** Vision output language (`zh` or `en`). */
  language?: 'zh' | 'en'
  /** Global hard timeout in seconds for one tool invocation; the call never exceeds it. */
  hardTimeoutSeconds?: number
  /** Per-session cap on concurrent tool operations (default 6). */
  sessionMaxConcurrency?: number
  /** Minimum remaining budget in seconds required before issuing a new request (default 20). */
  minAvailableSeconds?: number
  /** Maximum input image size in bytes; larger images are auto-compressed (lossless first). */
  maxImageBytes?: number
  /** Maximum decoded pixel count per input image; larger images are auto-downscaled to fit. */
  maxImagePixels?: number
  /** Default per-model in-flight request cap inherited by providers that do not set their own. */
  concurrency?: number
  runtime?: {
    /** `managed` uses the packaged snapshot and isolated venv; `external` uses a clean pinned checkout. */
    mode?: 'managed' | 'external'
    /** Required path to the clean pinned checkout when `mode` is `external`. */
    agentVisionToolkitPath?: string
    /** Optional Python 3.11+ bootstrap/interpreter override. */
    python?: string
  }
  /**
   * Optional shared storage root. When set, every workspace gets an isolated,
   * automatically generated child directory below this root instead of writing
   * `.dsh-vision-toolkit` into the workspace.
   */
  storageDir?: string
  /** Internal read-only history used to keep persisted paths valid after storage moves. */
  storageHistory?: string[]
  /** Extra directories (besides the workspace) inputs may come from. */
  allowedDirs?: string[]
  /**
   * Image-input variants: sibling model-selector entries for every model the
   * host positively declares text-only. A variant declares image input, so
   * pasted images keep the native attachment flow (composer thumbnail and
   * durable session image), and the plugin rewrites image blocks into Vision
   * Toolkit descriptions only on the wire to the model.
   */
  imageInputVariants?: {
    /** Whether variant routes are registered at all (default true). */
    enabled?: boolean
    /** Restrict wrapped upstream routes by provider id; empty wraps every eligible route. */
    providers?: string[]
    /**
     * Whether the browser paste integration automatically switches the Session
     * to the image-input variant of a text-only model before the paste, so
     * pasted images keep the native attachment flow with no manual model
     * change. The variant still exposes a workspace path to the model; off
     * keeps the path-only takeover instead (default true).
     */
    autoSwitch?: boolean
    /**
     * Transparent routing: variant routes keep the upstream provider and model
     * display names, and the browser integration hides the upstream text-only
     * entries that have a variant twin, so the model selector shows one entry
     * per model and sessions stay on the image-capable variant without users
     * seeing or switching a `(Vision Toolkit)` route. On by default; disable
     * to restore the explicit sibling entries.
     */
    hidden?: boolean
  }
}

/** Configuration schema with the documented P0 defaults. */
export const Config: Schema<VisionToolkitConfig> = z.object({
  provider: z.object({
    baseUrl: z.string().default(BUILT_IN_FREE_VISION_BASE_URL),
    credential: z.string().default(BUILT_IN_FREE_VISION_CREDENTIAL),
    model: z.string().default(BUILT_IN_FREE_VISION_MODEL),
    protocol: z.union(['openai', 'anthropic'] as const).default('openai'),
    anthropicThinking: z.union(['omit', 'disabled', 'adaptive'] as const).default('omit'),
    userAgent: z.string().default(DEFAULT_VISION_USER_AGENT),
    stream: z.boolean().default(false),
  }),
  providers: z.array(z.object({
    name: z.string(),
    enabled: z.boolean().default(true),
    id: z.string(),
    baseUrl: z.string(),
    credential: z.string(),
    model: z.string(),
    protocol: z.union(['openai', 'anthropic'] as const).default('openai'),
    anthropicThinking: z.union(['omit', 'disabled', 'adaptive'] as const).default('omit'),
    userAgent: z.string(),
    stream: z.boolean().default(false),
    t1Seconds: z.number(),
    t2Seconds: z.number(),
    maxImageBytes: z.number(),
    maxImagePixels: z.number(),
    concurrency: z.number(),
    attempts: z.number(),
  })).default([]),
  language: z.union(['zh', 'en'] as const).default('zh'),
  hardTimeoutSeconds: z.number().default(180),
  sessionMaxConcurrency: z.number().default(6),
  minAvailableSeconds: z.number().default(20),
  maxImageBytes: z.number().default(4194304),
  maxImagePixels: z.number().default(20000000),
  concurrency: z.number().default(4),
  runtime: z.object({
    mode: z.union(['managed', 'external'] as const).default('managed'),
    agentVisionToolkitPath: z.string(),
    python: z.string(),
  }),
  storageDir: z.string(),
  storageHistory: z.array(z.string()).default([]),
  allowedDirs: z.array(z.string()).default([]),
  imageInputVariants: z.object({
    enabled: z.boolean().default(true),
    providers: z.array(z.string()).default([]),
    autoSwitch: z.boolean().default(true),
    hidden: z.boolean().default(true),
  }),
})

/** One resolved online vision provider, with every default materialized. */
export interface ResolvedProvider {
  /** Stable unique id used to derive the auto-generated credential name. */
  id?: string
  name: string
  enabled: boolean
  baseUrl: string
  credential: CredentialRef
  model: string
  protocol: 'openai' | 'anthropic'
  anthropicThinking: 'omit' | 'disabled' | 'adaptive'
  userAgent: string
  stream: boolean
  t1Seconds: number
  t2Seconds: number
  maxImageBytes: number
  maxImagePixels: number
  concurrency: number
  attempts: number
}

/** Configuration after static validation, with every default materialized. */
export interface ResolvedVisionToolkitConfig {
  provider: {
    baseUrl: string
    credential: CredentialRef
    model: string
    protocol: 'openai' | 'anthropic'
    anthropicThinking: 'omit' | 'disabled' | 'adaptive'
    userAgent: string
    stream: boolean
  }
  /** Ordered failover pool; array order is the priority, highest first. */
  providers: ResolvedProvider[]
  language: 'zh' | 'en'
  hardTimeoutSeconds: number
  sessionMaxConcurrency: number
  minAvailableSeconds: number
  maxImageBytes: number
  maxImagePixels: number
  concurrency: number
  runtime: {
    mode: 'managed' | 'external'
    agentVisionToolkitPath?: string
    python?: string
  }
  storageDir?: string
  storageHistory: string[]
  allowedDirs: string[]
  imageInputVariants: {
    enabled: boolean
    providers: string[]
    autoSwitch: boolean
    hidden: boolean
  }
}

const MAX_TIMEOUT_SECONDS = 600
const MAX_IMAGE_BYTES = 268435456
const MAX_IMAGE_PIXELS = 268435456
const MAX_CONCURRENCY = 16
const MAX_PROVIDERS = 32
const MAX_PROVIDER_ATTEMPTS = 100
const DEFAULT_PROVIDER_ATTEMPTS = 3

/** Global limits a provider inherits when it does not set its own. */
interface ProviderDefaults {
  maxImageBytes: number
  maxImagePixels: number
  concurrency: number
}

/** How strictly one provider's connection fields are validated. */
type ProviderResolveMode = 'legacy' | 'enabled' | 'disabled'

/**
 * Resolve and validate one provider (a legacy `provider` entry or an element
 * of `providers`). `enabled` rejects absent or blank connection fields;
 * `legacy` fills absent fields with the built-in free-vision defaults but
 * still rejects explicit blank values; `disabled` is fully lenient.
 */
function resolveProvider(
  input: VisionProviderConfig,
  defaults: ProviderDefaults,
  label: string,
  mode: ProviderResolveMode,
): ResolvedProvider {
  const baseUrlInput = input.baseUrl
  const modelInput = input.model
  const credentialInput = input.credential
  const isBlank = (value: string | undefined): boolean => value === undefined || value.trim() === ''

  let baseUrl: string
  if (mode === 'enabled') {
    if (isBlank(baseUrlInput)) throw new VisionToolkitError('config', `${label}.baseUrl must not be empty`)
    baseUrl = baseUrlInput!.trim().replace(/\/+$/, '')
  } else if (mode === 'legacy') {
    baseUrl = baseUrlInput === undefined ? BUILT_IN_FREE_VISION_BASE_URL : baseUrlInput.trim().replace(/\/+$/, '')
  } else {
    baseUrl = isBlank(baseUrlInput) ? BUILT_IN_FREE_VISION_BASE_URL : baseUrlInput!.trim().replace(/\/+$/, '')
  }
  if (!/^https?:\/\//i.test(baseUrl) || baseUrl.length <= 'https://'.length) {
    throw new VisionToolkitError('config', `${label}.baseUrl must be an http(s) URL`)
  }

  let model: string
  if (mode === 'enabled') {
    if (isBlank(modelInput)) throw new VisionToolkitError('config', `${label}.model must not be empty`)
    model = modelInput!.trim()
  } else if (mode === 'legacy') {
    model = modelInput === undefined ? BUILT_IN_FREE_VISION_MODEL : modelInput.trim()
    if (model.length === 0) {
      throw new VisionToolkitError('config', `${label}.model must not be empty`)
    }
  } else {
    model = isBlank(modelInput) ? BUILT_IN_FREE_VISION_MODEL : modelInput!.trim()
  }

  let credentialSource: string
  if (mode === 'enabled') {
    if (isBlank(credentialInput)) throw new VisionToolkitError('config', `${label}.credential must not be empty`)
    credentialSource = credentialInput!.trim()
  } else if (mode === 'legacy') {
    credentialSource = credentialInput === undefined ? BUILT_IN_FREE_VISION_CREDENTIAL : credentialInput.trim()
  } else {
    credentialSource = isBlank(credentialInput) ? BUILT_IN_FREE_VISION_CREDENTIAL : credentialInput!.trim()
  }
  let credential: CredentialRef
  try {
    credential = credentialRef(credentialSource)
  } catch (error) {
    throw new VisionToolkitError('config', `${label}.credential "${credentialSource}" is not a valid credential reference`, { cause: error })
  }
  const protocol = input.protocol ?? 'openai'
  if (protocol !== 'openai' && protocol !== 'anthropic') {
    throw new VisionToolkitError('config', `${label}.protocol must be "openai" or "anthropic"`)
  }
  const anthropicThinking = input.anthropicThinking ?? 'omit'
  if (anthropicThinking !== 'omit' && anthropicThinking !== 'disabled' && anthropicThinking !== 'adaptive') {
    throw new VisionToolkitError('config', `${label}.anthropicThinking must be "omit", "disabled", or "adaptive"`)
  }
  const userAgent = (input.userAgent ?? DEFAULT_VISION_USER_AGENT).trim()
  if (userAgent.length === 0) {
    throw new VisionToolkitError('config', `${label}.userAgent must not be empty`)
  }
  const stream = input.stream === true
  const t1Seconds = input.t1Seconds ?? 90
  if (!Number.isInteger(t1Seconds) || t1Seconds < 1 || t1Seconds > MAX_TIMEOUT_SECONDS) {
    throw new VisionToolkitError('config', `${label}.t1Seconds must be an integer between 1 and ${MAX_TIMEOUT_SECONDS}`)
  }
  const t2Seconds = input.t2Seconds ?? 90
  if (!Number.isInteger(t2Seconds) || t2Seconds < 1 || t2Seconds > MAX_TIMEOUT_SECONDS) {
    throw new VisionToolkitError('config', `${label}.t2Seconds must be an integer between 1 and ${MAX_TIMEOUT_SECONDS}`)
  }
  const maxImageBytes = input.maxImageBytes ?? defaults.maxImageBytes
  if (!Number.isInteger(maxImageBytes) || maxImageBytes < 1024 || maxImageBytes > MAX_IMAGE_BYTES) {
    throw new VisionToolkitError('config', `${label}.maxImageBytes must be an integer between 1024 and ${MAX_IMAGE_BYTES}`)
  }
  const maxImagePixels = input.maxImagePixels ?? defaults.maxImagePixels
  if (!Number.isInteger(maxImagePixels) || maxImagePixels < 1 || maxImagePixels > MAX_IMAGE_PIXELS) {
    throw new VisionToolkitError('config', `${label}.maxImagePixels must be an integer between 1 and ${MAX_IMAGE_PIXELS}`)
  }
  const concurrency = input.concurrency ?? defaults.concurrency
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > MAX_CONCURRENCY) {
    throw new VisionToolkitError('config', `${label}.concurrency must be an integer between 1 and ${MAX_CONCURRENCY}`)
  }
  const attempts = input.attempts ?? DEFAULT_PROVIDER_ATTEMPTS
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > MAX_PROVIDER_ATTEMPTS) {
    throw new VisionToolkitError('config', `${label}.attempts must be an integer between 1 and ${MAX_PROVIDER_ATTEMPTS}`)
  }
  const name = (input.name ?? '').trim()
  const id = (input.id ?? '').trim()
  return {
    ...(id.length === 0 ? {} : { id }),
    name: name.length === 0 ? model : name,
    enabled: input.enabled !== false,
    baseUrl,
    credential,
    model,
    protocol,
    anthropicThinking,
    userAgent,
    stream,
    t1Seconds,
    t2Seconds,
    maxImageBytes,
    maxImagePixels,
    concurrency,
    attempts,
  }
}

/**
 * Validate and normalize a config object (partial inputs receive the same
 * defaults the schemastery schema applies). Configuration mistakes fail loud
 * at plugin load (the earliest resolvable point); runtime availability is a
 * separate, later concern.
 * @param config - parsed config with defaults applied.
 * @returns the fully defaulted, validated configuration.
 */
export function resolveConfig(config: VisionToolkitConfig = {}): ResolvedVisionToolkitConfig {
  const runtime = config.runtime ?? {}
  const language = config.language ?? 'zh'
  if (language !== 'zh' && language !== 'en') {
    throw new VisionToolkitError('config', 'language must be "zh" or "en"')
  }
  const hardTimeoutSeconds = config.hardTimeoutSeconds ?? 180
  if (!Number.isInteger(hardTimeoutSeconds) || hardTimeoutSeconds < 1 || hardTimeoutSeconds > MAX_TIMEOUT_SECONDS) {
    throw new VisionToolkitError('config', `hardTimeoutSeconds must be an integer between 1 and ${MAX_TIMEOUT_SECONDS}`)
  }
  const sessionMaxConcurrency = config.sessionMaxConcurrency ?? 6
  if (!Number.isInteger(sessionMaxConcurrency) || sessionMaxConcurrency < 1 || sessionMaxConcurrency > MAX_CONCURRENCY) {
    throw new VisionToolkitError('config', `sessionMaxConcurrency must be an integer between 1 and ${MAX_CONCURRENCY}`)
  }
  const minAvailableSeconds = config.minAvailableSeconds ?? 20
  if (!Number.isInteger(minAvailableSeconds) || minAvailableSeconds < 1 || minAvailableSeconds > MAX_TIMEOUT_SECONDS) {
    throw new VisionToolkitError('config', `minAvailableSeconds must be an integer between 1 and ${MAX_TIMEOUT_SECONDS}`)
  }
  const maxImageBytes = config.maxImageBytes ?? 4194304
  if (!Number.isInteger(maxImageBytes) || maxImageBytes < 1024 || maxImageBytes > MAX_IMAGE_BYTES) {
    throw new VisionToolkitError('config', `maxImageBytes must be an integer between 1024 and ${MAX_IMAGE_BYTES}`)
  }
  const maxImagePixels = config.maxImagePixels ?? 20000000
  if (!Number.isInteger(maxImagePixels) || maxImagePixels < 1 || maxImagePixels > MAX_IMAGE_PIXELS) {
    throw new VisionToolkitError('config', `maxImagePixels must be an integer between 1 and ${MAX_IMAGE_PIXELS}`)
  }
  const concurrency = config.concurrency ?? 4
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > MAX_CONCURRENCY) {
    throw new VisionToolkitError('config', `concurrency must be an integer between 1 and ${MAX_CONCURRENCY}`)
  }
  const mode = runtime.mode ?? 'managed'
  if (mode !== 'managed' && mode !== 'external') {
    throw new VisionToolkitError('config', 'runtime.mode must be "managed" or "external"')
  }
  const toolkitPath = runtime.agentVisionToolkitPath?.trim()
  if (toolkitPath !== undefined && toolkitPath.length === 0) {
    throw new VisionToolkitError('config', 'runtime.agentVisionToolkitPath must not be empty when provided')
  }
  if (mode === 'external' && toolkitPath === undefined) {
    throw new VisionToolkitError('config', 'runtime.agentVisionToolkitPath is required when runtime.mode is external')
  }
  if (mode === 'managed' && toolkitPath !== undefined) {
    throw new VisionToolkitError('config', 'runtime.agentVisionToolkitPath is only valid when runtime.mode is external')
  }
  const python = runtime.python?.trim()
  if (python !== undefined && python.length === 0) {
    throw new VisionToolkitError('config', 'runtime.python must not be empty')
  }
  const storageDir = config.storageDir?.trim()
  const storageHistory = [...new Set((config.storageHistory ?? [])
    .map(dir => dir.trim())
    .filter(dir => dir.length > 0 && dir !== storageDir))]
  const allowedDirs = (config.allowedDirs ?? []).map(dir => dir.trim()).filter(dir => dir.length > 0)
  const imageInputVariants = config.imageInputVariants ?? {}
  const variantProviders = (imageInputVariants.providers ?? [])
    .map(provider => provider.trim())
    .filter(provider => provider.length > 0)
  const providerDefaults: ProviderDefaults = { maxImageBytes, maxImagePixels, concurrency }
  const configuredProviders = config.providers ?? []
  if (configuredProviders.length > MAX_PROVIDERS) {
    throw new VisionToolkitError('config', `providers must have at most ${MAX_PROVIDERS} entries`)
  }
  const providers: ResolvedProvider[] = configuredProviders.length > 0
    ? configuredProviders.map((entry, index) =>
      resolveProvider(entry, providerDefaults, `providers[${index}]`, entry.enabled !== false ? 'enabled' : 'disabled'))
    : [resolveProvider(config.provider ?? {}, providerDefaults, 'provider', 'legacy')]
  const primary = providers.find(entry => entry.enabled) ?? providers[0]!
  return {
    provider: {
      baseUrl: primary.baseUrl,
      credential: primary.credential,
      model: primary.model,
      protocol: primary.protocol,
      anthropicThinking: primary.anthropicThinking,
      userAgent: primary.userAgent,
      stream: primary.stream,
    },
    providers,
    language,
    hardTimeoutSeconds,
    sessionMaxConcurrency,
    minAvailableSeconds,
    maxImageBytes,
    maxImagePixels,
    concurrency,
    runtime: {
      mode,
      ...(toolkitPath !== undefined ? { agentVisionToolkitPath: toolkitPath } : {}),
      ...(python !== undefined ? { python } : {}),
    },
    ...(storageDir === undefined || storageDir.length === 0 ? {} : { storageDir }),
    storageHistory,
    allowedDirs,
    imageInputVariants: {
      enabled: imageInputVariants.enabled ?? true,
      providers: variantProviders,
      autoSwitch: imageInputVariants.autoSwitch ?? true,
      hidden: imageInputVariants.hidden ?? true,
    },
  }
}

/** Merge prior storage roots into the next resolved generation's read-only history. */
export function retainedStorageHistory(
  next: VisionToolkitConfig,
  previous: VisionToolkitConfig,
): string[] {
  const resolvedNext = resolveConfig(next)
  const resolvedPrevious = resolveConfig(previous)
  return [...new Set([
    ...resolvedPrevious.storageHistory,
    ...resolvedNext.storageHistory,
    ...(resolvedPrevious.storageDir === undefined ? [] : [resolvedPrevious.storageDir]),
  ])].filter(storageDir => storageDir !== resolvedNext.storageDir)
}

export interface WatchedSettingsGeneration {
  /** Configuration to activate now; omitted after a successful history writeback. */
  config?: VisionToolkitConfig
  /** Whether the derived history still needs plugin-owned durable persistence. */
  requiresDurableStorageHistory?: boolean
  /** Non-fatal internal-history persistence error. */
  persistenceError?: unknown
}

/** Prepare one live Settings generation without letting internal history writeback block activation. */
export async function prepareWatchedSettingsGeneration(
  next: VisionToolkitConfig,
  previous: VisionToolkitConfig,
  writable: boolean,
  persistStorageHistory: (storageHistory: string[]) => Promise<void>,
): Promise<WatchedSettingsGeneration> {
  const storageHistory = retainedStorageHistory(next, previous)
  if (JSON.stringify(storageHistory) === JSON.stringify(resolveConfig(next).storageHistory)) return { config: next }

  const config = { ...next, storageHistory }
  if (!writable) return { config, requiresDurableStorageHistory: true }
  try {
    await persistStorageHistory(storageHistory)
    return {}
  } catch (persistenceError) {
    return { config, requiresDurableStorageHistory: true, persistenceError }
  }
}

/** Whether a resolved provider should use the bundled public key instead of DSH credentials. */
export function isBuiltInFreeVisionProvider(provider: ResolvedVisionToolkitConfig['provider']): boolean {
  return String(provider.credential) === BUILT_IN_FREE_VISION_CREDENTIAL
    && provider.baseUrl === BUILT_IN_FREE_VISION_BASE_URL
    && BUILT_IN_FREE_VISION_MODEL_ALIASES.has(provider.model)
    && provider.protocol === 'openai'
}
