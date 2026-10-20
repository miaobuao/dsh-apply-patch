import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import { SandboxedFileSystem } from '@deepseek-ai/dsh-fs-sandbox'
import { SandboxBashExecutor } from '@deepseek-ai/dsh-bash-sandbox'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'
import { apply as applyObservationPolicy } from '@deepseek-ai/dsh-fs-observation-policy'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { apply as applyPlugin } from './src/index.js'
import { ApplyPatchSettingsSchema } from './src/host/settings-schema.js'

const ws = mkdtempSync(join(tmpdir(), 'ap-dbg-'))
const ctx = new Context()
await ctx.plugin(LocalSubprocessRuntime)
await ctx.plugin(LocalSandboxProvider, {})
await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write' as never, workspaceRoot: ws })
await ctx.plugin(SandboxedFileSystem, { cwd: ws })
await ctx.plugin(SandboxBashExecutor, {})
await ctx.plugin(ToolRuntime, {})
await ctx.plugin(SystemPrompt, {})
await ctx.plugin(applyObservationPolicy)
// Same wiring as the loader: the entry config passes through the Config schema,
// which turns both switches into live volatile handles.
const resolvedConfig = ApplyPatchSettingsSchema({ disableEdit: true, disableWrite: true })
const fiber = await ctx.plugin({
  name: 'dsh-apply-patch',
  inject: ['tools', 'fs', 'systemPrompt', 'sandboxPolicy'],
  apply: (pluginCtx: Context) => applyPlugin(pluginCtx, resolvedConfig as never),
})
console.log('plugin() returned:', typeof fiber, (fiber as any)?.constructor?.name)
await new Promise(r => setTimeout(r, 300))
const f = (fiber as any)?.fiber ?? fiber
console.log('fiber state:', (f as any)?.state)
console.log('fiber error:', (f as any)?.error)
console.log('tools:', (ctx as any).tools?.schemas?.().map((t: any) => t.name))
process.exit(0)
