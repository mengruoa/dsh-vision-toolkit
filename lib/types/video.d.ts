/**
 * Local video support built on the bundled `ffprobe-static` binary instead of
 * the pinned Python vision pipeline: metadata probing stays a plain JS
 * subprocess, and the model-facing video request reuses the existing object
 * storage + OpenAI-compatible (Aliyun Qwen) chat-completions transport.
 * @module dsh-vision-toolkit/video
 */
/** Metadata derived from one ffprobe run (path/bytes are supplied by the runtime). */
export interface VideoMetadata {
    /** Container format name, e.g. "mov" or "matroska". */
    format: string;
    /** Format duration in seconds, or null when the stream reports none. */
    durationSeconds: number | null;
    /** Width of the first video stream, or null when the file carries no video. */
    width: number | null;
    /** Height of the first video stream, or null when the file carries no video. */
    height: number | null;
    /** Average frame rate of the first video stream, or null when unknown. */
    frameRate: number | null;
    /** Codec of the first video stream, or null when the file carries no video. */
    videoCodec: string | null;
    /** Codec of the first audio stream, or null when the file carries no audio. */
    audioCodec: string | null;
    /** Format bit rate in bits per second, or null when unknown. */
    bitRate: number | null;
    /** Number of video streams. */
    videoStreamCount: number;
    /** Number of audio streams. */
    audioStreamCount: number;
}
/** Full structured result for one local video-info probe. */
export interface VideoInfo extends VideoMetadata {
    /** Fence-checked absolute input path. */
    path: string;
    /** Input file size in bytes. */
    bytes: number;
}
/** Input for the local video-info tool (no API call). */
export interface VideoInfoRequest {
    video: string;
}
/** Input for the video-understanding tool (video + prompt → vision API). */
export interface VideoUnderstandRequest {
    video: string;
    prompt: string;
    /** Video sampling frame rate passed to the model; default 2. */
    fps?: number;
}
/** Result of one video-understanding call. */
export interface VideoUnderstandResult {
    /** Fence-checked absolute input path. */
    path: string;
    /** The vision model's answer text. */
    answer: string;
}
/**
 * Resolve the bundled ffprobe executable. An explicit `FFPROBE_BIN` override
 * wins (used by tests and unusual installs); otherwise the platform-correct
 * binary shipped by `ffprobe-static` is returned. `null` means no binary is
 * available and the caller must fail loud.
 */
export declare function ffprobeBinaryPath(): string | null;
/** S3 object Content-Type for one video extension (browser-probing convention). */
export declare function videoMediaType(extension: string): string;
/**
 * Parse the JSON printed by `ffprobe -print_format json -show_format -show_streams`
 * into a compact, model-facing metadata object. Missing or malformed fields
 * degrade to null rather than throwing: metadata is advisory, and the probe
 * only fails when the process itself failed or returned no JSON.
 */
export declare function parseFfprobeOutput(stdout: string): VideoMetadata;
/**
 * Extract the answer text from one OpenAI-compatible chat-completions response
 * body. Handles both string content and array content (text parts joined).
 * @returns the answer text, or an empty string when the shape is unrecognized.
 */
export declare function extractChatAnswer(body: string): string;
//# sourceMappingURL=video.d.ts.map