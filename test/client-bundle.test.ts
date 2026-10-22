/**
 * Artifact smoke test for the compiled Client half.
 *
 * The bundle is a browser artifact: `window.__ModuleLoader__.load({ id, factory })`.
 * This test evaluates the built `lib/client.js` against a stand-in module loader,
 * hands the factory the two real modules the artifact declares, drives the
 * exported `apply` with a stand-in Client context, and renders the registered
 * page through React's server renderer. It therefore exercises the shipped
 * code — bundle id, registration wiring, locale lookup, and rendered markup —
 * without installing a Harness profile or booting the Web shell.
 *
 * `lib/` is build output (gitignored), so the suite skips when it is absent:
 * `pnpm build` produces it locally, and CI builds after its test step.
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, it } from 'node:test'
import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const BUNDLE_URL = new URL('../lib/client.js', import.meta.url)
const BUNDLE_MISSING = !existsSync(BUNDLE_URL)
const SKIP_REASON = 'lib/client.js is absent — run `pnpm build` first'

/**
 * Declare one test that needs the built artifact.
 *
 * A missing build skips every case with the reason, so a source-only checkout
 * reports "skipped" instead of a failure that hides the real signal.
 * @param name test name.
 * @param body test body, which evaluates the artifact.
 */
function itWhenBuilt(name: string, body: () => void): void {
  it(name, { skip: BUNDLE_MISSING ? SKIP_REASON : false }, body)
}

/** `{name}` template substitution, the locale registry's placeholder form. */
function interpolate(template: string, params: Record<string, unknown> | undefined): string {
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.hasOwn(params, name) ? String(params[name]) : match)
}

/** One settings document as the Host's form projects it. */
interface SettingsValue {
  disableEdit?: boolean
  disableWrite?: boolean
  allowUnobservedOverwrite?: boolean
}

/** One bound config-form snapshot (`ConfigFormSnapshot` without its generics). */
interface FormSnapshot {
  status: 'loading' | 'ready' | 'unavailable'
  value: SettingsValue | undefined
  revision: number | undefined
  writable: boolean
}

/** One bound config form, the face the page consumes. */
interface FormScope {
  getSnapshot(): FormSnapshot
  subscribe(listener: () => void): () => void
  mutate(ops: readonly { op: 'set'; path: readonly string[]; value: unknown }[], revision?: number): Promise<boolean>
}

/** Every registration the Client half makes, recorded for assertions. */
interface ClientHarness {
  ctx: Record<string, unknown>
  dictionaries: Map<string, Record<string, Record<string, string>>>
  registered: Array<{ options: Record<string, unknown>; component: unknown }>
  servedNamespaces: string[][]
  formEntries: string[]
  /** The exact scope `configForms.get` handed the plugin. */
  formScope: FormScope
  effects: string[]
  /** Flip the active locale; bound translators read it at call time. */
  setLocale(locale: 'zh' | 'en'): void
  /** Replace the snapshot every render reads. */
  setSnapshot(snapshot: FormSnapshot): void
  /** Reads the locale the plugin registered, which every render asserts against. */
  translate(locale: 'zh' | 'en', key: string, params?: Record<string, unknown>): string
  /** Reads any registered namespace, for the Tool row's own dictionary. */
  translateNs(ns: string, locale: 'zh' | 'en', key: string, params?: Record<string, unknown>): string
}

/**
 * Build a stand-in Client context.
 *
 * `effect` runs its body immediately and keeps the disposer, matching Cordis'
 * eager effect execution, so `apply` performs every registration in this test.
 * @param snapshot Initial Host document projection.
 * @returns the context plus the recorders the assertions read.
 */
