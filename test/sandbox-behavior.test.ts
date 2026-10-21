/**
 * Behavioral regression tests for the applier's sandbox/observation contract.
 *
 * These boot a real cordis context with the real DSH services (sandbox policy,
 * sandboxed fs, observation policy, tool registry, system prompt) and drive
 * apply_patch through the registry, so the tests exercise the same seams the
 * host uses:
 *   - a failed hunk must not record a read observation,
 *   - a successful update must record one,
 *   - strict overwrite mode must require a prior read for Add/Delete,
 *   - Move reports its destination and a self-move is an in-place update,
 *   - a partial failure reports what already changed.
 *
 * Shell-backed tests boot `danger-full-access` so the sandboxed `rm` runs
 * everywhere: a host without a usable OS sandbox backend (for example macOS
 * without sandbox-exec permission) refuses `workspace-write` shell commands.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { AgentRegistry } from '@deepseek-ai/dsh-agent'
import type { Plugin } from '@deepseek-ai/cordis'
import { apply as applyObservationPolicy } from '@deepseek-ai/dsh-fs-observation-policy'
import { SandboxedFileSystem } from '@deepseek-ai/dsh-fs-sandbox'
import { SandboxBashExecutor } from '@deepseek-ai/dsh-bash-sandbox'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'
import { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { apply as applyPlugin, inject as pluginInject } from '../src/index.js'
import { ApplyPatchSettingsSchema } from '../src/host/settings-schema.js'
import { APPLY_PATCH_TOOL_NAME } from '../src/host/injector.js'

/** Boot a composed context and apply the plugin with the given entry config. */
async function boot(workspace: string, mode: string, entryConfig: Record<string, unknown>): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(LocalSandboxProvider, {})
  await ctx.plugin(SandboxPolicyService, { mode: mode as never, workspaceRoot: workspace })
  await ctx.plugin(SandboxedFileSystem, { cwd: workspace })
  await ctx.plugin(SandboxBashExecutor, {})
  await ctx.plugin(ToolRuntime, {})
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(applyObservationPolicy)
  await ctx.plugin({
    name: 'dsh-apply-patch',
    // The plugin's own dependency list, so a missing inject entry fails here.
    inject: [...pluginInject],
    apply: (pluginCtx: Context) => applyPlugin(pluginCtx, ApplyPatchSettingsSchema(entryConfig) as never),
  } satisfies Plugin)
  return ctx
}

/** One simulated tool execution with a session (the observation policy's owner). */
function fakeExec(workspace: string) {
  return {
    callId: 'test-call',
    name: APPLY_PATCH_TOOL_NAME,
    arguments: {},
    signal: new AbortController().signal,
    agent: {
      id: 'test-agent',
      session: {
        header: { cwd: workspace },
        events: [],
        inheritedEventCount: 0,
        seq: 0,
        snapshotEvents: () => [],
        eventAt: () => undefined,
      },
    },
  } as never
}

/** Execute one patch through the registered tool. */
async function runPatch(ctx: Context, exec: never, patch: string): Promise<string> {
  const tool = (ctx.tools as unknown as {
    get(name: string): { execute(args: unknown, exec: unknown): Promise<string> }
  }).get(APPLY_PATCH_TOOL_NAME)
  return tool.execute({ patch }, exec)
}

/** Resolve the write intent the observation policy would hand a real write. */
async function writeIntentKind(ctx: Context, workspace: string, path: string, exec: never) {
  const target = await ctx.fs.resolve(path, { cwd: workspace })
  const intent = await ctx.waterfall('fs/write-intent', target, exec, () => undefined)
  return intent
}

const dirs: string[] = []
function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ap-behavior-'))
  dirs.push(dir)
  return dir
}
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

