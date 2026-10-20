/**
 * Original work: Copyright (c) 2026 fonlan (MIT; see LICENSES/MIT.txt).
 * Modifications: Copyright (c) 2026 miaobuao.
 * Modified 2026-10-20: Codex compatibility and regression coverage.
 * This fork is distributed under GPL-3.0-or-later; see LICENSE and NOTICE.
 */
/**
 * Integration test: boot a real cordis context with the real DSH services
 * (tools registry, system-prompt assembly, settings, sandbox-policy,
 * sandboxed filesystem, observation policy) plus this plugin's apply, then
 * verify:
 *   1. the apply_patch tool is registered unconditionally (install = enable),
 *   2. the built-in file-editing tools are hidden according to the two switches,
 *   3. a full patch executes through the sandboxed fs seam (add/update/delete),
 *   4. sandbox denials surface as `[sandbox: ...]` errors (read-only mode).
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import { SandboxedFileSystem } from '@deepseek-ai/dsh-fs-sandbox'
import { SandboxBashExecutor } from '@deepseek-ai/dsh-bash-sandbox'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'
import { apply as applyObservationPolicy } from '@deepseek-ai/dsh-fs-observation-policy'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { apply as applyPlugin, readSuppressed } from '../src/index.js'
import { ApplyPatchSettingsSchema } from '../src/host/settings-schema.js'
import { APPLY_PATCH_TOOL_NAME, SUPPRESSIBLE_TOOLS } from '../src/host/injector.js'

/** Boot a composed context with the given sandbox mode + entry config. */
async function boot(workspace: string, mode: string, entryConfig: Record<string, unknown>) {
  const ctx = new Context()
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(LocalSandboxProvider, {})
  await ctx.plugin(SandboxPolicyService, { mode: mode as never, workspaceRoot: workspace })
  await ctx.plugin(SandboxedFileSystem, { cwd: workspace })
  await ctx.plugin(SandboxBashExecutor, {})
  await ctx.plugin(ToolRuntime, {})
  await ctx.plugin(SystemPrompt, {})
  // alpha.2: SandboxPolicyService registers a sandboxMode session projection,
  // so the projection registry service must exist before it activates.
  await ctx.plugin(SessionProjectionRegistry, {})
  await ctx.plugin(applyObservationPolicy)
  // dsh >= 0.1.7 wiring: the switches ride this entry's config, resolved
  // through the plugin's Config schema exactly as the loader does it (that
  // resolution turns each switch into a live volatile handle).
  await ctx.plugin({
    name: 'dsh-apply-patch',
    inject: ['tools', 'fs', 'systemPrompt', 'sandboxPolicy'],
    apply: (pluginCtx: Context) => applyPlugin(pluginCtx, ApplyPatchSettingsSchema(entryConfig) as never),
  } as never)
  return ctx
}

/** One simulated tool execution with a session cwd. */
function fakeExec(ctx: Context, cwd: string, signal = new AbortController().signal) {
  return {
    callId: 'test-call',
    name: APPLY_PATCH_TOOL_NAME,
    arguments: {},
    signal,
    agent: {
      id: 'test-agent',
      // dsh 0.2.0's session projections (sandboxPolicy.resolve reads the
      // session's `sandboxMode` cell) fold `session.snapshotEvents()` and
      // advance over `seq` / `eventAt`, so the fake carries that surface.
      // `events` stays for the pre-0.1.7 shape.
      session: {
        header: { cwd },
        events: [],
        inheritedEventCount: 0,
        seq: 0,
        snapshotEvents: () => [],
        eventAt: () => undefined,
      },
    },
  } as never
}

const suiteDir = mkdtempSync(join(tmpdir(), 'ap-integration-'))
const workspace = join(suiteDir, 'ws')
// A path OUTSIDE the workspace root AND outside tmpdir (the sandbox
// workspace-write policy explicitly allows /tmp writes).
const escapeDir = join(homedir(), '.dsh-apply-patch-escape-test')

before(() => {
  // Node's fs is used to PREPARE the workspace only; the tool itself only
  // mutates through the sandboxed fs seam.
  rmSync(workspace, { recursive: true, force: true })
  rmSync(escapeDir, { recursive: true, force: true })
})

after(() => {
  rmSync(suiteDir, { recursive: true, force: true })
})

