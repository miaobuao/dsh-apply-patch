/**
 * Built-in tool suppression through the official per-agent restriction.
 *
 * `edit` / `write` come from `@deepseek-ai/dsh-tool-fs`, which a deployment may
 * mount globally, from the agent preset, or both. A preset row does NOT register
 * into the agent's own layer: `@deepseek-ai/dsh-agent-preset-registry` creates a
 * generation scope per revision and binds the agent scope key as its CHILD
 * (`bindScopeParent(key, generation.key)`). `tools.view(agent)` therefore reads
 * preset registrations as inherited, which is exactly what `tools.restrict()`
 * filters — so one restriction on the agent's own context hides the tool from
 * schema presentation, lookup, and dispatch at once.
 *
 * This replaces an earlier `system-prompt/assemble` listener that filtered
 * `assembly.tools`. That payload never carried tools by contract (prompt
 * presentation is provider-owned), and dsh 0.2.2 stopped attaching them, so the
 * listener threw on every assembly and broke conversation entirely.
 *
 * The restriction is an effect of `agent.ctx`: disposing the agent or unloading
 * this plugin lifts it and the built-in tools return. Nothing is persisted, so
 * uninstalling the plugin cannot leave a user without `edit` / `write`.
 */
import type { Context } from '@deepseek-ai/cordis'
// Module augmentation only: makes `agent/created` and `settings/document-updated` typed.
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-settings'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { APPLY_PATCH_SETTINGS_NS, BUILTIN_EDIT_TOOL, BUILTIN_WRITE_TOOL } from '../shared/constants.js'
import type { ResolvedApplyPatchSettings } from './settings-schema.js'

/** Built-in tool names this plugin may hide, in display order. */
export const SUPPRESSIBLE_TOOLS = [BUILTIN_EDIT_TOOL, BUILTIN_WRITE_TOOL] as const

/**
 * The set of built-in tool names the current settings hide.
 *
 * The switches are volatile handles, so reading them here (instead of caching a
 * derived set) is what lets a settings change reach the next agent step.
 * @param config - the resolved entry config this host half was applied with.
 * @returns the current suppression set; empty when both switches are off.
 */
export function suppressedTools(config: ResolvedApplyPatchSettings): Set<string> {
  const hidden = new Set<string>()
  if (config.disableEdit.get()) hidden.add(BUILTIN_EDIT_TOOL)
  if (config.disableWrite.get()) hidden.add(BUILTIN_WRITE_TOOL)
  return hidden
}

/**
 * Install the per-agent restriction. Returns the disposer.
 *
 * Every live agent is tracked so a settings edit re-applies the restriction to
 * the agents that already exist; a new agent gets it when it is created. A
 * restriction that names a tool the composition never registers would throw, so
 * the install is guarded: hiding an unmounted tool is a no-op, never a reason to
 * fail agent creation.
 * @param ctx - plugin context carrying the agent lifecycle and settings events.
 * @param config - resolved volatile settings.
 * @returns the disposer removing every listener and restriction this call made.
 */
export function installToolSuppressor(ctx: Context, config: ResolvedApplyPatchSettings): () => void {
  /** Live agents this install has seen. */
  const agents = new Set<Agent>()
  /** The restriction currently applied to each agent. */
  const restrictions = new Map<Agent, () => void>()

  const lift = (agent: Agent): void => {
    restrictions.get(agent)?.()
    restrictions.delete(agent)
  }

  const refresh = (agent: Agent): void => {
    lift(agent)
    const hidden = [...suppressedTools(config)]
    if (hidden.length === 0) return
    // `agent.ctx` does not necessarily declare `tools` in its `inject` list, so
    // the optional accessor is the portable one; the service still resolves
    // against the accessing context, which is what makes the restriction scoped
    // to this agent.
    const tools = agent.ctx.get('tools')
    if (tools === undefined) return
    try {
      restrictions.set(agent, tools.restrict({ deny: hidden }))
    } catch (error) {
      ctx.logger?.warn?.(
        `dsh-apply-patch: could not restrict ${hidden.join(', ')} for this agent: ${String(error)}`,
      )
    }
  }

  const offCreated = ctx.on('agent/created', ({ agent }) => {
    agents.add(agent)
    // Own the bookkeeping through the agent's own effect so disposal cleans up
    // even while this plugin stays loaded.
    agent.ctx.effect(() => () => {
      agents.delete(agent)
      lift(agent)
    }, 'dsh-apply-patch: tool restriction')
    refresh(agent)
    return undefined
  })

  const offDisposed = ctx.on('agent/disposed', ({ agent }) => {
    agents.delete(agent)
    lift(agent)
  })

  // The settings plane writes volatile fields; a change republishes the
  // document of this namespace, which is the signal to re-derive the set.
  const offSettings = ctx.on('settings/document-updated', (ns) => {
    if (ns !== APPLY_PATCH_SETTINGS_NS) return
    for (const agent of agents) refresh(agent)
  })

  return () => {
    offCreated()
    offDisposed()
    offSettings()
    for (const dispose of restrictions.values()) dispose()
    restrictions.clear()
    agents.clear()
  }
}
