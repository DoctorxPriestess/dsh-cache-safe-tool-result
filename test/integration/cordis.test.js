/**
 * Integration tests against a REAL Cordis context.
 *
 * These prove the two claims the design rests on, using the installed runtime
 * rather than a double:
 *   1. a plain plugin can register a service with `ctx.provide(name, value)`;
 *   2. a scope that already has that service rejects the duplicate, so the
 *      plugin fails loud instead of running beside an unguarded pruner;
 *   3. `ctx.isolate(name, label)` really does hide an implementation from the
 *      parent scope - the reason a wrapper is impossible and a replacement is
 *      required.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const DSH_HOME = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh')
const PROFILE = join(DSH_HOME, 'profiles', 'web')
const localRequire = createRequire(import.meta.url)

/**
 * Resolve `@deepseek-ai/cordis` from any place this checkout can legitimately
 * reach it, without adding a dependency the plugin does not need:
 *   1. a local `node_modules` (when the repo is developed inside a DSH tree);
 *   2. the DSH installation named by `DSH_INSTALL` (default `D:\dsh`), which
 *      carries cordis as a transitive dependency of `@deepseek-ai/dsh`;
 *   3. the `web` profile's own `node_modules`.
 * The tests skip - they do not fail - when none of them resolves, so the suite
 * still runs on a machine with no DSH installed.
 * @returns the cordis module namespace, or `null`.
 */
