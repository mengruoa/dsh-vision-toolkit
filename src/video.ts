/**
 * Local video support built on the bundled `ffprobe-static` binary instead of
 * the pinned Python vision pipeline: metadata probing stays a plain JS
 * subprocess, and the model-facing video request reuses the existing object
 * storage + OpenAI-compatible (Aliyun Qwen) chat-completions transport.
 * @module dsh-vision-toolkit/video
 */

import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

/** Metadata derived from one ffprobe run (path/bytes are supplied by the runtime). */
export interface VideoMetadata {
  /** Container format name, e.g. "mov" or "matroska". */
  format: string
  /** Format duration in seconds, or null when the stream reports none. */
  durationSeconds: number | null
  /** Width of the first video stream, or null when the file carries no video. */
  width: number | null
  /** Height of the first video stream, or null when the file carries no video. */
  height: number | null
  /** Average frame rate of the first video stream, or null when unknown. */
  frameRate: number | null
  /** Codec of the first video stream, or null when the file carries no video. */
  videoCodec: string | null
  /** Codec of the first audio stream, or null when the file carries no audio. */
  audioCodec: string | null
  /** Format bit rate in bits per second, or null when unknown. */
  bitRate: number | null
  /** Number of video streams. */
  videoStreamCount: number
  /** Number of audio streams. */
  audioStreamCount: number
}

/** Full structured result for one local video-info probe. */
export interface VideoInfo extends VideoMetadata {
  /** Fence-checked absolute input path. */
  path: string
  /** Input file size in bytes. */
  bytes: number
}

/** Input for the local video-info tool (no API call). */
export interface VideoInfoRequest {
  video: string
}

/** Input for the video-understanding tool (video + prompt → vision API). */
export interface VideoUnderstandRequest {
  video: string
  prompt: string
  /** Video sampling frame rate passed to the model; default 2. */
  fps?: number
}

/** Result of one video-understanding call. */
export interface VideoUnderstandResult {
  /** Fence-checked absolute input path. */
  path: string
  /** The vision model's answer text. */
  answer: string
}

/**
 * Resolve the bundled ffprobe executable. An explicit `FFPROBE_BIN` override
 * wins (used by tests and unusual installs); otherwise the platform-correct
 * binary shipped by `ffprobe-static` is returned. `null` means no binary is
 * available and the caller must fail loud.
 */
export function ffprobeBinaryPath(): string | null {
  const override = process.env.FFPROBE_BIN?.trim()
  if (override !== undefined && override.length > 0) return override
  try {
    const mod = require('ffprobe-static') as { path?: unknown } | undefined
    const candidate = mod?.path
    return typeof candidate === 'string' && candidate.length > 0 ? candidate : null
  } catch {
    return null
  }
}

/** S3 object Content-Type for one video extension (browser-probing convention). */
export function videoMediaType(extension: string): string {
  switch (extension) {
    case '.mp4': return 'video/mp4'
    case '.mov': return 'video/quicktime'
    case '.webm': return 'video/webm'
    case '.mkv': return 'video/x-matroska'
    case '.avi': return 'video/x-msvideo'
    case '.m4v': return 'video/x-m4v'
    case '.mpeg':
    case '.mpg': return 'video/mpeg'
    case '.wmv': return 'video/x-ms-wmv'
    case '.flv': return 'video/x-flv'
    case '.ts':
    case '.m2ts': return 'video/mp2t'
    case '.3gp': return 'video/3gpp'
    default: return 'application/octet-stream'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

function integerValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null
}

/** Parse "num/den" or a plain float string into a frame rate, else null. */
function parseRate(raw: unknown): number | null {
  const text = stringValue(raw)
  if (text === null) return null
  const slash = text.indexOf('/')
  if (slash === -1) {
    const value = Number(text)
    return Number.isFinite(value) && value > 0 ? value : null
  }
  const numerator = Number(text.slice(0, slash))
  const denominator = Number(text.slice(slash + 1))
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return null
  const value = numerator / denominator
  return Number.isFinite(value) && value > 0 ? value : null
}

/**
 * Parse the JSON printed by `ffprobe -print_format json -show_format -show_streams`
 * into a compact, model-facing metadata object. Missing or malformed fields
 * degrade to null rather than throwing: metadata is advisory, and the probe
 * only fails when the process itself failed or returned no JSON.
 */
export function parseFfprobeOutput(stdout: string): VideoMetadata {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    throw new Error('ffprobe returned invalid JSON')
  }
  if (!isRecord(parsed)) throw new Error('ffprobe returned an unexpected structure')

  const streams = Array.isArray(parsed.streams) ? parsed.streams.filter(isRecord) : []
  const format = isRecord(parsed.format) ? parsed.format : {}

  let videoCodec: string | null = null
  let audioCodec: string | null = null
  let width: number | null = null
  let height: number | null = null
  let frameRate: number | null = null
  let videoStreamCount = 0
  let audioStreamCount = 0
  for (const stream of streams) {
    const codecType = stringValue(stream.codec_type)
    const codecName = stringValue(stream.codec_name)
    if (codecType === 'video') {
      videoStreamCount += 1
      if (videoCodec === null) {
        videoCodec = codecName
        width = integerValue(stream.width)
        height = integerValue(stream.height)
        frameRate = parseRate(stream.avg_frame_rate ?? stream.r_frame_rate)
      }
    } else if (codecType === 'audio') {
      audioStreamCount += 1
      if (audioCodec === null) audioCodec = codecName
    }
  }

  const durationText = stringValue(format.duration)
  const durationSeconds = durationText === null || durationText === 'N/A'
    ? null
    : (() => { const value = Number(durationText); return Number.isFinite(value) && value >= 0 ? value : null })()

  const formatName = stringValue(format.format_name)?.split(',')[0]?.trim() ?? null

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
  }
}

/**
 * Extract the answer text from one OpenAI-compatible chat-completions response
 * body. Handles both string content and array content (text parts joined).
 * @returns the answer text, or an empty string when the shape is unrecognized.
 */
export function extractChatAnswer(body: string): string {
  try {
    const parsed = JSON.parse(body) as unknown
    if (!isRecord(parsed)) return ''
    const choices = parsed.choices
    if (!Array.isArray(choices) || choices.length === 0) return ''
    const first = choices[0]
    if (!isRecord(first)) return ''
    const message = first.message
    if (!isRecord(message)) return ''
    const content = message.content
    if (typeof content === 'string') return content
    if (Array.isArray(content)) {
      return content
        .filter(isRecord)
        .map(part => (typeof part.text === 'string' ? part.text : ''))
        .join('')
    }
    return ''
  } catch {
    return ''
  }
}
