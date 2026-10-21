/**
 * Suppression tests: hiding a built-in editing tool must work for every layer the
 * tool may be registered in.
 *
 * This is the regression suite for the failure below: a restrict-based
 * implementation only masks INHERITED GLOBAL tools, while a shipped deployment
 * mounts `tool-fs` from the agent preset, so `edit` / `write` are scope-local and
 * were left completely visible. The hooks are name-based instead, and these tests
 * pin the three surfaces the model actually touches: the assembled tool list, the
 * assembled guidance sections, and execution.
 */
import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import type { PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import {
  APPLY_PATCH_TOOL_NAME,
  SUPPRESSIBLE_TOOLS,
  installToolGuard,
  installToolSuppressor,
  suppressedToolDenial,
  suppressedTools,
  withoutHiddenTools,
} from '../src/host/injector.js'
import { ApplyPatchSettingsSchema, type ResolvedApplyPatchSettings } from '../src/host/settings-schema.js'

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
    setDisableEdit(next: boolean) { values.disableEdit = next },
    setDisableWrite(next: boolean) { values.disableWrite = next },
  }
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
 * A synthetic assembly: the plugin's own tool, the built-ins, and one unrelated
 * tool plus guidance sections named the way `dsh-tool-fs` names them.
 */
function assemblyFixture(): PromptAssembly {
  return {
    tools: [
      { name: APPLY_PATCH_TOOL_NAME },
      { name: 'read' },
      ...SUPPRESSIBLE_TOOLS.map((name) => ({ name })),
    ],
    sections: [
      { name: 'identity', text: 'identity' },
      { name: 'tool:read', text: 'read guidance' },
      ...SUPPRESSIBLE_TOOLS.map((name) => ({ name: `tool:${name}`, text: `${name} guidance` })),
      { name: 'sandbox', text: 'sandbox guidance' },
    ],
    contexts: [],
    variables: {},
  } as never
}

/** Drive the real `system-prompt/assemble` waterfall with one assembly. */
async function runAssembly(ctx: Context, assembly: PromptAssembly): Promise<PromptAssembly> {
  return await ctx.waterfall(
    'system-prompt/assemble',
    assembly,
    { agent: undefined } as never,
    () => Promise.resolve(assembly),
  ) as never
}

/** Tool or section names, in assembly order. */
function names(items: Array<{ name: string }>): string[] {
  return items.map((item) => item.name)
}

describe('suppressedTools', () => {
  it('reads the live handles on every call instead of caching a set', () => {
    const live = liveConfig({ disableEdit: true, disableWrite: true })
    assert.deepEqual([...suppressedTools(live.config)], ['edit', 'write'])
    live.setDisableEdit(false)
    assert.deepEqual([...suppressedTools(live.config)], ['write'])
    live.setDisableWrite(false)
    assert.deepEqual([...suppressedTools(live.config)], [])
  })
})

describe('withoutHiddenTools', () => {
  it('drops hidden tools and their guidance sections', () => {
    const out = withoutHiddenTools(assemblyFixture(), new Set(['edit', 'write']))
    assert.deepEqual(names(out.tools), [APPLY_PATCH_TOOL_NAME, 'read'])
    assert.deepEqual(names(out.sections), ['identity', 'tool:read', 'sandbox'])
  })

  it('returns the same assembly when nothing is hidden', () => {
    const fixture = assemblyFixture()
    assert.equal(withoutHiddenTools(fixture, new Set()), fixture)
  })

  it('returns the same assembly when a hidden tool never appears', () => {
    const fixture = { tools: [{ name: 'read' }], sections: [], contexts: [], variables: {} } as never
    assert.equal(withoutHiddenTools(fixture, new Set(['edit'])), fixture)
  })
})

