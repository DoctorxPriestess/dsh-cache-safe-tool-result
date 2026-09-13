/**
 * The installer is the one part of this plugin that edits a file the user owns,
 * so its patch-list round trip is pinned here: installing must add exactly two
 * entries, keep every unrelated entry, be idempotent, and revert to the exact
 * previous state.
 *
 * The fixtures are synthetic on purpose - the tests never read (or depend on) a
 * real profile on this machine.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  ENTRY,
  computePatches,
  parsePatchList,
  patchEntries,
  renderPatchList,
  resolveTarget,
  listProfiles
} from '../../tools/install-preset.mjs'

const UNRELATED = { id: 'save-token', config: { compressEnabled: true } }
const OTHER_USER_ENTRY = { insert: [{ id: 'my-own-plugin', name: 'my-plugin' }] }

test('install from an empty list adds the disable and the insert, in order', () => {
  const { patches, changed, notes } = computePatches([])
  assert.equal(changed, true)
  assert.equal(patches.length, 2)
  assert.deepEqual(patches[0], { id: 'tool-result-pruner', disabled: true })
  assert.equal(patches[1].insert.length, 1)
  assert.equal(patches[1].insert[0].id, 'cache-safe-tool-result')
  assert.equal(patches[1].insert[0].name, ENTRY)
  assert.equal(patches[1].insert[0].config.firstPass, true)
  assert.equal(patches[1].insert[0].config.guardedPruner, true)
  assert.equal(patches[1].insert[0].config.thresholdChars, 8192)
  assert.ok(notes.length > 0)
})

test('install is idempotent and keeps unrelated entries', () => {
  const first = computePatches([UNRELATED, OTHER_USER_ENTRY])
  assert.equal(first.patches.length, 4, 'two unrelated entries plus the two managed ones')
  const second = computePatches(first.patches)
  assert.equal(second.patches.length, first.patches.length)
  assert.deepEqual(second.patches, first.patches)
  assert.ok(second.patches.some((patch) => patch.id === 'save-token'), 'an unrelated id patch survives')
  assert.ok(second.patches.some((patch) => patch.insert?.[0]?.id === 'my-own-plugin'), 'an unrelated insert survives')
})

test('a hand-edited entry of ours is replaced, not duplicated', () => {
  const stale = [
    { id: 'tool-result-pruner', disabled: true },
    { insert: [{ id: 'cache-safe-tool-result', name: '/somewhere/else/both.js', config: { firstPass: false } }] }
  ]
  const { patches, notes } = computePatches(stale)
  assert.equal(patches.length, 2, 'still exactly two entries')
  assert.equal(patches[1].insert[0].name, ENTRY, 'the entry was refreshed to this checkout')
  assert.ok(notes.some((note) => note.includes('replaced')))
})

test('an explicit --entry is honoured', () => {
  const { patches } = computePatches([], { entry: 'D:/elsewhere/src/both.js' })
  assert.equal(patches[1].insert[0].name, 'D:/elsewhere/src/both.js')
})

test('revert removes exactly our two entries', () => {
  const installed = computePatches([UNRELATED]).patches
  const back = computePatches(installed, { revert: true })
  assert.equal(back.changed, true)
  assert.deepEqual(back.patches, [UNRELATED])
})

test('revert on a file that never had them changes nothing', () => {
  const { changed, patches } = computePatches([UNRELATED], { revert: true })
  assert.equal(changed, false)
  assert.deepEqual(patches, [UNRELATED])
})

test('a full install/revert cycle round-trips the parsed list', () => {
  const original = [UNRELATED, OTHER_USER_ENTRY]
  const installed = computePatches(original).patches
  const reverted = computePatches(installed, { revert: true }).patches
  assert.deepEqual(reverted, original)
})

test('a realistic YAML patch file parses', () => {
  const text = [
    '# Your patch layer for this dsh profile, applied after every bundle layer:',
    '# a top-level YAML array of loader patch entries.',
    '[',
    '  {',
    '    "id": "save-token",',
    '    "config": { "compressEnabled": true }',
    '  }',
    ']'
  ].join('\n')
  const parsed = parsePatchList(text)
  assert.deepEqual(parsed, [UNRELATED])
})

test('a block-style YAML patch file parses, including the insert form', () => {
  const text = [
    '# comments are ignored',
    '- id: tool-result-pruner',
    '  disabled: true',
    '- insert:',
    '    - id: cache-safe-tool-result',
    "      name: 'D:/repo/src/both.js'",
    '      config:',
    '        firstPass: true',
    '        guardedPruner: true',
    '        thresholdChars: 8192',
    ''
  ].join('\n')
  const parsed = parsePatchList(text)
  assert.equal(parsed.length, 2)
  assert.deepEqual(parsed[0], { id: 'tool-result-pruner', disabled: true })
  assert.deepEqual(parsed[1], {
    insert: [
      {
        id: 'cache-safe-tool-result',
        name: 'D:/repo/src/both.js',
        config: { firstPass: true, guardedPruner: true, thresholdChars: 8192 }
      }
    ]
  })
  /* And the parsed list is recognised as this plugin's, so a re-run replaces
   * rather than duplicates it. */
  const { patches } = computePatches(parsed)
  assert.equal(patches.length, 2)
})

test('an empty or comment-only file parses as an empty list', () => {
  assert.deepEqual(parsePatchList(''), [])
  assert.deepEqual(parsePatchList('   \n'), [])
})

test('a non-array patch file is refused with a clear message', () => {
  assert.throws(() => parsePatchList('{"id": "x"}'), /top-level YAML\/JSON array/)
  assert.throws(() => parsePatchList('[1, 2]'), /top-level YAML\/JSON array/, 'an array of non-objects is not a patch list')
  assert.throws(() => parsePatchList('- 1\n- 2\n'), /top-level YAML\/JSON array/)
  /* A line the reader cannot interpret is refused rather than skipped. */
  assert.throws(() => parsePatchList('- id: x\n  : bad\n'), /cannot read|top-level/u)
})

test('render emits a header, valid JSON, and an empty list when nothing is left', () => {
  const rendered = renderPatchList(patchEntries())
  assert.ok(rendered.startsWith('#'), 'header comment first')
  assert.deepEqual(parsePatchList(rendered), patchEntries())
  assert.equal(renderPatchList([]), '[]\n')
})

test('--list and resolveTarget work against a fake DSH home', () => {
  const env = { DSH_HOME: 'C:/fake/dsh-home' }
  assert.deepEqual(listProfiles(env), [], 'no profiles under a home that does not exist')
  assert.throws(() => resolveTarget({ profile: 'web' }, env), /no profile "web"/)
  assert.throws(() => resolveTarget({}, env), /--profile <name>/)
  const viaPatch = resolveTarget({ patch: 'C:/tmp/some-patch.yml' }, env)
  assert.equal(viaPatch.path, 'C:/tmp/some-patch.yml')
})