async function loadCordis() {
  /** A require anchor whose directory resolution walks up into the DSH tree. */
  const anchors = [() => localRequire.resolve('@deepseek-ai/cordis')]
  const dshInstall = process.env.DSH_INSTALL ?? 'D:\\dsh'
  const dshPkg = join(dshInstall, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
  if (existsSync(dshPkg)) anchors.push(() => createRequire(dshPkg).resolve('@deepseek-ai/cordis'))
  if (existsSync(join(PROFILE, 'package.json'))) {
    anchors.push(() => createRequire(join(PROFILE, 'package.json')).resolve('@deepseek-ai/cordis'))
  }
  for (const resolve of anchors) {
    try {
      return await import(pathToFileURL(resolve()).href)
    } catch { /* try the next anchor */ }
  }
  return null
}

const cordis = await loadCordis()
const skip = cordis === null ? 'cordis is not resolvable from this checkout' : false

test('a plain plugin can provide a service', { skip }, async () => {
  const firstPass = await import('../../src/index.js')
  const pruner = await import('../../src/guarded-pruner.js')
  const root = new cordis.Context()
  const ctx = root.extend()

  const stats = firstPass.apply(ctx, {})
  assert.equal(typeof stats, 'object', 'apply returns read-only counters')
  assert.equal(typeof ctx.get('toolResultPruner'), 'undefined', 'nothing provided yet')

  pruner.apply(ctx, {})
  const service = ctx.get('toolResultPruner')
  assert.ok(service, 'the guarded pruner is resolvable by the built-in name')
  assert.equal(typeof service.pruneSession, 'function')
  assert.equal(typeof service.pruneContent, 'function')
})

test('a duplicate provide is rejected loudly', { skip }, async () => {
  const pruner = await import('../../src/guarded-pruner.js')
  const root = new cordis.Context()
  const a = root.extend()
  const b = root.extend()

  pruner.apply(a, {})
  assert.throws(() => pruner.apply(b, {}), /has been registered/)
})

test('an isolated scope hides the service from its parent', { skip }, async () => {
  const pruner = await import('../../src/guarded-pruner.js')
  const root = new cordis.Context()
  const group = root.isolate('toolResultPruner', Symbol('preset-group'))
  pruner.apply(group, {})

  assert.ok(group.get('toolResultPruner'), 'visible inside the isolate scope')
  assert.equal(root.get('toolResultPruner'), undefined, 'invisible outside it - no external wrapping is possible')
})

/**
 * The combined row, mounted on a real Cordis context and driven through the
 * context's own `waterfall`, with the same decision shapes `dsh-tools`'
 * `postExecute` uses (`{ kind: 'accept' }` as the inner behavior).
 */
test('the combined row truncates through a real cordis waterfall', { skip }, async () => {
  const both = await import('../../src/both.js')
  const root = new cordis.Context()
  const ctx = root.extend()

  const mounted = both.apply(ctx, {})
  assert.ok(mounted.firstPass !== null, 'the first-pass half mounted')
  assert.ok(mounted.guardedPruner !== null, 'the guarded-pruner half mounted')
  assert.ok(ctx.get('toolResultPruner'), 'the guarded pruner is the provider')

  const inner = async () => ({ kind: 'accept' })
  const big = { content: [{ type: 'text', text: 'q'.repeat(60000) }] }
  const decision = await ctx.waterfall(ctx, 'tools/post-execute', { callId: 'c1', name: 'probe' }, big, inner)
  assert.equal(decision.kind, 'accept')
  assert.ok(Array.isArray(decision.content), 'the content was replaced')
  assert.ok(decision.content[0].text.length < 60000, 'the appended form is the truncated one')
  assert.ok(decision.content[0].text.includes('[... tool result middle pruned ...]'))

  const small = await ctx.waterfall(ctx, 'tools/post-execute', { callId: 'c2', name: 'probe' }, { content: [{ type: 'text', text: 'small' }] }, inner)
  assert.deepEqual(small, { kind: 'accept' }, 'in-budget results pass through untouched')
})

test('a disabled half really is absent', { skip }, async () => {
  const both = await import('../../src/both.js')

  /* Each half needs its own root: `extend()` derives a sibling scope over the
   * SAME service registry, so a provider registered on one is visible on the
   * other and would make this test prove nothing. */
  const guardRoot = new cordis.Context()
  const guardOnly = guardRoot.extend()
  const guardMounted = both.apply(guardOnly, { firstPass: false })
  assert.equal(guardMounted.firstPass, null)
  assert.ok(guardOnly.get('toolResultPruner'), 'only the guard half mounted')
  const inner = async () => ({ kind: 'accept' })
  const decision = await guardOnly.waterfall(guardOnly, 'tools/post-execute', { callId: 'c1' }, { content: [{ type: 'text', text: 'q'.repeat(60000) }] }, inner)
  assert.deepEqual(decision, { kind: 'accept' }, 'no listener: the waterfall returns the inner decision')

  const firstPassRoot = new cordis.Context()
  const firstPassOnly = firstPassRoot.extend()
  const firstPassMounted = both.apply(firstPassOnly, { guardedPruner: false })
  assert.equal(firstPassMounted.guardedPruner, null)
  assert.ok(firstPassMounted.firstPass !== null, 'only the first-pass half mounted')
  assert.equal(firstPassOnly.get('toolResultPruner'), undefined, 'no provider was registered')

  assert.throws(() => both.apply(new cordis.Context(), { firstPass: false, guardedPruner: false }), /both halves are disabled/)
})

test('the plugin surface is small and dependency-free', async () => {
  const fs = await import('node:fs/promises')
  for (const file of ['src/index.js', 'src/truncate.js', 'src/guarded-pruner.js', 'src/both.js']) {
    const src = await fs.readFile(join(here, '..', '..', file), 'utf8')
    const imports = [...src.matchAll(/^import[^\n]*from\s+'([^']+)'/gm)].map((m) => m[1])
    for (const specifier of imports) {
      assert.ok(
        specifier.startsWith('.') || specifier.startsWith('node:'),
        `${file} must only import relative or node: builtins, found ${specifier}`
      )
    }
  }
})

test('no absolute machine path is baked into the sources', async () => {
  const fs = await import('node:fs/promises')
  for (const file of ['src/index.js', 'src/truncate.js', 'src/guarded-pruner.js', 'src/both.js']) {
    const src = await fs.readFile(join(here, '..', '..', file), 'utf8')
    assert.ok(!/[A-Za-z]:\\\\/.test(src), `${file} must not contain a Windows absolute path`)
    assert.ok(!/ControlxSaria|DoctorxPriestess/.test(src), `${file} must not contain a user-specific name`)
  }
})
