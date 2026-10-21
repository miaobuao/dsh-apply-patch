#!/usr/bin/env node
/**
 * Verify the published manifest against the build artifacts it ships.
 *
 * Runs with Node builtins only (`node scripts/verify-manifest.mjs` from the
 * repository root). Every failure names the offending file or field and exits
 * non-zero, so CI fails on a stale `lib/`, a renamed entry, an unpublished
 * artifact, or a dependency floor that drifted backwards.
 *
 * Checked here — the parts a compiler and a unit test cannot see:
 *   - `main`, `types`, and every `exports` target exist after the build,
 *   - every exported artifact is actually shipped by `files`,
 *   - the client bundle's loader id equals `package.json` `name`,
 *   - the client bundle requires nothing outside the platform module table,
 *   - runtime imports in the emitted declarations are declared dependencies,
 *   - every `@deepseek-ai/dsh-*` peer still admits the API generation this
 *     package is written against.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const REQUIRED_DSH_PEER_FLOOR = '0.2.1-alpha.1'
const CLIENT_TYPE_ENTRY = 'lib/types/client/index.d.ts'

const failures = []
/** @param {string} message */
const fail = (message) => { failures.push(message) }
/** Repository-relative display path. @param {string} absolute */
const repoPath = (absolute) => relative(ROOT, absolute).split(sep).join('/')

/** @param {string} path */
function readRepoFile(path) {
  const absolute = resolve(ROOT, path)
  if (!existsSync(absolute) || !statSync(absolute).isFile()) return undefined
  return readFileSync(absolute, 'utf8')
}

const pkgPath = resolve(ROOT, 'package.json')
if (!existsSync(pkgPath)) {
  console.error('verify-manifest: package.json not found at', repoPath(pkgPath))
  process.exit(1)
}
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))

// A missing `lib/` makes every artifact check fail for the same reason; report
// that once instead of once per path.
if (!existsSync(resolve(ROOT, 'lib'))) {
  console.error('verify-manifest: lib/ is missing — run `pnpm build` first')
  process.exit(1)
}

/**
 * Collect every string target in an `exports` condition tree.
 * @param {unknown} value
 * @param {string[]} into
 */
function exportTargets(value, into) {
  if (typeof value === 'string') into.push(value)
  else if (value !== null && typeof value === 'object') {
    for (const nested of Object.values(value)) exportTargets(nested, into)
  }
  return into
}

/** @param {string} specifier */
function packageNameOf(specifier) {
  const parts = specifier.split('/')
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}

/** @param {string} version */
function parseVersion(version) {
  const [core, prerelease = ''] = version.split('-')
  const [major, minor, patch] = core.split('.').map(Number)
  if ([major, minor, patch].some((part) => !Number.isInteger(part))) return undefined
  return { major, minor, patch, prerelease: prerelease.split('.').filter(Boolean) }
}

/** Semver ordering for the prerelease identifiers these ranges use. @param {string[]} a @param {string[]} b */
function comparePrerelease(a, b) {
  if (a.length === 0 || b.length === 0) return a.length === b.length ? 0 : (a.length === 0 ? 1 : -1)
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const left = a[index]
    const right = b[index]
    if (left === undefined) return -1
    if (right === undefined) return 1
    const leftNumeric = /^\d+$/.test(left)
    const rightNumeric = /^\d+$/.test(right)
    if (leftNumeric && rightNumeric) {
      if (Number(left) !== Number(right)) return Number(left) - Number(right)
    } else if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1
    else if (left !== right) return left < right ? -1 : 1
  }
  return 0
}

/** Compare two parsed versions. @param {ReturnType<typeof parseVersion>} a @param {ReturnType<typeof parseVersion>} b */
function compareVersion(a, b) {
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] - b[key]
  }
  return comparePrerelease(a.prerelease, b.prerelease)
}