describe('plugin apply', () => {
  it('registers the apply_patch tool', async () => {
    // Installing the plugin is enough: the tool is registered unconditionally,
    // and the switches only hide the built-in editing tools.
    const ctx = await boot(workspace, 'workspace-write', {})
    const names = ctx.tools.schemas().map((t: { name: string }) => t.name)
    assert.ok(names.includes(APPLY_PATCH_TOOL_NAME), `tool registered: ${names.join(', ')}`)
  })

  it('reads the switches out of the entry config, volatile handles included', async () => {
    // dsh >= 0.1.7 hands a `volatile()` field to apply() as a LIVE HANDLE
    // (`{ get() }`, non-enumerable, JSON `{}`), never as the value. Reading
    // `config.disableEdit` directly would therefore read a truthy object for
    // every state, so the switch could never be turned back off.
    const resolved = ApplyPatchSettingsSchema({ disableEdit: false, disableWrite: true }) as unknown as {
      disableEdit: unknown
      disableWrite: unknown
    }
    assert.equal(typeof resolved.disableEdit, 'object', 'the schema wraps the field in a cell')
    assert.ok(
      Symbol.for('cosmokit.volatile.write') in (resolved.disableEdit as object),
      'the cell carries cosmokit\'s registered symbol',
    )
    assert.deepEqual([...readSuppressed(resolved as never)], ['write'], 'cells are unwrapped')
    // Plain values (hand-built patches, hosts that resolve the config without
    // the volatile wrapper), defaults, and unusable values keep working.
    assert.deepEqual([...readSuppressed({ disableEdit: false, disableWrite: false })], [])
    assert.deepEqual([...readSuppressed(undefined)], ['edit', 'write'])
    assert.deepEqual([...readSuppressed({ disableEdit: 'nonsense' } as never)], ['edit', 'write'])
  })
})