function createClientHarness(snapshot: FormSnapshot): ClientHarness {
  let active: 'zh' | 'en' = 'en'
  let current = snapshot
  const dictionaries = new Map<string, Record<string, Record<string, string>>>()
  const registered: Array<{ options: Record<string, unknown>; component: unknown }> = []
  const servedNamespaces: string[][] = []
  const formEntries: string[] = []
  const effects: string[] = []
  const scope: FormScope = {
    getSnapshot: () => current,
    subscribe: () => () => {},
    mutate: async () => true,
  }
  const read = (ns: string, locale: 'zh' | 'en', key: string): string => {
    const text = dictionaries.get(ns)?.[locale]?.[key]
    assert.ok(typeof text === 'string', `locale "${ns}" has the "${locale}.${key}" key`)
    return text
  }
  const ctx = {
    effect: (body: () => unknown, label?: string) => {
      effects.push(label ?? '<unlabeled>')
      return body()
    },
    locale: {
      register: (ns: string, dicts: Record<string, Record<string, string>>) => {
        dictionaries.set(ns, dicts)
        return () => {}
      },
      bind: (ns: string) => (key: string, params?: Record<string, unknown>) =>
        interpolate(read(ns, active, key), params),
    },
    configForms: {
      get: (entryId: string) => { formEntries.push(entryId); return scope },
      whileServed: (namespaces: readonly string[], register: () => unknown) => {
        servedNamespaces.push([...namespaces])
        return register()
      },
    },
    slots: {
      inject: (name: string, register: () => unknown) => { servedNamespaces.push([name]); return register() },
      register: (options: Record<string, unknown>, component: unknown) => {
        registered.push({ options, component })
        return () => {}
      },
    },
  }
  return {
    ctx,
    dictionaries,
    registered,
    servedNamespaces,
    formEntries,
    formScope: scope,
    effects,
    setLocale: (locale) => { active = locale },
    setSnapshot: (next) => { current = next },
    translate: (locale, key, params) => interpolate(read('settings.applyPatch', locale, key), params),
    translateNs: (ns, locale, key, params) => interpolate(read(ns, locale, key), params),
  }
}

/** The artifact's exports, validated rather than cast. */
interface ClientModule {
  apply(ctx: Record<string, unknown>): void
  inject: readonly string[]
}

/** A page component as the slot registry stores it. */
type PageComponent = (props: { view: 'summary' | 'page'; scope: FormScope }) => ReactElement | null

/** Shape check for the browser artifact's export object. */
function isClientModule(value: unknown): value is ClientModule {
  if (typeof value !== 'object' || value === null) return false
  return typeof Reflect.get(value, 'apply') === 'function' && Array.isArray(Reflect.get(value, 'inject'))
}

/** Shape check for a registered page component. */
function isPageComponent(value: unknown): value is PageComponent {
  return typeof value === 'function'
}

/** One loaded bundle module, as `window.__ModuleLoader__` receives it. */
interface BundleLoad {
  id: string
  factory(require: (id: string) => unknown): unknown
}

/** The result of evaluating the artifact once. */
interface LoadedBundle {
  id: string
  module: ClientModule
  requested: string[]
  register(ctx: Record<string, unknown>): void
}

/**
 * Evaluate `lib/client.js` the way the Web shell does.
 *
 * The fake `require` serves the two real browser modules the artifact declares
 * and records every request, so a cross-plugin runtime import fails this test
 * instead of the page. React's server renderer needs `getServerSnapshot`, which
 * the browser shell never supplies, so the stand-in `useSyncExternalStore` also
 * accepts the two-argument form the component uses.
 * @returns the bundle id, its exports, and the module ids it requested.
 */
function loadBundle(): LoadedBundle {
  const nodeRequire = createRequire(import.meta.url)
  const react = nodeRequire('react') as Record<string, unknown> & {
    useSyncExternalStore(
      subscribe: () => () => void,
      getSnapshot: () => unknown,
      getServerSnapshot?: () => unknown,
    ): unknown
  }
  const jsxRuntime = nodeRequire('react/jsx-runtime')
  const requested: string[] = []
  const served = new Map<string, unknown>([
    ['react', {
      ...react,
      // The browser runtime renders client-side; the server renderer needs the
      // snapshot function it would otherwise take from the hydration path.
      useSyncExternalStore: (subscribe: () => () => void, getSnapshot: () => unknown) =>
        react.useSyncExternalStore(subscribe, getSnapshot, getSnapshot),
    }],
    ['react/jsx-runtime', jsxRuntime],
  ])
  const requireStub = (id: string): unknown => {
    requested.push(id)
    const module = served.get(id)
    if (module === undefined) throw new Error(`client bundle requested an unexpected module "${id}"`)
    return module
  }
  const loads: BundleLoad[] = []
  const window = { __ModuleLoader__: { load: (entry: BundleLoad) => { loads.push(entry) } } }
  new Function('window', readFileSync(BUNDLE_URL, 'utf8'))(window)
  assert.equal(loads.length, 1, 'the artifact registers exactly one module')
  const [load] = loads
  assert.ok(load !== undefined)
  const module: unknown = load.factory(requireStub)
  assert.ok(isClientModule(module), 'the factory exports { apply, inject }')
  return { id: load.id, module, requested, register: (ctx) => module.apply(ctx) }
}

