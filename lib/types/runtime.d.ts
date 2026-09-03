/**
 * Vision Toolkit runtime: structured requests in, structured results out.
 * One operation-wide deadline reaches every subprocess; image decoding,
 * byte/pixel limits, session-scoped concurrency, credential resolution, safe
 * output staging, and diagnostic logging stay below the model-facing tools.
 * @module dsh-vision-toolkit/runtime
 */
import type { Context } from '@deepseek-ai/cordis';
import { type ArtifactDescriptor } from './artifacts.ts';
import { type ResolvedProvider, type ResolvedVisionToolkitConfig } from './config.ts';
import { UpstreamAdapter, type DominantColorsOutput, type UpstreamEnvironment, type UpstreamVersionInfo } from './upstream.ts';
/** Per-invocation cancellation and timeout facts. */
export interface Deadline {
    signal: AbortSignal;
    /** True when the deadline timer fired. */
    timedOut: boolean;
    /** True when the caller signal fired first. */
    cancelled: boolean;
    /** Clear the timer and caller listener. */
    cleanup(): void;
}
/** Combine a caller abort signal with one hard operation timeout. */
export declare function createDeadline(signal: AbortSignal, timeoutMs: number): Deadline;
/** FIFO bounded concurrency gate whose queued callers remain cancellable. */
export declare class Semaphore {
    private readonly limit;
    private active;
    private readonly waiters;
    constructor(limit: number);
    /** Whether no active or queued caller still owns this gate. */
    get idle(): boolean;
    /** Free slots still claimable without queuing. */
    get available(): number;
    /** Acquire one slot, aborting while queued when `signal` fires. */
    acquire(signal: AbortSignal, permits?: number): Promise<void>;
    /** Release owned permits and wake FIFO waiters whose full weight now fits. */
    release(permits?: number): void;
    /** Non-blocking acquisition: claim a free slot immediately, else return false. */
    tryAcquire(permits?: number): boolean;
}
/** Validated image metadata retained in structured results and diagnostics. */
export interface ImageInfo {
    path: string;
    bytes: number;
    width: number;
    height: number;
    format: string;
    /** True when the analyzed image carries an alpha (transparency) channel. */
    hasAlpha: boolean;
    /** Original user-facing image path before any automatic compression. */
    originalPath: string;
}
/** Structured input for one glance call. */
export interface GlanceRequest {
    images: string[];
    query?: string;
    ocr?: boolean;
    region?: string;
}
/** Structured glance result. */
export interface GlanceResult {
    images: ImageInfo[];
    mode: 'describe' | 'qa' | 'ocr';
    answer: string;
    truncated: boolean;
}
/** Structured input for ground/detect. */
export interface LocateRequest {
    image: string;
    target: string;
    region?: string;
}
/** One located element with an upstream or caller label. */
export interface LocateMatch {
    label: string;
    box: {
        x1: number;
        y1: number;
        x2: number;
        y2: number;
    };
}
/** Structured ground result. */
export interface GroundResult {
    target: string;
    image: ImageInfo;
    imageWidth: number;
    imageHeight: number;
    matches: LocateMatch[];
    preview?: ArtifactDescriptor;
}
/** Structured detect result. */
export interface DetectResult {
    category: string;
    image: ImageInfo;
    imageWidth: number;
    imageHeight: number;
    elements: Array<{
        index: number;
        label: string;
        box: {
            x1: number;
            y1: number;
            x2: number;
            y2: number;
        };
    }>;
    preview?: ArtifactDescriptor;
}
/** Structured crop request. */
export interface CropRequest {
    image: string;
    region: string;
    scale?: number;
    output?: string;
}
/** Structured crop result. */
export interface CropResult {
    imageWidth: number;
    imageHeight: number;
    region: {
        x1: number;
        y1: number;
        x2: number;
        y2: number;
    };
    outputPath: string;
    mimeType: 'image/png' | 'image/jpeg';
    width: number;
    height: number;
    clamped: boolean;
    artifact: ArtifactDescriptor;
    note?: string;
}
/** Structured trace request supported by the pinned upstream snapshot. */
export interface TraceRequest {
    image: string;
    region?: string;
    scale?: number;
    color?: boolean;
    polygon?: boolean;
    output?: string;
}
/** Structured trace result. */
export interface TraceResult {
    imageWidth: number;
    imageHeight: number;
    outputPath: string;
    mimeType: 'image/svg+xml';
    geometry: {
        status: 'generated' | 'empty';
        pathCount: number;
        tracedScale: number;
        bytes: number;
    };
    artifact: ArtifactDescriptor;
    warning?: string;
}
/** Structured input for local image comparison. */
export interface PixelDiffRequest {
    original: string;
    rebuilt: string;
    grid?: number;
    top?: number;
    runName?: string;
}
/** Structured local pixel comparison plus formally delivered files. */
export interface PixelDiffResult {
    original: ImageInfo;
    rebuilt: ImageInfo;
    scaled: boolean;
    rebuiltOriginalSize?: {
        width: number;
        height: number;
    };
    overallDifferencePct: number;
    worstRegions: Array<{
        index: number;
        differencePct: number;
        box: {
            x1: number;
            y1: number;
            x2: number;
            y2: number;
        };
    }>;
    heatmap: ArtifactDescriptor;
    report: ArtifactDescriptor;
}
/** Structured input for the pinned long-screenshot OCR pipeline. */
export interface LongScreenshotOcrRequest {
    image: string;
    mode?: 'general' | 'chat';
    output?: string;
    runName?: string;
    targetHeight?: number;
    minHeight?: number;
    maxHeight?: number;
    overlap?: number;
    prompt?: string;
    jobs?: number;
    splitOnly?: boolean;
    resume?: boolean;
}
/** One long-OCR chunk and the files retained for audit or reuse. */
export interface LongScreenshotChunk {
    index: number;
    coreTop: number;
    coreBottom: number;
    cropTop: number;
    cropBottom: number;
    image: ArtifactDescriptor;
    ocr?: ArtifactDescriptor;
    reused?: boolean;
}
/** Long-screenshot split/OCR result with every durable deliverable. */
export interface LongScreenshotOcrResult {
    source: ImageInfo;
    mode: 'general' | 'chat';
    splitOnly: boolean;
    complete: boolean;
    chunkCount: number;
    runDirectory: string;
    output?: ArtifactDescriptor;
    manifest: ArtifactDescriptor;
    audit?: ArtifactDescriptor;
    chunks: LongScreenshotChunk[];
}
/** Structured input for transparent foreground extraction. */
export interface ExtractForegroundRequest {
    image: string;
    region?: string;
    boxes?: string;
    mode?: 'color' | 'dark';
    discRadius?: number;
    saturation?: number;
    darkThreshold?: number;
    excludeColor?: string;
    excludeTolerance?: number;
    padding?: number;
    keepWhites?: boolean;
    output?: string;
}
/** Transparent foreground file plus the pinned script's component metrics. */
export interface ExtractForegroundResult {
    source: ImageInfo;
    box: {
        x1: number;
        y1: number;
        x2: number;
        y2: number;
    };
    foregroundPixels: number;
    keptComponents: number;
    totalComponents: number;
    largestComponentPct: number;
    width: number;
    height: number;
    artifact: ArtifactDescriptor;
    autoSummary?: string;
}
/** Structured input for palette extraction or candidate scoring. */
export interface DominantColorsRequest {
    image: string;
    region?: string;
    candidates?: string[];
    top?: number;
    quantize?: number;
    maxPixels?: number;
    mergeTolerance?: number;
    candidateTolerance?: number;
}
/** Stable dominant-colour result enriched with source image facts. */
export interface DominantColorsResult {
    image: ImageInfo;
    analysis: DominantColorsOutput;
}
/** Structured input for rendering an authorized local HTML document. */
export interface HtmlScreenshotRequest {
    source: string;
    width?: number;
    height?: number;
    scale?: number;
    waitMs?: number;
    fullPage?: boolean;
    output?: string;
}
/** Browser-rendered PNG plus viewport and source facts. */
export interface HtmlScreenshotResult {
    sourcePath: string;
    sourceBytes: number;
    viewport: {
        width: number;
        height: number;
        scale: number;
    };
    width: number;
    height: number;
    /** Full document height in CSS pixels; present only for full-page captures. */
    pageHeight?: number;
    artifact: ArtifactDescriptor;
}
/** Optional preview controls shared by ground and detect. */
export interface LocatePreviewRequest extends LocateRequest {
    preview?: boolean;
    previewOutput?: string;
}
/** One named health-check state. */
export interface HealthCheck {
    status: 'ok' | 'warning' | 'error' | 'not_tested';
    detail: string;
}
/** Runtime, dependency, browser, and optional per-provider service health. */
export interface VisionToolkitHealthResult {
    pluginVersion: string;
    upstream: UpstreamVersionInfo;
    checks: {
        python: HealthCheck;
        dependencies: HealthCheck;
        chrome: HealthCheck;
        credential: HealthCheck;
        artifactDirectory: HealthCheck;
        tempDirectory: HealthCheck;
        service: HealthCheck;
        model: HealthCheck;
    };
    healthy: boolean;
    connectionTested: boolean;
    modelTested: boolean;
    /** Provider label when the service/model checks targeted one specific provider. */
    providerName?: string;
}
/** Shared per-call execution options. */
export interface ToolCallOptions {
    signal: AbortSignal;
    /** Override the global hard timeout (seconds) for this call. */
    timeoutSeconds?: number;
    workspace: string;
    /** Session identity for the per-session concurrency cap. */
    sessionId?: string;
    /** Live Session object whose lifetime bounds the one-entry glance cache. */
    sessionScope?: object;
}
/** One immutable vision-service snapshot used to generate cache-keyed evidence. */
export interface CapturedEvidenceRuntime {
    readonly evidenceFingerprint: string;
    glance(request: GlanceRequest, options: ToolCallOptions): Promise<GlanceResult>;
}
/** Parse a non-empty four-integer pixel box. */
export declare function parseRegion(region: string): {
    x1: number;
    y1: number;
    x2: number;
    y2: number;
};
/** One enabled provider paired with its resolved upstream environment. */
interface ResolvedProviderEnv {
    provider: ResolvedProvider;
    env: UpstreamEnvironment;
}
/** Live concurrency accounting returned by the availability query tool. */
export interface ConcurrencyStatus {
    /** New tool calls this session may start right now. */
    available: number;
    /** Per-session cap on concurrent tool operations. */
    sessionMax: number;
    /** Tool operations currently in flight in this session. */
    sessionInUse: number;
    /** Free per-session slots. */
    sessionFree: number;
    /** Total free model-request slots summed across enabled providers. */
    modelFree: number;
    /** Per-provider breakdown. */
    models: Array<{
        name: string;
        concurrency: number;
        inUse: number;
        free: number;
    }>;
}
/** Runtime facade used by every native tool. */
export declare class VisionToolkitRuntime {
    private readonly ctx;
    private readonly config;
    private readonly readableStorageDirs;
    private readonly semaphores;
    private readonly glanceCache;
    private readonly providerGates;
    private readonly adapter;
    constructor(ctx: Context, config: ResolvedVisionToolkitConfig, adapter?: UpstreamAdapter, readableStorageDirs?: readonly string[]);
    /** Pinned and prepared upstream identity. */
    get upstreamVersion(): UpstreamVersionInfo;
    /** Per-session cap on concurrent tool operations. */
    get sessionMaxConcurrency(): number;
    /** Shared storage root belonging to this immutable runtime generation. */
    get storageDirectory(): string | undefined;
    /** Stable identity for persisted image descriptions produced by this runtime. */
    get evidenceFingerprint(): string;
    /** Capture the credential and provider identity used by one evidence conversion. */
    captureEvidenceRuntime(): Promise<CapturedEvidenceRuntime>;
    /** Global hard timeout (ms) for one tool invocation, honoring the per-call override. */
    private hardTimeoutMs;
    private operationError;
    /** Per-session concurrency gate; callers acquire without queuing (excess is rejected). */
    private sessionGate;
    /** Live concurrency accounting for the calling session across the enabled provider pool. */
    concurrencyStatus(options: ToolCallOptions): ConcurrencyStatus;
    private runOperation;
    /** Highest-priority enabled provider, falling back to the first entry. */
    private get primaryProvider();
    /** Build the upstream environment for one resolved provider. */
    private providerEnv;
    /** Resolve one provider's credential into its environment, or undefined when unavailable. */
    private resolveProviderEnv;
    /** Resolve every enabled provider in priority order, skipping unreadable credentials. */
    resolveProviderPool(): Promise<ResolvedProviderEnv[]>;
    /** Resolve the primary provider's credential at the remote-operation boundary. */
    resolveVisionEnv(): Promise<UpstreamEnvironment>;
    private pathPolicy;
    private compressedImageRoot;
    private readCacheCandidate;
    private cacheEntryOutDigest;
    private pruneCompressedCache;
    private autoCompressImage;
    /** Validate one image against the configured global limits (used by local tools). */
    private validateImage;
    private accountImage;
    /** Stable gate key for one provider's in-flight request cap. */
    private providerGate;
    /**
     * Prepare one image for an online vision request against the enabled
     * provider pool. The raw image is kept when at least one enabled provider
     * accepts it; otherwise it is compressed once to the first (highest
     * priority) provider's limits so the priority route can proceed.
     */
    private prepareVisionImage;
    /**
     * Hedge-based failover across the enabled provider pool. The highest-priority
     * provider runs first; when one of its requests crosses t1 it keeps running
     * while the next provider starts in parallel. A provider whose cumulative
     * request time reaches t2 is terminated. A 429 provider is parked and moved
     * past immediately; parked providers are revisited at a 10s cadence once
     * every other provider is exhausted. The result always prefers the earliest
     * (highest-priority) provider.
     */
    private runVisionHedge;
    /** Remaining request budget (ms) for one provider: the tighter of its t2 and the global deadline. */
    private providerRequestBudget;
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
    private advanceAfterFailure;
    /**
     * Run one provider to a terminal state: retryable errors retry within
     * `attempts`, a single request crossing t1 hedges the next provider, and the
     * provider is terminated once its cumulative time reaches t2. A 429 parks the
     * provider and moves on. No request is issued once the remaining budget drops
     * below the configured minimum available time.
     */
    private runProviderTask;
    /**
     * Revisit parked (429) providers in priority order at a 10s cadence until one
     * succeeds or every provider exhausts its budget. Returns a success result or
     * `undefined` when the global deadline or minimum available time stops the loop.
     */
    private revisitRateLimited;
    private glanceCacheKey;
    private runUpstream;
    private probeGeneratedImage;
    private annotateLocations;
    /** glance: describe, targeted QA, OCR, or multi-image comparison. */
    glance(request: GlanceRequest, options: ToolCallOptions): Promise<GlanceResult>;
    private glanceWithEnv;
    private validateLocations;
    private locate;
    /** ground: locate one named target and return pixel boxes. */
    ground(request: LocatePreviewRequest, options: ToolCallOptions): Promise<GroundResult>;
    /** detect: inventory every instance of a kind. */
    detect(request: LocatePreviewRequest, options: ToolCallOptions): Promise<DetectResult>;
    /** crop: cut a pixel box into its own image file without requiring a credential. */
    crop(request: CropRequest, options: ToolCallOptions): Promise<CropResult>;
    /** trace: recover an SVG through the pinned upstream vtracer pipeline. */
    trace(request: TraceRequest, options: ToolCallOptions): Promise<TraceResult>;
    /** pixel_diff: compare real pixels, rank error regions, and deliver a heatmap plus JSON report. */
    pixelDiff(request: PixelDiffRequest, options: ToolCallOptions): Promise<PixelDiffResult>;
    /** long_screenshot_ocr: split safely, optionally OCR, and atomically deliver the complete audit run. */
    longScreenshotOcr(request: LongScreenshotOcrRequest, options: ToolCallOptions): Promise<LongScreenshotOcrResult>;
    /** extract_foreground: preserve the pinned component selection and deliver an RGBA PNG. */
    extractForeground(request: ExtractForegroundRequest, options: ToolCallOptions): Promise<ExtractForegroundResult>;
    /** dominant_colors: expose palette clusters or candidate scores as structure, never stdout prose. */
    dominantColors(request: DominantColorsRequest, options: ToolCallOptions): Promise<DominantColorsResult>;
    /** html_screenshot: render only a path-fenced local HTML file in the pinned Chrome adapter. */
    htmlScreenshot(request: HtmlScreenshotRequest, options: ToolCallOptions): Promise<HtmlScreenshotResult>;
    private writableDirectoryCheck;
    /** Health: inspect local readiness, and optionally probe one provider's `/models` plus one real multimodal request. */
    health(testConnection: boolean, options: ToolCallOptions, testModel?: boolean, provider?: ResolvedProvider): Promise<VisionToolkitHealthResult>;
    /** Report the packaged upstream snapshot version. */
    checkoutVersion(): Promise<string>;
    /** Prepared Python command. */
    python(): string;
}
export {};
//# sourceMappingURL=runtime.d.ts.map