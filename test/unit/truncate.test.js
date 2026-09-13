import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULTS,
  PRUNE_MARKER,
  codePointLength,
  measureContent,
  resolveBudgets,
  truncateContent
} from '../../src/truncate.js'
import { makeSession, makeToolContext, appendToolResult, appendSettledRequest, toolResultText } from '../helpers/harness.js'

const budgets = resolveBudgets()
const text = (value) => ({ type: 'text', text: value })

test('defaults match the installed built-in pruner', () => {
  assert.deepEqual(DEFAULTS, { thresholdChars: 8192, headChars: 4096, tailChars: 1024 })
  assert.equal(PRUNE_MARKER, '\n\n[... tool result middle pruned ...]\n\n')
})

test('short text is returned untouched', () => {
  assert.equal(truncateContent([text('short')], budgets), null)
})

test('exactly-at-threshold text is untouched', () => {
  const at = 'a'.repeat(DEFAULTS.thresholdChars)
  assert.equal(truncateContent([text(at)], budgets), null)
})

test('over-budget text keeps the exact head/marker/tail geometry', () => {
  const out = truncateContent([text('a'.repeat(100000))], budgets)
  assert.ok(out, 'truncates')
  assert.equal(out.length, 1)
  const value = out[0].text
  assert.equal(value.length, DEFAULTS.headChars + codePointLength(PRUNE_MARKER) + DEFAULTS.tailChars)
  assert.ok(value.startsWith('a'.repeat(DEFAULTS.headChars)))
  assert.ok(value.endsWith('a'.repeat(DEFAULTS.tailChars)))
  assert.ok(value.includes(PRUNE_MARKER))
  assert.ok(measureContent(out) <= DEFAULTS.thresholdChars)
})

test('surrogate pairs are never split by a retained boundary', () => {
  const emoji = '\u{1F600}'
  const out = truncateContent([text(emoji.repeat(20000))], budgets)
  assert.ok(out)
  const value = out[0].text
  assert.equal(codePointLength(value), DEFAULTS.headChars + codePointLength(PRUNE_MARKER) + DEFAULTS.tailChars)
  /* No lone surrogate may appear anywhere: the cut landed on a code-point
   * boundary on both sides of the removed span. */
  assert.ok(!/(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]|[\uD800-\uDBFF]($|[^\uDC00-\uDFFF])/.test(value))
})

test('multiple text blocks keep their order and the marker appears once', () => {
  /* Total spans the whole content, so the head lands in block 1 and the tail in
   * block 3; the fully-removed middle block contributes no text and is dropped,
   * exactly as the built-in pruner behaves. */
  const blocks = [text('x'.repeat(5000)), text('y'.repeat(9000)), text('z'.repeat(2000))]
  const out = truncateContent(blocks, budgets)
  assert.ok(out)
  assert.ok(out.length >= 2, 'the outer text blocks survive')
  const joined = out.map((b) => b.text).join('')
  assert.equal(joined.split(PRUNE_MARKER).length - 1, 1, 'marker appears exactly once')
  assert.ok(out[0].text.startsWith('x'), 'leading block keeps its head')
  assert.ok(out.at(-1).text.endsWith('z'), 'trailing block keeps its tail')
  assert.ok(!out.some((b) => b.text.includes('y')), 'the fully-removed middle span is gone')
  assert.ok(measureContent(out) <= DEFAULTS.thresholdChars)
})

test('non-text blocks are preserved in position', () => {
  const image = { type: 'image', attachment: { attachmentId: 'a1' } }
  const blocks = [text('x'.repeat(5000)), image, text('y'.repeat(9000))]
  const out = truncateContent(blocks, budgets)
  assert.ok(out)
  assert.equal(out[1], image, 'the rich block is passed through by identity')
  assert.equal(out.length, 3)
})

test('configurable budgets are honoured', () => {
  const small = resolveBudgets({ thresholdChars: 100, headChars: 40, tailChars: 20 })
  const out = truncateContent([text('a'.repeat(500))], small)
  assert.equal(measureContent(out), 40 + codePointLength(PRUNE_MARKER) + 20)
})

test('invalid budgets throw instead of silently truncating', () => {
  assert.throws(() => resolveBudgets({ thresholdChars: 0 }), /thresholdChars must be positive/)
  assert.throws(() => resolveBudgets({ headChars: -1 }), /non-negative integer/)
  assert.throws(() => resolveBudgets({ thresholdChars: 10, headChars: 9, tailChars: 9 }), /must be at most thresholdChars/)
})

