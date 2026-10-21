/**
 * Typed stand-ins for the Client runtime surfaces this bundle imports.
 *
 * Neither type is exported by an installed package: `ctx.slots` is provided by
 * the Web shell's `dsh-client-runtime`, and the owner props of each slot are
 * declared by the plugin that renders it. Each declaration below therefore
 * restates the exact contract the runtime honours (verified against
 * `SlotCore.register` / `SlotCore.entriesOfSlot` in
 * `@deepseek-ai/dsh-client-ui-slots` and the live `Slots.listSubTree` catalog),
 * so the plugin never needs a cast to reach them.
 *
 * `tool.call.toolview` is the keyed per-Tool-name view slot owned by
 * `@deepseek-ai/dsh-client-ui-tool`; its owner payload is restated in
 * `./tool-contract.ts` and registered under the `apply_patch` key.
 *
 * zh is the key source of truth for the locale namespace; en must carry the
 * exact same key set (enforced by `LocaleDictOf` at the typed `register` site
 * and by the locale registry at runtime).
 */
import type { zh, toolZh } from './locales'
import type { ToolCallOwnerProps } from './tool-contract'
import type { SlotCore, SlotMap } from '@deepseek-ai/dsh-client-ui-slots'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /**
     * The slot service. `inject` runs its registration while the owner
     * declaration is live and disposes it when that owner collapses; `register`
     * keeps the declaration-ownership wrapper the runtime adds around
     * `SlotCore.register`.
     */
    slots: Pick<SlotCore, 'register'> & {
      /** Re-register `register` whenever `name` reaches its declared population. */
      inject<K extends keyof SlotMap & string>(name: K, register: () => () => void): () => void
    }
  }
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'settings.applyPatch': keyof typeof zh
    'applyPatch.tool': keyof typeof toolZh
  }
  interface SlotMap {
    /**
     * A bundle's own configuration, keyed by the bundle's package name.
     *
     * The owner also hands its native configuration form to occupants; this
     * page renders from its own bound `configForms` scope instead, so the
     * declared owner share keeps only the view it reads.
     */
    'plugins.bundle.config': {
      kind: 'keyed'
      scope: 'root'
      owner: { view: 'summary' | 'page' }
    }
    /**
     * Keyed Tool call view dispatched by wire Tool name.
     *
     * The owner (the Tool call tree) passes the call identity and the running
     * or settled block; this bundle claims the `apply_patch` key only.
     */
    'tool.call.toolview': {
      kind: 'keyed'
      scope: 'session'
      owner: ToolCallOwnerProps
    }
  }
}

export {}