describe('observation lifecycle', () => {
  it('does not record a read when the hunk fails to match', async () => {
    const ws = workspace()
    writeFileSync(join(ws, 'f.txt'), 'hello\n')
    const ctx = await boot(ws, 'workspace-write', {})
    const exec = fakeExec(ws)
    await assert.rejects(
      runPatch(ctx, exec, '*** Begin Patch\n*** Update File: f.txt\n@@\n-missing\n+x\n*** End Patch'),
      /Failed to find expected lines/,
    )
    const intent = await writeIntentKind(ctx, ws, 'f.txt', exec)
    assert.equal(intent?.kind, 'createIfAbsent', 'a failed patch must not make the file count as read')
  })

  it('records the read and the resulting version after a successful update', async () => {
    const ws = workspace()
    writeFileSync(join(ws, 'f.txt'), 'hello\n')
    const ctx = await boot(ws, 'workspace-write', {})
    const exec = fakeExec(ws)
    await runPatch(ctx, exec, '*** Begin Patch\n*** Update File: f.txt\n@@\n-hello\n+updated\n*** End Patch')
    const intent = await writeIntentKind(ctx, ws, 'f.txt', exec)
    assert.equal(intent?.kind, 'replaceIfVersion')
    const target = await ctx.fs.resolve('f.txt', { cwd: ws })
    assert.equal(intent?.kind === 'replaceIfVersion' && intent.version, (await ctx.fs.stat(target))?.version)
  })
})

describe('allowUnobservedOverwrite', () => {
  it('rejects Add File over an unread file when strict', async () => {
    const ws = workspace()
    writeFileSync(join(ws, 'f.txt'), 'original\n')
    const ctx = await boot(ws, 'workspace-write', { allowUnobservedOverwrite: false })
    const exec = fakeExec(ws)
    await assert.rejects(
      runPatch(ctx, exec, '*** Begin Patch\n*** Add File: f.txt\n+replaced\n*** End Patch'),
      /allowUnobservedOverwrite/,
    )
    assert.equal(readFileSync(join(ws, 'f.txt'), 'utf8'), 'original\n')
  })

  it('allows the overwrite after the model read the file', async () => {
    const ws = workspace()
    writeFileSync(join(ws, 'f.txt'), 'original\n')
    const ctx = await boot(ws, 'workspace-write', { allowUnobservedOverwrite: false })
    const exec = fakeExec(ws)
    const target = await ctx.fs.resolve('f.txt', { cwd: ws })
    ctx.emit('fs/observed', target, { kind: 'present', version: (await ctx.fs.stat(target))!.version }, exec)
    await runPatch(ctx, exec, '*** Begin Patch\n*** Add File: f.txt\n+replaced\n*** End Patch')
    assert.equal(readFileSync(join(ws, 'f.txt'), 'utf8'), 'replaced\n')
  })

  it('keeps Codex overwrite semantics by default', async () => {
    const ws = workspace()
    writeFileSync(join(ws, 'f.txt'), 'original\n')
    const ctx = await boot(ws, 'workspace-write', {})
    const exec = fakeExec(ws)
    await runPatch(ctx, exec, '*** Begin Patch\n*** Add File: f.txt\n+replaced\n*** End Patch')
    assert.equal(readFileSync(join(ws, 'f.txt'), 'utf8'), 'replaced\n')
  })

  it('rejects deleting an unread file when strict, allows it after a read', async () => {
    const ws = workspace()
    writeFileSync(join(ws, 'f.txt'), 'x\n')
    const ctx = await boot(ws, 'danger-full-access', { allowUnobservedOverwrite: false })
    const exec = fakeExec(ws)
    await assert.rejects(
      runPatch(ctx, exec, '*** Begin Patch\n*** Delete File: f.txt\n*** End Patch'),
      /not read first/,
    )
    assert.equal(existsSync(join(ws, 'f.txt')), true)
    const target = await ctx.fs.resolve('f.txt', { cwd: ws })
    ctx.emit('fs/observed', target, { kind: 'present', version: (await ctx.fs.stat(target))!.version }, exec)
    await runPatch(ctx, exec, '*** Begin Patch\n*** Delete File: f.txt\n*** End Patch')
    assert.equal(existsSync(join(ws, 'f.txt')), false)
  })

  it('deletes an unread file by default (Codex semantics)', async () => {
    const ws = workspace()
    writeFileSync(join(ws, 'f.txt'), 'x\n')
    const ctx = await boot(ws, 'danger-full-access', {})
    await runPatch(ctx, fakeExec(ws), '*** Begin Patch\n*** Delete File: f.txt\n*** End Patch')
    assert.equal(existsSync(join(ws, 'f.txt')), false)
  })
})

