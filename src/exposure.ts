/**
 * Agent-scoped progressive exposure for the model-facing visual tools.
 * Runtime readiness is global, while tool schemas enter only an Agent through
 * the matching Skill or its bootstrap tool; administrative diagnostics stay on
 * the Web seam.
 * @module dsh-vision-toolkit/exposure
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import { VISION_SKILLS_CONTENT, VISION_SKILLS_NAME } from './skill.ts'
import { VISION_TOOL_NAMES, type ToolVisibility } from './tools.ts'

/** Small bootstrap tool retained only until the current Agent gains visual tools. */
export const VISION_TOOLKIT_ACTIVATE = 'vision_toolkit_activate'

/** Skill name used by releases before the rename to vision-skills. */
export const LEGACY_VISION_TOOLS_SKILL_NAME = 'vision-tools'

/** Unique pre-rename line in bundled instructions, kept for Session restore. */
export const LEGACY_VISION_TOOLS_SKILL_MARKER = 'If this content arrived through a direct `/vision-tools` invocation and the'

interface AgentExposure {
  active: boolean
  liftRestriction?: () => void
  toolDisposers: Array<() => void>
  toolNames: string[]
}

/** Result returned by the one-shot activation transport. */
export interface VisionToolkitActivationResult {
  activated: boolean
  tools: string[]
}

