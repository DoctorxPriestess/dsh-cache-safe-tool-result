# dsh-cache-safe-tool-result

A DeepSeek Harness (DSH) plugin that keeps tool results **cache-prefix safe**.

DSH's implicit prompt cache is a prefix cache: the provider reuses a cached prefix
only while the request's leading tokens are byte-identical to what it saw before.
DSH's built-in tool-result pruner truncates oversized tool results **in place**,
by appending a replacement node for a result that has already been sent — which
invalidates everything after that node and re-bills the whole tail as uncached
input.

This plugin closes that hole in two halves:

| half | what it does | where |
| --- | --- | --- |
| **FIRST-PASS** | truncates an over-budget tool result *before* the loop appends it to the session surface, through DSH's sanctioned `tools/post-execute` waterfall | `src/index.js` |
| **GUARD** | provides `toolResultPruner`, the pruning service `dsh-compaction-basic` consumes, and refuses to rewrite any result a provider request has already delivered | `src/guarded-pruner.js` |

Both mount from one row: `src/both.js`.

Measured on the two sessions this plugin was built from: cached-token accounting
was 330,502,592 tokens read versus 4,394,655 uncached, a **99.7%** hit rate
inside a warm window — and the only large uncached jumps in those logs are the
windows where the built-in pruner rewrote already-delivered results
(+299,372, +311,788, +95,353 and +50,351 uncached tokens).

---

## A. Architecture

```
                       ┌──────────────── profile (host plane) ────────────────┐
dsh-agent-loop         │                                                     │
  runGroup.commitReady │                                                     │
    └─ tools.finalize  │                                                     │
         └─ postExecute│  ctx.waterfall(agent scope, "tools/post-execute",   │
              │        │                 exec, result, next)                 │
              │        │      ▲                                             │
              │        │      │  FIRST-PASS listener (src/index.js)         │
              │        │      └── { kind: 'accept', content: truncated }     │
              │        └──────────────────────────────────────────────────── │
              ▼
        appendToolResult(session, …)      ← the result enters the surface ONCE
              │
              ▼
     ┌── agent scope / preset "compaction" isolate group ─────────────────┐
     │  dsh-compaction-basic ── ctx.get("toolResultPruner") ──┐           │
     │                                                        ▼           │
     │  GUARD: this plugin's guarded pruner (src/guarded-pruner.js)       │
     │      · delivered  → skip, byte-identical, no replacement node      │
     │      · fresh      → truncate (same geometry as the built-in one)   │
     │      · unprovable → skip (fail closed)                             │
     └────────────────────────────────────────────────────────────────────┘
```

The invariant the whole design serves:

> **A tool result may be compressed before it first enters the session surface.
> Once a provider request has carried it, its bytes never change again.**

## B. Hooks and interception points

Everything used here is a public DSH/Cordis extension point. No `node_modules`
file is touched.