describe('built-in tool suppression', () => {
  /**
   * Drive the REAL system-prompt/assemble waterfall with a synthetic assembly.
   *
   * The composed test context mounts no prompt tool list (that wiring lives in
   * plugins this scaffold does not boot), so `systemPrompt.assemble()` returns
   * an empty tool list. Emitting the waterfall with the built-in editing tools
   * plus apply_patch in the assembly exercises the plugin's own hook — which is
   * what decides which tools the model ends up seeing.
   */
  const BUILTIN = ['edit', 'write'] as const

  async function assembleTools(ctx: Context): Promise<string[]> {
    const assembly = {
      tools: [
        { name: APPLY_PATCH_TOOL_NAME },
        { name: 'read' },
        ...BUILTIN.map((name) => ({ name })),
      ],
    }
    const out = await ctx.waterfall(
      'system-prompt/assemble',
      assembly as never,
      { agent: undefined } as never,
      () => Promise.resolve(assembly as never),
    )
    return (out as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name)
  }

  it('hides both built-in editing tools by default', async () => {
    const ctx = await boot(workspace, 'workspace-write', {})
    assert.deepEqual(await assembleTools(ctx), [APPLY_PATCH_TOOL_NAME, 'read'])
  })

  it('keeps the built-in tools when both switches are off', async () => {
    const ctx = await boot(workspace, 'workspace-write', { disableEdit: false, disableWrite: false })
    assert.deepEqual(await assembleTools(ctx), [APPLY_PATCH_TOOL_NAME, 'read', 'edit', 'write'])
  })

  it('suppresses each built-in tool independently', async () => {
    const ctx = await boot(workspace, 'workspace-write', { disableEdit: true, disableWrite: false })
    assert.deepEqual(await assembleTools(ctx), [APPLY_PATCH_TOOL_NAME, 'read', 'write'])
    assert.deepEqual([...SUPPRESSIBLE_TOOLS], ['edit', 'write'])
  })

  /** Register a stub built-in editing tool so a call has a body to deny or run. */
  function registerStubTool(ctx: Context, name: string): void {
    ctx.tools.register(defineTool({
      name,
      description: `stub ${name} tool`,
      parameters: {},
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      async execute() {
        return `${name} executed`
      },
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

  it('denies execution when the model names a hidden tool directly', async () => {
    // The assembly filter hides `edit` from the model's tool list, but the
    // registry still holds the definition: the host resolves a call by name, so
    // without the execution guard a model that emits `edit` anyway would run it.
    const ctx = await boot(workspace, 'workspace-write', {})
    registerStubTool(ctx, 'edit')
    const denied = await callTool(ctx, 'edit')
    assert.equal(denied.isError, true)
    assert.match(denied.text, /hidden by dsh-apply-patch/)
  })

  it('runs the built-in tool again when its switch is off', async () => {
    const ctx = await boot(workspace, 'workspace-write', { disableEdit: false, disableWrite: false })
    registerStubTool(ctx, 'edit')
    const allowed = await callTool(ctx, 'edit')
    assert.equal(allowed.isError, false)
    assert.match(allowed.text, /edit executed/)
  })
})

describe('end-to-end patch application (sandboxed fs)', () => {
  it('adds, updates, and deletes files through the sandbox seam', async () => {
    const ctx = await boot(workspace, 'workspace-write', {})
    // Prepare via the SANDBOXED fs (not node fs) to stay faithful.
    const target = await ctx.fs.resolve('hello.py', { cwd: workspace })
    const info = await ctx.fs.stat(target)
    if (info === undefined) {
      const intent = await ctx.waterfall('fs/write-intent', target, undefined, () => undefined)
      await ctx.fs.writeText(target, 'print("hello")\n', intent)
      ctx.emit('fs/observed', target, { kind: 'present', version: (await ctx.fs.stat(target))!.version }, undefined)
    }
    const writeIntentFor = async (path: string) => {
      const t = await ctx.fs.resolve(path, { cwd: workspace })
      return { target: t, intent: await ctx.waterfall('fs/write-intent', t, undefined, () => undefined) }
    }

    // Find the tool definition and execute it with a fake exec.
    const def = ctx.tools.schemas().find((t) => t.name === APPLY_PATCH_TOOL_NAME) as never
    const exec = fakeExec(ctx, workspace)
    const run = async (patch: string) => {
      const tool = (ctx.tools as unknown as { get(name: string): { execute(args: unknown, exec: unknown): Promise<string> } }).get(APPLY_PATCH_TOOL_NAME)
      return tool.execute({ patch }, exec)
    }

    // Add a new file.
    const addOut = await run([
      '*** Begin Patch',
      '*** Add File: new.py',
      '+x = 1',
      '+y = 2',
      '*** End Patch',
    ].join('\n'))
    assert.match(addOut, /Success\. Updated the following files:\nA .*new\.py/)

    // Codex Add File overwrites existing content through the same sandbox seam.
    await run('*** Begin Patch\n*** Add File: new.py\n+overwritten\n*** End Patch')
    assert.equal(await ctx.fs.readText(await ctx.fs.resolve('new.py', { cwd: workspace })), 'overwritten\n')

    // Update hello.py.
    const updOut = await run([
      '*** Begin Patch',
      '*** Update File: hello.py',
      '@@',
      '-print("hello")',
      '+print("hello, world")',
      '*** End Patch',
    ].join('\n'))
    assert.match(updOut, /M .*hello\.py/)
    const after = await ctx.fs.readText(await ctx.fs.resolve('hello.py', { cwd: workspace }))
    assert.equal(after, 'print("hello, world")\n')

    // Delete the new file.
    const delOut = await run([
      '*** Begin Patch',
      '*** Delete File: new.py',
      '*** End Patch',
    ].join('\n'))
    assert.match(delOut, /D .*new\.py/)
    assert.equal(await ctx.fs.stat(await ctx.fs.resolve('new.py', { cwd: workspace })), undefined)


  })

  it('rejects a patch whose context does not match', async () => {
    const ctx = await boot(workspace, 'workspace-write', {})
    const tool = (ctx.tools as unknown as { get(name: string): { execute(args: unknown, exec: unknown): Promise<string> } }).get(APPLY_PATCH_TOOL_NAME)
    await assert.rejects(
      tool.execute({ patch: [
        '*** Begin Patch',
        '*** Update File: hello.py',
        '@@',
        '-print("nope")',
        '+print("x")',
        '*** End Patch',
      ].join('\n') }, fakeExec(ctx, workspace)),
      /Failed to find expected lines/,
    )

  })

  it('surfaces sandbox denials as [sandbox: ...] under read-only', async () => {
    const ctx = await boot(workspace, 'read-only', {})
    const tool = (ctx.tools as unknown as { get(name: string): { execute(args: unknown, exec: unknown): Promise<string> } }).get(APPLY_PATCH_TOOL_NAME)
    await assert.rejects(
      tool.execute({ patch: [
        '*** Begin Patch',
        '*** Add File: denied.py',
        '+x = 1',
        '*** End Patch',
      ].join('\n') }, fakeExec(ctx, workspace)),
      /sandbox: file access denied under read-only mode/,
    )

  })

  it('rejects writes outside the workspace root under workspace-write', async () => {
    const ctx = await boot(workspace, 'workspace-write', {})
    const tool = (ctx.tools as unknown as { get(name: string): { execute(args: unknown, exec: unknown): Promise<string> } }).get(APPLY_PATCH_TOOL_NAME)
    await assert.rejects(
      tool.execute({ patch: [
        '*** Begin Patch',
        `*** Add File: ${escapeDir}/escape.py`,
        '+x = 1',
        '*** End Patch',
      ].join('\n') }, fakeExec(ctx, workspace)),
      /sandbox: file access denied/,
    )

  })
})
