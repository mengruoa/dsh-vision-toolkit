/**
 * Vision Toolkit runtime: structured requests in, structured results out.
 * One operation-wide deadline reaches every subprocess; image decoding,
 * byte/pixel limits, session-scoped concurrency, credential resolution, safe
 * output staging, and diagnostic logging stay below the model-facing tools.
 * @module dsh-vision-toolkit/runtime
 */

import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { ResolvedCredential } from '@deepseek-ai/dsh-credentials'
import { SaxesParser } from 'saxes'
import { describeArtifact, type ArtifactDescriptor } from './artifacts.ts'
import { isBuiltInFreeVisionProvider, type ResolvedProvider, type ResolvedVisionToolkitConfig } from './config.ts'
import { BUILT_IN_FREE_VISION_KEY } from './defaults.ts'
import { evidenceRuntimeFingerprint } from './evidence-cache.ts'
import { VisionToolkitError, type VisionToolkitErrorCode } from './errors.ts'
import {
  assertDistinctOutput,
  commitStagedDirectory,
  commitStagedOutput,
  createPathPolicy,
  createStagedDirectory,
  createStagedOutput,
  isWithin,
  resolveHtmlFile,
  resolveInputFile,
  resolveOutputDirectory,
  resolveOutputFile,
  seedStagedDirectory,
  type PathPolicy,
} from './paths.ts'
import {
  parseCropOutput,
  parseDominantColorsOutput,
  parseExtractForegroundOutput,
  parseHtmlScreenshotOutput,
  parseLocationOutput,
  parsePixelDiffOutput,
  parseTraceOutput,
  UpstreamAdapter,
  type CompressedImageInfo,
  type DominantColorsOutput,
  type LocatedElement,
  type UpstreamEnvironment,
  type UpstreamRunResult,
  type UpstreamTool,
  type UpstreamVersionInfo,
} from './upstream.ts'
import { PLUGIN_VERSION } from './version.ts'

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg'
const VISION_MODEL_TEST_IMAGE = fileURLToPath(new URL('../assets/vision-model-test.png', import.meta.url))
const VISION_MODEL_TEST_PROMPT = 'This is an explicit service readiness test. Reply with one short sentence confirming that you received the image.'

/** Bump when the Pillow compression ladder changes so stale cache entries are ignored. */
const COMPRESSED_IMAGE_CACHE_VERSION = 'v2'
/** Cache keys carry 64-bit digests so Windows paths stay below MAX_PATH; the full file sha256 is computed on read and compared against this prefix. */
const COMPRESSED_IMAGE_CACHE_KEY_DIGEST_LENGTH = 16
const COMPRESSED_IMAGE_CACHE_MAX_ENTRIES = 200
const COMPRESSED_IMAGE_CACHE_MAX_BYTES = 512 * 1024 * 1024
const COMPRESSED_IMAGE_CACHE_STALE_PARTIAL_MS = 60 * 60 * 1000

function svgDocumentPathCount(svg: string): number | undefined {
  const parser = new SaxesParser({ xmlns: true })
  let depth = 0
  let invalid = false
  let pathCount = 0
  let rootSeen = false
  let rootClosed = false
  parser.on('doctype', () => { invalid = true })
  parser.on('error', () => { invalid = true })
  parser.on('opentag', (tag) => {
    if (depth === 0) {
      if (rootSeen || tag.local !== 'svg' || tag.uri !== SVG_NAMESPACE) invalid = true
      rootSeen = true
    }
    if (tag.local === 'path' && tag.uri === SVG_NAMESPACE) pathCount += 1
    depth += 1
  })
  parser.on('closetag', () => {
    depth -= 1
    if (depth === 0) rootClosed = true
    if (depth < 0) invalid = true
  })
  try {
    parser.write(svg).close()
  } catch {
    return undefined
  }
  return invalid || !rootSeen || !rootClosed || depth !== 0 ? undefined : pathCount
}

/** Per-invocation cancellation and timeout facts. */
export interface Deadline {
  signal: AbortSignal
  /** True when the deadline timer fired. */
  timedOut: boolean
  /** True when the caller signal fired first. */
  cancelled: boolean
  /** Clear the timer and caller listener. */
  cleanup(): void
}

/** Combine a caller abort signal with one hard operation timeout. */
export function createDeadline(signal: AbortSignal, timeoutMs: number): Deadline {
  const controller = new AbortController()
  const state = { timedOut: false, cancelled: false }
  const onCallerAbort = (): void => {
    if (controller.signal.aborted) return
    state.cancelled = true
    controller.abort()
  }
  if (signal.aborted) {
    state.cancelled = true
    controller.abort()
  } else {
    signal.addEventListener('abort', onCallerAbort, { once: true })
  }
  const timer = setTimeout(() => {
    if (controller.signal.aborted) return
    state.timedOut = true
    controller.abort()
  }, timeoutMs)
  return {
    signal: controller.signal,
    get timedOut(): boolean { return state.timedOut },
    get cancelled(): boolean { return state.cancelled },
    cleanup(): void {
      clearTimeout(timer)
      signal.removeEventListener('abort', onCallerAbort)
    },
  }
}

/** FIFO bounded concurrency gate whose queued callers remain cancellable. */
export class Semaphore {
  private active = 0
  private readonly waiters: Array<{
    resolve: () => void
    reject: (error: unknown) => void
    signal: AbortSignal
    permits: number
    onAbort: () => void
  }> = []

  constructor(private readonly limit: number) {}

  /** Whether no active or queued caller still owns this gate. */
  get idle(): boolean {
    return this.active === 0 && this.waiters.length === 0
  }

  /** Free slots still claimable without queuing. */
  get available(): number {
    return Math.max(0, this.limit - this.active)
  }

  /** Acquire one slot, aborting while queued when `signal` fires. */
  async acquire(signal: AbortSignal, permits = 1): Promise<void> {
    if (signal.aborted) throw new VisionToolkitError('cancelled', 'vision-toolkit: cancelled before execution')
    if (!Number.isInteger(permits) || permits < 1 || permits > this.limit) {
      throw new VisionToolkitError('input', `concurrency permits must be between 1 and ${this.limit}`)
    }
    if (this.waiters.length === 0 && this.active + permits <= this.limit) {
      this.active += permits
      return
    }
    return new Promise<void>((resolveAcquire, reject) => {
      const entry = {
        resolve: resolveAcquire,
        reject,
        signal,
        permits,
        onAbort: () => {},
      }
      entry.onAbort = (): void => {
        const index = this.waiters.indexOf(entry)
        if (index >= 0) this.waiters.splice(index, 1)
        reject(new VisionToolkitError('cancelled', 'vision-toolkit: cancelled while waiting for a concurrency slot'))
      }
      this.waiters.push(entry)
      signal.addEventListener('abort', entry.onAbort, { once: true })
    })
  }

  /** Release owned permits and wake FIFO waiters whose full weight now fits. */
  release(permits = 1): void {
    this.active = Math.max(0, this.active - permits)
    while (this.waiters.length > 0) {
      const next = this.waiters[0]
      if (next === undefined || this.active + next.permits > this.limit) break
      this.waiters.shift()
      next.signal.removeEventListener('abort', next.onAbort)
      this.active += next.permits
      next.resolve()
    }
  }

  /** Non-blocking acquisition: claim a free slot immediately, else return false. */
  tryAcquire(permits = 1): boolean {
    if (!Number.isInteger(permits) || permits < 1 || permits > this.limit) return false
    if (this.waiters.length === 0 && this.active + permits <= this.limit) {
      this.active += permits
      return true
    }
    return false
  }
}

/** Validated image metadata retained in structured results and diagnostics. */
export interface ImageInfo {
  path: string
  bytes: number
  width: number
  height: number
  format: string
  /** True when the analyzed image carries an alpha (transparency) channel. */
  hasAlpha: boolean
  /** Original user-facing image path before any automatic compression. */
  originalPath: string
}

/** Structured input for one glance call. */
export interface GlanceRequest {
  images: string[]
  query?: string
  ocr?: boolean
  region?: string
}

/** Structured glance result. */
export interface GlanceResult {
  images: ImageInfo[]
  mode: 'describe' | 'qa' | 'ocr'
  answer: string
  truncated: boolean
}

/** Structured input for ground/detect. */
export interface LocateRequest {
  image: string
  target: string
  region?: string
}

/** One located element with an upstream or caller label. */
export interface LocateMatch {
  label: string
  box: { x1: number; y1: number; x2: number; y2: number }
}

/** Structured ground result. */
export interface GroundResult {
  target: string
  image: ImageInfo
  imageWidth: number
  imageHeight: number
  matches: LocateMatch[]
  preview?: ArtifactDescriptor
}

/** Structured detect result. */
export interface DetectResult {
  category: string
  image: ImageInfo
  imageWidth: number
  imageHeight: number
  elements: Array<{ index: number; label: string; box: { x1: number; y1: number; x2: number; y2: number } }>
  preview?: ArtifactDescriptor
}

/** Structured crop request. */
export interface CropRequest {
  image: string
  region: string
  scale?: number
  output?: string
}

/** Structured crop result. */
export interface CropResult {
  imageWidth: number
  imageHeight: number
  region: { x1: number; y1: number; x2: number; y2: number }
  outputPath: string
  mimeType: 'image/png' | 'image/jpeg'
  width: number
  height: number
  clamped: boolean
  artifact: ArtifactDescriptor
  note?: string
}

/** Structured trace request supported by the pinned upstream snapshot. */
export interface TraceRequest {
  image: string
  region?: string
  scale?: number
  color?: boolean
  polygon?: boolean
  output?: string
}

/** Structured trace result. */
export interface TraceResult {
  imageWidth: number
  imageHeight: number
  outputPath: string
  mimeType: 'image/svg+xml'
  geometry: {
    status: 'generated' | 'empty'
    pathCount: number
    tracedScale: number
    bytes: number
  }
  artifact: ArtifactDescriptor
  warning?: string
}

/** Structured input for local image comparison. */
export interface PixelDiffRequest {
  original: string
  rebuilt: string
  grid?: number
  top?: number
  runName?: string
}

/** Structured local pixel comparison plus formally delivered files. */
export interface PixelDiffResult {
  original: ImageInfo
  rebuilt: ImageInfo
  scaled: boolean
  rebuiltOriginalSize?: { width: number; height: number }
  overallDifferencePct: number
  worstRegions: Array<{ index: number; differencePct: number; box: { x1: number; y1: number; x2: number; y2: number } }>
  heatmap: ArtifactDescriptor
  report: ArtifactDescriptor
}

/** Structured input for the pinned long-screenshot OCR pipeline. */
export interface LongScreenshotOcrRequest {
  image: string
  mode?: 'general' | 'chat'
  output?: string
  runName?: string
  targetHeight?: number
  minHeight?: number
  maxHeight?: number
  overlap?: number
  prompt?: string
  jobs?: number
  splitOnly?: boolean
  resume?: boolean
}

/** One long-OCR chunk and the files retained for audit or reuse. */
export interface LongScreenshotChunk {
  index: number
  coreTop: number
  coreBottom: number
  cropTop: number
  cropBottom: number
  image: ArtifactDescriptor
  ocr?: ArtifactDescriptor
  reused?: boolean
}

/** Long-screenshot split/OCR result with every durable deliverable. */
export interface LongScreenshotOcrResult {
  source: ImageInfo
  mode: 'general' | 'chat'
  splitOnly: boolean
  complete: boolean
  chunkCount: number
  runDirectory: string
  output?: ArtifactDescriptor
  manifest: ArtifactDescriptor
  audit?: ArtifactDescriptor
  chunks: LongScreenshotChunk[]
}

/** Structured input for transparent foreground extraction. */
export interface ExtractForegroundRequest {
  image: string
  region?: string
  boxes?: string
  mode?: 'color' | 'dark'
  discRadius?: number
  saturation?: number
  darkThreshold?: number
  excludeColor?: string
  excludeTolerance?: number
  padding?: number
  keepWhites?: boolean
  output?: string
}

/** Transparent foreground file plus the pinned script's component metrics. */
export interface ExtractForegroundResult {
  source: ImageInfo
  box: { x1: number; y1: number; x2: number; y2: number }
  foregroundPixels: number
  keptComponents: number
  totalComponents: number
  largestComponentPct: number
  width: number
  height: number
  artifact: ArtifactDescriptor
  autoSummary?: string
}

/** Structured input for palette extraction or candidate scoring. */
export interface DominantColorsRequest {
  image: string
  region?: string
  candidates?: string[]
  top?: number
  quantize?: number
  maxPixels?: number
  mergeTolerance?: number
  candidateTolerance?: number
}

/** Stable dominant-colour result enriched with source image facts. */
export interface DominantColorsResult {
  image: ImageInfo
  analysis: DominantColorsOutput
}

/** Structured input for rendering an authorized local HTML document. */
export interface HtmlScreenshotRequest {
  source: string
  width?: number
  height?: number
  scale?: number
  waitMs?: number
  fullPage?: boolean
  output?: string
}

