#!/usr/bin/env node
/**
 * Wire this plugin into a DSH profile, safely and reversibly.
 *
 * WHERE THE ROW ACTUALLY LIVES
 * ---------------------------
 * The `toolResultPruner` provider is not a preset-only row. `dsh --dump-config`
 * shows it in the PROFILE composition, contributed by `@deepseek-ai/dsh-base`
 * at the top level:
 *
 *     - id: tool-result-pruner
 *       name: '@deepseek-ai/dsh-compaction-tool-result-pruner'
 *       config: { thresholdChars: 8192, headChars: 4096, tailChars: 1024 }
 *
 * That makes the profile's own `cordis.patch.yml` the right seam - it is the
 * documented user layer, applied after every bundle layer, and it needs no edit
 * to any preset and none to `node_modules`.
 *
 * WHY TWO ENTRIES
 * ---------------
 * An id-targeted patch cannot rename a row: a `name` on such a patch is a
 * mismatch guard, not an override (`applyEntryPatches` skips the patch and warns
 * when the names differ - verified against the installed loader). So the swap is
 * performed as the documented pair:
 *
 *     - id: tool-result-pruner
 *       disabled: true          # retire the built-in provider
 *     - insert:
 *         - id: cache-safe-tool-result
 *           name: '<this checkout>/src/both.js'
 *           config: { firstPass: true, guardedPruner: true, ... }
 *
 * `dsh-compaction-basic` resolves the service with `ctx.get("toolResultPruner")`
 * and takes the last provider, which is the inserted row.
 *
 * READING THE EXISTING FILE
 * -------------------------
 * A patch file is YAML, and the shipped template's own is a commented `[]`. The
 * installer parses the YAML subset a patch list actually uses - block sequences,
 * block mappings, flow collections, quoted scalars, comments - because silently
 * rewriting a list it could not read would destroy whatever else the user keeps
 * there. It writes the list back as JSON, which the loader accepts (JSON is a
 * YAML subset), so every later run parses a whole file.
 *
 * USAGE
 * -----
 *   node tools/install-preset.mjs --list
 *   node tools/install-preset.mjs --profile web --dry-run
 *   node tools/install-preset.mjs --profile web
 *   node tools/install-preset.mjs --profile web --revert
 *
 * `--patch <path>` targets a specific patch file instead of a profile's.
 *
 * @module dsh-cache-safe-tool-result/tools/install-preset
 */

import { copyFileSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')
const PATCH_FILE = 'cordis.patch.yml'
const PLUGIN_ROW_ID = 'cache-safe-tool-result'

/** The combined entry point a profile row should name. */
export const ENTRY = join(REPO, 'src', 'both.js').replace(/\\/gu, '/')

/** The DSH home this run targets. */
export function dshHome(env = process.env) {
  return env.DSH_HOME ?? join(env.USERPROFILE ?? env.HOME ?? '', '.dsh')
}

/** `{ id, path, dir }` for every profile under `<home>/profiles`. */
export function listProfiles(env = process.env) {
  const root = join(dshHome(env), 'profiles')
  if (!existsSync(root)) return []
  const found = []
  for (const entry of readdirSync(root)) {
    const dir = join(root, entry)
    try {
      if (statSync(dir).isDirectory() && existsSync(join(dir, 'package.json'))) {
        found.push({ id: entry, dir, path: join(dir, PATCH_FILE) })
      }
    } catch { /* unreadable entry: skip it */ }
  }
  return found
}

/** Resolve `--profile` / `--patch` to the file this run edits. */
export function resolveTarget(options, env = process.env) {
  if (options.patch !== undefined) {
    const path = isAbsolute(options.patch) ? options.patch : resolve(process.cwd(), options.patch)
    return { id: options.patch, path }
  }
  if (options.profile === undefined) throw new Error('--profile <name> (or --patch <file>) is required; use --list')
  const found = listProfiles(env).find((profile) => profile.id === options.profile)
  if (found === undefined) throw new Error(`no profile "${options.profile}" under ${join(dshHome(env), 'profiles')} (try --list)`)
  return { id: found.id, path: found.path }
}

/* ------------------------------------------------------------------ *
 * A minimal YAML reader for the subset a patch list uses
 * ------------------------------------------------------------------ */

/** Strip a trailing `#` comment that is not inside quotes. */
function stripComment(text) {
  let quote
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (quote !== undefined) {
      if (char === quote) quote = undefined
      else if (char === '\\' && quote === '"') i += 1
      continue
    }
    if (char === "'" || char === '"') { quote = char; continue }
    if (char === '#' && (i === 0 || /\s/u.test(text[i - 1]))) return text.slice(0, i)
  }
  return text
}