/** The one registration this plugin made into a Slot, asserting it happened once. */
function registeredEntry(harness: ClientHarness, name: string): { options: Record<string, unknown>; component: unknown } {
  const entries = harness.registered.filter((entry) => entry.options.name === name)
  assert.equal(entries.length, 1, `the ${name} slot registers once`)
  const [entry] = entries
  assert.ok(entry !== undefined)
  return entry
}

/** The page the plugin registered into the bundle-configuration slot. */
function registeredPage(harness: ClientHarness): PageComponent {
  const entry = registeredEntry(harness, 'plugins.bundle.config')
  assert.ok(isPageComponent(entry.component), 'the registered component is renderable')
  return entry.component
}

/** A Tool view component as the Slot registry stores it. */
type ToolRowComponent = (props: Record<string, unknown>) => ReactElement | null

/** The `apply_patch` Tool view the plugin registered. */
function registeredToolview(harness: ClientHarness): ToolRowComponent {
  const entry = registeredEntry(harness, 'tool.call.toolview')
  const component: unknown = entry.component
  assert.equal(typeof component, 'function', 'the Tool view is renderable')
  return component as ToolRowComponent
}

/** Render the page once and return its markup. */
function render(page: PageComponent, props: { view: 'summary' | 'page'; scope: FormScope }): string {
  return renderToStaticMarkup(createElement(page, props))
}

/** Render the Tool view once and return its markup. */
function renderTool(component: ToolRowComponent, props: Record<string, unknown>): string {
  return renderToStaticMarkup(createElement(component, props))
}

/** Count the rendered switch controls. */
function switchCount(markup: string): number {
  return markup.match(/role="switch"/g)?.length ?? 0
}

/**
 * The stylesheet the bundle inlines into the page.
 * @param markup - one rendered page.
 * @returns its `<style>` bodies concatenated.
 */
