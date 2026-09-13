/**
 * Head/middle/tail text truncation, shared by both halves of this plugin.
 *
 * COMPATIBILITY NOTE (upstream-mirrored algorithm)
 * ------------------------------------------------
 * This is a deliberate, character-for-character port of the algorithm shipped
 * in `@deepseek-ai/dsh-compaction-tool-result-pruner` (v0.1.5-rc.2), including
 * its default budgets and its marker string. Two independent reasons force the
 * port instead of a reuse:
 *
 * 1. Importing that package for its `pruneContent`/`PRUNE_MARKER` exports is not
 *    side-effect free: the module's default export is a Cordis `Service` that
 *    registers itself as `toolResultPruner` on construction. A plugin that
 *    imported it would either collide with the built-in row (Cordis rejects a
 *    duplicate `provide`) or drag a second pruner into the tree.
 * 2. The guard half replaces the built-in service provider (see README), so it
 *    must implement the same `pruneSession` contract itself. Sharing one local
 *    implementation keeps both halves - and any future upstream drift - in one
 *    place.
 *
 * The port is ~50 lines and is covered by tests that assert it produces the
 * same geometry as the built-in pruner for the same input. If upstream changes
 * the algorithm, only this file needs to follow; see README "Known limitations".
 *
 * @module dsh-cache-safe-tool-result/truncate
 */

/**
 * Marker substituted for every removed middle span.
 * Byte-identical to `PRUNE_MARKER` in the built-in pruner, so a transcript that
 * was truncated by either mechanism reads the same to the model.
 */
export const PRUNE_MARKER = '\n\n[... tool result middle pruned ...]\n\n'

/** Defaults, mirrored from the built-in pruner (`DEFAULTS`). */
export const DEFAULTS = Object.freeze({
  thresholdChars: 8192,
  headChars: 4096,
  tailChars: 1024
})

/**
 * Count Unicode code points without splitting surrogate pairs.
 * @param text - text to measure.
 * @returns the Unicode code-point count.
 */
export function codePointLength(text) {
  return Array.from(text).length
}

/**
 * Measure text content in Unicode code points; non-text blocks cost zero.
 * @param blocks - tool-result content to measure.
 * @returns total Unicode code points across text blocks.
 */
export function measureContent(blocks) {
  let chars = 0
  for (const block of blocks) if (block.type === 'text') chars += codePointLength(block.text)
  return chars
}

/**
 * Validate and freeze truncation budgets.
 * @param config - untrusted configuration.
 * @returns a frozen `{thresholdChars, headChars, tailChars}`.
 * @throws when a budget is not a non-negative integer or the emitted span
 *   cannot fit inside `thresholdChars`.
 */
export function resolveBudgets(config = {}) {
  const resolved = {
    thresholdChars: config.thresholdChars ?? DEFAULTS.thresholdChars,
    headChars: config.headChars ?? DEFAULTS.headChars,
    tailChars: config.tailChars ?? DEFAULTS.tailChars
  }
  for (const key of ['thresholdChars', 'headChars', 'tailChars']) {
    const value = resolved[key]
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`dsh-cache-safe-tool-result: ${key} (${value}) must be a non-negative integer`)
    }
  }
  if (resolved.thresholdChars <= 0) {
    throw new Error('dsh-cache-safe-tool-result: thresholdChars must be positive')
  }
  const emitted = resolved.headChars + codePointLength(PRUNE_MARKER) + resolved.tailChars
  if (emitted > resolved.thresholdChars) {
    throw new Error(
      `dsh-cache-safe-tool-result: headChars + marker + tailChars (${emitted}) must be at most thresholdChars (${resolved.thresholdChars})`
    )
  }
  return Object.freeze(resolved)
}

/**
 * Replace an over-budget text middle while retaining rich-block order.
 *
 * Text slicing is by Unicode code point, not UTF-16 code unit, so a retained
 * boundary can never split a surrogate pair. Non-text blocks are copied
 * through in their original positions.
 * @param blocks - original tool-result content blocks.
 * @param budgets - resolved budgets from {@link resolveBudgets}.
 * @returns truncated content blocks, or `null` when the text is within budget
 *   (or when truncation cannot be proven to shrink the content).
 */
export function truncateContent(blocks, budgets) {
  const totalChars = measureContent(blocks)
  if (totalChars <= budgets.thresholdChars) return null
  const removedStart = budgets.headChars
  const removedEnd = totalChars - budgets.tailChars
  const truncated = []
  let consumed = 0
  let markerInserted = false
  for (const block of blocks) {
    if (block.type !== 'text') {
      truncated.push(block)
      continue
    }
    const points = Array.from(block.text)
    const blockStart = consumed
    const blockEnd = blockStart + points.length
    const headEnd = Math.min(points.length, Math.max(0, removedStart - blockStart))
    const tailStart = Math.min(points.length, Math.max(0, removedEnd - blockStart))
    const marker = blockStart < removedEnd && blockEnd > removedStart && !markerInserted ? PRUNE_MARKER : ''
    if (marker.length > 0) markerInserted = true
    const text = points.slice(0, headEnd).join('') + marker + points.slice(tailStart).join('')
    if (text.length > 0) truncated.push({ ...block, text })
    consumed = blockEnd
  }
  if (!markerInserted) return null
  const charsAfter = measureContent(truncated)
  if (charsAfter > budgets.thresholdChars || charsAfter >= totalChars) return null
  return truncated
}
