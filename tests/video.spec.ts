import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessService from '@deepseek-ai/dsh-subprocess-local'
import type { Credentials } from '@deepseek-ai/dsh-credentials'
import { resolveConfig, type VisionToolkitConfig } from '../src/config.ts'
import { createPathPolicy, resolveInputVideo } from '../src/paths.ts'
import { VisionToolkitRuntime } from '../src/runtime.ts'
import { createVisionTools, VISION_VIDEO_UNDERSTAND_TOOL } from '../src/tools.ts'
import { UpstreamAdapter } from '../src/upstream.ts'
import {
  extractChatAnswer,
  ffprobeBinaryPath,
  parseFfprobeOutput,
  videoMediaType,
} from '../src/video.ts'

const FFMPEG_STUB = fileURLToPath(new URL('./fixtures/ffprobe-stub', import.meta.url))
const FFMPEG_STUB_FAIL = fileURLToPath(new URL('./fixtures/ffprobe-stub-fail', import.meta.url))

const contexts: Context[] = []
const tempDirs: string[] = []

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function tempWorkspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-vision-toolkit-video-'))
  tempDirs.push(dir)
  await writeFile(join(dir, 'clip.mp4'), 'fake-video-bytes')
  return dir
}

async function setupRuntime(overrides: VisionToolkitConfig = {}, credential: string | null = 'test-vision-key') {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LocalSubprocessService)
  ctx.provide('credentials', {
    async resolve() {
      return credential === null ? undefined : { value: credential, source: 'env' }
    },
  } as unknown as Credentials)
  const config = resolveConfig({
    provider: { baseUrl: 'https://vision.example/v1', credential: 'VISION_API_KEY', model: 'fixture-model' },
    ...overrides,
  })
  const adapter = new UpstreamAdapter(ctx, config)
  const runtime = new VisionToolkitRuntime(ctx, config, adapter)
  return { ctx, config, runtime }
}

function options(workspace: string) {
  return { signal: new AbortController().signal, workspace }
}

describe('parseFfprobeOutput', () => {
  it('parses container, video, and audio facts', () => {
    const json = JSON.stringify({
      streams: [
        { codec_type: 'video', codec_name: 'h264', width: 512, height: 512, avg_frame_rate: '15/1' },
        { codec_type: 'audio', codec_name: 'aac' },
      ],
      format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '13.904000', bit_rate: '1708492' },
    })
    expect(parseFfprobeOutput(json)).toEqual({
      format: 'mov',
      durationSeconds: 13.904,
      width: 512,
      height: 512,
      frameRate: 15,
      videoCodec: 'h264',
      audioCodec: 'aac',
      bitRate: 1708492,
      videoStreamCount: 1,
      audioStreamCount: 1,
    })
  })

  it('degrades unknown fields to null', () => {
    expect(parseFfprobeOutput('{"streams":[],"format":{}}')).toEqual({
      format: 'unknown',
      durationSeconds: null,
      width: null,
      height: null,
      frameRate: null,
      videoCodec: null,
      audioCodec: null,
      bitRate: null,
      videoStreamCount: 0,
      audioStreamCount: 0,
    })
  })

  it('rejects invalid JSON', () => {
    expect(() => parseFfprobeOutput('not json')).toThrowError(/invalid JSON/)
  })
})

describe('videoMediaType', () => {
  it('maps common video extensions and falls back safely', () => {
    expect(videoMediaType('.mp4')).toBe('video/mp4')
    expect(videoMediaType('.mov')).toBe('video/quicktime')
    expect(videoMediaType('.webm')).toBe('video/webm')
    expect(videoMediaType('.mkv')).toBe('video/x-matroska')
    expect(videoMediaType('.unknown')).toBe('application/octet-stream')
  })
})

describe('extractChatAnswer', () => {
  it('reads string content', () => {
    expect(extractChatAnswer(JSON.stringify({ choices: [{ message: { content: 'hello' } }] }))).toBe('hello')
  })

  it('joins array content text parts', () => {
    const body = JSON.stringify({ choices: [{ message: { content: [{ text: 'a' }, { text: 'b' }] } }] })
    expect(extractChatAnswer(body)).toBe('ab')
  })

  it('returns empty for an unknown shape or invalid JSON', () => {
    expect(extractChatAnswer('nope')).toBe('')
    expect(extractChatAnswer('{}')).toBe('')
  })
})

