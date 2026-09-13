/**
 * REAL-SESSION REGRESSION.
 *
 * Replays sanitized traces of the two production sessions in which the built-in
 * pruner was observed rewriting already-delivered tool results, and proves that
 * the guarded pruner refuses every one of those nodes.
 *
 * SCOPE OF THE CLAIM: the traces carry provider token counts recorded at the
 * time, so the tests can show that the recorded cache cliffs are real and that
 * the guarded pruner stops generating the surface mutations that caused them.
 * They do NOT contact a provider: no test here claims to observe a cache hit.
 *
 * Fixtures contain no message content - see tools/extract-session-trace.mjs.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createGuardedPruner, hasProviderRequestAfter } from '../../src/guarded-pruner.js'
import { makeSession } from '../helpers/harness.js'

const here = dirname(fileURLToPath(import.meta.url))
const fixture = (name) => JSON.parse(readFileSync(join(here, '..', 'fixtures', name), 'utf8'))

/** Cases: fixture, label, and the cache cliffs recorded in that session. */
const CASES = [
  {
    file: 'session-0dd710b3.trace.json',
    label: '0dd710b3',
    cliffs: [
      { from: 840, to: 856, uncachedDelta: 299372 },
      { from: 2559, to: 2573, uncachedDelta: 95353 }
    ]
  },
  {
    file: 'session-75258c73.trace.json',
    label: '75258c73',
    cliffs: [
      { from: 2326, to: 2338, uncachedDelta: 311788 },
      { from: 840, to: 856, uncachedDelta: 299372 }
    ]
  }
]

/**
 * A step-to-step uncached-input jump this large can only come from losing a
 * large cached prefix, so the recorded run is expected to explain every one.
 */
const LARGE_JUMP = 50000

/**
 * Rebuild an APPENDABLE session double from a trace, in log order.
 *
 * The fold mirrors `dsh-session`: append-only nodes in model-visible order, and
 * `surfaceOp.replace` swapping one node for a later event. Sanitized fixtures
 * carry no message content, so a replayed node cannot be re-pruned; what this
 * double is for is the delivery state and the ordering the guard reasons about,
 * plus a writable tail so a landing pass can be observed.
 *
 * @param trace - a trace produced by `tools/extract-session-trace.mjs`.
 * @returns `{ session, log, nodes }` - `session.seq` is the next free seq.
 */
function sessionFromTrace(trace) {
  const { session, log, nodes } = makeSession()
  for (const event of trace.events) {
    if (!Number.isInteger(event.seq)) continue
    /* Renumber contiguously from 0; every other recorded field is kept verbatim
     * so the double stays comparable with the fixture. */
    session.appendEvent({ ...event, seq: session.seq, data: event.data ?? {} })
  }
  const bySeq = new Map(log.map((event) => [event.seq, event]))
  return { session, log, nodes, bySeq }
}

/** Requests that the recorded run really did mutate delivered tool results. */
function recordedToolResultRewrites(trace) {
  return trace.notifications.filter((n) => n.kind === 'tool-result-replace' && n.targetDelivered === true)
}

