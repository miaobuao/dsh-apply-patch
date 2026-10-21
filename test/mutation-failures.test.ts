/** Mutation failures expose committed changes without claiming an unconfirmed removal. */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { FsError, FsTargetKey, FsVersion, type FsObservation, type FsTarget } from '@deepseek-ai/dsh-fs'
import { applyHunks, ApplyFailure, type ApplyPatchCapabilities } from '../src/host/applier.js'
import { parsePatch } from '../src/host/parser.js'

function fixture() {
  const files = new Map([['a', { content: 'old\n', version: FsVersion('1') }]])
  const observed: Array<{ path: string; observation: FsObservation }> = []
  const caps: ApplyPatchCapabilities = {
    fs: {
      async stat(target) {
        const file = files.get(target.displayPath)
        return file === undefined ? undefined : { type: 'file', version: file.version }
      },
      async readText(target) { return files.get(target.displayPath)!.content },
      async writeText(target, content, intent) {
        const previous = files.get(target.displayPath)
        if (intent?.kind === 'replaceIfVersion' && previous?.version !== intent.version) {
          throw new FsError('stale write', 'FS_STALE_VERSION')
        }
        if (intent?.kind === 'createIfAbsent' && previous !== undefined) {
          throw new FsError('unread file', 'FS_NOT_OBSERVED')
        }
        const version = FsVersion('written')
        files.set(target.displayPath, { content, version })
        return { operation: previous === undefined ? 'create' : 'update', version, before: previous?.content ?? null, after: content }
      },
      processPath(target) { return target.displayPath },
    },
    shell: undefined,
    observe(target, observation) { observed.push({ path: target.displayPath, observation }) },
    async writeIntent() { return undefined },
  }
  const resolve = async (path: string): Promise<FsTarget> => ({ targetKey: FsTargetKey(path), displayPath: path })
  const run = (body: string, strict = false, signal = new AbortController().signal) =>
    applyHunks(parsePatch(`*** Begin Patch\n${body}\n*** End Patch`), resolve, caps, undefined, signal,
      { allowUnobservedOverwrite: !strict })
  return { caps, files, observed, run }
}

/** This shell loses the result after execution was requested; removal is unconfirmed. */
function disconnectedShell(): NonNullable<ApplyPatchCapabilities['shell']> {
  return {
    resolve(request) {
      return { ...request, workdir: '/', timeoutMs: 1000, onExpiry: 'kill', stdoutMaxBytes: 1024, sandboxPolicy: request.sandboxPolicy }
    },
    async execute() { throw new Error('lost shell connection') },
  }
}

const move = '*** Update File: a\n*** Move to: b\n@@\n-old\n+new'

describe('structured mutation failures', () => {
  it('preflights missing Move deletion capability before writing the destination', async () => {
    const { run, files } = fixture()
    await assert.rejects(run(move), (error: unknown) => {
      assert.ok(error instanceof ApplyFailure)
      assert.equal(error.stage, 'move-write')
      assert.deepEqual(error.applied, [])
      assert.equal(error.landedAt, undefined)
      return true
    })
    assert.equal(files.has('b'), false)
    assert.equal(files.get('a')?.content, 'old\n')
  })

  it('retains earlier hunks when Move preflight fails', async () => {
    const { run, files } = fixture()
    await assert.rejects(run(`*** Add File: created\n+hello\n${move}`), (error: unknown) => {
      assert.ok(error instanceof ApplyFailure)
      assert.deepEqual(error.applied, ['A created'])
      assert.deepEqual(error.affected.added, ['created'])
      assert.ok(Object.isFrozen(error.applied))
      assert.ok(Object.isFrozen(error.affected.added))
      return true
    })
    assert.equal(files.get('created')?.content, 'hello\n')
  })

  it('reports a landed destination and unknown source state after shell failure', async () => {
    const { run, files, caps, observed } = fixture()
    caps.shell = disconnectedShell()
    await assert.rejects(run(move), (error: unknown) => {
      assert.ok(error instanceof ApplyFailure)
      assert.equal(error.stage, 'move-remove')
      assert.equal(error.landedAt, 'b')
      assert.deepEqual(error.removal, { path: 'a', outcome: 'unknown' })
      assert.deepEqual(error.affected.modified, ['b'])
      assert.deepEqual(error.applied, ['M b'])
      assert.match(error.message, /Removal outcome is unknown/)
      assert.doesNotMatch(error.message, /still holds its previous contents/)
      return true
    })
    assert.equal(files.get('b')?.content, 'new\n')
    assert.equal(observed.some(entry => entry.path === 'a' && entry.observation.kind === 'absent'), false)
  })

  it('rejects a source changed after destination publication without starting rm', async () => {
    const { run, files, caps } = fixture()
    caps.shell = disconnectedShell()
    const observe = caps.observe
    caps.observe = (target, observation) => {
      observe(target, observation)
      if (target.displayPath === 'b') files.set('a', { content: 'external\n', version: FsVersion('external') })
    }
    await assert.rejects(run(move), (error: unknown) => {
      assert.ok(error instanceof ApplyFailure)
      assert.equal(error.code, 'FS_STALE_VERSION')
      assert.deepEqual(error.removal, { path: 'a', outcome: 'not-started' })
      assert.equal(error.landedAt, 'b')
      return true
    })
    assert.equal(files.get('a')?.content, 'external\n')
  })

  it('does not publish an observation for bytes read across a version change', async () => {
    const { run, files, caps, observed } = fixture()
    caps.fs.readText = async () => {
      files.set('a', { content: 'old\n', version: FsVersion('external') })
      return 'old\n'
    }
    await assert.rejects(run('*** Update File: a\n@@\n-old\n+new'), (error: unknown) => {
      assert.ok(error instanceof ApplyFailure)
      assert.equal(error.code, 'FS_STALE_VERSION')
      assert.equal(error.stage, 'verify')
      return true
    })
    assert.deepEqual(observed, [])
    assert.equal(files.get('a')?.version, 'external')
  })

  it('reports committed writes even when an observation listener throws', async () => {
    const { run, caps, files } = fixture()
    caps.observe = () => { throw new Error('recorder failed') }
    await assert.rejects(run('*** Add File: created\n+hello'), (error: unknown) => {
      assert.ok(error instanceof ApplyFailure)
      assert.deepEqual(error.applied, ['A created'])
      assert.deepEqual(error.affected.added, ['created'])
      assert.match(error.message, /recorder failed/)
      return true
    })
    assert.equal(files.get('created')?.content, 'hello\n')
  })

  it('does not mutate when cancellation precedes application', async () => {
    const { run, files } = fixture()
    const controller = new AbortController()
    controller.abort(new Error('cancelled'))
    await assert.rejects(run('*** Add File: created\n+hello', false, controller.signal), (error: unknown) => {
      assert.ok(error instanceof ApplyFailure)
      assert.equal(error.stage, 'resolve')
      assert.deepEqual(error.applied, [])
      return true
    })
    assert.equal(files.has('created'), false)
  })
})