| # | seam | kind | used for |
| --- | --- | --- | --- |
| 1 | `tools/post-execute` | Cordis waterfall on the agent scope | FIRST-PASS: replace the content that is about to be appended |
| 2 | `toolResultPruner` | Cordis service at the **top level of the profile composition** | GUARD: be the provider `dsh-compaction-basic` resolves |
| 3 | `cordis.patch.yml` (the profile's own user layer) | documented patch layer | the row swap that installs #2 (performed by `tools/install-preset.mjs`) |
| 4 | `session.snapshotEvents(seq+1)` | session log API | prove whether a node was already delivered |

### Where the provider row really lives

`dsh --dump-config` settles this, and it is worth checking on any DSH version
before wiring anything:

```
- id: tool-result-pruner
  name: '@deepseek-ai/dsh-compaction-tool-result-pruner'
  config: { thresholdChars: 8192, headChars: 4096, tailChars: 1024 }
```

It is contributed by `@deepseek-ai/dsh-base` at the **top level of the profile
composition**, with no `isolate` wrapper, and `dsh-compaction-basic` is its
sibling that reads it with `this.ctx.get("toolResultPruner")`. Two consequences:

* the profile's own `cordis.patch.yml` is the correct seam — a documented user
  layer applied after every bundle layer, so no preset and no `node_modules` file
  has to be edited;
* an id-targeted patch **cannot rename** a row: its `name` is a mismatch guard,
  not an override (`applyEntryPatches` skips the patch and warns). The swap is
  therefore the documented pair — disable the built-in row, insert this one.

### Why the guard is a replacement, not a wrapper

* the built-in pruner is a Cordis **service**. It exposes no event, waterfall,
  registry or hook seam of its own, so there is nothing to listen to;
* Cordis resolves services per **scope label**, and `ctx.get(name)` from a scope
  whose own label has no implementation returns `undefined` — verified against
  the installed runtime in `test/integration/cordis.test.js`
  ("an isolated scope hides the service from its parent"), which is also why an
  agent preset cannot reach a host-plane instance across an `isolate` boundary;
* `ctx.provide("toolResultPruner", …)` from inside a scope that already has one
  throws a duplicate registration.

So the only supported way to put a guard in front of the built-in pruner without
patching DSH is to **become** `toolResultPruner` in the same scope, which the
disable+insert patch does. `dsh-compaction-basic` treats the service as optional
(`const prune = this.ctx.get("toolResultPruner")`), so the swap needs no other
change. `src/both.js` implements the same two-method surface the built-in service
exposes — `pruneContent(blocks)` and `pruneSession(session)` — using the ~50-line
upstream-mirrored algorithm in `src/truncate.js`.

The FIRST-PASS half has no such constraint and is purely additive. It is mounted
from the same row for a practical reason (one edit instead of two), not because
it has to share a scope: a listener registered by a plain plugin is untagged, and
`dsh-scope`'s dispatch filter admits untagged listeners to every scope, so a
`tools/post-execute` listener fires for the agent's events wherever the row sits.

## C. FIRST-PASS: why it is race-free

```
runGroup.commitReady()
  → tools.finalize(exec, result)
      → postExecute(exec, result)          ← our listener runs HERE
          → ctx.waterfall(…, exec, result, next)
      → returns the accepted result (content already truncated)
  → appendToolResult(session, result)      ← the result enters history HERE
```

The listener runs strictly **before** the append, and DSH's decision protocol is
respected rather than bypassed:

* `next()` is awaited first, so earlier listeners and the built-in behavior win;
* a `block` decision is returned untouched;
* an `accept` decision that already replaced `value` is returned untouched — the
  `value` arm is valid for successful results only, and rewriting content next
  to it would desynchronise the pair;
* an error anywhere in the row returns the inner decision unchanged, so a tool
  call can never be turned into a failure by this plugin.

There is no race to lose here, because there is no second writer: the surface
node is created once, from the (already truncated) result.

## D. How "delivered" is determined

DSH records no `sentToProvider` / `lastSentSeq` / `requestWatermark` /
`deliveredSeq` field anywhere (a full grep of the installed harness finds none).
The only log-provable evidence of an admitted request is a later settlement
event, so the guard uses:

```
delivered(node)  ⟺  ∃ event in session.snapshotEvents(node.seq + 1)
                    with type ∈ { "assistant/message", "assistant/attempt" }
```

* `assistant/message` settles a request the provider answered;
* `assistant/attempt` settles one that streamed and then failed. It cannot prove
  the provider received the payload, so it counts as delivered — the guard errs
  toward leaving history alone;
* the predicate is **monotone**: it can only turn true as the log grows, so a
  delivered node stays delivered across retries, resumes and repeated passes;
* if the session does not expose `snapshotEvents`, the guard **throws and skips
  the node**: an unprovable state is never treated as "safe to rewrite".

This is deliberately one-sided. A false "delivered" costs a little pruning
capacity; a false "not delivered" costs a full cache-prefix invalidation. The
first-pass half is what recovers the capacity that conservative choice gives up.

## E. Why sent history is never rewritten

Three independent mechanisms, in order of importance:

1. **The guard never calls `append` for a delivered node.** Not a rollback, not a
   copy-and-replace, not a deferred fix-up: the node is skipped before any
   mutation is attempted (`pruneSession` builds its candidate list first, then
   rewrites only provably undelivered candidates).
2. **No rollback of the built-in pruner's work either.** If a delivered node was
   already replaced by the built-in pruner in the past, this plugin does not try
   to restore it — that would be a second rewrite of the same prefix position and
   would break the cache again. Replay/replacement history
   (`surface.replaceGeneration`) is only ever left alone.
3. **Replacement events are appended, never in-place.** Even when the guard does
   prune, it follows the same shape the built-in service uses (a
   `compaction/prune` shadow-price event, then a `tool/result` with
   `surfaceOp: { op: 'replace' }`), so a replay sees an ordinary append-only log.

`test/regression/real-session.test.js` drives the guard over replayed surfaces
from the two real sessions and asserts that **all 15 recorded rewrite targets
(8 + 7) are refused**, with the content hash of each target unchanged after
three consecutive passes.

## F. Tests

```
node --test "test/**/*.test.js"      # 68 tests
```

| suite | what it pins |
| --- | --- |
| `test/unit/truncate.test.js` | geometry parity with the built-in pruner, code-point boundaries, no surrogate splitting, marker appears exactly once |
| `test/unit/guarded-pruner.test.js` | 16 cases: delivered → skipped and byte-identical; undelivered → still pruned; `assistant/attempt` counts; UNKNOWN state fails closed; a throwing `snapshotEvents` is survived; repeated passes; shifted-base (forked) logs; child surfaces; a rejected append leaves nothing behind |
| `test/unit/install-preset.test.js` | the profile patch edit adds exactly the two entries, keeps unrelated ones, is idempotent, reverts to the exact previous list; block-style and flow-style YAML patch files both parse; anything unreadable is refused rather than rewritten |
| `test/integration/cordis.test.js` | against the **real** Cordis 4.0.2 from the local DSH install: `provide` works, a duplicate is rejected loudly, an isolate scope hides the service from its parent, and the combined row truncates through a real `ctx.waterfall` |
| `test/regression/real-session.test.js` | two sanitized production traces: the recorded cache cliffs are real, every recorded delivered-node rewrite is refused, delivered history is byte-stable across repeated passes, and a fresh node on the same surface is still pruned |

All 68 pass (`node --test`, Node 24). The regression fixtures carry **no message
content** — only `seq` / type / surface op / tool name / character count /
content hash / provider usage — and no test contacts a provider.

## G. Real-session regression

Two production sessions (`0dd710b3`, `75258c73`) were recorded with the built-in
pruner live. The relevant facts, reproducible from the fixtures:

| session | window | uncached input | cache read | Δ uncached |
| --- | --- | --- | --- | --- |
| `0dd710b3` | 840 → 856 | 1,417 → 300,789 | 348,544 → 18,432 | **+299,372** |
| `0dd710b3` | 2559 → 2573 | — | −100,480 | **+95,353** |
| `75258c73` | 2326 → 2338 | — | 348,288 → 35,200 | **+311,788** |

Each jump follows a burst of `compaction/prune` + `tool/result(replace)` events
targeting nodes that had been live across 75–299 completed requests. Replaying
those surfaces through the guarded pruner produces **zero** replacements for
those targets.

### End-to-end check on a real harness run

The install path and the FIRST-PASS mechanism were both exercised end to end
against a real DSH harness (`@deepseek-ai/dsh` 0.1.5-rc.2), in an isolated
`DSH_HOME` so the live profile was never touched:

1. install into a profile with `dsh plugin --profile <p> add <this checkout>`;
2. wire it with `node tools/install-preset.mjs --profile <p>`;
3. confirm the composition with `dsh --profile <p> --dump-config`;
4. run one headless session that makes a tool produce a large result.

Observed in the resulting session log:

| | baseline (built-in pruner) | with this plugin |
| --- | --- | --- |
| tool-result characters admitted | 50,000 | **5,159** |
| prune marker in the first admission | absent | **present (at code point 4,098)** |
| `tool/result` replacement events | 0 | **0** |
| `compaction/prune` events | 0 | **0** |

The result entered the surface already truncated, exactly once, with no
replacement node afterwards — which is the whole claim. `tools/session-report.mjs`
reproduces those numbers from a session log.

### Scope of these claims

These checks prove that the **surface mutation** is eliminated and that the
replacement row is what runs. They do not contact a provider, so they do not
observe a cache hit; that requires a live session (see "How to tell it is
working").

## H. DSH installation: unmodified

**No file under any `@deepseek-ai/dsh*` package was modified.** Every seam used
is public API:

* `tools/post-execute` — an event other plugins are expected to listen to;
* `toolResultPruner` — a Cordis service other plugins are expected to provide;
* `agent.cordis.yml` — a preset composition the user owns
  (`dsh-agent-presets`' `writableRoot`).

An earlier phase of this work did patch the installed pruner to prototype the
mechanism. That patch has been fully reverted and the installed package is
byte-identical to its pristine state. `src/` contains no reference to it.

## I. Files

```
src/index.js             FIRST-PASS row (tools/post-execute listener)
src/both.js              combined row: mounts both halves
src/guarded-pruner.js    GUARD: the toolResultPruner service + delivery predicate
src/truncate.js          upstream-mirrored head/middle/tail geometry (shared)
tools/install-preset.mjs idempotent, reversible profile patch-layer install
tools/session-report.mjs read a session log and report prune/replace/marker counts
tools/extract-session-trace.mjs  sanitized trace extractor (multi-frame zstd)
cordis.patch.yml         bundle marker; intentionally an empty patch list (see the file)
test/unit/*              geometry, guard, installer
test/integration/*       real Cordis context and real waterfall
test/regression/*        two sanitized production traces
test/fixtures/*.trace.json  the sanitized traces
```

## Install

### TL;DR

```sh
# 1. install the plugin into a profile
dsh plugin --profile web add github:DoctorxPriestess/dsh-cache-safe-tool-result

# 2. wire the profile (this is the load-bearing step) - from the installed package
cd "$DSH_HOME/profiles/web/node_modules/dsh-cache-safe-tool-result"
node tools/install-preset.mjs --profile web

# 3. restart dsh, then confirm what it composed
dsh --profile web --dump-config
```

### Step 1 — install the plugin into a profile

`dsh plugin` is a thin `pnpm` forwarder: it initializes the profile on first use,
runs the forwarded pnpm arguments in `<DSH_HOME>/profiles/<name>`, then reconciles
`dsh.profile.bundles` against what is actually installed.

```sh
# the common case: the web profile
dsh plugin --profile web add github:DoctorxPriestess/dsh-cache-safe-tool-result

# another profile
dsh plugin --profile tui add github:DoctorxPriestess/dsh-cache-safe-tool-result

# from a local checkout (a relative path is anchored to YOUR cwd, not the profile)
dsh plugin --profile web add /path/to/dsh-cache-safe-tool-result

# pin a version
dsh plugin --profile web add github:DoctorxPriestess/dsh-cache-safe-tool-result#v1.0.0
```

The package is installed as a dependency of the profile and appended to
`dsh.profile.bundles` (`@deepseek-ai/dsh-base`, `@deepseek-ai/dsh-web-app`, …,
`dsh-cache-safe-tool-result`). Confirm with:

```sh
dsh --profile web --dump-config
```

The bundle patch this package ships is intentionally an empty list, so installing
it changes nothing on its own — step 2 is what swaps the provider row.

### Step 2 — wire the profile

```sh
# the installer ships inside the package; run it from there
cd "$DSH_HOME/profiles/web/node_modules/dsh-cache-safe-tool-result"

node tools/install-preset.mjs --list              # which profiles exist
node tools/install-preset.mjs --profile web --dry-run
node tools/install-preset.mjs --profile web
```

From a checkout instead of an install, the same command works — the row simply
names the checkout you wired:

```sh
node tools/install-preset.mjs --profile web
```

Uninstall reverses both steps:

```sh
node tools/install-preset.mjs --profile web --revert
dsh plugin --profile web remove dsh-cache-safe-tool-result
```

`--preset <name>` is accepted as a synonym of `--profile` for convenience, but it
targets a profile, not an agent preset — the provider row lives in the profile
composition (see "Where the provider row really lives" above).

Step 2 edits `<DSH_HOME>/profiles/web/cordis.patch.yml`, appending exactly two
entries and leaving everything else - including any patch entries you already
keep there - untouched:

```yaml
- id: tool-result-pruner
  disabled: true
- insert:
    - id: cache-safe-tool-result
      name: 'D:/path/to/dsh-cache-safe-tool-result/src/both.js'
      config: { firstPass: true, guardedPruner: true, thresholdChars: 8192, headChars: 4096, tailChars: 1024 }
```

It reads the existing file as YAML (block or flow style, comments and all),
writes it back as JSON (a YAML subset the loader accepts), and makes a
timestamped `.bak` first. Revert with:

```sh
node tools/install-preset.mjs --profile web --revert
```

Restart `dsh` after either change. Confirm what the harness composed with:

```sh
dsh --profile web --dump-config
```

`tool-result-pruner` should now say `disabled: true` and a
`cache-safe-tool-result` row should follow it.

### Why the row names an absolute path

A bare package name in a profile bundle layer resolves from the harness
installation (or the profile's `node_modules`); this plugin is installed by
`dsh plugin add`, so it *is* resolvable that way — but the installer names the
checkout by absolute path so the row always points at the code you can read and
edit, and so a checkout copy and an installed copy cannot silently diverge.
Absolute paths are supported and converted to file URLs internally, including
Windows drive letters.

> To point the row at the **installed** copy instead (for example so a later
> `dsh plugin --profile web update` is what you run), pass `--entry`:
> `node tools/install-preset.mjs --profile web --entry "$DSH_HOME/profiles/web/node_modules/dsh-cache-safe-tool-result/src/both.js"`

## Configuration

| key | default | meaning |
| --- | --- | --- |
| `thresholdChars` | `8192` | truncate when the text exceeds this many code points |
| `headChars` | `4096` | leading code points retained |
| `tailChars` | `1024` | trailing code points retained |
| `firstPass` | `true` | mount the pre-admission truncation listener |
| `guardedPruner` | `true` | provide the delivery-guarded `toolResultPruner` |
| `includeNested` | `true` | first-pass: also truncate sub-dispatch results |
| `verbose` | `false` | log per-truncation and per-pass detail |

`thresholdChars`, `headChars` and `tailChars` match the built-in pruner's
defaults exactly, so the swap does not change how much context a session keeps.
Configuration is validated: `headChars + marker + tailChars` must fit inside
`thresholdChars`, and a non-integer or negative budget throws at mount time
rather than silently misbehaving.

## How to tell it is working

* **FIRST-PASS**: with `verbose: true`, a truncation logs
  `truncated <tool> result <before> -> <after> code points before admission`.
* **GUARD**: a session that keeps pruning now shows *no* new
  `tool/result` events with `surfaceOp: { op: 'replace' }` for nodes older than
  the last request.
* **The cache itself**: compare `prompt_cache_hit_tokens` across turns in a live
  session. A rewrite of delivered history shows up as a large drop in cache read
  and a matching jump in uncached input; the guard's whole purpose is that this
  no longer happens.

## Known limitations and upgrade risk

1. **The geometry is a port, not an import.** The upstream package's default
   export is a Cordis `Service` that registers itself on construction, so
   importing it for its `pruneContent` / `PRUNE_MARKER` exports is not
   side-effect free. `src/truncate.js` is a character-for-character port of the
   v0.1.5-rc.2 algorithm and is tested for the same geometry. **If upstream
   changes its algorithm, only that file needs to follow.**
2. **The service contract is a port too.** `pruneSession` / `pruneContent` /
   `measureContent` / `config` mirror the built-in surface. If a future DSH
   version adds a method the consumers call, this provider must add it as well.
   The integration test pins the methods that exist today.
3. **`assistant/attempt` is treated as delivered.** Capacity is lost when a
   request fails before the provider sees it; correctness is not.
4. **The guard only protects what it can see.** A rewrite performed by a
   *different* plugin (a compaction strategy that edits history itself, for
   example) is outside this plugin's control.
5. **Install is two steps by design.** The package install and the profile patch
   are separate because a bundle patch layer cannot rename a row and cannot see
   into a preset; the row swap is scripted, dry-runnable and reversible, but it
   is not zero-touch.
6. **Out of scope**: compaction thresholds, `reasoning_content` or tool-call
   argument compression, the provider's cache algorithm, and system-prompt or
   persona tuning.
7. **Nothing here is published to npm.** `package.json` carries
   `"private": true` deliberately: this is installed from source or GitHub.

## License

MIT — see `LICENSE`.