/** Browser-rendered PNG plus viewport and source facts. */
export interface HtmlScreenshotResult {
  sourcePath: string
  sourceBytes: number
  viewport: { width: number; height: number; scale: number }
  width: number
  height: number
  /** Full document height in CSS pixels; present only for full-page captures. */
  pageHeight?: number
  artifact: ArtifactDescriptor
}

/** Optional preview controls shared by ground and detect. */
export interface LocatePreviewRequest extends LocateRequest {
  preview?: boolean
  previewOutput?: string
}

/** One named health-check state. */
export interface HealthCheck {
  status: 'ok' | 'warning' | 'error' | 'not_tested'
  detail: string
}

/** Runtime, dependency, browser, and optional per-provider service health. */
export interface VisionToolkitHealthResult {
  pluginVersion: string
  upstream: UpstreamVersionInfo
  checks: {
    python: HealthCheck
    dependencies: HealthCheck
    chrome: HealthCheck
    credential: HealthCheck
    artifactDirectory: HealthCheck
    tempDirectory: HealthCheck
    service: HealthCheck
    model: HealthCheck
  }
  healthy: boolean
  connectionTested: boolean
  modelTested: boolean
  /** Provider label when the service/model checks targeted one specific provider. */
  providerName?: string
}

/** Shared per-call execution options. */
export interface ToolCallOptions {
  signal: AbortSignal
  /** Override the global hard timeout (seconds) for this call. */
  timeoutSeconds?: number
  workspace: string
  /** Session identity for the per-session concurrency cap. */
  sessionId?: string
  /** Live Session object whose lifetime bounds the one-entry glance cache. */
  sessionScope?: object
}

/** One immutable vision-service snapshot used to generate cache-keyed evidence. */
export interface CapturedEvidenceRuntime {
  readonly evidenceFingerprint: string
  glance(request: GlanceRequest, options: ToolCallOptions): Promise<GlanceResult>
}

interface GlanceCacheEntry {
  key: string
  result: GlanceResult
}

interface OperationMetrics {
  startedAt: number
  queueMs: number
  upstreamMs: number
  imageBytes: number
  imagePixels: number
  imageCount: number
  cacheHits: number
  usedVisionService: boolean
}

interface OperationContext {
  signal: AbortSignal
  metrics: OperationMetrics
  /** Absolute epoch-millisecond timestamp when the global hard timeout fires. */
  deadlineAt: number
}

const REGION_PATTERN = /^\s*(-?\d+)\s*,\s*(-?\d+)\s*,\s*(-?\d+)\s*,\s*(-?\d+)\s*$/
const MAX_TIMEOUT_SECONDS = 600
const FORMAT_BY_EXTENSION = new Map([
  ['.png', 'png'],
  ['.jpg', 'jpeg'],
  ['.jpeg', 'jpeg'],
  ['.gif', 'gif'],
  ['.webp', 'webp'],
])
const HEX_COLOR_PATTERN = /^#[0-9A-F]{6}$/

/**
 * Error codes a provider retries against the SAME provider within its
 * `attempts` budget. Only transient failures are worth re-requesting: a
 * timeout may clear on the next attempt and a 5xx / network drop is usually
 * ephemeral. Deterministic failures (auth, quota, rate_limit, invalid_request,
 * region, tos) must fail over to the next provider immediately instead of
 * re-requesting a backend that cannot succeed with the same input.
 */
const RETRYABLE_CODES: ReadonlySet<VisionToolkitErrorCode> = new Set(['timeout', 'server', 'network'])

/** Resolve as soon as `signal` aborts (or immediately when already aborted). */
function untilAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
}

/** Sleep for `ms`, resolving early when `signal` aborts. */
function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise(resolve => {
    const onAbort = (): void => { clearTimeout(timer); resolve() }
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve() }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function integerInRange(value: number | undefined, fallback: number, minimum: number, maximum: number, name: string): number {
  const resolved = value ?? fallback
  if (!Number.isInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new VisionToolkitError('input', `${name} must be an integer between ${minimum} and ${maximum}`)
  }
  return resolved
}

function finiteInRange(value: number | undefined, minimum: number, maximum: number, name: string): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new VisionToolkitError('input', `${name} must be between ${minimum} and ${maximum}`)
  }
  return value
}

function assertBoxWithin(
  box: { x1: number; y1: number; x2: number; y2: number },
  width: number,
  height: number,
  source: string,
): void {
  if (
    ![box.x1, box.y1, box.x2, box.y2].every(Number.isInteger)
    || box.x1 < 0
    || box.y1 < 0
    || box.x2 <= box.x1
    || box.y2 <= box.y1
    || box.x2 > width
    || box.y2 > height
  ) {
    throw new VisionToolkitError('output', `${source} returned an out-of-range box for ${width}x${height}`)
  }
}

function safeGeneratedName(name: unknown, source: string): string {
  if (typeof name !== 'string' || name.length === 0 || basename(name) !== name || name === '.' || name === '..') {
    throw new VisionToolkitError('output', `${source} returned an unsafe generated filename`)
  }
  return name
}

interface ParsedLongOcrChunk {
  index: number
  image: string
  imageSha256: string
  coreTop: number
  coreBottom: number
  cropTop: number
  cropBottom: number
  ocr?: string
  ocrReused?: boolean
}

interface ParsedLongOcrManifest {
  mode: 'general' | 'chat'
  complete: boolean
  chunks: ParsedLongOcrChunk[]
  raw: Record<string, unknown>
}

function objectRecord(value: unknown, source: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new VisionToolkitError('output', `${source} must be a JSON object`)
  }
  return value as Record<string, unknown>
}

function manifestInteger(record: Record<string, unknown>, key: string, source: string): number {
  const value = record[key]
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new VisionToolkitError('output', `${source}.${key} must be an integer`)
  }
  return value
}

function parseLongOcrManifest(
  text: string,
  expected: { source: string; output: string; width: number; height: number; mode: 'general' | 'chat'; splitOnly: boolean },
): ParsedLongOcrManifest {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new VisionToolkitError('output', 'long_screenshot_ocr: manifest is not valid JSON', { cause: error })
  }
  const manifest = objectRecord(parsed, 'long_screenshot_ocr manifest')
  if (manifest.schema_version !== 1) throw new VisionToolkitError('output', 'long_screenshot_ocr: unsupported manifest schema')
  if (manifest.input !== expected.source) throw new VisionToolkitError('output', 'long_screenshot_ocr: manifest source does not match the requested image')
  if (manifestInteger(manifest, 'image_width', 'long_screenshot_ocr manifest') !== expected.width
    || manifestInteger(manifest, 'image_height', 'long_screenshot_ocr manifest') !== expected.height) {
    throw new VisionToolkitError('output', 'long_screenshot_ocr: manifest dimensions do not match the source image')
  }
  if (manifest.mode !== expected.mode) throw new VisionToolkitError('output', 'long_screenshot_ocr: manifest mode does not match the request')
  const complete = manifest.complete
  if (typeof complete !== 'boolean' || complete === expected.splitOnly) {
    throw new VisionToolkitError('output', 'long_screenshot_ocr: manifest completion state is inconsistent')
  }
  if (!Array.isArray(manifest.chunks) || manifest.chunks.length === 0) {
    throw new VisionToolkitError('output', 'long_screenshot_ocr: manifest contains no chunks')
  }
  if (manifest.output !== (expected.splitOnly ? null : expected.output)) {
    throw new VisionToolkitError('output', 'long_screenshot_ocr: manifest output path is inconsistent')
  }
  const chunks = manifest.chunks.map((value, position): ParsedLongOcrChunk => {
    const record = objectRecord(value, `long_screenshot_ocr manifest.chunks[${position}]`)
    const index = manifestInteger(record, 'index', `long_screenshot_ocr manifest.chunks[${position}]`)
    if (index !== position + 1) throw new VisionToolkitError('output', 'long_screenshot_ocr: chunk indexes are not contiguous')
    const image = safeGeneratedName(record.image, 'long_screenshot_ocr')
    const imageSha256 = record.image_sha256
    if (typeof imageSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(imageSha256)) {
      throw new VisionToolkitError('output', 'long_screenshot_ocr: chunk image hash is invalid')
    }
    const coreTop = manifestInteger(record, 'core_top', `long_screenshot_ocr manifest.chunks[${position}]`)
    const coreBottom = manifestInteger(record, 'core_bottom', `long_screenshot_ocr manifest.chunks[${position}]`)
    const cropTop = manifestInteger(record, 'crop_top', `long_screenshot_ocr manifest.chunks[${position}]`)
    const cropBottom = manifestInteger(record, 'crop_bottom', `long_screenshot_ocr manifest.chunks[${position}]`)
    if (
      coreTop < 0
      || coreBottom <= coreTop
      || cropTop < 0
      || cropBottom <= cropTop
      || cropTop > coreTop
      || cropBottom < coreBottom
      || cropBottom > expected.height
    ) {
      throw new VisionToolkitError('output', 'long_screenshot_ocr: manifest contains an invalid chunk range')
    }
    const ocr = record.ocr === undefined ? undefined : safeGeneratedName(record.ocr, 'long_screenshot_ocr')
    const ocrReused = record.ocr_reused
    if (ocrReused !== undefined && typeof ocrReused !== 'boolean') {
      throw new VisionToolkitError('output', 'long_screenshot_ocr: ocr_reused must be boolean')
    }
    if (complete && ocr === undefined) throw new VisionToolkitError('output', 'long_screenshot_ocr: complete manifest is missing an OCR sidecar')
    return {
      index,
      image,
      imageSha256,
      coreTop,
      coreBottom,
      cropTop,
      cropBottom,
      ...(ocr === undefined ? {} : { ocr }),
      ...(ocrReused === undefined ? {} : { ocrReused }),
    }
  })
  return { mode: expected.mode, complete, chunks, raw: manifest }
}

/** Parse a non-empty four-integer pixel box. */
export function parseRegion(region: string): { x1: number; y1: number; x2: number; y2: number } {
  const match = REGION_PATTERN.exec(region)
  if (match === null) {
    throw new VisionToolkitError('input', 'region must be four integers: X1,Y1,X2,Y2 (pixels)')
  }
  const box = {
    x1: Number(match[1]),
    y1: Number(match[2]),
    x2: Number(match[3]),
    y2: Number(match[4]),
  }
  if (box.x2 <= box.x1 || box.y2 <= box.y1) {
    throw new VisionToolkitError('input', 'region must have x2 > x1 and y2 > y1')
  }
  return box
}

/** One enabled provider paired with its resolved upstream environment. */
interface ResolvedProviderEnv {
  provider: ResolvedProvider
  env: UpstreamEnvironment
}

/** Mutable in-flight state for one provider during a hedge-based failover run. */
interface ProviderTask {
  index: number
  entry: ResolvedProviderEnv
  cumulativeMs: number
  status: 'idle' | 'running' | 'succeeded' | 'failed' | 'ratelimited'
  result?: UpstreamRunResult
  error?: VisionToolkitError
  hedged: boolean
  launched: boolean
  settled: Promise<void>
  settle: () => void
  abort: AbortController
}

/** Live concurrency accounting returned by the availability query tool. */
export interface ConcurrencyStatus {
  /** New tool calls this session may start right now. */
  available: number
  /** Per-session cap on concurrent tool operations. */
  sessionMax: number
  /** Tool operations currently in flight in this session. */
  sessionInUse: number
  /** Free per-session slots. */
  sessionFree: number
  /** Total free model-request slots summed across enabled providers. */
  modelFree: number
  /** Per-provider breakdown. */
  models: Array<{ name: string; concurrency: number; inUse: number; free: number }>
}

/** Runtime facade used by every native tool. */
export class VisionToolkitRuntime {
  private readonly semaphores = new Map<string, Semaphore>()
  private readonly glanceCache = new WeakMap<object, GlanceCacheEntry>()
  private readonly providerGates = new Map<string, Semaphore>()
  private readonly adapter: UpstreamAdapter

  constructor(
    private readonly ctx: Context,
    private readonly config: ResolvedVisionToolkitConfig,
    adapter?: UpstreamAdapter,
    private readonly readableStorageDirs: readonly string[] = [],
  ) {
    this.adapter = adapter ?? new UpstreamAdapter(ctx, config)
  }

  /** Pinned and prepared upstream identity. */
  get upstreamVersion(): UpstreamVersionInfo {
    return this.adapter.versionInfo
  }

  /** Per-session cap on concurrent tool operations. */
  get sessionMaxConcurrency(): number {
    return this.config.sessionMaxConcurrency
  }

  /** Shared storage root belonging to this immutable runtime generation. */
  get storageDirectory(): string | undefined {
    return this.config.storageDir
  }

  /** Stable identity for persisted image descriptions produced by this runtime. */
  get evidenceFingerprint(): string {
    return evidenceRuntimeFingerprint(this.config, undefined, process.env.VISION_SSL_VERIFY?.trim())
  }

