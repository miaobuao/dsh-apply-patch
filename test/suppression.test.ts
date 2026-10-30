/**
 * Suppression tests: hiding a built-in editing tool must work for the layer the
 * tool is actually registered in.
 *
 * A shipped deployment mounts `@deepseek-ai/dsh-tool-fs` from the agent preset,
 * not from the host tree. That is still restrictable: the preset registry mints a
 * generation scope per revision and binds the agent scope key as its CHILD, so
 * `tools.view(agent)` reads preset registrations as inherited. This suite pins
 * that behaviour, because the plugin previously assumed the opposite and shipped
 * a `system-prompt/assemble` filter that broke on dsh 0.2.2.
 */
import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { installToolSuppressor, suppressedTools } from '../src/host/injector.js'
import type { ResolvedApplyPatchSettings } from '../src/host/settings-schema.js'
import { APPLY_PATCH_SETTINGS_NS } from '../src/shared/constants.js'

const roots: Context[] = []
afterEach(async () => { for (const ctx of roots.splice(0)) await ctx.fiber.dispose() })

/** A resolved config whose volatile handles can be flipped by the test. */
function liveConfig(initial: Record<string, boolean> = {}) {
  const values = {
    disableEdit: initial.disableEdit ?? true,
    disableWrite: initial.disableWrite ?? true,
    allowUnobservedOverwrite: initial.allowUnobservedOverwrite ?? true,
  }
  const config: ResolvedApplyPatchSettings = {
    disableEdit: { get: () => values.disableEdit },
    disableWrite: { get: () => values.disableWrite },
    allowUnobservedOverwrite: { get: () => values.allowUnobservedOverwrite },
  }
  return {
    config,
    set(next: Partial<typeof values>) { Object.assign(values, next) },
  }
}

/** Every tool definition here is a stand-in; only the name matters. */
function tool(name: string) {
  return defineTool({
    name,
    description: name,
    parameters: {},
    output: { schema: { type: 'string' }, render: () => [] },
    async execute() { return 'ok' },
  })
}

/** Boot the two host services the hooks touch. */
async function boot(): Promise<Context> {
  const ctx = new Context()
  roots.push(ctx)
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime, {})
  return ctx
}

/**
 * Compose what a preset-mounted tool-fs produces: a parent scope holding the
 * tools, and an agent scope bound underneath it.
 */
async function compose(ctx: Context, names: string[] = ['edit', 'write']) {
  const presetKey = {}
  const preset = createScope(ctx, presetKey)
  const presetTools = preset.ctx.get('tools')!
  for (const name of names) presetTools.register(tool(name))
  const agentKey = {}
  const agent = createScope(ctx, agentKey, { parent: presetKey })
  return { presetKey, agentKey, agentCtx: agent.ctx }
}

describe('restrict across the preset scope', () => {
  it('hides a parent-scope tool from the agent view while leaving the preset view intact', async () => {
    const ctx = await boot()
    const { presetKey, agentKey, agentCtx } = await compose(ctx)

    assert.notEqual(ctx.tools.get('edit', agentKey), undefined, 'visible before the restriction')

    const lift = agentCtx.get('tools')!.restrict({ deny: ['edit', 'write'] })

    assert.equal(ctx.tools.get('edit', agentKey), undefined)
    assert.equal(ctx.tools.get('write', agentKey), undefined)
    assert.notEqual(ctx.tools.get('edit', presetKey), undefined, 'the preset scope still resolves it')

    lift()
    assert.notEqual(ctx.tools.get('edit', agentKey), undefined, 'lifting restores the tool')
  })

  it('names only tools the composition actually mounts', async () => {
    const ctx = await boot()
    const { agentKey, agentCtx } = await compose(ctx, ['edit'])

    // `write` is absent: naming it throws, which is why the plugin guards the
    // install instead of letting it reach agent creation.
    assert.throws(() => agentCtx.get('tools')!.restrict({ deny: ['edit', 'write'] }), /unknown global tool/)
    assert.notEqual(ctx.tools.get('edit', agentKey), undefined, 'the failed restriction hides nothing')
  })
})

describe('installToolSuppressor', () => {
  it('restricts on agent creation, follows the live switches, and lifts on dispose', async () => {
    const ctx = await boot()
    const { agentKey, agentCtx } = await compose(ctx)
    const live = liveConfig()
    const fakeAgent = { ctx: agentCtx } as unknown as Agent

    const stop = installToolSuppressor(ctx, live.config)
    ctx.emit('agent/created', { agent: fakeAgent } as never)

    assert.equal(ctx.tools.get('edit', agentKey), undefined, 'hidden once the agent exists')
    assert.equal(ctx.tools.get('write', agentKey), undefined)

    live.set({ disableEdit: false })
    ctx.emit('settings/document-updated', APPLY_PATCH_SETTINGS_NS as never, 2 as never)

    assert.notEqual(ctx.tools.get('edit', agentKey), undefined, 'a flipped switch returns edit')
    assert.equal(ctx.tools.get('write', agentKey), undefined, 'the other switch still hides write')

    live.set({ disableEdit: true, disableWrite: false })
    ctx.emit('settings/document-updated', APPLY_PATCH_SETTINGS_NS as never, 3 as never)
    assert.equal(ctx.tools.get('edit', agentKey), undefined)
    assert.notEqual(ctx.tools.get('write', agentKey), undefined)

    stop()
    assert.notEqual(ctx.tools.get('write', agentKey), undefined, 'disposing the install lifts everything')
  })

  it('never breaks agent creation when the composition mounts no such tool', async () => {
    const ctx = await boot()
    const agentKey = {}
    const agent = createScope(ctx, agentKey)
    const live = liveConfig()
    const fakeAgent = { ctx: agent.ctx } as unknown as Agent

    const stop = installToolSuppressor(ctx, live.config)
    assert.doesNotThrow(() => ctx.emit('agent/created', { agent: fakeAgent } as never))
    stop()
  })
})

describe('suppressedTools', () => {
  it('reads the live handles on every call instead of caching a set', () => {
    const live = liveConfig({ disableEdit: true, disableWrite: true })
    assert.deepEqual([...suppressedTools(live.config)], ['edit', 'write'])
    live.set({ disableEdit: false })
    assert.deepEqual([...suppressedTools(live.config)], ['write'])
    live.set({ disableWrite: false })
    assert.deepEqual([...suppressedTools(live.config)], [])
  })
})