function renderJson(_args: unknown, value: unknown): ContentBlock[] {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isBundledSkillName(name: unknown): boolean {
  return name === VISION_SKILLS_NAME || name === LEGACY_VISION_TOOLS_SKILL_NAME
}

function isBundledSkillContent(text: string): boolean {
  return text.includes(VISION_SKILLS_CONTENT) || text.includes(LEGACY_VISION_TOOLS_SKILL_MARKER)
}

function isVisionSkillArguments(value: unknown): boolean {
  return isRecord(value) && isBundledSkillName(value.name)
}

function nativeSkillCall(raw: string): boolean {
  try {
    return isVisionSkillArguments(JSON.parse(raw))
  } catch {
    return false
  }
}

function containsBundledSkillContent(blocks: readonly unknown[]): boolean {
  return blocks.some(block => isRecord(block)
    && block.type === 'text'
    && typeof block.text === 'string'
    && isBundledSkillContent(block.text))
}

function isBundledSkillResult(value: unknown): boolean {
  return isRecord(value)
    && isBundledSkillName(value.name)
    && typeof value.content === 'string'
    && isBundledSkillContent(value.content)
}

/**
 * Iterate a Session's durable event log across runtime lines. dsh 0.1.2-alpha
 * replaced the `events` getter with `snapshotEvents()` (session-log-read-intent):
 * iterating the removed `session.events` throws `session.events is not iterable`
 * and takes down `agent/created` → session restore. Prefer the snapshot accessor
 * and fall back to the legacy rc-line `events` getter so both lines work.
 */
function sessionEventLog(session: Session): readonly SessionEvent[] {
  const snapshot = (session as { snapshotEvents?: () => readonly SessionEvent[] }).snapshotEvents
  return typeof snapshot === 'function'
    ? snapshot.call(session)
    : (session as { events: readonly SessionEvent[] }).events
}

/** Whether durable history proves that this Session loaded the bundled Skill. */
function hasLoadedVisionSkill(session: Session): boolean {
  const nativeCalls = new Set<string>()
  for (const event of sessionEventLog(session)) {
    if (event.type === 'user/message') {
      const source = event.data.source
      if (source.kind === 'skill-invocation'
        && isBundledSkillName(source.name)
        && containsBundledSkillContent(event.data.content)) return true
      continue
    }
    if (event.type === 'tool/call') {
      if (event.data.name === 'skill' && nativeSkillCall(event.data.arguments)) {
        nativeCalls.add(String(event.data.callId))
      }
      continue
    }
    if (event.type === 'tool/result') {
      const [block] = event.data.message.content
      if (block?.type === 'tool-result'
        && block.isError !== true
        && nativeCalls.has(String(block.toolCallId))
        && containsBundledSkillContent(block.content)) return true
      continue
    }
    if (event.type === 'tool/code-dispatch'
      && event.data.name === 'skill'
      && event.data.isError === false
      && isVisionSkillArguments(event.data.arguments)
      && containsBundledSkillContent(event.data.content)) return true
  }
  return false
}

/**
 * Owns one progressive-exposure generation for a ready Vision Toolkit runtime.
 * The bootstrap tool is global; visual definitions are created and registered
 * in an Agent scope after the Skill load is durable, just succeeded, or the
 * model explicitly invokes the bootstrap fallback.
 */
export class VisionToolExposure {
  readonly activationTool: ToolDefinition
  private readonly states = new Map<Agent, AgentExposure>()
  private installed = false

  /**
   * @param ctx - Plugin context with Tool and Agent registries.
   * @param createTools - Fresh definitions bound to the current runtime
   *   generation, filtered by a tool-visibility snapshot.
   * @param resolveVisibility - Live resolver for the current tool-visibility
   *   snapshot; read once per activation (a session-head snapshot).
   */
  constructor(
    private readonly ctx: Context,
    private readonly createTools: (snapshot: ToolVisibility) => ToolDefinition[],
    private readonly resolveVisibility: () => ToolVisibility = () => ({ local: true, online: true, video: false }),
  ) {
    this.activationTool = defineTool({
      name: VISION_TOOLKIT_ACTIVATE,
      description: `Report and (re)mount the Vision Toolkit execution tools for this Agent: the currently visible subset of ${Object.values(VISION_TOOL_NAMES).join(', ')} plus optional video understanding. `
        + `The visual tool set is normally mounted automatically when the ${VISION_SKILLS_NAME} Skill loads; call this ONLY when the user explicitly asks you to refresh or reload the current session's vision tools, or to list which vision tools are currently available. `
        + 'It restores the tool set to the latest Settings snapshot and returns the tool names actually mounted.',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            activated: { type: 'boolean', required: true },
            tools: { type: 'array', items: { type: 'string' }, required: true },
          },
        },
        render: renderJson,
      },
      execute: (_args, exec): Promise<VisionToolkitActivationResult> => {
        if (exec.agent === undefined) {
          throw new Error(`${VISION_TOOLKIT_ACTIVATE}: an Agent Session is required`)
        }
        // An already-active Agent is reloaded (re-reads the latest Settings
        // snapshot) rather than returning the stale set, so the tool genuinely
        // refreshes the visible tool list on an explicit user request.
        return Promise.resolve(this.reload(exec.agent))
      },
      presentCall: () => ({ card: 'generic', title: 'Refresh or list vision tools', kind: 'execute' }),
    })
  }

  /** Install lifecycle listeners and adopt Agents that already exist. */
  install(): () => void {
    if (this.installed) throw new Error('dsh-vision-toolkit: progressive exposure is already installed')
    this.installed = true
    const listeners = [
      this.ctx.on('agent/created', ({ agent }) => { this.attach(agent) }),
      this.ctx.on('agent/disposed', ({ agent }) => { this.detach(agent) }),
      this.ctx.on('session/event', (session, event) => {
        if (event.type === 'step/end') this.applyHideActivationForSession(session)
      }),
      this.ctx.on('tools/result', (exec, result) => {
        if (result.isError === false
          && exec.name === 'skill'
          && exec.agent !== undefined
          && isVisionSkillArguments(exec.arguments)
          && isBundledSkillResult(result.value)) {
          this.activate(exec.agent)
        }
        return undefined
      }),
    ]
    try {
      for (const agent of this.ctx.agents.list()) this.attach(agent)
    } catch (error) {
      for (const dispose of listeners.reverse()) dispose()
      this.disposeStates()
      this.installed = false
      throw error
    }
    return () => {
      if (!this.installed) return
      this.installed = false
      for (const dispose of listeners.reverse()) dispose()
      this.disposeStates()
    }
  }

  private attach(agent: Agent): void {
    if (this.states.has(agent)) return
    this.states.set(agent, { active: false, toolDisposers: [], toolNames: [] })
    if (hasLoadedVisionSkill(agent.session)) this.activate(agent)
  }

  private activate(agent: Agent): VisionToolkitActivationResult {
    this.attach(agent)
    const state = this.states.get(agent)
    /* v8 ignore next -- attach() synchronously creates this exact entry. */
    if (state === undefined) throw new Error(`dsh-vision-toolkit: Agent ${String(agent.id)} has no exposure state`)
    if (state.active) return { activated: false, tools: [...state.toolNames] }

    const definitions = this.createTools(this.resolveVisibility())
    const toolDisposers: Array<() => void> = []
    try {
      for (const definition of definitions) toolDisposers.push(agent.ctx.tools.register(definition))
      // A Skill call and the bootstrap can be issued in the same model step.
      // Restricting immediately would turn the still-in-flight bootstrap call
      // into an UNKNOWN_TOOL error, so live sessions hide at step/end.
      if (!this.isLiveSession(agent.session)) this.applyHideActivation(agent)
    } catch (error) {
      for (const dispose of toolDisposers.reverse()) dispose()
      throw error
    }

    state.active = true
    state.toolDisposers = toolDisposers
    state.toolNames = definitions.map(definition => definition.name)
    return { activated: true, tools: [...state.toolNames] }
  }

  /**
   * Explicit refresh/reload from the bootstrap tool. An inactive Agent is
   * mounted; an active Agent is torn down and re-mounted from the *current*
   * Settings snapshot, so the returned tool list reflects the latest
   * `toolVisibility` instead of the stale activation-time set.
   */
  private reload(agent: Agent): VisionToolkitActivationResult {
    this.attach(agent)
    const state = this.states.get(agent)
    if (state === undefined) return { activated: false, tools: [] }
    if (!state.active) return this.activate(agent)
    // Dispose the current tool generation (including the hide-restriction on
    // the bootstrap gauntlet) and rebuild from the fresh snapshot.
    this.disposeState(state)
    this.states.set(agent, { active: false, toolDisposers: [], toolNames: [] })
    return this.activate(agent)
  }

  /** Whether the session is attached to the live SessionStore (production). */
  private isLiveSession(session: Session): boolean {
    return this.ctx.sessions.get(session.id) === session
  }

  private applyHideActivationForSession(session: Session): void {
    for (const agent of this.ctx.agents.list()) {
      if (agent.session === session && this.states.get(agent)?.active === true) {
        this.applyHideActivation(agent)
      }
    }
  }

  private applyHideActivation(agent: Agent): void {
    const state = this.states.get(agent)
    if (state === undefined || state.liftRestriction !== undefined) return
    state.liftRestriction = agent.ctx.tools.restrict({ deny: [VISION_TOOLKIT_ACTIVATE] })
  }

  private detach(agent: Agent): void {
    const state = this.states.get(agent)
    if (state === undefined) return
    this.states.delete(agent)
    this.disposeState(state)
  }

  private disposeStates(): void {
    for (const state of this.states.values()) this.disposeState(state)
    this.states.clear()
  }

  private disposeState(state: AgentExposure): void {
    state.liftRestriction?.()
    for (const dispose of state.toolDisposers.reverse()) dispose()
  }
}
