/**
 * Restated Client contract for the `tool.call.toolview` slot.
 *
 * The owner types live in `@deepseek-ai/dsh-client-ui-tool`, a package this
 * bundle deliberately does not load (the Client purity gate forbids cross-plugin
 * value imports, and loading a Harness Client package as a module would break
 * the row whenever that package changes). The contract below therefore restates
 * exactly what this plugin's row consumes, verified against the live
 * `Slots.listSubTree` payload and the package's published `client` types:
 *
 *   - phases `preparing` / `start` / `result` and their block fields,
 *   - `args` as the lazy `PartialArguments` reader (streaming-safe),
 *   - the settled result content, failure state, and persisted `meta`,
 *   - the owner callbacks a Tool view may use.
 *
 * Only fields the row reads are declared; extra owner props (for example the
 * image loader) may be supplied at runtime and are intentionally ignored here.
 */

/** 1-based line to reveal when opening a file. */
export interface OpenFileOptions {
  /** 1-based first line to show; absent reveals the file's beginning. */
  readonly line?: number
}

/** Stable disclosure Hook; each invocation owns its open state. */
export interface Disclosure {
  readonly expanded: boolean
  readonly setExpanded: (open: boolean) => void
  readonly toggle: () => void
}

/** Supplier of {@link Disclosure} handed to every atomic Tool view. */
export type UseDisclosure = () => Disclosure

/**
 * Lazy readers over the call's streaming top-level arguments.
 *
 * Mirrors `PartialArguments` from `@deepseek-ai/dsh-util-values`: every reader
 * is total, a string reader returns the decoded text available so far, and a
 * length read can declare a change-detection step for streaming refreshes.
 */
export interface ToolArgs {
  /** Decoded string field text so far, or undefined when absent/not a string. */
  text(field: string): string | undefined
  /** Decoded UTF-16 length of a string field, with optional step/offset for change detection. */
  stringLength(
    field: string,
    options?: { readonly step?: number; readonly offset?: number },
  ): number | undefined
  /** Whether the field's closing delimiter arrived. */
  complete(field: string): boolean
  /** Whether the whole argument object can no longer grow. */
  closed(): boolean
  /** Whether indexing or a content read found invalid JSON. */
  readonly invalid: boolean
}

/** One harness content block as the row reads it. */
export interface ToolContentBlock {
  readonly type: string
  /** Text payload of a `text` block. */
  readonly text?: string
}

/** Identity shared by every stage of one Tool call. */
interface ToolCallHead {
  readonly callId: string
  /** Wire Tool name; the keyed dispatch value. */
  readonly name: string
  /** Lazy argument view; grows in place while the call is preparing. */
  readonly args: ToolArgs
}

/** A named call whose arguments are not complete yet. */
export interface PreparingToolCall extends ToolCallHead {
  readonly phase: 'preparing'
}

/** A dispatched call with complete arguments and no result yet. */
export interface StartedToolCall extends ToolCallHead {
  readonly phase: 'start'
  /** The complete argument JSON text. */
  readonly argsRaw: string
}

/** A settled call: the recorded result paired with its call head. */
export interface ToolResultNode extends ToolCallHead {
  readonly kind: 'tool-result'
  /** Model-facing result content (the rendered error text on failure). */
  readonly content: readonly ToolContentBlock[]
  /** Whether the call failed. */
  readonly isError: boolean
  /** Normalized failure identity, when recorded. */
  readonly error?: {
    readonly name: string
    readonly code: string
    readonly reason?: string
  }
  /** Tool-private presentation payload persisted with the result, when declared. */
  readonly meta?: unknown
}

/** One preparing, dispatched, or settled call. */
export type ToolCallBlock = PreparingToolCall | StartedToolCall | ToolResultNode

/** Stage-specific Tool data supplied to the keyed view. */
export type ToolCallPhaseProps =
  | { readonly phase: 'preparing'; readonly block: PreparingToolCall }
  | { readonly phase: 'start'; readonly block: StartedToolCall }
  | { readonly phase: 'result'; readonly block: ToolResultNode }

/** Callbacks and scope facts every atomic Tool view receives. */
export interface ToolCallCommonProps {
  /** Stable Hook; the row must call it once and never cache the result. */
  readonly useDisclosure: UseDisclosure
  readonly callId: string
  /** Wire Tool name and keyed dispatch value. */
  readonly toolName: string
  /** Session workspace root for relative summaries. */
  readonly cwd?: string | undefined
  /** Host account home; POSIX home-rooted summaries display as `~`. */
  readonly home?: string | undefined
  /** Open an argument path, optionally at a 1-based line. */
  readonly openFile: (path: string, options?: OpenFileOptions) => void
  /** Inspect this call in the trajectory view when available. */
  readonly inspect?: (() => void) | undefined
}

/** Full owner currency of the keyed `tool.call.toolview` slot. */
export type ToolCallOwnerProps = ToolCallCommonProps & ToolCallPhaseProps
