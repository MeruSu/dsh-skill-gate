# dsh-skill-gate

**Installing this plugin changes nothing.** With no config file, every preset
sees exactly the skill catalog it saw before — the plugin is a no-op until you
give it a list, and it stays quiet about it.

Skills are the second-largest fixed cost in a DSH first turn: 9,917 B / 38
entries in the measured `dev` preset, 24.6 % of a 40,250 B opening request
(`cangku/261119_k4m_skillgate_spec.md` §1). Most presets use a handful of them.
`dsh-skill-gate` lets you say **per preset** which skills are worth showing; a
hidden skill neither reaches the model's context nor loads when the model tries
to call it.

Your lists are your own. Nothing ships pre-configured, and the saving only exists
after you write a list.

> **Status: 0.1.3 — verified on a real desktop profile, and it now covers
> subagent and teammate sessions.** Measured on desktop with a `standard` deny
> list of 4 names (`tencent-docs`, `office*`, `cangku-snapshots`,
> `blender-modeling`): a **subagent** session went from 30 catalog entries to
> **20 model-visible lines / 5,399 B**, none of the four hidden names appeared,
> and `source.entries` stayed at **30** — the digest-stability design held. That
> session carried **no `agent-preset/selected` event**; it was covered by 0.1.3's
> parent-chain fallback. Earlier, on an isolated profile: 21 lines / 5,303 B →
> **2 lines / 1,158 B (−78.2 %)**. **Not measured anywhere: whole-turn byte
> totals, and the 38-skill figure from the spec** (real catalogs measured so far:
> 21, 30, 17). Open items and full evidence:
> `cangku/261119_k4m_skillgate_report.md`.
## 1. What it does

Two hooks, nothing else:

1. **Catalog rewrite** — on `agent/pre-step`, after the host has rendered the
   `<available_skills>` catalog, the gate removes the lines belonging to hidden
   skills.
2. **Call guard** — if the model calls `skill("office")` anyway, the call is
   refused with a reason naming the preset policy. This half can be switched off
   per preset (`guard: false`): the line stays hidden, the call is allowed.

The plugin has **no tools, no system-prompt section, no client half and no
injected messages**. It exists to save context; it must not spend any.

## 2. Install

`dsh-skill-gate` is a host-only bundle: the package ships `cordis.patch.yml`, whose
single row registers the plugin as `skill-gate`. Install it into the profile you
want it in the way you install any DSH bundle — put the package in that profile's
`node_modules` and register it in the profile's `bundles` list — then **restart the
host once**. It has no client half, so nothing reloads in the browser.

Verified path: `dsh-skill-gate@0.1.3` mirror-installed into a desktop profile —
**real directory, no junction or symlink** — restarted, and the log carried
`[skill-gate] config loaded presets=standard` with no `did not activate` line.
To check activation yourself, look at stderr: a plugin that fails to activate
prints exactly one line and then is invisible everywhere else.

## 3. Configure it — nothing happens until you do

One file: `$DSH_HOME/skill-gate.json` (`$DSH_HOME` defaults to `~/.dsh`).

**No file → no filtering, any preset, and no log noise.** That is the delivered
state.

`skill-gate.example.json` in this package is a template for you to copy; the
plugin never reads it.

```json
{
  "version": 1,
  "presets": {
    "dev": {
      "mode": "allow",
      "names": ["plugin-work", "web-work", "motion-work", "dsh-plugin-dev",
                "cordis-composition-reference", "cangku-snapshots", "long-session-fold"]
    },
    "minimal": { "mode": "allow", "names": ["cangku-snapshots"] },
    "clerk":   { "mode": "deny",  "names": ["office*", "univer*"] },
    "scholar": { "enabled": false, "mode": "deny", "names": [] }
  }
}
```

**`mode`**

| value | meaning |
|---|---|
| `allow` | keep only the skills whose name matches `names`; hide everything else |
| `deny` | hide the skills whose name matches `names`; keep everything else |

**`names`** — exact skill names, `*` allowed as a wildcard: `office*`, `role-*`,
`*work`. A `*` matches any run of characters, including none, and the **whole**
name must match — `office*` matches `office` and `office-xlsx` but not `xoffice`.
Every other regex metacharacter is literal, so `a.b` matches only the skill
literally named `a.b`.

