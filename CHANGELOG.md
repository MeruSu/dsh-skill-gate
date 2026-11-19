# Changelog

All notable changes to `dsh-skill-gate` are recorded here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.6] — 2026-11-19

### Fixed

- **`guard: null` no longer silently becomes `true`.** `lib/policy.js` read the key with
  `entry.guard ?? true`, so an explicit `null` (the usual way to "turn it off" by
  accident) fell back to the default and kept refusing calls without a word. It is now
  `entry.guard === undefined ? true : entry.guard`, so `null` reaches the existing
  non-boolean branch and drops only that preset with
  `presets.<name>: guard must be a boolean`. Found by auditing §3 of the requirement doc
  against the implementation; the failing assertion was added first
  (`FAILED — 1/32`), then the one-line fix made it green (`PASS — 32 groups`).
- The plugin suite gained a `guard: false` case that runs a real `apply()`; before it,
  dropping `policy.guard` inside `index.js` or mis-writing the `guard=off` log field kept
  both suites green (verified by mutation). Totals are now `PASS — 32 groups` /
  `PASS — 33 groups`.

### Notes

- 0.1.5 was built locally but never published; this release is the first published build
  that contains `guard`. The installed desktop copy was still the pre-fix 0.1.5 build
  (`lib/policy.js` SHA `1B24C11F…`), so upgrading to 0.1.6 is what actually closes the hole.

## [0.1.5] — 2026-11-19

### Added

- **`guard` per preset (default `true`) — hide the catalog line without refusing the
  call.** Until now one switch did both: whatever the catalog hid, the guard refused.
  `{ "guard": false }` keeps the skill out of `<available_skills>` while letting
  `skill("X")` execute, so a skill the model learned from elsewhere, or one the user
  points at with `@name`, still loads. The refusal message and the catalog filter are
  unchanged for `guard: true`, and an entry without the key behaves exactly as before.
- The per-step debug line now reports the switch:
  `[skill-gate] preset=dev mode=allow guard=on form=catalog kept=7/38 bytes=9917->2147`.

### Notes

- `guard` is validated like the other keys: a non-boolean drops only that preset entry
  and reports `presets.<name>: guard must be a boolean`. `guard: null` counts as
  non-boolean — it drops the entry instead of silently reverting to the default.
- **Upgrade required for the field to work.** A release without `guard` ignores it
  (the validator only knows the keys it ships), so such a host keeps hiding the
  catalog line *and refusing the call* — the degraded state is `guard: true`. The
  config file lives outside the package and survives an upgrade, but the behaviour
  changes only after the host restarts on 0.1.5 or newer.
- Tests: 31 + 32 groups (three new policy cases: `guard:false` hides but allows, the
  key defaults to on, a non-boolean drops only its own entry).

## [0.1.4] — 2026-11-19

### Added

- **Display metadata.** The plugin list now shows a localized name and a real icon:
  `locale/zh.json` → 「技能闸门」, `locale/en.json` → "Skill Gate", plus a 100×100
  `icon.png` (19,774 B). `exports` gained `./locale/*.json` and `./icon`, and `files`
  ships both, so the metadata actually travels inside the tarball — without those two
  entries npm installs the plugin but the host falls back to the English package name.
- `repository` / `homepage` / `bugs` and an explicit `publishConfig` (`access: public`).

No behavior change: the gate logic, its tests (28 + 32 groups) and the patch row are
untouched.

## [0.1.3] — 2026-11-19

### Fixed

- **Subagent and teammate sessions are now filtered.** `presetIdOfAgent()` only asked
  `agentPresets.composedPreset(agent.ctx)`, which answers "" for any agent mounted
  inside a parent's composition — every subagent and teammate session. Those sessions
  therefore saw the full catalog and could load any skill (measured on desktop: 30
  entries, `skill("tencent-docs")` succeeded), so presets that only ever run as
  subagents (scholar, clerk, dev) were completely unaffected by the gate.

  Resolution now walks a three-level chain and stops at the first non-empty answer:

  1. `agentPresets.composedPreset(agent.ctx)` — a root session's composition stays
     authoritative and is never overridden by the levels below;
  2. `agentPresets.presetForSession(agent.session)` — the `agentPreset` session
     projection (registry 480-482), an O(1) read of committed state, not an event scan;
  3. the nearest live ancestor: `session.header.parentSession` → `ctx.agents.get(id)`
     (dsh-agent 726), then levels 1 and 2 again on that parent, at most 4 hops, with a
     visited set so a cyclic lineage terminates.

  An unresolved lineage resolves to "" and the session is left untouched; every level
  swallows its own failure and falls through. No new per-step cost beyond those map
  reads: still one `statSync` and one string pass.

### Added

- One info line per config file version, when a config with presets loads:
  `[skill-gate] config loaded presets=clerk,dev`.

## [0.1.2] — 2026-11-19

### Fixed

- **Released-package fix: the published tarball did not include `README.zh.md`.**
  0.1.1 listed `README.md` in `files[]` but not its Chinese counterpart, so
  `npm pack` silently dropped it and Chinese readers got no documentation in the
  installed package. `README.zh.md` is now listed, and the package-shape test
  asserts every shipped file — including both READMEs — so the list cannot drift
  again without a red test. No runtime change: `index.js`, `lib/` and the
  bundle patch are byte-identical to 0.1.1.

## [0.1.1] — 2026-11-19

### Fixed

