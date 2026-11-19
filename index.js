/**
 * Host half of `dsh-skill-gate` — hide skills per agent preset.
 *
 * The host has no "filter skills per preset" switch (`dsh-tool-skill` only knows
 * `catalogDescriptionMaxLength`, and `dsh-skill`'s registry is append-only), so
 * this plugin works the two places that do exist:
 *
 *  1. `agent/pre-step` — rewrite the model-facing `<available_skills>` block of the
 *     `skill-catalog` message, so a hidden skill never reaches the context.
 *  2. `ctx.tools.guard` — refuse a `skill` call for a hidden name.
 *
 * Installing this plugin changes nothing: with no `$DSH_HOME/skill-gate.json`
 * there is no list, so every preset passes through untouched.
 *
 * Three rules this file keeps, each one paid for by a measurement
 * (`cangku/tmp/261119_k4m_gate1.md`):
 *
 *  - The listener registers with `{ prepend: true }`. Cordis runs a waterfall
 *    outermost-first (cordis/lib/index.js:903-918), so a plain `on()` that mounts
 *    after `dsh-tool-skill` would sit INSIDE its listener: it would only see the
 *    decision after the host had produced it, and the host's own listener would
 *    replace the work on the next step (measured: the message stays at its full
 *    9,917 B and nothing is filtered).
 *  - `source.entries` is passed through untouched. `dsh-tool-skill` digests the
 *    entries of the PERSISTED catalog message (dsh-tool-skill/lib/index.js
 *    1065-1083); filtering them makes the persisted digest disagree with the live
 *    snapshot on every step, and the host answers by re-sending a full catalog each
 *    step (measured: +1 `update` message per step).
 *  - Nothing throws. The listener is the outermost one, so an exception would
 *    reach the agent loop's `preStep` catch and fail the whole turn
 *    (dsh-agent-loop/lib/index.js:709-712).
 *
 * Zero tools, zero system-prompt sections, zero injected messages: this plugin
 * exists to save context, so it must not spend any.
 */
import { join } from "node:path";
import {
  CONFIG_FILENAME,
  ConfigLoader,
  catalogFormLabel,
  dshHomeOf,
  filterCatalogText,
  guardVerdict,
  resolvePresetPolicy,
} from "./lib/policy.js";

/** Package name; also the module id the loader registers. */
export const name = "dsh-skill-gate";

/** Only the guard needs a service; `agent/pre-step` is an event and `agentPresets` is optional. */
export const inject = ["tools"];

/** Prefix of every log line this plugin writes. */
const LOG_PREFIX = "[skill-gate]";

/**
 * The reason a hidden skill gives when the model tries to load it. Chinese, like
 * every other guard refusal on this machine (`dsh-tool-skill`'s own errors, the
 * sandbox's framed denials all render in the host's language); it is an error
 * string, not a rendered list, so it does not follow the catalog's English.
 * @param skillName - the refused skill name.
 * @returns the refusal text handed to the model.
 */
export function hiddenReason(skillName) {
  return `技能「${skillName}」在本预设中被隐藏（dsh-skill-gate）`;
}

/**
 * How many parent hops the fallback chain may climb. A subagent tree is at most a
 * few deep; the cap is what makes a corrupt or cyclic lineage terminate instead of
 * walking forever.
 */
export const MAX_PARENT_DEPTH = 4;

