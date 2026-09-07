/**
 * Model-facing native tools. Every definition projects one structured runtime
 * operation, declares replay-safe file locations, and preserves canonical
 * result metadata for the optional Web client without changing Headless or
 * model-visible semantics.
 * @module dsh-vision-toolkit/tools
 */
import { defineTool, type JsonValue } from '@deepseek-ai/dsh-tools';
import { VisionToolkitRuntime } from './runtime.ts';
/** Canonical names shared by registration, bootstrap guidance, and tests. */
export declare const VISION_TOOL_NAMES: {
    readonly glance: "vision_glance";
    readonly ground: "vision_ground";
    readonly detect: "vision_detect";
    readonly trace: "vision_trace";
    readonly crop: "vision_crop";
    readonly pixelDiff: "vision_pixel_diff";
    readonly longScreenshotOcr: "vision_long_screenshot_ocr";
    readonly extractForeground: "vision_extract_foreground";
    readonly dominantColors: "vision_dominant_colors";
    readonly htmlScreenshot: "vision_html_screenshot";
    readonly concurrency: "vision_concurrency";
    readonly videoInfo: "vision_video_info";
};
/**
 * Opt-in video-understanding tool name. Deliberately outside {@link VISION_TOOL_NAMES}
 * so the always-registered canonical set stays unconditional; this tool enters an
 * Agent only when a vision service has video support enabled.
 */
export declare const VISION_VIDEO_UNDERSTAND_TOOL = "vision_video_understand";
/**
 * Tool-group buckets used by the `toolVisibility` snapshot. A bucket that is
 * off contributes none of its listed tools to an Agent's visible surface.
 * - local: local-processing tools (no on-line fan-out, no concurrency charge).
 * - online: on-line image tools plus the concurrency/status probe.
 * - video: video-understanding tool (experimental).
 */
export interface ToolVisibility {
    local: boolean;
    online: boolean;
    video: boolean;
}
/** Runtime lookup accepted by tools so Settings can atomically swap generations. */
export type VisionToolkitRuntimeSource = VisionToolkitRuntime | (() => VisionToolkitRuntime);
/** Browser-only metadata projector; the model-visible value remains unchanged. */
export type VisionToolkitPresentationProjector = (value: JsonValue) => JsonValue;
/**
 * Build the complete P0/P1 tool set from one live runtime source.
 * @param source - Current runtime or atomic runtime lookup.
 * @param projectPresentation - Browser-only projection for Artifact capabilities.
 * @param lifecycleSignal - Plugin lifetime; aborting it cancels every active tool call.
 * @param toolVisibility - Session-head visibility snapshot; a bucket that is off
 *   contributes none of its tools. Defaults to every bucket on.
 * @returns Native tool definitions registered as one lifecycle generation.
 */
export declare function createVisionTools(source: VisionToolkitRuntimeSource, projectPresentation?: VisionToolkitPresentationProjector, lifecycleSignal?: AbortSignal, toolVisibility?: ToolVisibility): ReturnType<typeof defineTool>[];
//# sourceMappingURL=tools.d.ts.map