// 1. Entry points exist.
const entryTargets = new Set()
for (const field of ['main', 'types']) {
  if (typeof pkg[field] !== 'string') { fail(`package.json: \`${field}\` is not a string`); continue }
  entryTargets.add(pkg[field].replace(/^\.\//, ''))
}
for (const [subpath, target] of Object.entries(pkg.exports ?? {})) {
  const targets = exportTargets(target, [])
  if (targets.length === 0) fail(`package.json: exports["${subpath}"] declares no file target`)
  for (const resolved of targets) entryTargets.add(resolved.replace(/^\.\//, ''))
}
for (const target of entryTargets) {
  if (!readRepoFile(target)) fail(`entry target is missing: ${target} (rebuild, then retry)`)
}

// 2. Every entry point is shipped, together with the artifacts the host and the
//    client half load at runtime.
const files = Array.isArray(pkg.files) ? pkg.files : []
if (files.length === 0) fail('package.json: `files` is missing or empty')
/** @param {string} path */
const isShipped = (path) => files.some((entry) => {
  const normalized = entry.replace(/\/$/, '')
  return path === normalized || path.startsWith(`${normalized}/`)
})
for (const target of entryTargets) {
  // npm and pnpm always publish the manifest itself, whether `files` lists it or not.
  if (target === 'package.json') continue
  if (!isShipped(target)) fail(`entry target is not covered by \`files\`: ${target}`)
}
for (const artifact of ['lib/index.js', 'lib/client.js', CLIENT_TYPE_ENTRY]) {
  if (!isShipped(artifact)) fail(`artifact is not covered by \`files\`: ${artifact}`)
}
for (const entry of files) {
  const absolute = resolve(ROOT, entry)
  if (!existsSync(absolute)) fail(`\`files\` entry does not exist in the repository: ${entry}`)
}

// 3. The client bundle registers under the package name.
const clientDefault = pkg.exports?.['./client']?.default
const clientBundle = typeof clientDefault === 'string'
  ? readRepoFile(clientDefault)
  : undefined
if (clientBundle === undefined && typeof clientDefault === 'string') {
  fail(`client bundle is missing: ${clientDefault}`)
} else if (clientBundle !== undefined) {
  const id = /__ModuleLoader__\s*\.load\(\s*\{\s*id\s*:\s*["']([^"']+)["']/.exec(clientBundle)?.[1]
  if (id === undefined) fail(`client bundle has no __ModuleLoader__.load({ id }) call: ${clientDefault}`)
  else if (id !== pkg.name) fail(`client bundle id "${id}" does not match package.json name "${pkg.name}"`)
}

// 4. The client bundle requires only platform modules this build declares.
const tsdownConfig = readRepoFile('tsdown.config.ts')
if (tsdownConfig === undefined) fail('tsdown.config.ts is missing')
else {
  const arrayText = /const CLIENT_EXTERNALS = \[([\s\S]*?)\]/.exec(tsdownConfig)?.[1]
  if (arrayText === undefined) fail('tsdown.config.ts: CLIENT_EXTERNALS array not found')
  else {
    const externals = new Set([...arrayText.matchAll(/['"]([^'"]+)['"]/g)].map((match) => match[1]))
    for (const match of clientBundle?.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g) ?? []) {
      const specifier = match[1]
      if (!externals.has(specifier)) {
        fail(`client bundle requires "${specifier}", which CLIENT_EXTERNALS does not declare — `
          + 'add it to the platform externals or inline the dependency')
      }
    }
  }
}

// 5. Runtime imports in the emitted declarations are declared dependencies.
const declared = new Set([
  ...Object.keys(pkg.peerDependencies ?? {}),
  ...Object.keys(pkg.dependencies ?? {}),
])
/** @param {string} directory @returns {string[]} */
function walkDeclarations(directory) {
  if (!existsSync(directory)) return []
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = join(directory, entry.name)
    if (entry.isDirectory()) return walkDeclarations(absolute)
    return entry.name.endsWith('.d.ts') ? [absolute] : []
  })
}
for (const declaration of walkDeclarations(resolve(ROOT, 'lib/types'))) {
  const source = readFileSync(declaration, 'utf8')
  const specifiers = new Set(
    [...source.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)]
      .map((match) => match[1])
      .filter((specifier) => !specifier.startsWith('.') && !specifier.startsWith('node:')),
  )
  for (const specifier of specifiers) {
    const name = packageNameOf(specifier)
    if (name.startsWith('@deepseek-ai/') && !declared.has(name)) {
      fail(`${repoPath(declaration)} imports "${specifier}" but package.json does not declare "${name}"`)
    }
  }
}

// 6. The client type entry exists (the `./client` export resolves to a build).
if (!readRepoFile(CLIENT_TYPE_ENTRY)) {
  fail(`client type entry is missing: ${CLIENT_TYPE_ENTRY} (tsc -p tsconfig.client-types.json)`)
}

// 7. DSH peer floors have not drifted backwards.
const requiredFloor = parseVersion(REQUIRED_DSH_PEER_FLOOR)
for (const [name, range] of Object.entries(pkg.peerDependencies ?? {})) {
  if (!name.startsWith('@deepseek-ai/dsh-')) continue
  const match = /^([~^])?\s*(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(range)
  if (match === null) {
    fail(`peerDependencies["${name}"] = "${range}" is not a plain caret/tilde range — `
      + `write ^${REQUIRED_DSH_PEER_FLOOR} or newer`)
    continue
  }
  const floor = parseVersion(match[2])
  if (floor === undefined || compareVersion(floor, requiredFloor) < 0) {
    fail(`peerDependencies["${name}"] = "${range}" admits versions below ${REQUIRED_DSH_PEER_FLOOR}, `
      + 'which lacks the scoped tools/configForms APIs this package uses')
  }
}

// 8. The bundle manifest row points at a real patch file.
const patch = pkg.dsh?.bundle?.patch
if (typeof patch !== 'string') fail('package.json: dsh.bundle.patch is missing')
else if (!readRepoFile(patch)) fail(`bundle patch is missing: ${patch}`)

// Report.
if (failures.length > 0) {
  console.error(`verify-manifest: ${failures.length} problem(s)\n`)
  for (const failure of failures) console.error(`  ✗ ${failure}`)
  process.exit(1)
}
console.log('verify-manifest: manifest matches the build artifacts')