/** Coerce whatever a host service returns into a preset id, or "". */
function asPresetId(value) {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Level 1 — the composition this agent is mounted in.
 * A root session's composed preset is authoritative; the later levels never
 * override a non-empty answer from here.
 * Mirrors `dsh-scope-manager/lib/index.js:522-533`: the preset service is an
 * optional dependency, so a missing or throwing service degrades to "" (= keep
 * looking) instead of failing the step.
 * @returns the preset id, or "".
 */
function composedPresetOf(ctx, agent) {
  const presets = ctx.get("agentPresets", false);
  if (!presets || typeof presets.composedPreset !== "function") return "";
  try {
    return asPresetId(presets.composedPreset(agent?.ctx));
  } catch {
    return "";
  }
}

/**
 * Level 2 — the preset this session itself recorded.
 * Reads the `agentPreset` session projection (`presetForSession`, registry
 * 480-482 → `stateOf`), which is an O(1) map read over committed state, NOT a
 * scan of session events. This is the level that makes subagent sessions work:
 * a subagent is mounted in its parent's composition, so level 1 returns "" for
 * it while its own session header still names the preset it was launched with.
 * @returns the preset id, or "".
 */
function sessionPresetOf(ctx, agent) {
  const presets = ctx.get("agentPresets", false);
  if (!presets || typeof presets.presetForSession !== "function") return "";
  const session = agent?.session;
  if (session === undefined || session === null) return "";
  try {
    return asPresetId(presets.presetForSession(session));
  } catch {
    return "";
  }
}

/** The durable parent session id recorded on a child's header, or "". */
function parentSessionIdOf(agent) {
  try {
    const header = agent?.session?.header;
    if (header === undefined || header === null) return "";
    return asPresetId(header.parentSession);
  } catch {
    return "";
  }
}

/**
 * The live agent for a session id, or undefined.
 * `ctx.agents.get` is a plain registry lookup (dsh-agent/lib/index.js:726) — an
 * in-memory map read, never a session read.
 */
function parentAgentOf(ctx, sessionId) {
  const agents = ctx.get("agents", false);
  if (!agents || typeof agents.get !== "function") return undefined;
  try {
    return agents.get(sessionId) ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Walk the fallback chain: the agent itself (levels 1 and 2), then its live parent
 * agent (levels 1 and 2 again), up to {@link MAX_PARENT_DEPTH} hops.
 * The same idiom the host uses for lineage (dsh-subagent/lib/index.js:1742-1754),
 * with a depth cap and a visited set so a cyclic or broken chain cannot loop.
 * @returns the first non-empty preset id, or "" when nothing resolves.
 */
function resolvePresetId(ctx, agent, seen, remaining) {
  if (agent === undefined || agent === null) return "";
  const composed = composedPresetOf(ctx, agent);
  if (composed !== "") return composed;
  const own = sessionPresetOf(ctx, agent);
  if (own !== "") return own;
  if (remaining <= 0) return "";
  const parentId = parentSessionIdOf(agent);
  if (parentId === "" || seen.has(parentId)) return "";
  seen.add(parentId);
  const parent = parentAgentOf(ctx, parentId);
  if (parent === undefined) return "";
  return resolvePresetId(ctx, parent, seen, remaining - 1);
}

/**
 * Preset id of one agent, with the subagent fallback chain.
 *
 * Order: its own composition, then its own session's recorded preset, then the
 * nearest live ancestor that resolves one. "" means "no preset found" and the
 * caller must leave the session alone — an unresolved lineage is never treated as
 * a match. No level may throw: every failure degrades to the next one.
 * @param ctx - the plugin context.
 * @param agent - the agent of the current step.
 * @returns the preset id, or "".
 */
export function presetIdOfAgent(ctx, agent) {
  return resolvePresetId(ctx, agent, new Set(), MAX_PARENT_DEPTH);
}

/**
 * Mount the gate.
 * @param ctx - Cordis context.
 * @param config - reserved; the gate reads nothing from it (the list lives in
 *   `$DSH_HOME/skill-gate.json`, so it can be edited without recomposing).
 */
export function apply(ctx, config = {}) {
  void config;
  const logger = ctx.logger;
  const warn = (message) => {
    try {
      logger?.warn?.(`${LOG_PREFIX} ${message}`);
    } catch {
      /* logging must never break a step */
    }
  };
  const configFile = join(dshHomeOf(process.env), CONFIG_FILENAME);
  const loader = new ConfigLoader({ file: configFile, warn });

  /**
   * Say once which presets the loaded config covers. Tied to the loader's file
   * stamp, so it appears per file version — never once per step.
   * @param presets - the freshly read preset map.
   */
  let announcedStamp;
  function announceLoaded(presets) {
    if (loader.stamp === announcedStamp) return;
    announcedStamp = loader.stamp;
    if (presets.size === 0) return;
    try {
      logger?.info?.(`${LOG_PREFIX} config loaded presets=${[...presets.keys()].sort().join(",")}`);
    } catch {
      /* logging must never break a step */
    }
  }

  /**
   * Policy for one agent's preset.
   * @param agent - the agent owning the step or the tool call.
   * @returns a resolved policy, or null when the preset must be left alone.
   */
  function policyOf(agent) {
    const presetId = presetIdOfAgent(ctx, agent);
    if (presetId === "") return null;
    const presets = loader.read();
    announceLoaded(presets);
    return resolvePresetPolicy(presets, presetId);
  }

  /**
   * One step: run the chain, then rewrite the catalog message in place.
   * @param payload - `{ agent, messages, signal }` from the waterfall.
   * @param next - the next listener in the chain; must be called exactly once.
   * @returns the decision, with the catalog text filtered when a policy applies.
   */
  async function rewriteCatalog(payload, next) {
    const decision = await next();
    try {
      if (decision === undefined || decision === null || decision.kind === "reject") return decision;
      const messages = decision.messages;
      if (!Array.isArray(messages)) return decision;
      const index = messages.findIndex((message) => message?.source?.kind === "skill-catalog");
      if (index < 0) return decision;
      const policy = policyOf(payload?.agent);
      if (policy === null) return decision;
      const message = messages[index];
      const content = Array.isArray(message.content) ? message.content : [];
      const textPart = content[0];
      if (textPart === undefined || typeof textPart.text !== "string") return decision;
      const filtered = filterCatalogText(textPart.text, policy);
      if (!filtered.changed) return decision;
      const before = Buffer.byteLength(textPart.text, "utf8");
      const after = Buffer.byteLength(filtered.text, "utf8");
      logger?.debug?.(
        `${LOG_PREFIX} preset=${presetIdOfAgent(ctx, payload?.agent)} mode=${policy.mode} `
          + `guard=${policy.guard === false ? "off" : "on"} `
          + `form=${catalogFormLabel(message.source)} kept=${filtered.kept}/${filtered.total} bytes=${before}->${after}`,
      );
      const replacement = {
        ...message,
        content: [{ ...textPart, text: filtered.text }, ...content.slice(1)],
      };
      const nextMessages = messages.slice();
      nextMessages[index] = replacement;
      return { ...decision, messages: nextMessages };
    } catch (err) {
      warn(`catalog rewrite skipped: ${err?.message ?? err}`);
      return decision;
    }
  }

  ctx.on("agent/pre-step", rewriteCatalog, { prepend: true });

  const releaseGuard = ctx.tools.guard((exec) => guardVerdict(exec, policyOf, hiddenReason));
  if (typeof releaseGuard === "function") ctx.effect?.(() => releaseGuard);

  // Nothing else may be attached to ctx. A Cordis context is managed: an undeclared
  // property assignment throws "cannot set property X without provide" from inside
  // apply(), which leaves the plugin COMPLETELY inert while the host boots and logs
  // only one warning (0.1.0 shipped exactly that bug). Everything this plugin needs
  // stays local to apply().
}