**`enabled`** — optional, defaults to `true`. `{ "enabled": false }` switches the
gate off for that one preset while leaving other entries alone; it is the
per-preset off switch you want while you are still tuning a list.

**`guard`** — optional, defaults to `true`. It controls **refusing the call**, which
is independent of hiding the catalog line:

| value | effect |
|---|---|
| `true` (default) | not listed, and a direct `skill("X")` call is refused |
| `false` | still not listed, but the call is **allowed** — a name the model learned elsewhere, or a user's `@skill` reference, still loads the skill |

`guard` requires 0.1.5 or newer: older releases ignore the field and continue to refuse hidden calls. A config change is picked up on the next step; upgrading the plugin itself requires a host restart.

**Presets you are not mentioned in are not touched at all.** This is the most
important rule: an unconfigured preset gets exactly the catalog the host would
have produced.

### When the config is broken

| Situation | Behaviour |
|---|---|
| File missing | **nothing happens, no warning** — the shipped state |
| Invalid JSON | every preset passes through, **one warning** |
| One preset entry malformed (bad `mode`, `names` not an array of strings, `enabled`/`guard` not a boolean, including `guard: null`) | **only that entry is dropped** and reported; the rest of the file keeps working |
| Root is not an object | every preset passes through, one warning |

The rule underneath all four: a broken config must never leave an agent with no
skills, and must never make the host noisy for someone who has not configured
anything.

### What "hidden" means, precisely

The gate edits the **text** of the catalog message. It deliberately leaves the
machine-readable `source.entries` array untouched.

The reason lives in the host: `@deepseek-ai/dsh-tool-skill` decides whether the
catalog changed by hashing `source.entries` **as read back from the persisted
session event** (`catalogHistory`, `dsh-tool-skill/lib/index.js` 1065-1083). If
the plugin shrinks the persisted entries, the persisted digest disagrees with the
live one on every step and the host re-renders a full catalog every step — the
opposite of saving bytes. Measured against the real module: the "filter entries
**and** text" variant emits a fresh `update` on steps 2 and 3 (2,147 B, then
2,010 B, then 2,010 B; three catalog events —
`cangku/tmp/k4m_node/k4m_gate1_matrix.txt:11-13`).

So entries stay whole, the digest stays stable, and the model sees only the kept
lines. The cost is under *Known limitations*.

## 4. Verify it actually took effect

1. **A session that resolves to a configured preset — and this is the part that
   catches most people.** The gate acts only when it can resolve a preset id:
   the agent's own composition, then its session's recorded preset, then the
   parent it was spawned from (up to 4 hops). A **subagent needs no
   `agent-preset/selected` of its own** — it inherits from its parent. A session
   that resolves to nothing is passed through untouched, silently. See *Known
   limitations*.
2. **A config-loaded line, once per file version.** When a config that has
   presets loads, the plugin writes one **info** line —
   `[skill-gate] config loaded presets=standard`. If you never see it, the file
   was not found or had no usable presets.
3. **Log line.** Each step that really filters writes one **debug**-level line:
   ```
   [skill-gate] preset=dev mode=allow guard=on form=catalog kept=7/38 bytes=9917->2147
   ```
   `form` is `catalog` for the first catalog and `update` for the incremental
   form, `kept=7/38` is kept-over-total entries, `bytes=9917->2147` is the text
   before and after. Turn debug logging on to see it — at default verbosity you
   will not. If you never see this line at debug level, no preset matched your
   config; check the spelling of the preset id first.
4. **Catalog in a session.** The `<available_skills>` block must list only the
   kept skills.
5. **Call guard.** Ask the model to use a hidden skill (`skill("office")` under
   the `dev` list above). The call must be refused with
   `技能「office」在本预设中被隐藏（dsh-skill-gate）`. The refusal text is
   Chinese while the catalog notice is English — deliberate, see *Known
   limitations*.
6. **An untouched preset still works.** Open a session in a preset absent from
   your config; its catalog must be identical to a run with the plugin disabled.
