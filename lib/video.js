/**
 * Local video support built on the bundled `ffprobe-static` binary instead of
 * the pinned Python vision pipeline: metadata probing stays a plain JS
 * subprocess, and the model-facing video request reuses the existing object
 * storage + OpenAI-compatible (Aliyun Qwen) chat-completions transport.
 * @module dsh-vision-toolkit/video
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
/**
 * Resolve the bundled ffprobe executable. An explicit `FFPROBE_BIN` override
 * wins (used by tests and unusual installs); otherwise the platform-correct
 * binary shipped by `ffprobe-static` is returned. `null` means no binary is
 * available and the caller must fail loud.
 */
export function ffprobeBinaryPath() {
    const override = process.env.FFPROBE_BIN?.trim();
    if (override !== undefined && override.length > 0)
        return override;
    try {
        const mod = require('ffprobe-static');
        const candidate = mod?.path;
        return typeof candidate === 'string' && candidate.length > 0 ? candidate : null;
    }
    catch {
        return null;
    }
}
/** S3 object Content-Type for one video extension (browser-probing convention). */
export function videoMediaType(extension) {
    switch (extension) {
        case '.mp4': return 'video/mp4';
        case '.mov': return 'video/quicktime';
        case '.webm': return 'video/webm';
        case '.mkv': return 'video/x-matroska';
        case '.avi': return 'video/x-msvideo';
        case '.m4v': return 'video/x-m4v';
        case '.mpeg':
        case '.mpg': return 'video/mpeg';
        case '.wmv': return 'video/x-ms-wmv';
        case '.flv': return 'video/x-flv';
        case '.ts':
        case '.m2ts': return 'video/mp2t';
        case '.3gp': return 'video/3gpp';
        default: return 'application/octet-stream';
    }
}
function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function stringValue(value) {
    return typeof value === 'string' && value.trim().length > 0 ? value : null;
}
function integerValue(value) {
    return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}
/** Parse "num/den" or a plain float string into a frame rate, else null. */
function parseRate(raw) {
    const text = stringValue(raw);
    if (text === null)
        return null;
    const slash = text.indexOf('/');
    if (slash === -1) {
        const value = Number(text);
        return Number.isFinite(value) && value > 0 ? value : null;
    }
    const numerator = Number(text.slice(0, slash));
    const denominator = Number(text.slice(slash + 1));
    if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0)
        return null;
    const value = numerator / denominator;
    return Number.isFinite(value) && value > 0 ? value : null;
}
/**
 * Parse the JSON printed by `ffprobe -print_format json -show_format -show_streams`
 * into a compact, model-facing metadata object. Missing or malformed fields
 * degrade to null rather than throwing: metadata is advisory, and the probe
 * only fails when the process itself failed or returned no JSON.
 */
export function parseFfprobeOutput(stdout) {
    let parsed;
    try {
        parsed = JSON.parse(stdout);
    }
    catch {
        throw new Error('ffprobe returned invalid JSON');
    }
    if (!isRecord(parsed))
        throw new Error('ffprobe returned an unexpected structure');
    const streams = Array.isArray(parsed.streams) ? parsed.streams.filter(isRecord) : [];
    const format = isRecord(parsed.format) ? parsed.format : {};
    let videoCodec = null;
    let audioCodec = null;
    let width = null;
    let height = null;
    let frameRate = null;
    let videoStreamCount = 0;
    let audioStreamCount = 0;
    for (const stream of streams) {
        const codecType = stringValue(stream.codec_type);
        const codecName = stringValue(stream.codec_name);
        if (codecType === 'video') {
            videoStreamCount += 1;
            if (videoCodec === null) {
                videoCodec = codecName;
                width = integerValue(stream.width);
                height = integerValue(stream.height);
                frameRate = parseRate(stream.avg_frame_rate ?? stream.r_frame_rate);
            }
        }
        else if (codecType === 'audio') {
            audioStreamCount += 1;
            if (audioCodec === null)
                audioCodec = codecName;
        }
    }
    const durationText = stringValue(format.duration);
    const durationSeconds = durationText === null || durationText === 'N/A'
        ? null
        : (() => { const value = Number(durationText); return Number.isFinite(value) && value >= 0 ? value : null; })();
    const formatName = stringValue(format.format_name)?.split(',')[0]?.trim() ?? null;
    return {
        format: formatName ?? 'unknown',
        durationSeconds,
        width,
        height,
        frameRate,
        videoCodec,
        audioCodec,
        bitRate: integerValue(typeof format.bit_rate === 'string' ? Number(format.bit_rate) : format.bit_rate),
        videoStreamCount,
        audioStreamCount,
    };
}
/**
 * Extract the answer text from one OpenAI-compatible chat-completions response
 * body. Handles both string content and array content (text parts joined).
 * @returns the answer text, or an empty string when the shape is unrecognized.
 */
export function extractChatAnswer(body) {
    try {
        const parsed = JSON.parse(body);
        if (!isRecord(parsed))
            return '';
        const choices = parsed.choices;
        if (!Array.isArray(choices) || choices.length === 0)
            return '';
        const first = choices[0];
        if (!isRecord(first))
            return '';
        const message = first.message;
        if (!isRecord(message))
            return '';
        const content = message.content;
        if (typeof content === 'string')
            return content;
        if (Array.isArray(content)) {
            return content
                .filter(isRecord)
                .map(part => (typeof part.text === 'string' ? part.text : ''))
                .join('');
        }
        return '';
    }
    catch {
        return '';
    }
}
//# sourceMappingURL=video.js.map