describe('move semantics', () => {
  it('reports the destination path and removes the source', async () => {
    const ws = workspace()
    writeFileSync(join(ws, 'a.txt'), 'old\n')
    const ctx = await boot(ws, 'danger-full-access', {})
    const out = await runPatch(ctx, fakeExec(ws), [
      '*** Begin Patch',
      '*** Update File: a.txt',
      '*** Move to: b.txt',
      '@@',
      '-old',
      '+new',
      '*** End Patch',
    ].join('\n'))
    assert.match(out, /M .*b\.txt/)
    assert.doesNotMatch(out, /M .*a\.txt/)
    assert.equal(existsSync(join(ws, 'a.txt')), false)
    assert.equal(readFileSync(join(ws, 'b.txt'), 'utf8'), 'new\n')
  })

  it('treats a move onto the same path as an in-place update', async () => {
    const ws = workspace()
    writeFileSync(join(ws, 'a.txt'), 'old\n')
    const ctx = await boot(ws, 'danger-full-access', {})
    const out = await runPatch(ctx, fakeExec(ws), [
      '*** Begin Patch',
      '*** Update File: a.txt',
      '*** Move to: ./a.txt',
      '@@',
      '-old',
      '+new',
      '*** End Patch',
    ].join('\n'))
    assert.match(out, /M .*a\.txt/)
    assert.equal(readFileSync(join(ws, 'a.txt'), 'utf8'), 'new\n', 'self-move must not delete the file')
  })

  it('creates the destination directory when the move target is nested', async () => {
    const ws = workspace()
    writeFileSync(join(ws, 'a.txt'), 'old\n')
    const ctx = await boot(ws, 'danger-full-access', {})
    await runPatch(ctx, fakeExec(ws), [
      '*** Begin Patch',
      '*** Update File: a.txt',
      '*** Move to: nested/b.txt',
      '@@',
      '-old',
      '+new',
      '*** End Patch',
    ].join('\n'))
    assert.equal(readFileSync(join(ws, 'nested', 'b.txt'), 'utf8'), 'new\n')
    assert.equal(existsSync(join(ws, 'a.txt')), false)
  })
})

describe('shell quoting and backend fidelity', () => {
  it('deletes a name that needs shell quoting', async () => {
    const ws = workspace()
    const name = "it's a file ü.txt"
    writeFileSync(join(ws, name), 'x\n')
    const ctx = await boot(ws, 'danger-full-access', {})
    const out = await runPatch(ctx, fakeExec(ws), `*** Begin Patch\n*** Delete File: ${name}\n*** End Patch`)
    assert.match(out, /D .*it's a file ü\.txt/)
    assert.equal(existsSync(join(ws, name)), false)
  })

  it('preserves CRLF through the real backend', async () => {
    const ws = workspace()
    writeFileSync(join(ws, 'w.txt'), 'one\r\ntwo\r\n')
    const ctx = await boot(ws, 'danger-full-access', {})
    await runPatch(ctx, fakeExec(ws), '*** Begin Patch\n*** Update File: w.txt\n@@\n-two\n+TWO\n*** End Patch')
    assert.equal(readFileSync(join(ws, 'w.txt'), 'utf8'), 'one\r\nTWO\r\n')
  })

  it('writes through a symbolic link to its target', async () => {
    const ws = workspace()
    writeFileSync(join(ws, 'real.txt'), 'v1\n')
    symlinkSync(join(ws, 'real.txt'), join(ws, 'link.txt'))
    const ctx = await boot(ws, 'danger-full-access', {})
    await runPatch(ctx, fakeExec(ws), '*** Begin Patch\n*** Update File: link.txt\n@@\n-v1\n+v2\n*** End Patch')
    assert.equal(readFileSync(join(ws, 'real.txt'), 'utf8'), 'v2\n')
    assert.equal(readFileSync(join(ws, 'link.txt'), 'utf8'), 'v2\n')
  })
})

describe('partial failure reporting', () => {
  it('names the changes that already landed', async () => {
    const ws = workspace()
    const ctx = await boot(ws, 'workspace-write', {})
    await assert.rejects(
      runPatch(ctx, fakeExec(ws), [
        '*** Begin Patch',
        '*** Add File: created.txt',
        '+hello',
        '*** Update File: missing.txt',
        '@@',
        '-old',
        '+new',
        '*** End Patch',
      ].join('\n')),
      (error: unknown) => {
        assert.ok(error instanceof Error)
        assert.match(error.message, /Applied before the failure:\nA .*created\.txt/)
        return true
      },
    )
    assert.equal(existsSync(join(ws, 'created.txt')), true)
  })
})