/** Parse one scalar: quoted string, flow collection, or plain text. */
function parseScalar(text) {
  const value = text.trim()
  if (value.length === 0) return undefined
  if (value.startsWith('[') || value.startsWith('{')) return JSON.parse(value)
  if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) return value.slice(1, -1).replace(/''/gu, "'")
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) return JSON.parse(value)
  if (value === 'true') return true
  if (value === 'false') return false
  if (value === 'null' || value === '~') return null
  if (/^-?\d+$/u.test(value)) return Number(value)
  return value
}

/**
 * Parse the YAML subset a patch list uses.
 *
 * Supported: block sequences of block mappings, nested mappings and sequences,
 * flow `{}`/`[]` collections, single/double quoted scalars, and `#` comments.
 * Anything else throws, so an unreadable patch file is never rewritten.
 * @param text - the file contents.
 * @returns the parsed list or map.
 */
export function parseYamlSubset(text) {
  const lines = []
  for (const raw of text.split('\n')) {
    const withoutComment = stripComment(raw.replace(/\r+$/u, ''))
    if (withoutComment.trim().length === 0) continue
    lines.push({ indent: withoutComment.length - withoutComment.trimStart().length, content: withoutComment.trim() })
  }
  let cursor = 0

  /** One block: a sequence, a mapping, or a scalar, at `indent`. */
  function parseBlock(indent) {
    const line = lines[cursor]
    if (line === undefined || line.indent < indent) return undefined
    if (line.content.startsWith('- ') || line.content === '-') return parseSequence(indent)
    return parseMapping(indent)
  }

  /** A `key: value` mapping at `indent`, including nested blocks. */
  function parseMapping(indent) {
    const map = {}
    while (cursor < lines.length) {
      const line = lines[cursor]
      if (line.indent < indent) break
      if (line.indent > indent) throw new Error(`unexpected indentation in the patch file: ${JSON.stringify(line.content)}`)
      if (line.content.startsWith('- ')) break
      const match = /^(?<key>[^:]+):(?<rest>.*)$/u.exec(line.content)
      if (match === null) throw new Error(`the installer cannot read this patch file line: ${JSON.stringify(line.content)}`)
      const key = match.groups.key.trim().replace(/^['"]|['"]$/gu, '')
      const rest = match.groups.rest.trim()
      cursor += 1
      if (rest.length > 0) {
        map[key] = parseScalar(rest)
        continue
      }
      const next = lines[cursor]
      if (next !== undefined && next.indent > indent) {
        map[key] = parseBlock(next.indent)
      } else if (next !== undefined && next.indent === indent && (next.content.startsWith('- ') || next.content === '-')) {
        /* A sequence may sit at the same indent as its key. */
        map[key] = parseSequence(indent)
      } else {
        map[key] = null
      }
    }
    return map
  }

  /** A `- ` sequence at `indent`. */
  function parseSequence(indent) {
    const list = []
    while (cursor < lines.length) {
      const line = lines[cursor]
      if (line.indent !== indent || !(line.content.startsWith('- ') || line.content === '-')) break
      const inline = line.content === '-' ? '' : line.content.slice(2).trim()
      if (inline.length === 0) {
        cursor += 1
        const next = lines[cursor]
        list.push(next !== undefined && next.indent > indent ? parseBlock(next.indent) : null)
        continue
      }
      /* `- id: x` opens a mapping whose first key is on the dash line: rewrite
       * the line as an indented key and let `parseMapping` consume the whole
       * item, cursor included, so the next loop iteration sees the next item. */
      if (/^[A-Za-z_][^:]*:(?:[ \t]|$)/u.test(inline)) {
        lines[cursor] = { indent: indent + 2, content: inline }
        list.push(parseMapping(indent + 2))
        continue
      }
      cursor += 1
      list.push(parseScalar(inline))
    }
    return list
  }

  const parsed = parseBlock(lines[0]?.indent ?? 0)
  if (cursor < lines.length) throw new Error(`the installer could not consume the whole patch file (stopped at ${JSON.stringify(lines[cursor].content)})`)
  return parsed
}

/**
 * Validate a parsed document as a patch list.
 * @param parsed - the parsed document.
 * @returns the validated list.
 * @throws when it is not a top-level array of entries.
 */
function asPatchList(parsed) {
  if (!Array.isArray(parsed)) throw new Error('the patch file must be a top-level YAML/JSON array of entries')
  for (const entry of parsed) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`the patch file must be a top-level YAML/JSON array of entries (found ${JSON.stringify(entry)})`)
    }
  }
  return parsed
}