describe('assembly hook', () => {
  it('hides both built-in editing tools by default', async () => {
    const ctx = await boot()
    installToolSuppressor(ctx, liveConfig().config)
    const out = await runAssembly(ctx, assemblyFixture())
    assert.deepEqual(names(out.tools), [APPLY_PATCH_TOOL_NAME, 'read'])
    assert.deepEqual(names(out.sections), ['identity', 'tool:read', 'sandbox'])
  })

  it('suppresses each switch independently', async () => {
    const ctx = await boot()
    installToolSuppressor(ctx, liveConfig({ disableEdit: true, disableWrite: false }).config)
    const out = await runAssembly(ctx, assemblyFixture())
    assert.deepEqual(names(out.tools), [APPLY_PATCH_TOOL_NAME, 'read', 'write'])
    assert.deepEqual(names(out.sections), ['identity', 'tool:read', 'tool:write', 'sandbox'])
  })

  it('follows a flip without a re-install', async () => {
    const ctx = await boot()
    const live = liveConfig()
    installToolSuppressor(ctx, live.config)
    assert.deepEqual(names((await runAssembly(ctx, assemblyFixture())).tools), [APPLY_PATCH_TOOL_NAME, 'read'])
    live.setDisableEdit(false)
    assert.deepEqual(names((await runAssembly(ctx, assemblyFixture())).tools), [APPLY_PATCH_TOOL_NAME, 'read', 'edit'])
  })

  it('leaves the assembly untouched when both switches are off', async () => {
    const ctx = await boot()
    installToolSuppressor(ctx, liveConfig({ disableEdit: false, disableWrite: false }).config)
    const fixture = assemblyFixture()
    assert.equal(await runAssembly(ctx, fixture), fixture)
  })
})

describe('execution guard', () => {
  /** Register a stub tool so a call has a body to deny or run. */
  function registerStubTool(ctx: Context, name: string): void {
    ctx.tools.register(defineTool({
      name,
      description: `stub ${name} tool`,
      parameters: {},
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      async execute() { return `${name} executed` },
    }))
  }

  /** Call a tool through the registry's public execution path (guards included). */
  async function callTool(ctx: Context, name: string): Promise<{ text: string; isError: boolean }> {
    const result = await ctx.tools.execute({
      callId: `${name}-call`,
      name,
      arguments: {},
      signal: new AbortController().signal,
    } as never)
    return {
      text: result.content.map((block) => block.type === 'text' ? block.text : '').join(''),
      isError: result.isError,
    }
  }

  it('denies a suppressed tool by name and allows the rest', async () => {
    const ctx = await boot()
    registerStubTool(ctx, 'edit')
    installToolGuard(ctx, liveConfig().config)
    const denied = await callTool(ctx, 'edit')
    assert.equal(denied.isError, true)
    assert.match(denied.text, /tool "edit" is hidden by dsh-apply-patch; use apply_patch instead/)
    assert.equal(suppressedToolDenial(new Set(['edit']), 'read'), undefined)
  })

  it('runs the tool again when its switch is off', async () => {
    const ctx = await boot()
    registerStubTool(ctx, 'edit')
    installToolGuard(ctx, liveConfig({ disableEdit: false }).config)
    const allowed = await callTool(ctx, 'edit')
    assert.equal(allowed.isError, false)
    assert.match(allowed.text, /edit executed/)
  })

  it('follows a flip without a re-install', async () => {
    const ctx = await boot()
    registerStubTool(ctx, 'edit')
    const live = liveConfig()
    installToolGuard(ctx, live.config)
    assert.equal((await callTool(ctx, 'edit')).isError, true)
    live.setDisableEdit(false)
    assert.equal((await callTool(ctx, 'edit')).isError, false)
  })
})

describe('deployment shapes', () => {
  it('hides a tool registered in an agent scope, not only a global one', async () => {
    // The shipped presets mount `tool-fs` per agent, so its tools are
    // scope-local. A restriction cannot mask those; the assembly filter must.
    const ctx = await boot()
    installToolSuppressor(ctx, liveConfig().config)
    const scoped = ctx.plugin({ name: 'preset-like', inject: ['tools'], apply(scopeCtx: Context) {
      for (const name of SUPPRESSIBLE_TOOLS) {
        scopeCtx.tools.register(defineTool({
          name,
          description: `scoped ${name}`,
          parameters: {},
          output: { schema: { type: 'string' }, render: (_a, value) => [{ type: 'text', text: value }] },
          async execute() { return `${name} executed` },
        }))
      }
    } })
    await scoped
    assert.ok(ctx.tools.get('edit'), 'the scoped tool is visible in its own scope')
    const out = await runAssembly(ctx, assemblyFixture())
    assert.deepEqual(names(out.tools), [APPLY_PATCH_TOOL_NAME, 'read'], 'the assembly carries neither hidden tool')
  })

  it('reads the real schema defaults', () => {
    const resolved = ApplyPatchSettingsSchema({})
    assert.deepEqual([...suppressedTools(resolved)], ['edit', 'write'])
    assert.deepEqual([...suppressedTools(ApplyPatchSettingsSchema({ disableEdit: false }))], ['write'])
  })
})