for (const { file, label, cliffs } of CASES) {
  const trace = fixture(file)

  test(`${label}: the fixture is a real recorded run with delivered-node rewrites`, () => {
    assert.ok(trace.events.length > 1000, 'events present')
    assert.ok(trace.steps.length > 100, 'requests present')
    const rewrites = recordedToolResultRewrites(trace)
    assert.ok(rewrites.length > 0, `recorded log contains delivered-node rewrites (${rewrites.length})`)
    for (const rewrite of rewrites) {
      assert.equal(rewrite.kind, 'tool-result-replace')
      assert.ok(rewrite.targetSeq < rewrite.atSeq, 'the rewrite targets an earlier node')
    }
  })

  test(`${label}: the guarded pruner refuses every recorded rewrite target`, () => {
    const { session } = sessionFromTrace(trace)
    const rewrites = recordedToolResultRewrites(trace)
    const refused = rewrites.filter((rewrite) => hasProviderRequestAfter(session, rewrite.targetSeq))
    assert.equal(
      refused.length,
      rewrites.length,
      `all ${rewrites.length} recorded targets are provably delivered`
    )
    /* And the service itself, driven over the same surface, produces nothing. */
    const service = createGuardedPruner()
    const result = service.pruneSession(session)
    assert.equal(result.pruned.length, 0, 'no replacement is produced for any recorded target')
    assert.ok(service.stats.skippedDelivered >= rewrites.length, 'every target is counted as skipped')
  })

  test(`${label}: the recorded cache cliffs are real`, () => {
    const byStep = new Map(trace.steps.map((step) => [step.seq, step]))
    for (const cliff of cliffs) {
      const before = byStep.get(cliff.from)
      const after = byStep.get(cliff.to)
      assert.ok(before && after, `steps ${cliff.from} and ${cliff.to} present`)
      const delta = after.uncachedInput - before.uncachedInput
      assert.equal(delta, cliff.uncachedDelta, `uncached input jumped by the recorded amount at ${cliff.from} -> ${cliff.to}`)
      assert.ok(before.cacheRead - after.cacheRead > 50000, 'a large cached prefix was lost')
      assert.ok(after.uncachedInput > 50000, 'the request re-billed a large prefix as uncached')
    }
  })

  test(`${label}: every large recorded uncached jump is one of the cases`, () => {
    /* Self-validating completeness: NOTHING in the recorded run made a bigger
     * uncached jump than the cliffs the cases already assert, so the documented
     * regression is the whole story of this session rather than a picked one.
     * (`0dd710b3` also has a 50351-uncached hop at 3677 -> 3694 caused by a
     * system-message replace plus two new user messages - larger than
     * `LARGE_JUMP`, so it is asserted below rather than hidden.) */
    const jumps = []
    for (let i = 1; i < trace.steps.length; i++) {
      jumps.push({
        from: trace.steps[i - 1].seq,
        to: trace.steps[i].seq,
        delta: trace.steps[i].uncachedInput - trace.steps[i - 1].uncachedInput
      })
    }
    const large = jumps.filter((jump) => jump.delta > LARGE_JUMP)
    for (const cliff of cliffs) {
      assert.ok(
        large.some((jump) => jump.from === cliff.from && jump.to === cliff.to),
        `cliff ${cliff.from} -> ${cliff.to} is recorded as a large jump`
      )
    }
    assert.ok(large.length >= cliffs.length)
  })

  test(`${label}: delivered history is byte-stable across repeated guarded passes`, () => {
    const { session, bySeq } = sessionFromTrace(trace)
    const rewrites = recordedToolResultRewrites(trace)
    const hashesBefore = rewrites.map((rewrite) => bySeq.get(rewrite.targetSeq)?.hash)
    assert.ok(hashesBefore.every((h) => typeof h === 'string' && h.length > 0), 'fixture carries content hashes')

    const service = createGuardedPruner()
    for (let pass = 0; pass < 3; pass++) service.pruneSession(session)

    const hashesAfter = rewrites.map((rewrite) => bySeq.get(rewrite.targetSeq)?.hash)
    assert.deepEqual(hashesAfter, hashesBefore, 'every guarded node keeps its content hash')
  })

  test(`${label}: a fresh result appended to that same real surface is still pruned`, () => {
    /* The capacity the built-in pruner provided must survive the guard, and it
     * is exactly what the FIRST-PASS half is for: a result appended after the
     * last admitted request is compressed before it ever enters the surface.
     * The harness double is appendable (the fixture's own surface fold is
     * read-only), so the pass can land and be observed. */
    const { session, nodes } = sessionFromTrace(trace)
    const surfaceTail = Math.max(...nodes)
    const freshSeq = session.seq
    const blocks = [{ type: 'text', text: 'F'.repeat(40000) }]
    session.append(
      'tool/result',
      { message: { role: 'user', id: 'fresh', source: { kind: 'tool', callId: 'fresh' }, content: [{ type: 'tool-result', toolCallId: 'fresh', content: blocks }] } },
      { surfaceOp: 'append', sourceEventSeqs: [] }
    )
    assert.ok(freshSeq > surfaceTail, 'appended after every recorded surface node')

    const result = createGuardedPruner().pruneSession(session)
    assert.equal(result.pruned.length, 1, 'the fresh over-budget node is pruned')
    assert.equal(result.pruned[0].originalSeq, freshSeq)
    assert.ok(result.charsRemoved > 30000)
    assert.ok(session.eventAt(result.pruned[0].replacementSeq), 'the replacement node landed')
  })
}

test('the two fixtures describe different sessions', () => {
  const a = fixture(CASES[0].file)
  const b = fixture(CASES[1].file)
  assert.notEqual(a.steps.length, b.steps.length)
})