- **`apply()` threw `cannot set property "skillGate" without provide`, which left
  the plugin fully inert while the host booted normally.** 0.1.0 attached a
  read-only `ctx.skillGate` view at the end of `apply()`. A Cordis context is
  managed, so an undeclared property assignment throws; `apply()` aborted before
  either hook was registered, the host printed one warning and every session ran
  with an unfiltered catalog. The view is gone — `apply()` now touches nothing but
  `ctx.on` and `ctx.tools`. Two tests hold that line: one drives a proxy that
  rejects undeclared writes the way Cordis does, one asserts `apply()` adds no key
  to `ctx`. One injected mutation (P13, restoring the assignment) turns both red.

### Verification

Measured on a real host: an isolated `meru-clean` profile, `DSH_HOME` pointed at a
workspace directory, registry package `dsh-skill-gate@0.1.1`.

- **Activates.** stderr empty across every boot after the fix;
  `dsh: warning: 1 entry did not activate` gone; `--dump-config` lists
  `- id: skill-gate / name: dsh-skill-gate`.
- **Filters.** `dev` preset with a 7-name allow list, in a profile that defines 21
  skills (2 of those 7 names exist there): model-visible catalog went from
  21 lines / 5,303 B to **2 lines / 1,158 B** — −4,145 B, −78.2 % on that one
  message. `entries` stayed at 21, as designed.
- **Refuses.** `skill("office")` returned
  `Error: 技能「office」在本预设中被隐藏（dsh-skill-gate）` (`isError: true`), and
  the model quoted the refusal back.
- **Leaves unconfigured presets alone.** With `{"version":1,"presets":{}}` the dev
  catalog was 21 lines / 5,303 B, identical to the no-plugin baseline.
- **Does not re-send.** Two sessions × 2 rounds, one `skill-catalog` message each,
  `update: false`.

Not verified at this version: the 38-skill desktop profile, whole-turn byte
totals, `minimal`/1-name allow, invalid-JSON recovery on a live host,
config-deletion recovery, and disable-plugin recovery. See
`cangku/261119_k4m_skillgate_report.md` for the itemised list.

### Note

- 0.1.0 was never used in a desktop profile; this release supersedes it.

## [0.1.0] — 2026-11-19

First release — **defective, superseded by 0.1.1.** Per-preset skill filtering for
the DSH host: a hidden skill does not reach the model's `<available_skills>`
catalog and cannot be loaded through the `skill` tool. The plugin registered no
hook in practice (see 0.1.1); use 0.1.1.

### Added

- **Per-preset policy** from `$DSH_HOME/skill-gate.json`, with `allow`
  (whitelist) and `deny` (blacklist) modes and `*` wildcards in skill names
  (`office*`, `role-*`).
- **Optional `enabled`** per preset, defaulting to `true`, to switch the gate off
  for one preset without deleting its list.
- **Catalog rewrite** on `agent/pre-step`, registered with `{ prepend: true }`
  and running after `next()`. Only the model-facing text inside
  `<available_skills>` is rewritten; `source.entries` is left untouched so the
  host's catalog digest stays stable and the catalog is not re-sent every step.
- **Call guard**: `skill("<hidden>")` is refused with
  `技能「X」在本预设中被隐藏（dsh-skill-gate）`.
- **Hot reload** without restarting the host: the config is re-read when its
  mtime or size changes, checked once per step.
- **One debug log line per filtered step**:
  `[skill-gate] preset=dev mode=allow form=catalog kept=7/38 bytes=9917->2147`.

### Design notes

- Shipping state is **inert**: with no config file there is no list and the
  plugin stays silent. Invalid JSON or a field of the wrong type also passes
  every preset through, but logs **one** warning. A broken config must never
  leave an agent with no skills, and never make an unconfigured host noisy.
- Presets absent from `presets` are not touched at all.
- When every skill is hidden, the catalog message is kept (deleting it would
  desynchronise the host's digest) and its body is replaced with one notice line.
- No tools, no system-prompt section, no client half, no injected messages: the
  plugin spends no context of its own.
- Never writes to the Cordis context. Every failure path logs and degrades to
  "no filtering"; exceptions never escape the hooks.

### Known limitations

- **No preset bound to the session → no filtering.** The gate resolves the
  preset id through `agentPresets.composedPreset(agent.ctx)`; an unbound session
  returns `""` and is passed through untouched, silently.
- `source.entries` keeps every skill even after the text is filtered, so
  consumers that read it (skill badges) disagree with what the model sees.
- The two user-visible strings have different languages on purpose: the
  empty-catalog notice is English (it replaces a line inside the host's English
  catalog block), the guard refusal is Chinese (it is an error string).

### Verification status

Filtering behaviour was measured against the real `@deepseek-ai/dsh-tool-skill`
module (7-cell matrix, catalog rotation, 4 mutations, anti-self-proof run — see
`cangku/tmp/261119_k4m_gate1.md`), and covered by 47 unit tests plus 13 injected
mutations (`cangku/tmp/261119_k4m_dev_report.md`). **No functional acceptance
item has been observed on a live session yet** — the catalog going 38 → 7, the
guard refusing a call, and the first-turn byte totals are all open. See
`cangku/261119_k4m_skillgate_report.md` for which items are measured and which
are not.

[Unreleased]: https://example.invalid/dsh-skill-gate/compare/v0.1.3...HEAD
[0.1.3]: https://example.invalid/dsh-skill-gate/releases/tag/v0.1.3
[0.1.2]: https://example.invalid/dsh-skill-gate/releases/tag/v0.1.2
[0.1.1]: https://example.invalid/dsh-skill-gate/releases/tag/v0.1.1
[0.1.0]: https://example.invalid/dsh-skill-gate/releases/tag/v0.1.0
