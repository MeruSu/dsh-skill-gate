/**
 * Pure rules behind `dsh-skill-gate` — everything that can be decided without a
 * running Cordis host lives here, so the test suite can assert the contract
 * against the same code the plugin runs.
 *
 * Two rules exist:
 *
 *  - `resolvePresetPolicy` turns one `skill-gate.json` document plus one preset
 *    name into `{ mode, names, matchers } | null`. `null` means "do not touch
 *    this preset", which is the answer for every unconfigured preset, for
 *    `enabled: false`, and for every configuration that could not be trusted.
 *  - `filterCatalogText` rewrites the model-facing catalog text. It keeps the
 *    original line objects, never a re-rendered description: the catalog lines are
 *    produced by `@deepseek-ai/dsh-tool-skill` through `escapeText`, so
 *    re-escaping would double-escape `& < >`.
 *
 * Why the text and not `source.entries` (gate-1 evidence, 2026-11-19):
 * `dsh-tool-skill` keys its "did the catalog change" decision on a digest of
 * `source.entries` read back from the PERSISTED session event
 * (`catalogHistory`, dsh-tool-skill/lib/index.js 1065-1083). Rewriting the
 * entries makes the persisted digest disagree with the live one on every step,
 * so the host re-renders a full catalog every step; leaving them alone keeps the
 * digest stable and the host drops its own message on the next step instead of
 * re-sending it. See cangku/tmp/261119_k4m_gate1.md.
 */

import { statSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Config file name, directly under `$DSH_HOME`. */
export const CONFIG_FILENAME = "skill-gate.json";

/** The example file next to the package; documentation only, never read by the plugin. */
export const EXAMPLE_FILENAME = "skill-gate.example.json";

/** The two list shapes: `allow` keeps only matches, `deny` drops matches. */
export const MODES = ["allow", "deny"];

/** Shown in place of the entries when a preset hides every skill. */
export const EMPTY_NOTICE = "- No skills are available in this preset (dsh-skill-gate)";

/** Opens and closes the model-facing list inside the catalog message. */
export const SKILLS_OPEN = "<available_skills>";
export const SKILLS_CLOSE = "</available_skills>";

/**
 * Escape a literal name into a regular expression that matches the whole name.
 * Every regex metacharacter is escaped, then `\*` becomes `.*`, so `office*` and
 * `role-*` work while `x.y` stays literal.
 * @param pattern - a configured name, possibly containing `*`.
 * @returns an anchored regular expression source.
 */
export function nameToRegExpSource(pattern) {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return `^${escaped.replace(/\\\*/g, ".*")}$`;
}

/**
 * Whether one skill name is hidden by one policy.
 * @param policy - a resolved policy from {@link resolvePresetPolicy}.
 * @param name - the skill name to test.
 * @returns whether the skill must not be shown or loaded.
 */
export function isHiddenByPolicy(policy, name) {
  if (policy === null || policy === undefined) return false;
  if (typeof name !== "string" || name === "") return false;
  const hit = policy.matchers.some((re) => re.test(name));
  return policy.mode === "allow" ? !hit : hit;
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate one preset entry of the config document.
 * @param entry - the raw `presets[<name>]` value.
 * @returns `{ ok: true, enabled, mode, names }` or `{ ok: false, reason }`.
 */
export function validatePresetEntry(entry) {
  if (!isPlainObject(entry)) return { ok: false, reason: "preset entry is not an object" };
  const enabled = entry.enabled ?? true;
  if (typeof enabled !== "boolean") return { ok: false, reason: "enabled must be a boolean" };
  const guard = entry.guard === undefined ? true : entry.guard;
  if (typeof guard !== "boolean") return { ok: false, reason: "guard must be a boolean" };
  const mode = entry.mode;
  if (typeof mode !== "string" || !MODES.includes(mode)) {
    return { ok: false, reason: `mode must be one of ${MODES.join("/")}` };
  }
  const names = entry.names;
  if (!Array.isArray(names)) return { ok: false, reason: "names must be an array" };
  for (const name of names) {
    if (typeof name !== "string" || name === "") return { ok: false, reason: "names must be non-empty strings" };
  }
  return { ok: true, enabled, guard, mode, names: [...names] };
}

/**
 * Parse a config document into a lookup keyed by preset name.
 * Never throws: an unreadable document yields an empty map plus one reason.
 * @param text - raw file contents.
 * @returns `{ presets: Map, error: string | null }`.
 */
export function parseConfigDocument(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { presets: new Map(), error: `invalid JSON (${err?.message ?? err})` };
  }
  if (!isPlainObject(parsed)) return { presets: new Map(), error: "config root is not an object" };
  const rawPresets = parsed.presets;
  if (rawPresets === undefined) return { presets: new Map(), error: null };
  if (!isPlainObject(rawPresets)) return { presets: new Map(), error: "presets is not an object" };
  const presets = new Map();
  const errors = [];
  for (const [presetName, entry] of Object.entries(rawPresets)) {
    const checked = validatePresetEntry(entry);
    if (!checked.ok) {
      errors.push(`presets.${presetName}: ${checked.reason}`);
      continue;
    }
    presets.set(presetName, {
      enabled: checked.enabled,
      guard: checked.guard,
      mode: checked.mode,
      names: checked.names,
    });
  }
  return { presets, error: errors.length > 0 ? errors.join("; ") : null };
}

/**
 * Resolve one preset's policy out of a parsed config.
 * @param presets - the map from {@link parseConfigDocument}.
 * @param presetId - the composed preset id of the calling agent ("" = unknown).
 * @returns `{ mode, names, matchers }` or `null` when the preset must be left alone.
 */
export function resolvePresetPolicy(presets, presetId) {
  if (!(presets instanceof Map) || typeof presetId !== "string" || presetId === "") return null;
  const entry = presets.get(presetId);
  if (entry === undefined) return null;
  if (entry.enabled === false) return null;
  return {
    mode: entry.mode,
    guard: entry.guard !== false,
    names: [...entry.names],
    matchers: entry.names.map((pattern) => new RegExp(nameToRegExpSource(pattern))),
  };
}

/**
 * Rewrite the model-facing catalog text.
 *
 * The list is located by its opening and closing marker lines; every line in
 * between is kept verbatim unless its parsed name is hidden. Lines that do not
 * parse as `- \`name\`: description` are kept as-is (never dropped silently, and
 * never mistaken for an entry). When every entry is hidden the open/close pair
 * stays, with one notice line between them, so the message itself — and therefore
 * the host's catalog digest — is untouched.
 * @param text - the catalog message text.
 * @param policy - a resolved policy, or null to pass through.
 * @returns `{ text, kept, total, changed }`.
 */
export function filterCatalogText(text, policy) {
  if (typeof text !== "string" || policy === null || policy === undefined) {
    return { text, kept: 0, total: 0, changed: false };
  }
  const lines = text.split("\n");
  const open = lines.indexOf(SKILLS_OPEN);
  const close = lines.indexOf(SKILLS_CLOSE);
  if (open < 0 || close < 0 || close < open) return { text, kept: 0, total: 0, changed: false };
  const body = [];
  let kept = 0;
  let total = 0;
  for (let index = open + 1; index < close; index += 1) {
    const line = lines[index];
    const match = /^- `([^`]*)`: /.exec(line);
    if (match === null) {
      body.push(line);
      continue;
    }
    total += 1;
    if (isHiddenByPolicy(policy, match[1])) continue;
    kept += 1;
    body.push(line);
  }
  if (kept === 0 && total > 0) body.push(EMPTY_NOTICE);
  const rewritten = [
    ...lines.slice(0, open + 1),
    ...body,
    ...lines.slice(close),
  ].join("\n");
  return { text: rewritten, kept, total, changed: rewritten !== text };
}

/**
 * Log label for the catalog message shape. Both shapes carry the same list, so
 * the rewrite is identical; the label only keeps the log honest about which
 * renderer produced the message.
 * @param source - a message `source`.
 * @returns `"catalog"` for the first catalog, `"update"` for a re-published one.
 */
export function catalogFormLabel(source) {
  return source?.update === true ? "update" : "catalog";
}

/**
 * `$DSH_HOME`, falling back to `~/.dsh` exactly like the profile launcher does.
 * @param env - process environment (injected for tests).
 * @returns the absolute home directory.
 */
export function dshHomeOf(env = process.env) {
  const explicit = env?.DSH_HOME;
  if (typeof explicit === "string" && explicit !== "") return explicit;
  return join(homedir(), ".dsh");
}

/**
 * mtime-keyed config reader: one `statSync` per call, a re-read only when the
 * mtime or size moved. A missing file is the normal state (the plugin ships no
 * list), so it is silent; an unreadable or malformed file warns once.
 */
export class ConfigLoader {
  /**
   * @param options.file - absolute config path.
   * @param options.warn - sink for the one-line warnings; never throws upstream.
   */
  constructor({ file, warn }) {
    this.file = file;
    this.warn = warn ?? (() => {});
    /** @type {string | null} */
    this.stamp = null;
    /** @type {Map<string, {enabled: boolean, mode: string, names: string[]}>} */
    this.presets = new Map();
    /** Last reported problem, so the same state warns once. */
    this.reported = null;
  }

  /**
   * Read the config if it changed since the previous call.
   * @returns the current preset map (never null; empty means "allow everything").
   */
  read() {
    let stamp;
    try {
      const info = statSync(this.file);
      stamp = `${info.mtimeMs}:${info.size}`;
    } catch (err) {
      stamp = `missing:${err?.code ?? "unknown"}`;
    }
    if (stamp === this.stamp) return this.presets;
    this.stamp = stamp;
    this.presets = new Map();
    if (stamp.startsWith("missing:")) {
      // No config is the shipped default: every preset untouched, no warning.
      this.reported = null;
      return this.presets;
    }
    let text;
    try {
      text = readFileSync(this.file, "utf8");
    } catch (err) {
      this.report(`cannot read ${this.file} (${err?.message ?? err})`);
      return this.presets;
    }
    const parsed = parseConfigDocument(text);
    this.presets = parsed.presets;
    this.report(parsed.error === null ? null : `${this.file}: ${parsed.error}`);
    return this.presets;
  }

  /**
   * Report a problem once per distinct text; a clean read clears the latch so a
   * later breakage is reported again.
   * @param problem - the warning text, or null when the read was clean.
   */
  report(problem) {
    if (problem === this.reported) return;
    this.reported = problem;
    if (problem !== null) this.warn(problem);
  }
}

/**
 * Guard verdict for one `skill` tool call.
 *
 * Returns undefined (allow) in two cases: the call is not for a hidden skill, or the
 * preset entry carries `guard: false` — hiding the catalog line and refusing the call
 * are independent switches, so a preset can shrink the catalog while leaving the
 * skill reachable.
 * @param exec - `{ name, arguments, agent }` from `ctx.tools.guard`.
 * @param policyOf - `(agent) => policy | null`.
 * @param reasonOf - `(name) => string` for the refusal text.
 * @returns the refusal string, or undefined to allow the call.
 */
export function guardVerdict(exec, policyOf, reasonOf) {
  const name = String(exec?.name ?? "");
  if (name !== "skill") return undefined;
  const skillName = String(exec?.arguments?.name ?? "");
  if (skillName === "") return undefined;
  let policy = null;
  try {
    policy = policyOf(exec?.agent);
  } catch {
    policy = null;
  }
  if (!isHiddenByPolicy(policy, skillName)) return undefined;
  // `guard: false` keeps the catalog hidden but lets a call through: the model can
  // still reach a skill it was never told about (a name it learned elsewhere).
  if (policy !== null && policy !== undefined && policy.guard === false) return undefined;
  return reasonOf(skillName);
}