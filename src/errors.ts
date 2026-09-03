/**
 * Stable error vocabulary shared by the runtime, upstream adapter, and tools.
 * Every failure reaching the model carries one of these codes and a message
 * that never contains credentials or raw upstream stack traces.
 * @module dsh-vision-toolkit/errors
 */

/**
 * Discriminant tag for every Vision Toolkit failure.
 *
 * The remote vision-provider failures are split by a machine-routable taxonomy
 * so the failover loop can decide, per error, whether to retry the SAME
 * provider or advance to the next one:
 *
 * - `auth`           401/403 — credential is wrong or unauthorized. Never retry.
 * - `quota`          402 — account out of quota/unpaid. Never retry.
 * - `rate_limit`     429 — throttled. Park and revisit, never retry in place.
 * - `server`         5xx — transient provider fault. Worth a same-provider retry.
 * - `network`        connection refused / DNS / socket — transient. Worth a retry.
 * - `region`         provider unavailable in this region. Never retry.
 * - `tos`            rejected by content/safety policy. Never retry.
 * - `invalid_request` 400/404/422 — bad request or unknown model. Never retry.
 * - `service`        fallback for unclassifiable remote failures. Never retry.
 */
export const VISION_TOOLKIT_ERROR_CODES = [
  'config',
  'input',
  'capacity',
  'auth',
  'quota',
  'rate_limit',
  'server',
  'network',
  'region',
  'tos',
  'invalid_request',
  'service',
  'runtime',
  'output',
  'timeout',
  'cancelled',
  'path',
] as const

/** Stable machine-readable error category. */
export type VisionToolkitErrorCode = typeof VISION_TOOLKIT_ERROR_CODES[number]

/** Error with a stable category; safe to surface to the model. */
export class VisionToolkitError extends Error {
  readonly code: VisionToolkitErrorCode

  constructor(code: VisionToolkitErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'VisionToolkitError'
    this.code = code
  }
}

/**
 * Replace every known secret occurrence in untrusted text. Used before
 * upstream stderr, exit messages, or trace reports enter logs or results.
 * @param text - text that may embed a secret.
 * @param secrets - values that must never be surfaced.
 * @returns text with each secret replaced by a fixed marker.
 */
export function redactText(text: string, secrets: readonly string[]): string {
  let result = text
  for (const secret of secrets) {
    if (secret.length === 0) continue
    result = result.split(secret).join('<redacted>')
  }
  return result
}

/**
 * Build a model-safe upstream failure line: the tool prefix plus the
 * redacted stderr tail, never a JavaScript stack.
 * @param tool - upstream CLI name.
 * @param stderr - captured upstream stderr.
 * @param secrets - values to redact.
 * @returns one-line safe message.
 */
export function upstreamFailureMessage(tool: string, stderr: string, secrets: readonly string[]): string {
  const tail = redactText(stderr, secrets).trim().split(/\r?\n/).filter(Boolean).slice(-2).join(' ')
  return tail.length === 0 ? `${tool}: upstream command failed` : `${tool}: ${tail}`
}