describe('ffprobeBinaryPath', () => {
  it('prefers the FFPROBE_BIN override', () => {
    vi.stubEnv('FFPROBE_BIN', '/custom/ffprobe')
    expect(ffprobeBinaryPath()).toBe('/custom/ffprobe')
  })
})

describe('resolveInputVideo', () => {
  it('accepts a workspace video and reports its bytes', async () => {
    const workspace = await tempWorkspace()
    const policy = await createPathPolicy(workspace, [], undefined)
    const resolved = await resolveInputVideo('clip.mp4', policy)
    expect(resolved.path).toContain('clip.mp4')
    expect(resolved.bytes).toBe('fake-video-bytes'.length)
  })

  it('rejects an unsupported extension', async () => {
    const workspace = await tempWorkspace()
    const policy = await createPathPolicy(workspace, [], undefined)
    await writeFile(join(workspace, 'notes.txt'), 'x')
    await expect(resolveInputVideo('notes.txt', policy)).rejects.toThrowError(/unsupported video format/)
  })
})

describe('videoInfo', () => {
  it('probes a video with ffprobe and returns structured metadata', async () => {
    vi.stubEnv('FFPROBE_BIN', FFMPEG_STUB)
    const workspace = await tempWorkspace()
    const { runtime } = await setupRuntime()
    const result = await runtime.videoInfo({ video: 'clip.mp4' }, options(workspace))
    expect(result).toMatchObject({
      path: expect.stringContaining('clip.mp4'),
      bytes: 'fake-video-bytes'.length,
      format: 'mov',
      durationSeconds: 13.904,
      width: 512,
      height: 512,
      frameRate: 15,
      videoCodec: 'h264',
      audioCodec: 'aac',
      bitRate: 1708492,
      videoStreamCount: 1,
      audioStreamCount: 1,
    })
  })

  it('fails loud when ffprobe cannot read the file', async () => {
    vi.stubEnv('FFPROBE_BIN', FFMPEG_STUB_FAIL)
    const workspace = await tempWorkspace()
    const { runtime } = await setupRuntime()
    await expect(runtime.videoInfo({ video: 'clip.mp4' }, options(workspace)))
      .rejects.toThrowError(/cannot read video metadata/)
  })
})

describe('video tool exposure', () => {
  it('registers the video-understanding tool only when video support is enabled', async () => {
    const off = await setupRuntime()
    const offNames = createVisionTools(() => off.runtime).map(tool => tool.name)
    expect(offNames).toContain('vision_video_info')
    expect(offNames).not.toContain(VISION_VIDEO_UNDERSTAND_TOOL)

    const on = await setupRuntime({
      provider: { baseUrl: 'https://vision.example/v1', credential: 'VISION_API_KEY', model: 'fixture-model', videoSupport: true },
    })
    const onNames = createVisionTools(() => on.runtime).map(tool => tool.name)
    expect(onNames).toContain('vision_video_info')
    expect(onNames).toContain(VISION_VIDEO_UNDERSTAND_TOOL)
  })
})

describe('videoUnderstand', () => {
  it('fails with a config error when no provider enables video support', async () => {
    const workspace = await tempWorkspace()
    const { runtime } = await setupRuntime()
    await expect(runtime.videoUnderstand(
      { video: 'clip.mp4', prompt: 'what is this?' },
      options(workspace),
    )).rejects.toThrowError(/no enabled vision service has video support/)
  })

  it('fails with a config error when object storage is missing', async () => {
    const workspace = await tempWorkspace()
    const { runtime } = await setupRuntime({
      provider: { baseUrl: 'https://vision.example/v1', credential: 'VISION_API_KEY', model: 'fixture-model', videoSupport: true },
    })
    await expect(runtime.videoUnderstand(
      { video: 'clip.mp4', prompt: 'what is this?' },
      options(workspace),
    )).rejects.toThrowError(/object storage is not configured/)
  })
})