/**
 * Parse a patch file.
 * @param text - the file's contents.
 * @returns the patch list.
 * @throws when the file is not a top-level array of entries.
 */
export function parsePatchList(text) {
  const body = text
    .split('\n')
    .filter((line) => !/^\s*#/u.test(line))
    .join('\n')
    .trim()
  if (body.length === 0) return []
  /* Fast path: a JSON body (what this installer writes, and what the shipped
   * profile template writes) parses without the YAML reader. */
  try {
    return asPatchList(JSON.parse(body))
  } catch (error) {
    if (error?.message?.startsWith('the patch file must be')) throw error
    /* Not JSON: fall through to the YAML reader. */
  }
  /* A flow-style top-level collection (`[ { … } ]`), possibly multi-line: the
   * YAML reader does not model flow collections at the document root. */
  if (body.startsWith('[') || body.startsWith('{')) {
    try {
      return asPatchList(JSON.parse(body))
    } catch (error) {
      throw new Error(`the patch file must be a top-level YAML/JSON array of entries (${error?.message})`)
    }
  }
  const parsed = parseYamlSubset(body)
  if (parsed === null || parsed === undefined) return []
  return asPatchList(parsed)
}

/* ------------------------------------------------------------------ *
 * Computing the new list
 * ------------------------------------------------------------------ */

/** The two patch entries this plugin owns. */
export function patchEntries(entry = ENTRY) {
  return [
    { id: 'tool-result-pruner', disabled: true },
    {
      insert: [
        {
          id: PLUGIN_ROW_ID,
          name: entry,
          config: {
            firstPass: true,
            guardedPruner: true,
            thresholdChars: 8192,
            headChars: 4096,
            tailChars: 1024
          }
        }
      ]
    }
  ]
}

/** Whether one parse-tree entry is (one of) this plugin's patch entries. */
function isOurs(patch) {
  if (patch === null || typeof patch !== 'object') return false
  if (patch.id === 'tool-result-pruner' && patch.disabled === true) return true
  const inserted = patch.insert
  return Array.isArray(inserted) && inserted.some((row) => row?.id === PLUGIN_ROW_ID)
}

/**
 * Compute the rewritten patch list.
 * @param patches - the current list.
 * @param options - `{ revert, entry }`.
 * @returns `{ patches, changed, notes }`.
 */
export function computePatches(patches, options = {}) {
  const revert = options.revert === true
  const entry = options.entry ?? ENTRY
  const ours = patchEntries(entry)
  const kept = patches.filter((patch) => !isOurs(patch))
  const removed = patches.length - kept.length
  if (revert) {
    if (removed === 0) return { patches: kept, changed: false, notes: ['nothing to revert'] }
    return { patches: kept, changed: true, notes: [`removed ${removed} entr${removed === 1 ? 'y' : 'ies'} owned by this plugin`] }
  }
  const notes = []
  if (removed > 0) notes.push(`replaced ${removed} previous entr${removed === 1 ? 'y' : 'ies'} owned by this plugin`)
  notes.push('disabled the built-in tool-result-pruner row')
  notes.push(`inserted the ${PLUGIN_ROW_ID} row naming ${entry}`)
  return { patches: [...kept, ...ours], changed: true, notes }
}

/** Render a patch list back to the file body. */
export function renderPatchList(patches) {
  if (patches.length === 0) return '[]\n'
  const header = [
    '# Patch layer for this DSH profile, applied after every bundle layer.',
    '# Managed in part by dsh-cache-safe-tool-result: the tool-result-pruner entry',
    '# and the cache-safe-tool-result insert. Remove them with',
    '#   node tools/install-preset.mjs --profile <name> --revert',
    ''
  ].join('\n')
  return `${header}${JSON.stringify(patches, null, 2)}\n`
}

/** Timestamped backup path next to the patch file. */
function backupPath(file) {
  return `${file}.${new Date().toISOString().replace(/[:.]/gu, '-')}.bak`
}

function parseArgs(argv) {
  const options = { profile: undefined, patch: undefined, entry: undefined, dryRun: false, revert: false, list: false, help: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--revert') options.revert = true
    else if (arg === '--list') options.list = true
    else if (arg === '--help' || arg === '-h') options.help = true
    else if (arg === '--profile' || arg === '--preset') options.profile = argv[++i]
    else if (arg.startsWith('--profile=')) options.profile = arg.slice('--profile='.length)
    else if (arg === '--patch') options.patch = argv[++i]
    else if (arg === '--entry') options.entry = argv[++i]
    else throw new Error(`unknown argument: ${arg}`)
  }
  return options
}

function usage() {
  return [
    'Wire this plugin into a DSH profile, safely and reversibly.',
    '',
    'Usage:',
    '  node tools/install-preset.mjs --list',
    '  node tools/install-preset.mjs --profile web --dry-run',
    '  node tools/install-preset.mjs --profile web',
    '  node tools/install-preset.mjs --profile web --revert',
    '  node tools/install-preset.mjs --patch ./cordis.patch.yml',
    '',
    'Edits <DSH_HOME>/profiles/<name>/cordis.patch.yml: it disables the built-in',
    'tool-result-pruner row and inserts this checkout as its replacement.',
    'A timestamped .bak is written next to the file before every change.'
  ].join('\n')
}

function main(argv) {
  const options = parseArgs(argv)
  if (options.help) {
    console.log(usage())
    return 0
  }
  if (options.list) {
    const profiles = listProfiles()
    if (profiles.length === 0) console.log(`no profiles under ${join(dshHome(), 'profiles')}`)
    for (const profile of profiles) {
      console.log(`${profile.id}\t${profile.path}${existsSync(profile.path) ? '' : ' (will be created)'}`)
    }
    return 0
  }

  const target = resolveTarget(options)
  const before = existsSync(target.path) ? readFileSync(target.path, 'utf8') : ''
  const patches = parsePatchList(before)
  const { patches: next, changed, notes } = computePatches(patches, options)
  const after = renderPatchList(next)

  console.log(`profile: ${target.id}`)
  console.log(`file:    ${target.path}`)
  console.log(`mode:    ${options.revert ? 'revert' : 'install'}${options.dryRun ? ' (dry run)' : ''}`)
  for (const note of notes) console.log(`  - ${note}`)

  if (!changed) {
    console.log('already in the requested state; nothing written')
    return 0
  }
  if (options.dryRun) {
    console.log('\n--- resulting patch file ---')
    console.log(after)
    console.log('--- dry run: no file written ---')
    return 0
  }
  if (existsSync(target.path)) {
    const backup = backupPath(target.path)
    copyFileSync(target.path, backup)
    console.log(`\nbackup: ${backup}`)
  }
  writeFileSync(target.path, after)
  console.log('written. Restart dsh for the profile layer to take effect.')
  return 0
}

/* Only run when invoked as a script, so tests can import the helpers. */
const invokedDirectly = process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url
if (invokedDirectly) {
  try {
    process.exitCode = main(process.argv.slice(2))
  } catch (error) {
    console.error(`install-preset: ${error?.message ?? error}`)
    process.exitCode = 1
  }
}