7. **Broken config.** Write `{` into `skill-gate.json`, open a new session: all
   skills present, session runs normally, one warning logged.

## 5. Known limitations

**Subagents are covered now — a session that never picked a preset still may
be filtered.** 0.1.3 resolves the preset through a three-level chain: the agent's
own composition, then the preset its session recorded, then the nearest live
ancestor session (up to 4 hops). So a subagent or teammate that carries **no
`agent-preset/selected` event of its own** inherits the preset of the parent that
spawned it. That is what makes presets which only ever run as subagents (`dev`,
`clerk`, `scholar`) actually filtered. When you read a session log to check,
remember the missing `agent-preset/selected` is *normal* for a subagent and does
not mean the gate was skipped.

**A session with no preset anywhere → no filtering, and no message about it.**
What remains "unbound" is only a session with **neither** a selected preset
**nor** a parent lineage that resolves one. The gate reads the session's composed
preset id through the preset registry
(`dsh-agent-preset-registry/lib/index.js:734-736`, which returns the mount's
`presetId` and nothing when the session has no preset). Such a session resolves
to `""` and is passed through untouched. This is the safe direction (never hide
skills you cannot reason about), but it means "the plugin is installed and the
catalog looks unchanged" is **not** evidence of a bug.
**The catalog text and `source.entries` disagree, by design.** Anything reading
`source.entries` still sees every skill, including ones the model was never
shown. Measured directly: after the rewrite the text carries no `role-dev` line
while the stored entries still list it (`textHasRoleDev=false`,
`storedHasRoleDev=true`, all four steps,
`cangku/tmp/k4m_node/k4m_gate1_rotation.json`). Consumers such as skill badges
therefore describe a different world than the model does. This is the accepted
price of a stable digest.

**The two user-visible strings are in different languages.** The empty-catalog
notice is English — `- No skills are available in this preset (dsh-skill-gate)`
— because it replaces a line inside the host's own English catalog block. The
guard refusal is Chinese — `技能「X」在本预设中被隐藏（dsh-skill-gate）` —
because it is an error string, not a rendered section. Both are written by this
plugin, not the host.

**The gate only sees what the host renders.** Skills that never reach the catalog
are outside its reach. `user-invocable` skills are out of scope too: the gate
governs what the model can see and call, not what a human can invoke.

**`@skill` mentions are affected.** The `scope-manager` plugin rewrites
`@skillname` into `/skillname`, and when that path ends in the `skill` tool the
guard refuses it for hidden skills. Intended, but surprising the first time.

**Changes apply on the next request, not instantly.** The config is re-read when
its mtime or size changes, checked once per step. Nothing uses `fs.watch`, so
there is no file handle to leak on Windows — and no reaction between steps
either.

**A failed activation is nearly invisible.** A Cordis plugin that throws inside
`apply()` does not take the host down: the host boots normally, prints one warning
to stderr, and every session runs as if the plugin were not installed. 0.1.0
shipped exactly that. If the gate seems to do nothing, read stderr before you
suspect your config.

## 6. Guarantees the plugin keeps

- Never modifies `app.asar` or any other plugin's `node_modules`.
- Disable or uninstall → stock behaviour immediately, no residue.
- Never writes to the Cordis context. An undeclared property assignment throws
  inside `apply()`, which leaves a Cordis plugin **completely inert while the host
  boots normally and logs one warning** — 0.1.0 shipped exactly that. Two
  regression tests and one injected mutation now guard it.
- Every failure path logs and degrades to "no filtering". Exceptions never escape
  the hooks: this plugin is the outermost `agent/pre-step` listener, so a throw
  would take down the whole turn.
- One `statSync` per step; filtering is a single pass over one already-rendered
  message.

## 7. Evidence

| What | Where |
|---|---|
| Requirement and baseline measurement | `cangku/261119_k4m_skillgate_spec.md` |
| Gate-1 experiments (matrix, rotation, mutation) | `cangku/tmp/261119_k4m_gate1.md`, `cangku/tmp/k4m_node/` |
| Implementation and test report | `cangku/tmp/261119_k4m_dev_report.md` |
| Acceptance report | `cangku/261119_k4m_skillgate_report.md` |

## License

MIT.