/* ------------------------------------------------------------------ *
 * FIRST-PASS through the real plugin row and a waterfall double
 * ------------------------------------------------------------------ */

async function loadFirstPass(config) {
  const mod = await import('../../src/index.js')
  const { ctx, invoke } = makeToolContext()
  const stats = mod.apply(ctx, config)
  return { mod, invoke, stats }
}

test('first-pass truncates before admission and leaves value alone', async () => {
  const { invoke } = await loadFirstPass({})
  const decision = await invoke({ callId: 'c1', name: 'pwsh' }, { content: [text('a'.repeat(100000))] })
  assert.equal(decision.kind, 'accept')
  assert.ok(Array.isArray(decision.content), 'content replaced')
  assert.ok(!Object.prototype.hasOwnProperty.call(decision, 'value'), 'value arm untouched')
  assert.ok(measureContent(decision.content) <= DEFAULTS.thresholdChars)
})

test('first-pass leaves in-budget results on the built-in accept path', async () => {
  const { invoke } = await loadFirstPass({})
  const decision = await invoke({ callId: 'c1', name: 'read' }, { content: [text('short')] })
  assert.deepEqual(decision, { kind: 'accept' })
})

test('first-pass truncates a failed result text but never its value', async () => {
  const { invoke } = await loadFirstPass({})
  const decision = await invoke({ callId: 'c1' }, { content: [text('e'.repeat(50000))], isError: true })
  assert.equal(decision.kind, 'accept')
  assert.ok(decision.content[0].text.includes(PRUNE_MARKER))
  assert.ok(!Object.prototype.hasOwnProperty.call(decision, 'value'))
})

test('an upstream block decision wins', async () => {
  const { invoke } = await loadFirstPass({})
  const block = { kind: 'block', feedback: [text('denied')] }
  const decision = await invoke({ callId: 'c1' }, { content: [text('a'.repeat(50000))] }, async () => block)
  assert.equal(decision, block)
})

test('an upstream content decision wins', async () => {
  const { invoke } = await loadFirstPass({})
  const upstream = { kind: 'accept', content: [text('already handled')] }
  const decision = await invoke({ callId: 'c1' }, { content: [text('a'.repeat(50000))] }, async () => upstream)
  assert.equal(decision, upstream)
})

test('an upstream value decision wins', async () => {
  const { invoke } = await loadFirstPass({})
  const upstream = { kind: 'accept', value: { ok: true } }
  const decision = await invoke({ callId: 'c1' }, { content: [text('a'.repeat(50000))] }, async () => upstream)
  assert.equal(decision, upstream)
})

test('a missing content array is bypassed, not thrown on', async () => {
  const { invoke } = await loadFirstPass({})
  const decision = await invoke({ callId: 'c1' }, {})
  assert.deepEqual(decision, { kind: 'accept' })
})

test('includeNested:false bypasses sub-dispatch results', async () => {
  const { invoke } = await loadFirstPass({ includeNested: false })
  const decision = await invoke({ callId: 'c1', parent: 'root' }, { content: [text('a'.repeat(50000))] })
  assert.deepEqual(decision, { kind: 'accept' })
})

test('an unexpected error in the row fails open for the tool call', async () => {
  const { invoke } = await loadFirstPass({})
  /* A hostile result whose content getter throws stands in for a harness API
   * change; the built-in result must still be delivered unchanged. The row must
   * hand back the inner decision itself: `postExecute` dereferences the
   * waterfall result unconditionally, so returning `undefined` would turn a
   * successful tool call into a TypeError. */
  const hostile = {
    get content() { throw new Error('harness API changed') }
  }
  const decision = await invoke({ callId: 'c1' }, hostile)
  assert.deepEqual(decision, { kind: 'accept' }, 'the caller keeps its default accept decision')
})

test('the row truncates what would have been appended, end to end', async () => {
  const { invoke } = await loadFirstPass({})
  const { session } = makeSession()
  appendSettledRequest(session)
  const big = 'r'.repeat(120000)
  const decision = await invoke({ callId: 'c9', name: 'pwsh' }, { content: [text(big)] })
  /* Mirror the loop: it appends decision.content ?: result.content. */
  const seq = session.append('tool/result', { message: { role: 'user', content: [{ type: 'tool-result', toolCallId: 'c9', content: decision.content }] } }, { surfaceOp: 'append' }).seq
  const admitted = toolResultText(session, seq)
  assert.ok(admitted.includes(PRUNE_MARKER), 'the appended form is the truncated one')
  assert.ok(measureContent(decision.content) <= DEFAULTS.thresholdChars)
  assert.notEqual(admitted, big)
})