function inlinedCss(markup: string): string {
  return [...markup.matchAll(/<style>([\s\S]*?)<\/style>/g)]
    .map(match => match[1])
    .join('\n')
    // React escapes the stylesheet like any other text child, so attribute
    // selectors arrive quoted as `&#x27;`.
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

/** The readable text of one render, with the inlined stylesheet and escaping removed. */
function visibleText(markup: string): string {
  return markup
    .replace(/<style>[\s\S]*?<\/style>/g, '')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

/** Assert one rendered page shows exactly one copy of `copy`. */
function assertShows(markup: string, copy: string, what: string): void {
  assert.ok(visibleText(markup).includes(copy), `${what} shows "${copy}"`)
}

/** Assert one rendered page never shows `copy`. */
function assertHides(markup: string, copy: string, what: string): void {
  assert.ok(!visibleText(markup).includes(copy), `${what} does not show "${copy}"`)
}

/** A ready, writable Host document with composition defaults. */
const READY: FormSnapshot = { status: 'ready', value: {}, revision: 1, writable: true }

/** One patch exercising Update, Add, and Delete in that order (+3 / -1). */
const PATCH_ALL_KINDS = [
  '*** Begin Patch',
  '*** Update File: src/a.ts',
  '@@',
  '-old-line',
  '+new-line',
  '+more-line',
  '*** Add File: src/b.ts',
  '+created',
  '*** Delete File: old.txt',
  '*** End Patch',
].join('\n')

/**
 * Build the props one Tool call view receives at a given stage.
 *
 * The block mirrors the Client record shapes (`args` is the lazy reader, a
 * settled node carries the result content), so the row is exercised through
 * the same fields the runtime supplies.
 * @param harness - client harness supplying the Tool dictionary.
 * @param options - stage, patch text, result content, and disclosure state.
 * @returns the Tool view props.
 */
function toolProps(harness: ClientHarness, options: {
  phase: 'preparing' | 'start' | 'result'
  patch?: string
  content?: readonly { type: string; text?: string }[]
  isError?: boolean
  expanded?: boolean
}): Record<string, unknown> {
  const args = {
    text: (field: string) => field === 'patch' ? options.patch : undefined,
    stringLength: (field: string) => field === 'patch' ? options.patch?.length : undefined,
    complete: (field: string) => field === 'patch' && options.patch !== undefined,
    closed: () => options.phase !== 'preparing',
    invalid: false,
  }
  const head = { callId: 'call-1', name: 'apply_patch', args }
  const block = options.phase === 'result'
    ? {
        ...head,
        kind: 'tool-result',
        content: options.content ?? [],
        isError: options.isError ?? false,
      }
    : options.phase === 'start'
      ? { ...head, phase: 'start', argsRaw: JSON.stringify({ patch: options.patch ?? null }) }
      : { ...head, phase: 'preparing' }
  return {
    phase: options.phase,
    block,
    callId: 'call-1',
    toolName: 'apply_patch',
    cwd: '/workspace',
    home: '/home/user',
    openFile: () => {},
    inspect: () => {},
    useDisclosure: () => ({
      expanded: options.expanded ?? false,
      setExpanded: () => {},
      toggle: () => {},
    }),
    t: (key: string, params?: Record<string, unknown>) =>
      harness.translateNs('applyPatch.tool', 'en', key, params),
  }
}

describe('client bundle', () => {
  itWhenBuilt('registers under the bundle package name with its declared services', () => {
    const bundle = loadBundle()
    assert.equal(bundle.id, 'dsh-apply-patch')
    assert.deepEqual([...bundle.module.inject], ['slots', 'locale', 'configForms'])
  })

  itWhenBuilt('imports only the browser modules the shell provides', () => {
    const bundle = loadBundle()
    const harness = createClientHarness(READY)
    bundle.register(harness.ctx)
    assert.deepEqual([...new Set(bundle.requested)].sort(), ['react', 'react/jsx-runtime'])
  })

  itWhenBuilt('registers its dictionaries, its own entry form, the bundle page, and the Tool view', () => {
    const bundle = loadBundle()
    const harness = createClientHarness(READY)
    bundle.register(harness.ctx)

    const dictionaries = harness.dictionaries.get('settings.applyPatch')
    assert.ok(dictionaries !== undefined, 'the locale namespace is registered')
    assert.deepEqual(Object.keys(dictionaries).sort(), ['en', 'zh'], 'both shipped locales arrive in one call')
    assert.deepEqual(
      Object.keys(dictionaries.en).sort(),
      Object.keys(dictionaries.zh).sort(),
      'the dictionaries stay bilingual',
    )
    const toolDictionaries = harness.dictionaries.get('applyPatch.tool')
    assert.ok(toolDictionaries !== undefined, 'the Tool row namespace is registered')
    assert.deepEqual(
      Object.keys(toolDictionaries.en).sort(),
      Object.keys(toolDictionaries.zh).sort(),
      'the Tool row dictionaries stay bilingual',
    )
    assert.deepEqual(harness.formEntries, ['dsh-apply-patch'], 'the form binds this plugin entry id')
    assert.deepEqual(harness.servedNamespaces, [
      ['dsh-apply-patch'],
      ['plugins.bundle.config'],
      ['tool.call.toolview'],
    ])

    const entry = registeredEntry(harness, 'plugins.bundle.config')
    assert.equal(entry.options.name, 'plugins.bundle.config')
    assert.equal(entry.options.key, 'dsh-apply-patch')
    assert.equal(entry.options.locale, 'settings.applyPatch')
    assert.equal(typeof entry.options.inject, 'function')

    const toolview = registeredEntry(harness, 'tool.call.toolview')
    assert.equal(toolview.options.key, 'apply_patch', 'the row claims the wire Tool name')
    assert.equal(toolview.options.locale, 'applyPatch.tool')
    assert.deepEqual(harness.effects, [
      'dsh-apply-patch: dictionaries',
      'dsh-apply-patch: plugin center page',
      'dsh-apply-patch: apply_patch tool view',
    ])
  })

  itWhenBuilt('hands the page the form scope it bound', () => {
    const bundle = loadBundle()
    const harness = createClientHarness(READY)
    bundle.register(harness.ctx)
    assert.equal(formScopeOf(harness), harness.formScope, 'the inject face carries the bound form scope')
  })

  itWhenBuilt('renders the localized heading and all three switches', () => {
    const bundle = loadBundle()
    const harness = createClientHarness(READY)
    bundle.register(harness.ctx)
    const page = registeredPage(harness)

    const markup = render(page, { view: 'page', scope: formScopeOf(harness) })
    assertShows(markup, harness.translate('en', 'sectionTitle'), 'the heading')
    assertShows(markup, harness.translate('en', 'sectionSub'), 'the summary')
    assert.equal(switchCount(markup), 3)
    for (const key of ['disableEditLabel', 'disableWriteLabel', 'allowUnobservedOverwriteLabel']) {
      assertShows(markup, harness.translate('en', key), `the ${key} row`)
    }
    assertHides(markup, harness.translate('en', 'readOnly'), 'a writable document')
  })

  itWhenBuilt('renders the shell switch control, not a hand-rolled one', () => {
    // The shell's switch is a <button role="switch"> wrapping one thumb span.
    // This plugin must reproduce that control (a plugin may not load a Harness
    // Client package), so the markup and geometry are pinned here: a regression
    // to <input type="checkbox"> or to different dimensions is a visible defect.
    const bundle = loadBundle()
    const harness = createClientHarness(READY)
    bundle.register(harness.ctx)
    const markup = render(registeredPage(harness), { view: 'page', scope: formScopeOf(harness) })

    const controls = [...markup.matchAll(/<button[^>]*role="switch"[^>]*>([\s\S]*?)<\/button>/g)]
    assert.equal(controls.length, 3, 'three switch buttons')
    for (const control of controls) {
      assert.match(control[1], /<span class="ap-switch-thumb"><\/span>/, 'each control wraps exactly one thumb span')
    }
    assert.equal((markup.match(/role="switch"[^>]*aria-checked/g) ?? []).length + (markup.match(/aria-checked[^>]*role="switch"/g) ?? []).length, 3,
      'each control reports aria-checked itself')
    assert.doesNotMatch(markup, /<input[^>]*type="checkbox"/, 'not a native checkbox')

    const css = inlinedCss(markup)
    for (const declaration of ['width:36px', 'height:20px', 'width:16px', 'height:16px', 'border-radius:999px', 'translate(16px)']) {
      assert.ok(css.replace(/\s+/g, '').includes(declaration), `the switch keeps the shell geometry: ${declaration}`)
    }
    assert.match(css, /\.ap-switch\[aria-checked=['"]true['"]\]/, 'the checked state is styled from aria-checked')
  })

  itWhenBuilt('reads the active locale at render time instead of freezing it', () => {
    const bundle = loadBundle()
    const harness = createClientHarness(READY)
    bundle.register(harness.ctx)
    const page = registeredPage(harness)
    const scope = formScopeOf(harness)

    const english = render(page, { view: 'page', scope })
    harness.setLocale('zh')
    const chinese = render(page, { view: 'page', scope })
    assertShows(chinese, harness.translate('zh', 'sectionTitle'), 'the switched page')
    assert.notEqual(visibleText(chinese), visibleText(english), 'the same mounted page follows a language switch')
  })

  itWhenBuilt('renders nothing when the Host does not serve this entry', () => {
    const bundle = loadBundle()
    const harness = createClientHarness({ ...READY, status: 'unavailable' })
    bundle.register(harness.ctx)
    assert.equal(render(registeredPage(harness), { view: 'page', scope: formScopeOf(harness) }), '')
  })

  itWhenBuilt('does not claim read-only while the first document is still loading', () => {
    const bundle = loadBundle()
    const harness = createClientHarness({ ...READY, status: 'loading', value: undefined })
    bundle.register(harness.ctx)
    const markup = render(registeredPage(harness), { view: 'page', scope: formScopeOf(harness) })

    assertHides(markup, harness.translate('en', 'readOnly'), 'a loading document')
    assert.equal(switchCount(markup), 3, 'the rows are shown, disabled, while loading')
    assert.match(markup, /disabled/, 'controls stay disabled until the document arrives')
  })

  itWhenBuilt('reports a ready read-only document', () => {
    const bundle = loadBundle()
    const harness = createClientHarness({ ...READY, writable: false })
    bundle.register(harness.ctx)
    const markup = render(registeredPage(harness), { view: 'page', scope: formScopeOf(harness) })
    assertShows(markup, harness.translate('en', 'readOnly'), 'a read-only document')
    assert.match(markup, /disabled/)
  })

  itWhenBuilt('contributes the form only for the page view', () => {
    const bundle = loadBundle()
    const harness = createClientHarness(READY)
    bundle.register(harness.ctx)
    assert.equal(render(registeredPage(harness), { view: 'summary', scope: formScopeOf(harness) }), '')
  })

  itWhenBuilt('renders parsed file operations instead of the raw patch text', () => {
    const bundle = loadBundle()
    const harness = createClientHarness(READY)
    bundle.register(harness.ctx)
    const markup = renderTool(registeredToolview(harness), toolProps(harness, {
      phase: 'start',
      patch: PATCH_ALL_KINDS,
    }))

    assertShows(
      markup,
      harness.translateNs('applyPatch.tool', 'en', 'titleEditMany', {
        count: 3,
        paths: 'src/a.ts, src/b.ts, old.txt',
      }),
      'the title generated from the actions and every path',
    )
    assertHides(
      markup,
      harness.translateNs('applyPatch.tool', 'en', 'toolTitle'),
      'the generic tool title',
    )
    assertShows(markup, '+3', 'the added total')
    assertShows(markup, '-1', 'the removed total')
    assertHides(markup, '*** Begin Patch', 'the raw patch')
    assertHides(markup, '*** Add File', 'a raw hunk header')
    // The shell's disclosure rows swap the leading icon for a hover chevron;
    // they never append one at the end of the row.
    assert.match(markup, /ap-tool-chevron-hover/, 'the leading icon hosts the hover chevron')
    assert.doesNotMatch(markup, /ap-tool-chevron-slot/, 'no trailing chevron is appended')
    // The leading glyph is a patch document: a page carrying + and - change marks.
    assert.match(markup, /M5\.6 6\.5h4\.8/, 'the leading glyph carries the patch plus mark')
    assert.match(markup, /M5\.6 10\.8h4\.8/, 'the leading glyph carries the patch minus mark')
  })

  itWhenBuilt('lists operations in patch order with their verdicts once expanded', () => {
    const bundle = loadBundle()
    const harness = createClientHarness(READY)
    bundle.register(harness.ctx)
    const markup = renderTool(registeredToolview(harness), toolProps(harness, {
      phase: 'result',
      patch: PATCH_ALL_KINDS,
      expanded: true,
      content: [{
        type: 'text',
        text: 'Success. Updated the following files:\nM src/a.ts\nA src/b.ts\nD old.txt',
      }],
    }))

    const text = visibleText(markup)
    const first = text.indexOf('src/a.ts')
    const second = text.indexOf('src/b.ts')
    const third = text.indexOf('old.txt')
    assert.ok(first >= 0 && second > first && third > second, 'operations follow patch order')
    assertShows(markup, harness.translateNs('applyPatch.tool', 'en', 'toolApplied'), 'the applied verdict')
    assertShows(markup, 'new-line', 'the update added line')
    assertShows(markup, 'old-line', 'the update removed line')
    assert.doesNotMatch(markup, /class="ap-tool-diff-fold"/, 'a short diff shows all its lines')
    // Expanded rows keep their header in view over the scrolling body, like the
    // shell's reasoning and compaction blocks do.
    assert.match(markup, /data-disclosure-header/, 'the header is addressable for sticky layout')
    assert.match(
      inlinedCss(markup),
      /\.ap-tool\[data-open\]\s*>\s*\.ap-tool-header\s*\{[^}]*position:\s*sticky/,
      'the expanded header is sticky',
    )
    assert.match(
      inlinedCss(markup),
      /\.ap-tool-op-head\s*\{[^}]*markdown-code-block/,
      'operation paths use the small diff-card type, not the chat body size',
    )
    // One fixed-width canvas keeps the horizontal scrollbar steady and lets the
    // added/removed tint span the whole scrollable line, not just the viewport.
    assert.match(markup, /class="ap-tool-diff-canvas" style="width:\d+ch"/, 'the diff canvas has a fixed width')
  })

  itWhenBuilt('folds the middle of a long diff and expands it on click', () => {
    const bundle = loadBundle()
    const harness = createClientHarness(READY)
    bundle.register(harness.ctx)
    const markup = renderTool(registeredToolview(harness), toolProps(harness, {
      phase: 'result',
      expanded: true,
      patch: [
        '*** Begin Patch',
        '*** Update File: src/a.ts',
        '@@',
        ' ctx-0',
        ' ctx-1',
        '-removed-a',
        '+added-a',
        ' ctx-2',
        ' ctx-3',
        ' ctx-4',
        ' ctx-5',
        ' ctx-6',
        '-removed-b',
        '+added-b',
        ' ctx-7',
        ' ctx-8',
        '*** End Patch',
      ].join('\n'),
      content: [{ type: 'text', text: 'Success. Updated the following files:\nM src/a.ts' }],
    }))

    // Each edge keeps changed lines (the point of the preview); only the
    // context between the two change clusters is folded.
    assertShows(markup, 'removed-a', 'the first changed line at the top edge')
    assertShows(markup, 'added-a', 'the first added line at the top edge')
    assertShows(markup, 'removed-b', 'the last changed line at the bottom edge')
    assertShows(markup, 'added-b', 'the last added line at the bottom edge')
    assertHides(markup, 'ctx-3', 'the folded middle context')
    assertShows(
      markup,
      harness.translateNs('applyPatch.tool', 'en', 'diffExpand', { count: 3 }),
      'the expand-middle control',
    )
    assert.match(markup, /class="ap-tool-diff-fold"/, 'the expand control is a button')
    assert.match(markup, /data-state="applied"/, 'the operation keeps its applied verdict')
  })

  itWhenBuilt('retains the full diff once settled, without the streaming preview cap', () => {
    const bundle = loadBundle()
    const harness = createClientHarness(READY)
    bundle.register(harness.ctx)
    // 250 diff lines: more than the 200-line streaming preview budget.
    const body = Array.from({ length: 125 }, (_, index) => `-old-${index}\n+new-${index}`).join('\n')
    const markup = renderTool(registeredToolview(harness), toolProps(harness, {
      phase: 'result',
      expanded: true,
      patch: ['*** Begin Patch', '*** Update File: src/a.ts', '@@', body, '*** End Patch'].join('\n'),
      content: [{ type: 'text', text: 'Success. Updated the following files:\nM src/a.ts' }],
    }))

    // The fold count is derived from all 250 retained lines: 250 - 3 - 4 = 243
    // hidden between the two change edges. A capped preview would report 196.
    assertShows(
      markup,
      harness.translateNs('applyPatch.tool', 'en', 'diffExpand', { count: 243 }),
      'the fold is computed over the complete diff',
    )
    assertShows(markup, 'old-0', 'a changed line at the top edge')
    assertShows(markup, 'new-124', 'a changed line at the bottom edge')
    assertHides(markup, ' more lines', 'the streaming preview-cap notice')
  })

  itWhenBuilt('derives a single-file title from its action and path', () => {
    const bundle = loadBundle()
    const harness = createClientHarness(READY)
    bundle.register(harness.ctx)
    const markup = renderTool(registeredToolview(harness), toolProps(harness, {
      phase: 'start',
      patch: [
        '*** Begin Patch',
        '*** Update File: src/a.ts',
        '@@',
        '-before',
        '+after',
        '*** End Patch',
      ].join('\n'),
    }))

    assertShows(
      markup,
      harness.translateNs('applyPatch.tool', 'en', 'titleUpdate', { path: 'src/a.ts' }),
      'the single-file update title',
    )
    assertHides(markup, harness.translateNs('applyPatch.tool', 'en', 'toolTitle'), 'the generic title')
  })

  itWhenBuilt('aggregates one action across several files in the title', () => {
    const bundle = loadBundle()
    const harness = createClientHarness(READY)
    bundle.register(harness.ctx)
    const markup = renderTool(registeredToolview(harness), toolProps(harness, {
      phase: 'start',
      patch: [
        '*** Begin Patch',
        '*** Add File: src/a.ts',
        '+one',
        '*** Add File: src/b.ts',
        '+two',
        '*** End Patch',
      ].join('\n'),
    }))

    assertShows(
      markup,
      harness.translateNs('applyPatch.tool', 'en', 'titleAddMany', {
        count: 2,
        paths: 'src/a.ts, src/b.ts',
      }),
      'the aggregated add title with both file names',
    )
    assert.match(
      inlinedCss(markup),
      /\.ap-tool-title\s*\{[^}]*text-overflow:\s*ellipsis/,
      'a title wider than the row truncates instead of wrapping',
    )
  })

  itWhenBuilt('reports the partially applied operations of a failed patch', () => {
    const bundle = loadBundle()
    const harness = createClientHarness(READY)
    bundle.register(harness.ctx)
    const markup = renderTool(registeredToolview(harness), toolProps(harness, {
      phase: 'result',
      expanded: true,
      isError: true,
      patch: [
        '*** Begin Patch',
        '*** Update File: src/a.ts',
        '@@',
        '-a',
        '+b',
        '*** Update File: src/b.ts',
        '@@',
        '-x',
        '+y',
        '*** End Patch',
      ].join('\n'),
      content: [{
        type: 'text',
        text: 'Error: Failed to update file /workspace/src/b.ts: no such file\n\n'
          + 'Applied before the failure:\nM /workspace/src/a.ts',
      }],
    }))

    assertShows(markup, 'no such file', 'the failure message')
    assertShows(markup, '1/2 applied', 'the applied count')
    assertShows(markup, harness.translateNs('applyPatch.tool', 'en', 'toolUnapplied'), 'the unapplied verdict')
    assertHides(markup, 'Applied before the failure:', 'the raw trailer')
  })

  itWhenBuilt('falls back to the result summary when the call arguments left the window', () => {
    const bundle = loadBundle()
    const harness = createClientHarness(READY)
    bundle.register(harness.ctx)
    const markup = renderTool(registeredToolview(harness), toolProps(harness, {
      phase: 'result',
      expanded: true,
      content: [{
        type: 'text',
        text: 'Success. Updated the following files:\nM src/a.ts\nA src/b.ts',
      }],
    }))

    assertShows(markup, 'src/a.ts', 'the recorded update path')
    assertShows(markup, 'src/b.ts', 'the recorded add path')
    assertShows(markup, harness.translateNs('applyPatch.tool', 'en', 'toolApplied'), 'the applied verdict')
  })

  itWhenBuilt('shows the preparing label before any hunk has arrived', () => {
    const bundle = loadBundle()
    const harness = createClientHarness(READY)
    bundle.register(harness.ctx)
    const markup = renderTool(registeredToolview(harness), toolProps(harness, { phase: 'preparing' }))

    assertShows(markup, harness.translateNs('applyPatch.tool', 'en', 'toolPreparing'), 'the preparing label')
    assertHides(markup, '*** Begin Patch', 'the raw patch')
  })

  itWhenBuilt('grows the operation list while the patch is still streaming', () => {
    const bundle = loadBundle()
    const harness = createClientHarness(READY)
    bundle.register(harness.ctx)
    const markup = renderTool(registeredToolview(harness), toolProps(harness, {
      phase: 'preparing',
      expanded: true,
      patch: '*** Begin Patch\n*** Add File: src/partial.ts\n+one',
    }))

    assertShows(markup, 'src/partial.ts', 'the operation seen so far')
    assertShows(markup, 'one', 'its streamed line')
  })
})

/**
 * The form scope the page receives through its inject face.
 * @param harness Client harness whose context was already driven through `apply`.
 * @returns the bound form scope.
 */
function formScopeOf(harness: ClientHarness): FormScope {
  const inject = registeredEntry(harness, 'plugins.bundle.config').options.inject
  assert.equal(typeof inject, 'function')
  const face: unknown = Reflect.apply(inject as (...args: unknown[]) => unknown, undefined, [])
  assert.ok(typeof face === 'object' && face !== null)
  const scope: unknown = Reflect.get(face, 'scope')
  assert.ok(isFormScope(scope), 'the inject face carries a config-form scope')
  return scope
}

/** Shape check for a config-form scope at the browser-module boundary. */
function isFormScope(value: unknown): value is FormScope {
  if (typeof value !== 'object' || value === null) return false
  return typeof Reflect.get(value, 'getSnapshot') === 'function'
    && typeof Reflect.get(value, 'subscribe') === 'function'
    && typeof Reflect.get(value, 'mutate') === 'function'
}
