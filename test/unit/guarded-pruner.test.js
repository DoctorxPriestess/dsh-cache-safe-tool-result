import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

import { createGuardedPruner, hasProviderRequestAfter } from '../../src/guarded-pruner.js'
import { DEFAULTS, PRUNE_MARKER, measureContent } from '../../src/truncate.js'
import { makeSession, appendToolResult, appendSettledRequest, toolResultText } from '../helpers/harness.js'

const LONG = 'Z'.repeat(50000)
const hash = (value) => createHash('sha256').update(value).digest('hex')
const pruner = () => createGuardedPruner()

/* ------------------------------------------------------------------ *
 * B. CACHE-SAFE tests
 * ------------------------------------------------------------------ */

test('undelivered node: still pruned (first-pass capacity retained)', () => {
  const { session, log } = makeSession()
  appendSettledRequest(session)          // a request happened before the result
  const seq = appendToolResult(session, 'c1', LONG)  // appended after it: undelivered

  const result = pruner().pruneSession(session)

  assert.equal(result.pruned.length, 1)
  assert.equal(result.pruned[0].originalSeq, seq)
  assert.ok(result.pruned[0].charsAfter <= DEFAULTS.thresholdChars)
  assert.ok(result.charsRemoved > 0)
  assert.equal(log.filter((e) => e.type === 'compaction/prune').length, 1, 'shadow-price event emitted for a landing')
  assert.equal(log.filter((e) => e.surfaceOp?.op === 'replace').length, 1)
})

test('delivered once: skipped, and the node stays byte-identical', () => {
  const { session, log, nodes } = makeSession()
  const seq = appendToolResult(session, 'c1', LONG)
  appendSettledRequest(session)          // a request carried it

  const before = hash(toolResultText(session, seq))
  const result = pruner().pruneSession(session)
  const after = hash(toolResultText(session, seq))

  assert.equal(result.pruned.length, 0)
  assert.equal(result.charsRemoved, 0)
  assert.equal(before, after, 'content hash unchanged')
  assert.deepEqual(nodes, [seq, seq + 1], 'surface order untouched')
  assert.equal(log.filter((e) => e.type === 'compaction/prune').length, 0, 'no shadow-price event for a refused node')
})

test('delivered many times: still skipped', () => {
  const { session } = makeSession()
  const seq = appendToolResult(session, 'c1', LONG)
  for (let i = 0; i < 25; i++) appendSettledRequest(session)

  const result = pruner().pruneSession(session)
  assert.equal(result.pruned.length, 0)
  assert.equal(toolResultText(session, seq).length, LONG.length)
})

test('assistant/attempt counts as delivered (conservative)', () => {
  const { session } = makeSession()
  const seq = appendToolResult(session, 'c1', LONG)
  appendSettledRequest(session, 'assistant/attempt')

  const result = pruner().pruneSession(session)
  assert.equal(result.pruned.length, 0)
  assert.equal(toolResultText(session, seq).length, LONG.length)
})

test('UNKNOWN delivery state is skipped (fail closed)', () => {
  const { session } = makeSession()
  const seq = appendToolResult(session, 'c1', LONG)
  const broken = {
    surface: session.surface,
    eventAt: (s) => session.eventAt(s),
    /* snapshotEvents missing: the pass cannot prove anything */
    append: (...args) => session.append(...args)
  }

  const service = pruner()
  const result = service.pruneSession(broken)

  assert.equal(result.pruned.length, 0)
  assert.equal(service.stats.skippedUnprovable, 1)
  assert.equal(toolResultText(session, seq).length, LONG.length)
  assert.equal(hasProviderRequestAfter.length, 2)
  assert.throws(() => hasProviderRequestAfter({}, 1), /snapshotEvents is unavailable/)
})

test('a throwing snapshotEvents is skipped, not crashed on', () => {
  const { session } = makeSession()
  const seq = appendToolResult(session, 'c1', LONG)
  const broken = {
    surface: session.surface,
    eventAt: (s) => session.eventAt(s),
    snapshotEvents: () => { throw new Error('log window gone') },
    append: (...args) => session.append(...args)
  }
  const service = pruner()
  const result = service.pruneSession(broken)
  assert.equal(result.pruned.length, 0)
  assert.equal(service.stats.skippedUnprovable, 1)
  assert.equal(toolResultText(session, seq).length, LONG.length)
})

test('repeated triggers never rewrite an already-sent node', () => {
  const { session, log } = makeSession()
  const seq = appendToolResult(session, 'c1', LONG)
  appendSettledRequest(session)
  const service = pruner()

  for (let i = 0; i < 5; i++) service.pruneSession(session)

  assert.equal(service.stats.skippedDelivered, 5)
  assert.equal(log.filter((e) => e.surfaceOp?.op === 'replace').length, 0)
  assert.equal(toolResultText(session, seq).length, LONG.length)
})