  /** Capture the credential and provider identity used by one evidence conversion. */
  async captureEvidenceRuntime(): Promise<CapturedEvidenceRuntime> {
    // The primary provider's key hash sharpens cache invalidation, but a
    // missing primary credential must not block evidence conversion when a
    // later provider in the failover pool is available.
    let credentialSha256: string | undefined
    let sslVerify: string | undefined
    try {
      const env = await this.resolveVisionEnv()
      credentialSha256 = createHash('sha256').update(env.VISION_API_KEY).digest('hex')
      sslVerify = env.VISION_SSL_VERIFY
    } catch {
      credentialSha256 = undefined
    }
    const evidenceFingerprint = evidenceRuntimeFingerprint(this.config, credentialSha256, sslVerify)
    return Object.freeze({
      evidenceFingerprint,
      glance: (request: GlanceRequest, options: ToolCallOptions) => this.glanceWithEnv(request, options),
    })
  }

  /** Global hard timeout (ms) for one tool invocation, honoring the per-call override. */
  private hardTimeoutMs(options: ToolCallOptions): number {
    const seconds = options.timeoutSeconds ?? this.config.hardTimeoutSeconds
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > MAX_TIMEOUT_SECONDS) {
      throw new VisionToolkitError('input', `timeoutSeconds must be an integer between 1 and ${MAX_TIMEOUT_SECONDS}`)
    }
    return seconds * 1000
  }

  private operationError(
    tool: string,
    error: unknown,
    deadline: Deadline,
    phase: 'queue' | 'execution' = 'execution',
  ): VisionToolkitError {
    if (deadline.cancelled) {
      return new VisionToolkitError(
        'cancelled',
        phase === 'queue' ? `${tool}: cancelled while waiting for a concurrency slot` : `${tool}: cancelled`,
      )
    }
    if (deadline.timedOut) {
      return new VisionToolkitError(
        'timeout',
        phase === 'queue' ? `${tool}: timed out while waiting for a concurrency slot` : `${tool}: timed out`,
      )
    }
    if (error instanceof VisionToolkitError) return error
    return new VisionToolkitError('runtime', `${tool}: execution failed`, { cause: error })
  }

  /** Per-session concurrency gate; callers acquire without queuing (excess is rejected). */
  private sessionGate(options: ToolCallOptions): { key: string; value: Semaphore } {
    const key = options.sessionId ?? `workspace:${options.workspace}`
    const value = this.semaphores.get(key) ?? new Semaphore(this.config.sessionMaxConcurrency)
    this.semaphores.set(key, value)
    return { key, value }
  }

  /** Live concurrency accounting for the calling session across the enabled provider pool. */
  concurrencyStatus(options: ToolCallOptions): ConcurrencyStatus {
    const gate = this.sessionGate(options)
    const sessionFree = gate.value.available
    const models = this.config.providers
      .filter(provider => provider.enabled)
      .map(provider => {
        const modelGate = this.providerGate(provider)
        return {
          name: provider.name,
          concurrency: provider.concurrency,
          inUse: provider.concurrency - modelGate.available,
          free: modelGate.available,
        }
      })
    const modelFree = models.reduce((sum, model) => sum + model.free, 0)
    return {
      available: Math.min(sessionFree, modelFree),
      sessionMax: this.config.sessionMaxConcurrency,
      sessionInUse: this.config.sessionMaxConcurrency - sessionFree,
      sessionFree,
      modelFree,
      models,
    }
  }

  private async runOperation<T>(
    tool: string,
    options: ToolCallOptions,
    action: (operation: OperationContext) => Promise<T>,
    permits = 1,
  ): Promise<T> {
    const hardTimeoutMs = this.hardTimeoutMs(options)
    const startedAt = Date.now()
    const deadlineAt = startedAt + hardTimeoutMs
    const metrics: OperationMetrics = {
      startedAt,
      queueMs: 0,
      upstreamMs: 0,
      imageBytes: 0,
      imagePixels: 0,
      imageCount: 0,
      cacheHits: 0,
      usedVisionService: false,
    }
    const gate = this.sessionGate(options)
    if (!gate.value.tryAcquire(permits)) {
      throw new VisionToolkitError('capacity', `${tool}: exceeded the session concurrency limit`)
    }
    const executionDeadline = createDeadline(options.signal, hardTimeoutMs)
    try {
      if (executionDeadline.signal.aborted) throw this.operationError(tool, undefined, executionDeadline)
      const value = await action({ signal: executionDeadline.signal, metrics, deadlineAt })
      if (executionDeadline.signal.aborted) throw this.operationError(tool, undefined, executionDeadline)
      this.ctx.logger.info(
        'dsh-vision-toolkit tool=%s outcome=ok totalMs=%d upstreamMs=%d images=%d imageBytes=%d imagePixels=%d cacheHits=%d model=%s',
        tool,
        Date.now() - metrics.startedAt,
        metrics.upstreamMs,
        metrics.imageCount,
        metrics.imageBytes,
        metrics.imagePixels,
        metrics.cacheHits,
        metrics.usedVisionService ? this.config.provider.model : 'local',
      )
      return value
    } catch (error) {
      const classified = this.operationError(tool, error, executionDeadline)
      this.ctx.logger.warn(
        'dsh-vision-toolkit tool=%s outcome=error category=%s totalMs=%d upstreamMs=%d images=%d imageBytes=%d imagePixels=%d cacheHits=%d',
        tool,
        classified.code,
        Date.now() - metrics.startedAt,
        metrics.upstreamMs,
        metrics.imageCount,
        metrics.imageBytes,
        metrics.imagePixels,
        metrics.cacheHits,
      )
      throw classified
    } finally {
      gate.value.release(permits)
      executionDeadline.cleanup()
      if (gate.value.idle) this.semaphores.delete(gate.key)
    }
  }

  /** Highest-priority enabled provider, falling back to the first entry. */
  private get primaryProvider(): ResolvedProvider {
    return this.config.providers.find(provider => provider.enabled) ?? this.config.providers[0]!
  }

  /** Build the upstream environment for one resolved provider. */
  private providerEnv(provider: ResolvedProvider, resolved: ResolvedCredential): UpstreamEnvironment {
    const sslVerify = process.env.VISION_SSL_VERIFY?.trim()
    return {
      VISION_API_KEY: resolved.value,
      VISION_BASE_URL: provider.baseUrl,
      VISION_MODEL: provider.model,
      VISION_API_PROTOCOL: provider.protocol === 'anthropic' ? 'anthropic' : 'chat_completions',
      VISION_ANTHROPIC_THINKING: provider.anthropicThinking,
      ...(sslVerify === undefined ? {} : { VISION_SSL_VERIFY: sslVerify }),
      ...(provider.stream ? { VISION_STREAM: '1' } : {}),
      VISION_USER_AGENT: provider.userAgent,
      LANG: this.config.language,
    }
  }

  /** Resolve one provider's credential into its environment, or undefined when unavailable. */
  private async resolveProviderEnv(provider: ResolvedProvider): Promise<ResolvedProviderEnv | undefined> {
    let resolved: ResolvedCredential | undefined
    try {
      resolved = isBuiltInFreeVisionProvider({
        baseUrl: provider.baseUrl,
        credential: provider.credential,
        model: provider.model,
        protocol: provider.protocol,
        anthropicThinking: provider.anthropicThinking,
        userAgent: provider.userAgent,
        stream: provider.stream,
      })
        ? { value: BUILT_IN_FREE_VISION_KEY, source: 'built-in' }
        : await this.ctx.credentials.resolve(provider.credential)
    } catch {
      resolved = undefined
    }
    if (resolved === undefined) return undefined
    return { provider, env: this.providerEnv(provider, resolved) }
  }

  /** Resolve every enabled provider in priority order, skipping unreadable credentials. */
  async resolveProviderPool(): Promise<ResolvedProviderEnv[]> {
    const pool: ResolvedProviderEnv[] = []
    for (const provider of this.config.providers) {
      if (!provider.enabled) continue
      const entry = await this.resolveProviderEnv(provider)
      if (entry === undefined) {
        this.ctx.logger.warn(
          'dsh-vision-toolkit provider=%s credential=%s unavailable; skipped from the failover pool',
          provider.name,
          String(provider.credential),
        )
        continue
      }
      pool.push(entry)
    }
    return pool
  }

  /** Resolve the primary provider's credential at the remote-operation boundary. */
  async resolveVisionEnv(): Promise<UpstreamEnvironment> {
    const entry = await this.resolveProviderEnv(this.primaryProvider)
    if (entry === undefined) {
      throw new VisionToolkitError(
        'config',
        `credential ${String(this.primaryProvider.credential)} is not configured; set it through DSH credentials`,
      )
    }
    return entry.env
  }

  private pathPolicy(workspace: string): Promise<PathPolicy> {
    return createPathPolicy(workspace, this.config.allowedDirs, this.config.storageDir, this.readableStorageDirs)
  }

  private async compressedImageRoot(policy: PathPolicy): Promise<string> {
    const root = join(policy.storageRoot, 'tmp', 'compressed-images')
    let current = policy.storageRoot
    for (const segment of ['tmp', 'compressed-images']) {
      current = join(current, segment)
      try {
        await mkdir(current, { mode: 0o700 })
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
      }
      const info = await lstat(current)
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new VisionToolkitError('path', `compressed-image cache path is not a real directory: ${current}`)
      }
      if (!isWithin(policy.storageRoot, current)) {
        throw new VisionToolkitError('path', `compressed-image cache path escaped plugin storage: ${current}`)
      }
    }
    const canonical = await realpath(root)
    if (!isWithin(policy.storageRoot, canonical)) {
      throw new VisionToolkitError('path', 'compressed-image cache resolved outside plugin storage')
    }
    return canonical
  }

  private async readCacheCandidate(
    root: string,
    name: string,
    expectedOutDigestPrefix: string,
    maxBytes: number,
    maxPixels: number,
    operation: OperationContext,
  ): Promise<{ path: string; bytes: number; width: number; height: number; format: string; hasAlpha: boolean } | undefined> {
    const candidate = join(root, name)
    let info
    try {
      info = await lstat(candidate)
    } catch {
      return undefined
    }
    if (!info.isFile() || info.size < 1 || info.size > maxBytes) return undefined
    let real: string
    try {
      real = await realpath(candidate)
    } catch {
      return undefined
    }
    if (!isWithin(root, real)) return undefined
    let bytes: Buffer
    try {
      bytes = await readFile(real, { signal: operation.signal })
    } catch {
      return undefined
    }
    const digest = createHash('sha256').update(bytes).digest('hex')
    if (bytes.length !== info.size || !digest.startsWith(expectedOutDigestPrefix)) return undefined
    let probed: { width: number; height: number; format: string; mode: string; hasAlpha: boolean } | undefined
    try {
      probed = await this.adapter.probeImageSize(real, { signal: operation.signal })
    } catch {
      probed = undefined
    }
    const extension = extname(real).toLowerCase()
    if (
      probed === undefined
      || FORMAT_BY_EXTENSION.get(extension) !== probed.format
      || probed.width * probed.height > maxPixels
    ) {
      return undefined
    }
    return { path: real, bytes: bytes.length, width: probed.width, height: probed.height, format: probed.format, hasAlpha: probed.hasAlpha }
  }

  private cacheEntryOutDigest(entry: string, prefix: string): string | undefined {
    const tail = entry.slice(prefix.length + 1)
    return /^[0-9a-f]{16}-/u.test(tail) ? tail.slice(0, 16) : undefined
  }

  private async pruneCompressedCache(root: string): Promise<void> {
    let entries: string[]
    try {
      entries = await readdir(root)
    } catch {
      return
    }
    const stalePartials: string[] = []
    const candidates: Array<{ name: string; size: number; mtime: number; removable: boolean }> = []
    for (const name of entries) {
      if (name.startsWith('.')) {
        if (name.endsWith('.partial')) {
          const info = await lstat(join(root, name)).catch(() => undefined)
          if (info !== undefined && Date.now() - info.mtimeMs > COMPRESSED_IMAGE_CACHE_STALE_PARTIAL_MS) {
            stalePartials.push(name)
          }
        }
        continue
      }
      let info
      try {
        info = await lstat(join(root, name))
      } catch {
        continue
      }
      candidates.push({
        name,
        size: info.isFile() ? info.size : 0,
        mtime: info.mtimeMs,
        removable: !info.isFile() || !name.startsWith(`${COMPRESSED_IMAGE_CACHE_VERSION}-`),
      })
    }
    candidates.sort((a, b) => a.mtime - b.mtime)
    let totalBytes = 0
    let kept = 0
    const remove: string[] = []
    for (const candidate of candidates) {
      if (
        candidate.removable
        || totalBytes + candidate.size > COMPRESSED_IMAGE_CACHE_MAX_BYTES
        || kept >= COMPRESSED_IMAGE_CACHE_MAX_ENTRIES
      ) {
        remove.push(candidate.name)
      } else {
        totalBytes += candidate.size
        kept += 1
      }
    }
    await Promise.all([...stalePartials, ...remove].map(name => rm(join(root, name), { force: true }).catch(() => {})))
  }

  private async autoCompressImage(
    image: { path: string; bytes: number },
    policy: PathPolicy,
    operation: OperationContext,
    maxBytes: number,
    maxPixels: number,
  ): Promise<ImageInfo> {
    let bytes: Buffer
    try {
      bytes = await readFile(image.path, { signal: operation.signal })
    } catch (error) {
      throw new VisionToolkitError('input', `image changed while preparing the vision request: ${image.path}`, { cause: error })
    }
    if (bytes.length !== image.bytes) {
      throw new VisionToolkitError('input', `image changed while preparing the vision request: ${image.path}`)
    }
    const digest = createHash('sha256').update(bytes).digest('hex').slice(0, COMPRESSED_IMAGE_CACHE_KEY_DIGEST_LENGTH)
    const root = await this.compressedImageRoot(policy)
    await this.pruneCompressedCache(root)
    const prefix = `${COMPRESSED_IMAGE_CACHE_VERSION}-${digest}-b${maxBytes}-p${maxPixels}`
    for (const entry of await readdir(root)) {
      if (!entry.startsWith(`${prefix}-`) || entry.startsWith('.')) continue
      const outDigestPrefix = this.cacheEntryOutDigest(entry, prefix)
      if (outDigestPrefix === undefined) {
        await rm(join(root, entry), { force: true }).catch(() => {})
        continue
      }
      const cached = await this.readCacheCandidate(root, entry, outDigestPrefix, maxBytes, maxPixels, operation)
      if (cached !== undefined) {
        return { ...cached, originalPath: image.path }
      }
      await rm(join(root, entry), { force: true }).catch(() => {})
    }
    const staged = join(root, `.${prefix}-${randomUUID()}.partial`)
    let compressed: CompressedImageInfo
    try {
      compressed = await this.adapter.compressImage(image.path, staged, maxBytes, maxPixels, { signal: operation.signal })
    } catch (error) {
      await rm(staged, { force: true }).catch(() => {})
      throw error
    }
    const extension = compressed.format === 'jpeg' ? 'jpg' : compressed.format
    const stagedBytes = await readFile(staged, { signal: operation.signal })
    const outDigest = createHash('sha256').update(stagedBytes).digest('hex').slice(0, COMPRESSED_IMAGE_CACHE_KEY_DIGEST_LENGTH)
    const finalName = `${prefix}-${outDigest}-${compressed.width}x${compressed.height}.${extension}`
    const finalPath = join(root, finalName)
    const existing = await this.readCacheCandidate(root, finalName, outDigest, maxBytes, maxPixels, operation)
    if (existing !== undefined) {
      await rm(staged, { force: true }).catch(() => {})
      return { ...existing, originalPath: image.path }
    }
    await rm(finalPath, { force: true }).catch(() => {})
    try {
      await rename(staged, finalPath)
    } catch (error) {
      await rm(staged, { force: true }).catch(() => {})
      throw new VisionToolkitError('path', `cannot commit compressed image cache entry: ${finalPath}`, { cause: error })
    }
    await this.pruneCompressedCache(root)
    return {
      path: finalPath,
      bytes: compressed.bytes,
      width: compressed.width,
      height: compressed.height,
      format: compressed.format,
      hasAlpha: compressed.hasAlpha,
      originalPath: image.path,
    }
  }

  /** Validate one image against the configured global limits (used by local tools). */
  private async validateImage(raw: string, policy: PathPolicy, operation: OperationContext): Promise<ImageInfo> {
    const image = await resolveInputFile(raw, policy)
    const decoded = await this.adapter.probeImageSize(image.path, { signal: operation.signal })
    const pixels = decoded.width * decoded.height
    if (!Number.isSafeInteger(pixels) || pixels < 1) {
      throw new VisionToolkitError('input', `image dimensions are invalid: ${decoded.width}x${decoded.height}`)
    }
    const extension = extname(image.path).toLowerCase()
    const expected = FORMAT_BY_EXTENSION.get(extension)
    if (expected !== decoded.format) {
      throw new VisionToolkitError('input', `image content is ${decoded.format}, but the filename uses ${extension}`)
    }
    if (image.bytes <= this.config.maxImageBytes && pixels <= this.config.maxImagePixels) {
      return { ...image, width: decoded.width, height: decoded.height, format: decoded.format, hasAlpha: decoded.hasAlpha, originalPath: image.path }
    }
    return this.autoCompressImage(image, policy, operation, this.config.maxImageBytes, this.config.maxImagePixels)
  }

  private accountImage(image: ImageInfo, operation: OperationContext): void {
    operation.metrics.imageCount += 1
    operation.metrics.imageBytes += image.bytes
    operation.metrics.imagePixels += image.width * image.height
  }

  /** Stable gate key for one provider's in-flight request cap. */
  private providerGate(provider: ResolvedProvider): Semaphore {
    const key = `${provider.baseUrl}\u0000${provider.model}\u0000${String(provider.credential)}`
    let gate = this.providerGates.get(key)
    if (gate === undefined) {
      gate = new Semaphore(provider.concurrency)
      this.providerGates.set(key, gate)
    }
    return gate
  }

  /**
   * Prepare one image for an online vision request against the enabled
   * provider pool. The raw image is kept when at least one enabled provider
   * accepts it; otherwise it is compressed once to the first (highest
   * priority) provider's limits so the priority route can proceed.
   */
  private async prepareVisionImage(
    raw: string,
    providers: readonly ResolvedProvider[],
    policy: PathPolicy,
    operation: OperationContext,
  ): Promise<ImageInfo> {
    const image = await resolveInputFile(raw, policy)
    const decoded = await this.adapter.probeImageSize(image.path, { signal: operation.signal })
    const pixels = decoded.width * decoded.height
    if (!Number.isSafeInteger(pixels) || pixels < 1) {
      throw new VisionToolkitError('input', `image dimensions are invalid: ${decoded.width}x${decoded.height}`)
    }
    const extension = extname(image.path).toLowerCase()
    const expected = FORMAT_BY_EXTENSION.get(extension)
    if (expected !== decoded.format) {
      throw new VisionToolkitError('input', `image content is ${decoded.format}, but the filename uses ${extension}`)
    }
    const fits = providers.some(provider => image.bytes <= provider.maxImageBytes && pixels <= provider.maxImagePixels)
    if (fits) {
      return { ...image, width: decoded.width, height: decoded.height, format: decoded.format, hasAlpha: decoded.hasAlpha, originalPath: image.path }
    }
    const first = providers[0]
    if (first === undefined) {
      throw new VisionToolkitError('config', 'no enabled vision provider is available for this image')
    }
    return this.autoCompressImage(image, policy, operation, first.maxImageBytes, first.maxImagePixels)
  }

  /**
   * Hedge-based failover across the enabled provider pool. The highest-priority
   * provider runs first; when one of its requests crosses t1 it keeps running
   * while the next provider starts in parallel. A provider whose cumulative
   * request time reaches t2 is terminated. A 429 provider is parked and moved
   * past immediately; parked providers are revisited at a 10s cadence once
   * every other provider is exhausted. The result always prefers the earliest
   * (highest-priority) provider.
   */
  private async runVisionHedge(
    tool: 'glance' | 'ground' | 'detect' | 'long_screenshot_ocr',
    args: readonly string[],
    images: readonly ImageInfo[],
    operation: OperationContext,
    pool: readonly ResolvedProviderEnv[],
  ): Promise<UpstreamRunResult> {
    if (pool.length === 0) {
      throw new VisionToolkitError('config', 'no enabled vision provider has a resolvable credential')
    }
    // Providers that cannot accept the image size are skipped entirely.
    const eligible = pool.filter(({ provider }) =>
      images.every(image => image.bytes <= provider.maxImageBytes && image.width * image.height <= provider.maxImagePixels))
    if (eligible.length === 0) {
      throw new VisionToolkitError('capacity', `${tool}: no enabled vision provider accepts the image size`)
    }

    const tasks: ProviderTask[] = eligible.map((entry, index) => {
      let settle!: () => void
      const settled = new Promise<void>(resolve => { settle = resolve })
      return {
        index,
        entry,
        cumulativeMs: 0,
        status: 'idle',
        hedged: false,
        launched: false,
        settled,
        settle,
        abort: new AbortController(),
      }
    })
    const n = tasks.length

    const launch = (from: number): void => {
      for (let i = from; i < n; i++) {
        const task = tasks[i]
        if (task === undefined || task.launched || task.status !== 'idle') continue
        task.launched = true
        void this.runProviderTask(tool, args, operation, task, () => launch(i + 1))
        return
      }
    }

    launch(0)

    const settleAny = (subset: ProviderTask[]): Promise<void> =>
      Promise.race([...subset.map(task => task.settled), untilAbort(operation.signal)])

    while (true) {
      if (operation.signal.aborted) break
      const running = tasks.filter(task => task.status === 'running')
      const successIndex = tasks.findIndex(task => task.status === 'succeeded')
      if (successIndex >= 0) {
        const blocking = running.filter(task => task.index < successIndex)
        if (blocking.length === 0) {
          for (const task of running) task.abort.abort()
          return tasks[successIndex]!.result!
        }
        await settleAny(blocking)
      } else {
        if (running.length === 0) break
        await settleAny(running)
      }
    }

    // No success from the main pass. Revisit parked (429) providers at a 10s cadence.
    if (!operation.signal.aborted) {
      const parked = tasks.filter(task => task.status === 'ratelimited')
      if (parked.length > 0) {
        const revisited = await this.revisitRateLimited(tool, args, operation, parked)
        if (revisited !== undefined) return revisited
      }
    }

    const success = tasks.find(task => task.status === 'succeeded')
    if (success !== undefined) return success.result!
    if (operation.signal.aborted) {
      throw new VisionToolkitError('timeout', `${tool}: timed out`)
    }
    const firstError = tasks.find(task => task.status === 'failed' || task.status === 'ratelimited')
    if (firstError?.error !== undefined) throw firstError.error
    throw new VisionToolkitError('service', `${tool}: all vision providers failed`)
  }

  /** Remaining request budget (ms) for one provider: the tighter of its t2 and the global deadline. */
  private providerRequestBudget(task: ProviderTask, operation: OperationContext): number {
    const t2Remaining = task.entry.provider.t2Seconds * 1000 - task.cumulativeMs
    const globalRemaining = operation.deadlineAt - Date.now()
    return Math.max(0, Math.min(t2Remaining, globalRemaining))
  }

  /**
   * Advance to the next provider after one provider reached a terminal
   * failure. This is what makes failover work for FAST failures too: the
   * hedge timer only launches the next provider when the current one is SLOW
   * (crosses t1), so a quick auth/5xx/network failure must explicitly launch
   * the successor. Never advances when a higher-priority provider superseded
   * this task, when the whole operation was cancelled, or when the global
   * deadline has too little room left for another request. `launch` is
   * idempotent, so an earlier hedge timer cannot cause a double launch.
   */
  private advanceAfterFailure(task: ProviderTask, operation: OperationContext, launchNext: () => void): void {
    if (task.abort.signal.aborted || operation.signal.aborted) return
    if (operation.deadlineAt - Date.now() < this.config.minAvailableSeconds * 1000) return
    launchNext()
  }

  /**
   * Run one provider to a terminal state: retryable errors retry within
   * `attempts`, a single request crossing t1 hedges the next provider, and the
   * provider is terminated once its cumulative time reaches t2. A 429 parks the
   * provider and moves on. No request is issued once the remaining budget drops
   * below the configured minimum available time.
   */
  private async runProviderTask(
    tool: 'glance' | 'ground' | 'detect' | 'long_screenshot_ocr',
    args: readonly string[],
    operation: OperationContext,
    task: ProviderTask,
    launchNext: () => void,
  ): Promise<void> {
    const { provider, env } = task.entry
    const gate = this.providerGate(provider)
    if (!gate.tryAcquire()) {
      task.status = 'failed'
      task.error = new VisionToolkitError('capacity', `${tool}: ${provider.name} has no free concurrency slot`)
      task.settle()
      launchNext()
      return
    }
    task.status = 'running'
    try {
      let attempt = 0
      const minAvailableMs = this.config.minAvailableSeconds * 1000
      while (true) {
        const budget = this.providerRequestBudget(task, operation)
        if (budget < minAvailableMs) {
          task.status = 'failed'
          task.error = new VisionToolkitError('timeout', `${tool}: ${provider.name} has insufficient remaining time`)
          this.advanceAfterFailure(task, operation, launchNext)
          return
        }
        const reqDeadline = createDeadline(AbortSignal.any([operation.signal, task.abort.signal]), budget)
        const hedgeMs = Math.min(provider.t1Seconds * 1000, budget)
        let hedgeTimer: ReturnType<typeof setTimeout> | undefined
        if (!task.hedged) {
          hedgeTimer = setTimeout(() => {
            task.hedged = true
            launchNext()
          }, hedgeMs)
        }
        const started = Date.now()
        try {
          const result = await this.runUpstream(tool, args, { signal: reqDeadline.signal, metrics: operation.metrics }, env)
          if (hedgeTimer !== undefined) clearTimeout(hedgeTimer)
          task.cumulativeMs += Date.now() - started
          task.status = 'succeeded'
          task.result = result
          return
        } catch (error) {
          if (hedgeTimer !== undefined) clearTimeout(hedgeTimer)
          task.cumulativeMs += Date.now() - started
          if (task.abort.signal.aborted) {
            task.status = 'failed'
            task.error = new VisionToolkitError('cancelled', `${tool}: superseded by a higher-priority provider`)
            return
          }
          if (operation.signal.aborted) {
            task.status = 'failed'
            task.error = new VisionToolkitError('timeout', `${tool}: timed out`)
            return
          }
          const classified = error instanceof VisionToolkitError
            ? error
            : new VisionToolkitError('service', `${tool}: request failed`, { cause: error })
          if (reqDeadline.timedOut) {
            task.status = 'failed'
            task.error = new VisionToolkitError('timeout', `${tool}: ${provider.name} exhausted its t2 budget`)
            this.advanceAfterFailure(task, operation, launchNext)
            return
          }
          if (classified.code === 'rate_limit') {
            task.status = 'ratelimited'
            task.error = classified
            launchNext()
            return
          }
          if (RETRYABLE_CODES.has(classified.code) && attempt + 1 < provider.attempts) {
            attempt += 1
            continue
          }
          task.status = 'failed'
          task.error = classified
          this.advanceAfterFailure(task, operation, launchNext)
          return
        } finally {
          reqDeadline.cleanup()
        }
      }
    } finally {
      gate.release()
      task.settle()
    }
  }

  /**
   * Revisit parked (429) providers in priority order at a 10s cadence until one
   * succeeds or every provider exhausts its budget. Returns a success result or
   * `undefined` when the global deadline or minimum available time stops the loop.
   */
  private async revisitRateLimited(
    tool: 'glance' | 'ground' | 'detect' | 'long_screenshot_ocr',
    args: readonly string[],
    operation: OperationContext,
    parked: ProviderTask[],
  ): Promise<UpstreamRunResult | undefined> {
    const minAvailableMs = this.config.minAvailableSeconds * 1000
    while (!operation.signal.aborted) {
      let anyRevisitable = false
      for (const task of parked) {
        if (operation.signal.aborted) break
        if (task.status !== 'ratelimited') continue
        const budget = this.providerRequestBudget(task, operation)
        if (budget < minAvailableMs) continue
        anyRevisitable = true
        await abortableSleep(Math.min(10_000, budget), operation.signal)
        if (operation.signal.aborted) break
        const { provider, env } = task.entry
        const gate = this.providerGate(provider)
        if (!gate.tryAcquire()) continue
        const reqDeadline = createDeadline(operation.signal, Math.min(provider.t2Seconds * 1000 - task.cumulativeMs, operation.deadlineAt - Date.now()))
        const started = Date.now()
        try {
          const result = await this.runUpstream(tool, args, { signal: reqDeadline.signal, metrics: operation.metrics }, env)
          task.cumulativeMs += Date.now() - started
          task.status = 'succeeded'
          task.result = result
          return result
        } catch (error) {
          task.cumulativeMs += Date.now() - started
          if (reqDeadline.timedOut) {
            task.status = 'failed'
            task.error = new VisionToolkitError('timeout', `${tool}: ${provider.name} exhausted its t2 budget`)
            continue
          }
          const classified = error instanceof VisionToolkitError
            ? error
            : new VisionToolkitError('service', `${tool}: request failed`, { cause: error })
          if (classified.code === 'rate_limit') continue
          task.status = 'failed'
          task.error = classified
        } finally {
          reqDeadline.cleanup()
          gate.release()
        }
      }
      if (!anyRevisitable) break
    }
    return undefined
  }

  private async glanceCacheKey(
    request: GlanceRequest,
    images: readonly ImageInfo[],
    pool: readonly ResolvedProviderEnv[],
    signal: AbortSignal,
  ): Promise<string> {
    const imageFingerprints = await Promise.all(images.map(async (image) => {
      let bytes: Buffer
      try {
        bytes = await readFile(image.path, { signal })
      } catch (error) {
        throw new VisionToolkitError('input', `image changed while preparing the vision request: ${image.path}`, { cause: error })
      }
      if (bytes.length !== image.bytes) {
        throw new VisionToolkitError('input', `image changed while preparing the vision request: ${image.path}`)
      }
      return {
        path: image.path,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      }
    }))
    return JSON.stringify({
      images: imageFingerprints,
      query: request.query ?? null,
      ocr: request.ocr === true,
      region: request.region ?? null,
      language: this.config.language,
      providers: pool.map(({ provider, env }) => ({
        name: provider.name,
        baseUrl: env.VISION_BASE_URL,
        model: env.VISION_MODEL,
        protocol: env.VISION_API_PROTOCOL,
        anthropicThinking: env.VISION_ANTHROPIC_THINKING,
        sslVerify: env.VISION_SSL_VERIFY ?? null,
        stream: env.VISION_STREAM === '1',
        userAgent: env.VISION_USER_AGENT,
        credentialSha256: createHash('sha256').update(env.VISION_API_KEY).digest('hex'),
        maxImageBytes: provider.maxImageBytes,
        maxImagePixels: provider.maxImagePixels,
        attempts: provider.attempts,
      })),
    })
  }

  private async runUpstream(
    tool: UpstreamTool,
    args: readonly string[],
    operation: { signal: AbortSignal; metrics: OperationMetrics },
    env?: UpstreamEnvironment,
  ): Promise<UpstreamRunResult> {
    const started = Date.now()
    if (env !== undefined) operation.metrics.usedVisionService = true
    const result = await this.adapter.run(tool, args, {
      signal: operation.signal,
      ...(env === undefined ? {} : { env }),
    })
    operation.metrics.upstreamMs += Date.now() - started
    if (result.outcome.exitCode !== 0) {
      throw this.adapter.classifyFailure(tool, result, {
        timedOut: false,
        cancelled: operation.signal.aborted,
        ...(env === undefined ? {} : { secrets: [env.VISION_API_KEY] }),
      })
    }
    if (result.stdoutTruncated || result.stderrTruncated) {
      throw new VisionToolkitError('output', `${tool}: upstream output exceeded the capture limit`)
    }
    return result
  }

  private async probeGeneratedImage(
    path: string,
    operation: OperationContext,
    source: string,
  ): Promise<{ width: number; height: number; format: string; mode: string }> {
    try {
      return await this.adapter.probeImageSize(path, { signal: operation.signal })
    } catch (error) {
      if (operation.signal.aborted) throw error
      throw new VisionToolkitError('output', `${source}: generated image is missing, corrupt, or unsupported`, { cause: error })
    }
  }

  private async annotateLocations(
    tool: 'vision_ground' | 'vision_detect',
    image: ImageInfo,
    elements: readonly LocatedElement[],
    output: string | undefined,
    policy: PathPolicy,
    operation: OperationContext,
  ): Promise<ArtifactDescriptor> {
    const extension = extname(image.originalPath).toLowerCase()
    const stem = basename(image.originalPath, extension)
    const suffix = tool === 'vision_ground' ? 'ground' : 'detect'
    const finalPath = resolveOutputFile(output, policy, `${stem}.${suffix}.preview.png`, ['.png'])
    assertDistinctOutput(image.path, finalPath)
    assertDistinctOutput(image.originalPath, finalPath)
    const staged = createStagedOutput(policy, '.png')
    try {
      const started = Date.now()
      await this.adapter.renderAnnotatedPreview(image.path, staged, elements, { signal: operation.signal })
      operation.metrics.upstreamMs += Date.now() - started
      const preview = await this.probeGeneratedImage(staged, operation, tool)
      if (preview.format !== 'png' || preview.width !== image.width || preview.height !== image.height) {
        throw new VisionToolkitError('output', `${tool}: annotation preview dimensions or format do not match the source image`)
      }
      await commitStagedOutput(staged, finalPath, policy)
      return describeArtifact(finalPath, policy, {
        mimeType: 'image/png',
        kind: 'image',
        description: tool === 'vision_ground' ? 'Grounding bounding-box preview' : 'Detected-element bounding-box preview',
        sourceTool: tool,
        previewIntent: 'image',
      })
    } finally {
      await rm(staged, { force: true }).catch(() => {})
    }
  }

  /** glance: describe, targeted QA, OCR, or multi-image comparison. */
  async glance(request: GlanceRequest, options: ToolCallOptions): Promise<GlanceResult> {
    return this.glanceWithEnv(request, options)
  }

  private async glanceWithEnv(
    request: GlanceRequest,
    options: ToolCallOptions,
  ): Promise<GlanceResult> {
    return this.runOperation('vision_glance', options, async (operation) => {
      if (request.images.length === 0) throw new VisionToolkitError('input', 'glance requires at least one image')
      if (request.query !== undefined && request.ocr === true) {
        throw new VisionToolkitError('input', 'glance: query and ocr are mutually exclusive')
      }
      if (request.region !== undefined && request.images.length > 1) {
        throw new VisionToolkitError('input', 'glance: region works with exactly one image')
      }
      if (request.region !== undefined) parseRegion(request.region)
      const policy = await this.pathPolicy(options.workspace)
      const pool = await this.resolveProviderPool()
      if (pool.length === 0) {
        throw new VisionToolkitError('config', 'no enabled vision provider has a resolvable credential')
      }
      const providers = pool.map(entry => entry.provider)
      const images: ImageInfo[] = []
      const seen = new Set<string>()
      for (const raw of request.images) {
        const image = await this.prepareVisionImage(raw, providers, policy, operation)
        if (seen.has(image.path)) {
          operation.metrics.cacheHits += 1
          continue
        }
        seen.add(image.path)
        this.accountImage(image, operation)
        images.push(image)
      }
      const cacheKey = options.sessionScope === undefined
        ? undefined
        : await this.glanceCacheKey(request, images, pool, operation.signal)
      if (options.sessionScope !== undefined && cacheKey !== undefined) {
        const cached = this.glanceCache.get(options.sessionScope)
        if (cached?.key === cacheKey) {
          operation.metrics.cacheHits += 1
          return cached.result
        }
      }
      const result = await this.runVisionHedge('glance', [
        ...images.map(image => image.path),
        ...(request.region !== undefined ? ['--region', request.region] : []),
        ...(request.ocr === true ? ['--ocr'] : []),
        ...(request.query !== undefined ? ['-q', request.query] : []),
      ], images, operation, pool)
      const answer = result.stdout.trim()
      if (answer.length === 0) throw new VisionToolkitError('output', 'glance: vision API returned an empty description')
      const value: GlanceResult = {
        images,
        mode: request.ocr === true ? 'ocr' : request.query !== undefined ? 'qa' : 'describe',
        answer,
        truncated: false,
      }
      if (options.sessionScope !== undefined && cacheKey !== undefined && !operation.signal.aborted) {
        this.glanceCache.set(options.sessionScope, { key: cacheKey, result: value })
      }
      return value
    })
  }

  private validateLocations(elements: LocatedElement[], width: number, height: number): void {
    for (const element of elements) {
      const { x1, y1, x2, y2 } = element.box
      if (
        ![x1, y1, x2, y2].every(Number.isInteger)
        || x1 < 0
        || y1 < 0
        || x2 <= x1
        || y2 <= y1
        || x2 > width
        || y2 > height
      ) {
        throw new VisionToolkitError('output', `upstream returned an out-of-range box for ${width}x${height}`)
      }
    }
  }

  private async locate(
    request: LocateRequest,
    options: ToolCallOptions,
    operation: OperationContext,
    tool: 'ground' | 'detect',
  ): Promise<{ image: ImageInfo; elements: LocatedElement[] }> {
    if (request.target.trim().length === 0) throw new VisionToolkitError('input', 'target must not be empty')
    if (request.region !== undefined) parseRegion(request.region)
    const policy = await this.pathPolicy(options.workspace)
    const pool = await this.resolveProviderPool()
    if (pool.length === 0) {
      throw new VisionToolkitError('config', 'no enabled vision provider has a resolvable credential')
    }
    const image = await this.prepareVisionImage(request.image, pool.map(entry => entry.provider), policy, operation)
    this.accountImage(image, operation)
    const result = await this.runVisionHedge(tool, [
      image.path,
      request.target,
      ...(request.region !== undefined ? ['--region', request.region] : []),
    ], [image], operation, pool)
    const elements = parseLocationOutput(result.stdout)
    this.validateLocations(elements, image.width, image.height)
    return { image, elements }
  }

  /** ground: locate one named target and return pixel boxes. */
  async ground(request: LocatePreviewRequest, options: ToolCallOptions): Promise<GroundResult> {
    return this.runOperation('vision_ground', options, async (operation) => {
      const { image, elements } = await this.locate(request, options, operation, 'ground')
      const labeled = elements.map(element => ({ label: element.label ?? request.target, box: element.box }))
      const preview = request.preview === true
        ? await this.annotateLocations('vision_ground', image, labeled, request.previewOutput, await this.pathPolicy(options.workspace), operation)
        : undefined
      return {
        target: request.target,
        image,
        imageWidth: image.width,
        imageHeight: image.height,
        matches: labeled,
        ...(preview === undefined ? {} : { preview }),
      }
    })
  }

  /** detect: inventory every instance of a kind. */
  async detect(request: LocatePreviewRequest, options: ToolCallOptions): Promise<DetectResult> {
    return this.runOperation('vision_detect', options, async (operation) => {
      const { image, elements } = await this.locate(request, options, operation, 'detect')
      const labeled = elements.map(element => ({ label: element.label ?? request.target, box: element.box }))
      const preview = request.preview === true
        ? await this.annotateLocations('vision_detect', image, labeled, request.previewOutput, await this.pathPolicy(options.workspace), operation)
        : undefined
      return {
        category: request.target,
        image,
        imageWidth: image.width,
        imageHeight: image.height,
        elements: labeled.map((element, index) => ({
          index: index + 1,
          label: element.label,
          box: element.box,
        })),
        ...(preview === undefined ? {} : { preview }),
      }
    })
  }

  /** crop: cut a pixel box into its own image file without requiring a credential. */
  async crop(request: CropRequest, options: ToolCallOptions): Promise<CropResult> {
    return this.runOperation('vision_crop', options, async (operation) => {
      const region = parseRegion(request.region)
      if (request.scale !== undefined && (!Number.isInteger(request.scale) || request.scale < 1 || request.scale > 8)) {
        throw new VisionToolkitError('input', 'crop: scale must be an integer between 1 and 8')
      }
      const policy = await this.pathPolicy(options.workspace)
      const image = await this.validateImage(request.image, policy, operation)
      this.accountImage(image, operation)
      const sourceExtension = extname(image.originalPath).toLowerCase()
      const stem = basename(image.originalPath, sourceExtension)
      const finalPath = resolveOutputFile(
        request.output,
        policy,
        request.scale !== undefined && request.scale > 1 ? `${stem}.crop@${request.scale}x.png` : `${stem}.crop.png`,
        ['.png', '.jpg', '.jpeg'],
      )
      assertDistinctOutput(image.path, finalPath)
      assertDistinctOutput(image.originalPath, finalPath)
      const outputExtension = extname(finalPath).toLowerCase()
      const staged = createStagedOutput(policy, outputExtension)
      try {
        const result = await this.runUpstream('crop', [
          image.path,
          '--region',
          request.region,
          '-o',
          staged,
          ...(request.scale !== undefined ? ['--scale', String(request.scale)] : []),
        ], operation)
        const parsed = parseCropOutput(result.stdout, result.stderr)
        const generated = await this.probeGeneratedImage(staged, operation, 'crop')
        const expectedFormat = outputExtension === '.png' ? 'png' : 'jpeg'
        if (
          generated.format !== expectedFormat
          || generated.width !== parsed.width
          || generated.height !== parsed.height
        ) {
          throw new VisionToolkitError('output', 'crop: generated image does not match the upstream summary')
        }
        await commitStagedOutput(staged, finalPath, policy)
        const mimeType = outputExtension === '.png' ? 'image/png' : 'image/jpeg'
        const artifact = await describeArtifact(finalPath, policy, {
          mimeType,
          kind: 'image',
          description: 'Cropped image region',
          sourceTool: 'vision_crop',
          previewIntent: 'image',
        })
        return {
          imageWidth: image.width,
          imageHeight: image.height,
          region,
          outputPath: finalPath,
          mimeType,
          width: parsed.width,
          height: parsed.height,
          clamped: parsed.clamped,
          artifact,
          ...(parsed.note === undefined ? {} : { note: parsed.note }),
        }
      } finally {
        await rm(staged, { force: true }).catch(() => {})
      }
    })
  }

  /** trace: recover an SVG through the pinned upstream vtracer pipeline. */
  async trace(request: TraceRequest, options: ToolCallOptions): Promise<TraceResult> {
    return this.runOperation('vision_trace', options, async (operation) => {
      if (request.region !== undefined) parseRegion(request.region)
      if (request.scale !== undefined && (!Number.isInteger(request.scale) || request.scale < 1 || request.scale > 16)) {
        throw new VisionToolkitError('input', 'trace: scale must be an integer between 1 and 16')
      }
      const policy = await this.pathPolicy(options.workspace)
      const image = await this.validateImage(request.image, policy, operation)
      this.accountImage(image, operation)
      const extension = extname(image.originalPath).toLowerCase()
      const stem = basename(image.originalPath, extension)
      const finalPath = resolveOutputFile(request.output, policy, `${stem}.svg`, ['.svg'])
      assertDistinctOutput(image.path, finalPath)
      assertDistinctOutput(image.originalPath, finalPath)
      const staged = createStagedOutput(policy, '.svg')
      try {
        const result = await this.runUpstream('trace', [
          image.path,
          ...(request.region !== undefined ? ['--region', request.region] : []),
          ...(request.scale !== undefined ? ['--scale', String(request.scale)] : []),
          ...(request.polygon === true ? ['--polygon'] : []),
          ...(request.color === true ? ['--color'] : []),
          '-o',
          staged,
        ], operation)
        const parsed = parseTraceOutput(result.stdout)
        const svg = await readFile(staged, 'utf8').catch(() => '')
        const actualPathCount = svgDocumentPathCount(svg)
        if (actualPathCount === undefined) {
          throw new VisionToolkitError('output', 'trace: output SVG is not a parseable document')
        }
        if (actualPathCount !== parsed.pathCount) {
          throw new VisionToolkitError('output', 'trace: reported path count does not match the generated SVG')
        }
        const svgInfo = await stat(staged)
        if (svgInfo.size !== parsed.bytes) {
          throw new VisionToolkitError('output', 'trace: reported byte count does not match the generated SVG')
        }
        await commitStagedOutput(staged, finalPath, policy)
        const artifact = await describeArtifact(finalPath, policy, {
          mimeType: 'image/svg+xml',
          kind: 'svg',
          description: 'Traced vector geometry',
          sourceTool: 'vision_trace',
          previewIntent: 'svg',
        })
        const warning = result.stderr.trim()
        return {
          imageWidth: image.width,
          imageHeight: image.height,
          outputPath: finalPath,
          mimeType: 'image/svg+xml',
          geometry: {
            status: parsed.pathCount === 0 ? 'empty' : 'generated',
            pathCount: parsed.pathCount,
            tracedScale: parsed.tracedScale,
            bytes: parsed.bytes,
          },
          artifact,
          ...(warning.length === 0 ? {} : { warning: warning.split(/\r?\n/).slice(-1)[0] ?? warning }),
        }
      } finally {
        await rm(staged, { force: true }).catch(() => {})
      }
    })
  }

  /** pixel_diff: compare real pixels, rank error regions, and deliver a heatmap plus JSON report. */
  async pixelDiff(request: PixelDiffRequest, options: ToolCallOptions): Promise<PixelDiffResult> {
    return this.runOperation('vision_pixel_diff', options, async (operation) => {
      const grid = integerInRange(request.grid, 6, 1, 32, 'pixel_diff.grid')
      const top = integerInRange(request.top, 5, 1, grid * grid, 'pixel_diff.top')
      const policy = await this.pathPolicy(options.workspace)
      const original = await this.validateImage(request.original, policy, operation)
      const rebuilt = await this.validateImage(request.rebuilt, policy, operation)
      this.accountImage(original, operation)
      this.accountImage(rebuilt, operation)
      const originalStem = basename(original.originalPath, extname(original.originalPath))
      const rebuiltStem = basename(rebuilt.originalPath, extname(rebuilt.originalPath))
      const finalDirectory = resolveOutputDirectory(
        request.runName,
        policy,
        `${originalStem}-vs-${rebuiltStem}.pixel-diff`,
      )
      if (
        isWithin(finalDirectory, original.path)
        || isWithin(finalDirectory, rebuilt.path)
        || isWithin(finalDirectory, original.originalPath)
        || isWithin(finalDirectory, rebuilt.originalPath)
      ) {
        throw new VisionToolkitError('input', 'pixel_diff artifact directory would replace an input image')
      }
      const stagedDirectory = await createStagedDirectory(policy)
      const stagedHeatmap = join(stagedDirectory, 'heatmap.png')
      const stagedReport = join(stagedDirectory, 'report.json')
      try {
        const result = await this.runUpstream('pixel_diff', [
          original.path,
          rebuilt.path,
          '--grid',
          String(grid),
          '--top',
          String(top),
          '-o',
          stagedHeatmap,
        ], operation)
        const parsed = parsePixelDiffOutput(result.stdout)
        if (parsed.heatmapPath !== stagedHeatmap) {
          throw new VisionToolkitError('output', 'pixel_diff: upstream reported an unexpected heatmap path')
        }
        if (!Number.isFinite(parsed.overallDifferencePct) || parsed.overallDifferencePct < 0 || parsed.overallDifferencePct > 100) {
          throw new VisionToolkitError('output', 'pixel_diff: overall difference is outside 0-100%')
        }
        if (
          parsed.scaled !== (original.width !== rebuilt.width || original.height !== rebuilt.height)
          || (parsed.scaledToSize !== undefined
            && (parsed.scaledToSize.width !== original.width || parsed.scaledToSize.height !== original.height))
          || parsed.worstRegions.length > top
          || parsed.worstRegions.some((region, index) => region.index !== index + 1)
        ) {
          throw new VisionToolkitError('output', 'pixel_diff: scaling or ranked-region metadata is inconsistent')
        }
        for (const region of parsed.worstRegions) assertBoxWithin(region.box, original.width, original.height, 'pixel_diff')
        const heatmapInfo = await this.probeGeneratedImage(stagedHeatmap, operation, 'pixel_diff')
        if (heatmapInfo.format !== 'png' || heatmapInfo.width !== original.width || heatmapInfo.height !== original.height) {
          throw new VisionToolkitError('output', 'pixel_diff: heatmap dimensions or format do not match the reference image')
        }
        const reportPayload = {
          schemaVersion: 1,
          sourceTool: 'vision_pixel_diff',
          original,
          rebuilt,
          scaled: parsed.scaled,
          ...(parsed.rebuiltOriginalSize === undefined ? {} : { rebuiltOriginalSize: parsed.rebuiltOriginalSize }),
          overallDifferencePct: parsed.overallDifferencePct,
          grid,
          worstRegions: parsed.worstRegions,
        }
        await writeFile(stagedReport, `${JSON.stringify(reportPayload, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
        await commitStagedDirectory(stagedDirectory, finalDirectory, policy)
        const heatmapPath = join(finalDirectory, 'heatmap.png')
        const reportPath = join(finalDirectory, 'report.json')
        const [heatmap, report] = await Promise.all([
          describeArtifact(heatmapPath, policy, {
            mimeType: 'image/png',
            kind: 'image',
            description: 'Pixel-difference heatmap',
            sourceTool: 'vision_pixel_diff',
            previewIntent: 'image',
          }),
          describeArtifact(reportPath, policy, {
            mimeType: 'application/json',
            kind: 'json',
            description: 'Structured pixel-difference report',
            sourceTool: 'vision_pixel_diff',
            previewIntent: 'text',
          }),
        ])
        return {
          original,
          rebuilt,
          scaled: parsed.scaled,
          ...(parsed.rebuiltOriginalSize === undefined ? {} : { rebuiltOriginalSize: parsed.rebuiltOriginalSize }),
          overallDifferencePct: parsed.overallDifferencePct,
          worstRegions: parsed.worstRegions,
          heatmap,
          report,
        }
      } finally {
        await rm(stagedDirectory, { recursive: true, force: true }).catch(() => {})
      }
    })
  }

  /** long_screenshot_ocr: split safely, optionally OCR, and atomically deliver the complete audit run. */
  async longScreenshotOcr(request: LongScreenshotOcrRequest, options: ToolCallOptions): Promise<LongScreenshotOcrResult> {
    const jobs = integerInRange(request.jobs, Math.min(2, this.config.concurrency), 1, this.config.concurrency, 'long_screenshot_ocr.jobs')
    const splitOnly = request.splitOnly === true
    const permits = splitOnly ? 1 : jobs
    return this.runOperation('vision_long_screenshot_ocr', options, async (operation) => {
      const mode = request.mode ?? 'general'
      if (mode !== 'general' && mode !== 'chat') throw new VisionToolkitError('input', 'long_screenshot_ocr.mode must be general or chat')
      const targetHeight = request.targetHeight === undefined
        ? undefined
        : integerInRange(request.targetHeight, request.targetHeight, 64, 100000, 'long_screenshot_ocr.targetHeight')
      const minHeight = request.minHeight === undefined
        ? undefined
        : integerInRange(request.minHeight, request.minHeight, 64, 100000, 'long_screenshot_ocr.minHeight')
      const maxHeight = request.maxHeight === undefined
        ? undefined
        : integerInRange(request.maxHeight, request.maxHeight, 64, 100000, 'long_screenshot_ocr.maxHeight')
      if (minHeight !== undefined && maxHeight !== undefined && minHeight > maxHeight) {
        throw new VisionToolkitError('input', 'long_screenshot_ocr.minHeight must not exceed maxHeight')
      }
      if (targetHeight !== undefined && minHeight !== undefined && targetHeight < minHeight) {
        throw new VisionToolkitError('input', 'long_screenshot_ocr.targetHeight must not be below minHeight')
      }
      if (targetHeight !== undefined && maxHeight !== undefined && targetHeight > maxHeight) {
        throw new VisionToolkitError('input', 'long_screenshot_ocr.targetHeight must not exceed maxHeight')
      }
      const overlap = request.overlap === undefined
        ? undefined
        : integerInRange(request.overlap, request.overlap, 0, 10000, 'long_screenshot_ocr.overlap')
      if (request.prompt !== undefined && request.prompt.trim().length === 0) {
        throw new VisionToolkitError('input', 'long_screenshot_ocr.prompt must not be empty when provided')
      }
      const policy = await this.pathPolicy(options.workspace)
      const pool = splitOnly ? [] : await this.resolveProviderPool()
      if (!splitOnly && pool.length === 0) {
        throw new VisionToolkitError('config', 'no enabled vision provider has a resolvable credential')
      }
      const image = splitOnly
        ? await this.validateImage(request.image, policy, operation)
        : await this.prepareVisionImage(request.image, pool.map(entry => entry.provider), policy, operation)
      this.accountImage(image, operation)
      const stem = basename(image.originalPath, extname(image.originalPath))
      const finalDirectory = resolveOutputDirectory(request.runName, policy, `${stem}.long-ocr`)
      if (isWithin(finalDirectory, image.path) || isWithin(finalDirectory, image.originalPath)) {
        throw new VisionToolkitError('input', 'long_screenshot_ocr artifact directory would replace the input image')
      }
      const stagedDirectory = await createStagedDirectory(policy)
      try {
        if (request.resume === true) await seedStagedDirectory(finalDirectory, stagedDirectory, policy)
        const stagedPolicy = { ...policy, outputDir: stagedDirectory }
        const stagedOutput = resolveOutputFile(request.output, stagedPolicy, `${stem}.ocr.md`, ['.md', '.markdown'])
        const finalOutput = join(finalDirectory, basename(stagedOutput))
        const stagedChunks = join(stagedDirectory, 'chunks')
        const stagedManifest = join(stagedChunks, 'manifest.json')
        const ocrArgs = [
          image.path,
          '--mode',
          mode,
          '-o',
          stagedOutput,
          '--chunks-dir',
          stagedChunks,
          ...(targetHeight === undefined ? [] : ['--target-height', String(targetHeight)]),
          ...(minHeight === undefined ? [] : ['--min-height', String(minHeight)]),
          ...(maxHeight === undefined ? [] : ['--max-height', String(maxHeight)]),
          ...(overlap === undefined ? [] : ['--overlap', String(overlap)]),
          ...(request.prompt === undefined ? [] : ['--prompt', request.prompt]),
          '--jobs',
          String(jobs),
          '--timeout',
          String(this.config.hardTimeoutSeconds),
          ...(splitOnly ? ['--split-only'] : []),
          ...(request.resume === true ? ['--resume'] : []),
        ]
        const result = splitOnly
          ? await this.runUpstream('long_screenshot_ocr', ocrArgs, operation)
          : await this.runVisionHedge('long_screenshot_ocr', ocrArgs, [image], operation, pool)
        const reported = result.stdout.trim()
        const expectedReported = splitOnly ? stagedManifest : stagedOutput
        if (reported !== expectedReported) {
          throw new VisionToolkitError('output', 'long_screenshot_ocr: upstream reported an unexpected output path')
        }
        const parsedManifest = parseLongOcrManifest(await readFile(stagedManifest, 'utf8'), {
          source: image.path,
          output: stagedOutput,
          width: image.width,
          height: image.height,
          mode,
          splitOnly,
        })
        for (const chunk of parsedManifest.chunks) {
          const chunkBytes = await readFile(join(stagedChunks, chunk.image))
          if (createHash('sha256').update(chunkBytes).digest('hex') !== chunk.imageSha256) {
            throw new VisionToolkitError('output', `long_screenshot_ocr: chunk ${chunk.index} hash does not match the manifest`)
          }
        }
        parsedManifest.raw.output = splitOnly ? null : finalOutput
        await writeFile(stagedManifest, `${JSON.stringify(parsedManifest.raw, null, 2)}\n`, 'utf8')
        await commitStagedDirectory(stagedDirectory, finalDirectory, policy)
        const finalChunks = join(finalDirectory, 'chunks')
        const manifest = await describeArtifact(join(finalChunks, 'manifest.json'), policy, {
          mimeType: 'application/json',
          kind: 'json',
          description: 'Long-screenshot split and merge manifest',
          sourceTool: 'vision_long_screenshot_ocr',
          previewIntent: 'text',
        })
        const output = splitOnly
          ? undefined
          : await describeArtifact(finalOutput, policy, {
            mimeType: 'text/markdown',
            kind: 'markdown',
            description: 'Merged long-screenshot OCR transcript',
            sourceTool: 'vision_long_screenshot_ocr',
            previewIntent: 'text',
          })
        const audit = splitOnly
          ? undefined
          : await describeArtifact(join(finalChunks, 'ocr_audit.md'), policy, {
            mimeType: 'text/markdown',
            kind: 'markdown',
            description: 'Long-screenshot OCR boundary audit',
            sourceTool: 'vision_long_screenshot_ocr',
            previewIntent: 'text',
          })
        const chunks: LongScreenshotChunk[] = []
        for (const chunk of parsedManifest.chunks) {
          const chunkImage = await describeArtifact(join(finalChunks, chunk.image), policy, {
            mimeType: 'image/png',
            kind: 'image',
            description: `Long-screenshot OCR chunk ${chunk.index}`,
            sourceTool: 'vision_long_screenshot_ocr',
            previewIntent: 'image',
          })
          const ocr = chunk.ocr === undefined
            ? undefined
            : await describeArtifact(join(finalChunks, chunk.ocr), policy, {
              mimeType: mode === 'chat' ? 'application/json' : 'text/markdown',
              kind: mode === 'chat' ? 'json' : 'markdown',
              description: `OCR sidecar for chunk ${chunk.index}`,
              sourceTool: 'vision_long_screenshot_ocr',
              previewIntent: 'text',
            })
          chunks.push({
            index: chunk.index,
            coreTop: chunk.coreTop,
            coreBottom: chunk.coreBottom,
            cropTop: chunk.cropTop,
            cropBottom: chunk.cropBottom,
            image: chunkImage,
            ...(ocr === undefined ? {} : { ocr }),
            ...(chunk.ocrReused === undefined ? {} : { reused: chunk.ocrReused }),
          })
        }
        return {
          source: image,
          mode,
          splitOnly,
          complete: parsedManifest.complete,
          chunkCount: chunks.length,
          runDirectory: finalDirectory,
          ...(output === undefined ? {} : { output }),
          manifest,
          ...(audit === undefined ? {} : { audit }),
          chunks,
        }
      } finally {
        await rm(stagedDirectory, { recursive: true, force: true }).catch(() => {})
      }
    }, permits)
  }

  /** extract_foreground: preserve the pinned component selection and deliver an RGBA PNG. */
  async extractForeground(request: ExtractForegroundRequest, options: ToolCallOptions): Promise<ExtractForegroundResult> {
    return this.runOperation('vision_extract_foreground', options, async (operation) => {
      const policy = await this.pathPolicy(options.workspace)
      const image = await this.validateImage(request.image, policy, operation)
      this.accountImage(image, operation)
      const region = request.region === undefined ? undefined : parseRegion(request.region)
      if (region !== undefined) assertBoxWithin(region, image.width, image.height, 'extract_foreground.region')
      const boxes = request.boxes === undefined ? undefined : parseRegion(request.boxes)
      if (boxes !== undefined) assertBoxWithin(boxes, image.width, image.height, 'extract_foreground.boxes')
      const discRadius = finiteInRange(request.discRadius, 1, Math.max(image.width, image.height) * 4, 'extract_foreground.discRadius')
      const saturation = integerInRange(request.saturation, 12, 0, 255, 'extract_foreground.saturation')
      const darkThreshold = integerInRange(request.darkThreshold, 215, 0, 255, 'extract_foreground.darkThreshold')
      const excludeTolerance = finiteInRange(request.excludeTolerance ?? 24, 0, 442, 'extract_foreground.excludeTolerance')
      const padding = integerInRange(request.padding, 3, 0, 4096, 'extract_foreground.padding')
      const excludeColor = request.excludeColor === undefined
        ? undefined
        : `#${request.excludeColor.trim().replace(/^#/, '').toUpperCase()}`
      if (excludeColor !== undefined && !HEX_COLOR_PATTERN.test(excludeColor)) {
        throw new VisionToolkitError('input', 'extract_foreground.excludeColor must be #RRGGBB')
      }
      const extension = extname(image.originalPath).toLowerCase()
      const stem = basename(image.originalPath, extension)
      const finalPath = resolveOutputFile(request.output, policy, `${stem}.foreground.png`, ['.png'])
      assertDistinctOutput(image.path, finalPath)
      assertDistinctOutput(image.originalPath, finalPath)
      const staged = createStagedOutput(policy, '.png')
      try {
        const result = await this.runUpstream('extract_foreground', [
          image.path,
          ...(region === undefined ? [] : ['--region', `${region.x1},${region.y1},${region.x2},${region.y2}`]),
          ...(boxes === undefined ? [] : ['--boxes', `${boxes.x1},${boxes.y1},${boxes.x2},${boxes.y2}`]),
          '--mode',
          request.mode ?? 'color',
          '--sat',
          String(saturation),
          '--dark',
          String(darkThreshold),
          '--exclude-tol',
          String(excludeTolerance),
          '--pad',
          String(padding),
          ...(discRadius === undefined ? [] : ['--disc-radius', String(discRadius)]),
          ...(excludeColor === undefined ? [] : ['--exclude-color', excludeColor]),
          ...(request.keepWhites === false ? ['--no-keep-whites'] : []),
          '-o',
          staged,
        ], operation)
        const parsed = parseExtractForegroundOutput(result.stdout)
        if (parsed.outputPath !== staged) throw new VisionToolkitError('output', 'extract_foreground: upstream reported an unexpected output path')
        assertBoxWithin(parsed.box, image.width, image.height, 'extract_foreground')
        if (
          parsed.foregroundPixels <= 0
          || parsed.keptComponents <= 0
          || parsed.totalComponents < parsed.keptComponents
          || parsed.largestComponentPct < 0
          || parsed.largestComponentPct > 100
        ) {
          throw new VisionToolkitError('output', 'extract_foreground: component metrics are invalid')
        }
        const generated = await this.probeGeneratedImage(staged, operation, 'extract_foreground')
        if (
          generated.format !== 'png'
          || (generated.mode !== 'RGBA' && generated.mode !== 'LA')
          || generated.width !== parsed.width
          || generated.height !== parsed.height
        ) {
          throw new VisionToolkitError('output', 'extract_foreground: output is not the reported transparent PNG')
        }
        await commitStagedOutput(staged, finalPath, policy)
        const artifact = await describeArtifact(finalPath, policy, {
          mimeType: 'image/png',
          kind: 'image',
          description: 'Extracted transparent foreground',
          sourceTool: 'vision_extract_foreground',
          previewIntent: 'image',
        })
        return {
          source: image,
          box: parsed.box,
          foregroundPixels: parsed.foregroundPixels,
          keptComponents: parsed.keptComponents,
          totalComponents: parsed.totalComponents,
          largestComponentPct: parsed.largestComponentPct,
          width: parsed.width,
          height: parsed.height,
          artifact,
          ...(parsed.autoSummary === undefined ? {} : { autoSummary: parsed.autoSummary }),
        }
      } finally {
        await rm(staged, { force: true }).catch(() => {})
      }
    })
  }

  /** dominant_colors: expose palette clusters or candidate scores as structure, never stdout prose. */
  async dominantColors(request: DominantColorsRequest, options: ToolCallOptions): Promise<DominantColorsResult> {
    return this.runOperation('vision_dominant_colors', options, async (operation) => {
      const top = integerInRange(request.top, 5, 1, 64, 'dominant_colors.top')
      const quantize = integerInRange(request.quantize, 16, 2, 256, 'dominant_colors.quantize')
      const maxPixels = integerInRange(request.maxPixels, 96, 8, 4096, 'dominant_colors.maxPixels')
      const mergeTolerance = integerInRange(request.mergeTolerance, 8, 0, 255, 'dominant_colors.mergeTolerance')
      const candidateTolerance = integerInRange(request.candidateTolerance, 16, 0, 255, 'dominant_colors.candidateTolerance')
      const policy = await this.pathPolicy(options.workspace)
      const image = await this.validateImage(request.image, policy, operation)
      this.accountImage(image, operation)
      const region = request.region === undefined ? undefined : parseRegion(request.region)
      if (region !== undefined) assertBoxWithin(region, image.width, image.height, 'dominant_colors.region')
      const candidates = request.candidates?.map(value => `#${value.trim().replace(/^#/, '').toUpperCase()}`)
      if (candidates !== undefined) {
        if (candidates.length === 0 || candidates.length > 32) {
          throw new VisionToolkitError('input', 'dominant_colors.candidates must contain between 1 and 32 colors')
        }
        if (candidates.some(candidate => !HEX_COLOR_PATTERN.test(candidate))) {
          throw new VisionToolkitError('input', 'dominant_colors.candidates must contain only #RRGGBB colors')
        }
        if (new Set(candidates).size !== candidates.length) {
          throw new VisionToolkitError('input', 'dominant_colors.candidates must not contain duplicates')
        }
      }
      const result = await this.runUpstream('dominant_colors', [
        image.path,
        ...(region === undefined ? [] : ['--region', `${region.x1},${region.y1},${region.x2},${region.y2}`]),
        ...(candidates === undefined ? [] : ['--candidates', candidates.join(',')]),
        '--top',
        String(top),
        '--quantize',
        String(quantize),
        '--max-pixels',
        String(maxPixels),
        '--merge-tol',
        String(mergeTolerance),
        '--tol',
        String(candidateTolerance),
      ], operation)
      const analysis = parseDominantColorsOutput(result.stdout)
      assertBoxWithin(analysis.region, image.width, image.height, 'dominant_colors')
      if (analysis.width !== analysis.region.x2 - analysis.region.x1 || analysis.height !== analysis.region.y2 - analysis.region.y1) {
        throw new VisionToolkitError('output', 'dominant_colors: reported region dimensions are inconsistent')
      }
      if (candidates !== undefined) {
        if (analysis.mode !== 'candidates') throw new VisionToolkitError('output', 'dominant_colors: expected candidate mode output')
        if (analysis.candidates.map(candidate => candidate.color).join(',') !== candidates.join(',')) {
          throw new VisionToolkitError('output', 'dominant_colors: candidate rows do not match the request')
        }
      } else if (analysis.mode !== 'palette') {
        throw new VisionToolkitError('output', 'dominant_colors: expected palette mode output')
      }
      return { image, analysis }
    })
  }

  /** html_screenshot: render only a path-fenced local HTML file in the pinned Chrome adapter. */
  async htmlScreenshot(request: HtmlScreenshotRequest, options: ToolCallOptions): Promise<HtmlScreenshotResult> {
    return this.runOperation('vision_html_screenshot', options, async (operation) => {
      const width = integerInRange(request.width, 1280, 1, 8192, 'html_screenshot.width')
      const height = integerInRange(request.height, 800, 1, 8192, 'html_screenshot.height')
      const scale = integerInRange(request.scale, 1, 1, 4, 'html_screenshot.scale')
      const waitMs = integerInRange(request.waitMs, 0, 0, 120000, 'html_screenshot.waitMs')
      const fullPage = request.fullPage === true
      const outputPixels = width * height * scale * scale
      if (!Number.isSafeInteger(outputPixels) || outputPixels > this.config.maxImagePixels) {
        throw new VisionToolkitError('capacity', `HTML screenshot would create ${outputPixels} pixels, exceeding maxImagePixels ${this.config.maxImagePixels}`)
      }
      const policy = await this.pathPolicy(options.workspace)
      const source = await resolveHtmlFile(request.source, policy)
      if (source.bytes > this.config.maxImageBytes) {
        throw new VisionToolkitError('capacity', `HTML source is ${source.bytes} bytes, exceeding maxImageBytes ${this.config.maxImageBytes}`)
      }
      const stem = basename(source.path, extname(source.path))
      const finalPath = resolveOutputFile(request.output, policy, `${stem}.screenshot.png`, ['.png'])
      assertDistinctOutput(source.path, finalPath)
      const staged = createStagedOutput(policy, '.png')
      try {
        const result = await this.runUpstream('html_screenshot', [
          source.path,
          '-o',
          staged,
          '--width',
          String(width),
          '--height',
          String(height),
          '--scale',
          String(scale),
          '--wait-ms',
          String(waitMs),
          ...(fullPage ? ['--full-page', '--max-pixels', String(this.config.maxImagePixels)] : []),
        ], operation)
        const parsed = parseHtmlScreenshotOutput(result.stdout)
        const expectedWidth = width * scale
        if (parsed.outputPath !== staged || parsed.width !== expectedWidth) {
          throw new VisionToolkitError('output', 'html_screenshot: upstream summary does not match the requested output')
        }
        if (fullPage !== (parsed.pageHeight !== undefined)) {
          throw new VisionToolkitError('output', 'html_screenshot: upstream full-page metadata does not match the request')
        }
        const pageHeight = parsed.pageHeight
        const expectedHeight = pageHeight === undefined ? height * scale : pageHeight * scale
        if (pageHeight !== undefined && (!Number.isInteger(pageHeight) || pageHeight <= 0)) {
          throw new VisionToolkitError('output', 'html_screenshot: upstream reported an invalid page height')
        }
        const outputPixels = expectedWidth * expectedHeight
        if (!Number.isSafeInteger(outputPixels) || outputPixels > this.config.maxImagePixels) {
          throw new VisionToolkitError('capacity', `HTML screenshot would create ${outputPixels} pixels, exceeding maxImagePixels ${this.config.maxImagePixels}`)
        }
        if (parsed.height !== expectedHeight) {
          throw new VisionToolkitError('output', 'html_screenshot: upstream summary does not match the requested output')
        }
        const generated = await this.probeGeneratedImage(staged, operation, 'html_screenshot')
        if (generated.format !== 'png' || generated.width !== expectedWidth || generated.height !== expectedHeight) {
          throw new VisionToolkitError('output', 'html_screenshot: generated PNG dimensions do not match the reported output')
        }
        await commitStagedOutput(staged, finalPath, policy)
        const artifact = await describeArtifact(finalPath, policy, {
          mimeType: 'image/png',
          kind: 'image',
          description: 'Headless browser screenshot of local HTML',
          sourceTool: 'vision_html_screenshot',
          previewIntent: 'image',
        })
        return {
          sourcePath: source.path,
          sourceBytes: source.bytes,
          viewport: { width, height, scale },
          width: expectedWidth,
          height: expectedHeight,
          ...(pageHeight === undefined ? {} : { pageHeight }),
          artifact,
        }
      } finally {
        await rm(staged, { force: true }).catch(() => {})
      }
    })
  }

  private async writableDirectoryCheck(path: string, label: string): Promise<HealthCheck> {
    const probe = join(path, `.vision-toolkit-health-${randomUUID()}`)
    try {
      await writeFile(probe, 'ok\n', { encoding: 'utf8', flag: 'wx' })
      await rm(probe, { force: true })
      return { status: 'ok', detail: `${label} is writable: ${path}` }
    } catch {
      await rm(probe, { force: true }).catch(() => {})
      return { status: 'error', detail: `${label} is not writable: ${path}` }
    }
  }

  /** Health: inspect local readiness, and optionally probe one provider's `/models` plus one real multimodal request. */
  async health(testConnection: boolean, options: ToolCallOptions, testModel = false, provider?: ResolvedProvider): Promise<VisionToolkitHealthResult> {
    return this.runOperation('vision_toolkit_health', options, async (operation) => {
      const info = this.upstreamVersion
      const python: HealthCheck = { status: 'ok', detail: `${info.pythonVersion} via ${info.python}` }
      const dependencies: HealthCheck = {
        status: 'ok',
        detail: Object.entries(info.dependencies).map(([name, version]) => `${name}=${version}`).join(', '),
      }
      let chrome: HealthCheck
      try {
        const started = Date.now()
        const chromePath = await this.adapter.findChrome({ signal: operation.signal })
        operation.metrics.upstreamMs += Date.now() - started
        chrome = chromePath === undefined
          ? { status: 'warning', detail: 'Chrome/Chromium/Edge was not found; vision_html_screenshot is unavailable' }
          : { status: 'ok', detail: chromePath }
      } catch {
        if (operation.signal.aborted) throw new VisionToolkitError('cancelled', 'vision_toolkit_health: cancelled')
        chrome = { status: 'error', detail: 'Chrome availability probe failed' }
      }
      let resolvedCredential: ResolvedCredential | undefined
      let credential: HealthCheck
      try {
        resolvedCredential = isBuiltInFreeVisionProvider(this.config.provider)
          ? { value: BUILT_IN_FREE_VISION_KEY, source: 'built-in' }
          : await this.ctx.credentials.resolve(this.config.provider.credential)
        credential = resolvedCredential === undefined
          ? { status: 'error', detail: `credential ${this.config.provider.credential} is not configured` }
          : { status: 'ok', detail: `credential ${this.config.provider.credential} is resolvable` }
      } catch {
        credential = { status: 'error', detail: `credential ${this.config.provider.credential} could not be resolved` }
      }
      let artifactDirectory: HealthCheck
      try {
        // allowedDirs are session input roots; they do not affect output readiness.
        const policy = await createPathPolicy(options.workspace, [], this.config.storageDir)
        artifactDirectory = await this.writableDirectoryCheck(policy.outputDir, 'Artifact directory')
      } catch {
        artifactDirectory = { status: 'error', detail: 'Artifact directory could not be prepared' }
      }
      const tempDirectory = await this.writableDirectoryCheck(info.runtimeHome, 'Runtime temp directory')
      let service: HealthCheck = {
        status: 'not_tested',
        detail: 'Connection was not tested; use the per-provider API test',
      }
      let model: HealthCheck = {
        status: 'not_tested',
        detail: 'Vision model was not tested; use the per-provider model test',
      }
      const target = provider ?? (testConnection || testModel ? this.primaryProvider : undefined)
      if (target !== undefined && (testConnection || testModel)) {
        const entry = await this.resolveProviderEnv(target)
        if (entry === undefined) {
          if (testConnection) {
            service = { status: 'error', detail: `Connection test skipped because credential ${String(target.credential)} is unavailable` }
          }
          if (testModel) {
            model = { status: 'error', detail: `Vision model test skipped because credential ${String(target.credential)} is unavailable` }
          }
        } else {
          if (testConnection) {
            operation.metrics.usedVisionService = true
            const endpoint = `${target.baseUrl}/models`
            try {
              const started = Date.now()
              const headers: Record<string, string> = {
                Accept: 'application/json',
                'User-Agent': target.userAgent,
              }
              if (target.protocol === 'anthropic') {
                headers['x-api-key'] = entry.env.VISION_API_KEY
                headers['anthropic-version'] = '2023-06-01'
              } else {
                headers.Authorization = `Bearer ${entry.env.VISION_API_KEY}`
              }
              const response = await fetch(endpoint, {
                method: 'GET',
                headers,
                signal: operation.signal,
              })
              operation.metrics.upstreamMs += Date.now() - started
              await response.body?.cancel().catch(() => {})
              if (response.ok) {
                service = { status: 'ok', detail: `Service responded at ${endpoint} (HTTP ${response.status})` }
              } else if (response.status === 401) {
                service = { status: 'error', detail: `Service rejected the configured credential (HTTP ${response.status})` }
              } else if (response.status === 403) {
                // Some providers (e.g. Groq preview/account restrictions) block GET /models
                // while real multimodal requests still work. Treat 403 as a warning so the
                // explicit vision-model test, not the model list endpoint, decides access.
                service = { status: 'warning', detail: `Service is reachable but restricted GET /models (HTTP 403); the credential may still be valid for real vision requests` }
              } else if (response.status === 404 || response.status === 405) {
                service = { status: 'warning', detail: `Service is reachable but does not expose GET /models (HTTP ${response.status})` }
              } else if (response.status === 429) {
                service = { status: 'warning', detail: 'Service is reachable but rate-limited the connection test (HTTP 429)' }
              } else {
                service = { status: 'error', detail: `Service connection test failed with HTTP ${response.status}` }
              }
            } catch {
              if (operation.signal.aborted) throw new VisionToolkitError('cancelled', 'vision_toolkit_health: connection test cancelled')
              service = { status: 'error', detail: `Service could not be reached at ${endpoint}` }
            }
          }
          if (testModel) {
            try {
              const attemptDeadline = createDeadline(operation.signal, target.t2Seconds * 1000)
              try {
                const result = await this.runUpstream(
                  'glance',
                  [VISION_MODEL_TEST_IMAGE, '-q', VISION_MODEL_TEST_PROMPT],
                  { signal: attemptDeadline.signal, metrics: operation.metrics },
                  entry.env,
                )
                if (result.stdout.trim().length === 0) {
                  throw new VisionToolkitError('output', 'glance: vision API returned an empty description')
                }
                model = {
                  status: 'ok',
                  detail: `Vision model ${target.model} completed a multimodal request`,
                }
              } finally {
                attemptDeadline.cleanup()
              }
            } catch (error) {
              if (operation.signal.aborted) throw error
              const detail = error instanceof Error ? error.message : String(error)
              model = { status: 'error', detail: `Vision model test failed: ${detail.slice(0, 600)}` }
            }
          }
        }
      }
      const checks = { python, dependencies, chrome, credential, artifactDirectory, tempDirectory, service, model }
      const healthy = Object.values(checks).every(check => check.status !== 'error')
      return {
        pluginVersion: PLUGIN_VERSION,
        upstream: info,
        checks,
        healthy,
        connectionTested: testConnection,
        modelTested: testModel,
        ...(provider === undefined ? {} : { providerName: provider.name }),
      }
    })
  }

  /** Report the packaged upstream snapshot version. */
  checkoutVersion(): Promise<string> {
    return this.adapter.readCheckoutVersion()
  }

  /** Prepared Python command. */
  python(): string {
    return this.adapter.versionInfo.python
  }
}