test('resume/replay does not re-replace a delivered node', () => {
  /* A resumed session re-folds its log: the same tool result is still followed
   * by a settled request, so it is still refused. */
  const { session } = makeSession()
  const seq = appendToolResult(session, 'c1', LONG)
  appendSettledRequest(session)
  const replayed = {
    surface: session.surface,
    eventAt: (s) => session.eventAt(s),
    snapshotEvents: (from, to) => session.snapshotEvents(from, to),
    append: (...args) => session.append(...args)
  }
  const service = pruner()
  assert.equal(service.pruneSession(replayed).pruned.length, 0)
  assert.equal(service.pruneSession(replayed).pruned.length, 0)
  assert.equal(toolResultText(session, seq).length, LONG.length)
})

test('a forked/seeded log with a shifted base seq behaves identically', () => {
  const { session } = makeSession({ baseSeq: 1000 })
  const seq = appendToolResult(session, 'c1', LONG)
  appendSettledRequest(session)
  assert.equal(seq, 1000)
  const result = pruner().pruneSession(session)
  assert.equal(result.pruned.length, 0)
  assert.equal(toolResultText(session, seq).length, LONG.length)
})

test('a child agent surface is guarded the same way', () => {
  /* A child session is just another session; nothing in the guard is global. */
  const parent = makeSession()
  appendToolResult(parent.session, 'p1', LONG)
  appendSettledRequest(parent.session)

  const child = makeSession()
  const childSeq = appendToolResult(child.session, 'c1', LONG)
  appendSettledRequest(child.session)

  assert.equal(pruner().pruneSession(child.session).pruned.length, 0)
  assert.equal(toolResultText(child.session, childSeq).length, LONG.length)
})

test('mixed surface: undelivered is pruned while delivered stays byte-stable', () => {
  const { session } = makeSession()
  const delivered = appendToolResult(session, 'old', LONG)
  appendSettledRequest(session)
  const fresh = appendToolResult(session, 'new', LONG)

  const deliveredBefore = hash(toolResultText(session, delivered))
  const result = pruner().pruneSession(session)

  assert.equal(result.pruned.length, 1, 'exactly the fresh node')
  assert.equal(result.pruned[0].originalSeq, fresh)
  assert.equal(hash(toolResultText(session, delivered)), deliveredBefore, 'delivered node byte-stable')
  assert.ok(toolResultText(session, result.pruned[0].replacementSeq).includes(PRUNE_MARKER))
})

/* ------------------------------------------------------------------ *
 * Interface parity with the built-in service
 * ------------------------------------------------------------------ */

test('service exposes the built-in contract', () => {
  const service = pruner()
  assert.deepEqual(Object.keys(service.config).sort(), ['headChars', 'tailChars', 'thresholdChars'])
  assert.equal(typeof service.measureContent, 'function')
  assert.equal(typeof service.pruneContent, 'function')
  assert.equal(typeof service.pruneSession, 'function')
  assert.equal(service.pruneContent([{ type: 'text', text: 'short' }]), null)
})

test('pruneContent mirrors the built-in geometry for the same input', () => {
  const out = pruner().pruneContent([{ type: 'text', text: 'q'.repeat(20000) }])
  assert.equal(measureContent(out), DEFAULTS.headChars + PRUNE_MARKER.length + DEFAULTS.tailChars)
})

test('result shape matches the built-in service', () => {
  const { session } = makeSession()
  appendSettledRequest(session)
  appendToolResult(session, 'c1', LONG)
  const result = pruner().pruneSession(session)
  assert.deepEqual(Object.keys(result).sort(), ['charsRemoved', 'pruned'])
  assert.deepEqual(Object.keys(result.pruned[0]).sort(), ['callId', 'charsAfter', 'charsBefore', 'originalSeq', 'replacementSeq'])
})

test('a surface-less session is skipped without throwing', () => {
  const service = pruner()
  assert.deepEqual(service.pruneSession(undefined), { pruned: [], charsRemoved: 0 })
  assert.deepEqual(service.pruneSession({}), { pruned: [], charsRemoved: 0 })
})

test('a rejected append leaves no partial rewrite behind', () => {
  const { session } = makeSession()
  appendSettledRequest(session)
  const seq = appendToolResult(session, 'c1', LONG)
  const broken = {
    surface: session.surface,
    eventAt: (s) => session.eventAt(s),
    snapshotEvents: (from, to) => session.snapshotEvents(from, to),
    append: () => { throw new Error('session is read-only') }
  }
  const service = pruner()
  const result = service.pruneSession(broken)
  assert.equal(result.pruned.length, 0)
  assert.equal(toolResultText(session, seq).length, LONG.length)
})
