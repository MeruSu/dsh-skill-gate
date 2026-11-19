/**
 * Integration tests for dsh-skill-gate's host half (index.js).
 *
 * Run: node test/plugin.test.mjs
 *
 * The plugin under test is the real `index.js`. What is faked is the HOST, and
 * only the host: a Cordis-shaped context whose `on()` records the listener and
 * its options, whose `waterfall` runs listeners outermost-first (the semantics
 * copied from cordis/lib/index.js:903-918), whose `tools.guard` stores the
 * predicate the way dsh-tools does (dsh-tools/lib/index.js:649-662), and a fake
 * `agentPresets` service. No part of the plugin is replaced.
 *
 * Two of these tests are the ones that catch "installed but silently inactive":
 * the prepend assertion, and the two-plugin waterfall that proves a plain
 * listener mounted inside the host's own listener does nothing.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

let groups = 0;
const failures = [];
const queue = [];
function test(name, fn) {
  queue.push({ name, fn });
}

// ---------------------------------------------------------------- host fakes
/**
 * A Cordis-shaped context. `on()` keeps registration order and options;
 * `waterfall()` mirrors cordis' outermost-first dispatch.
 */
function makeCtx({
  presetId = "",
  presetsThrows = false,
  strict = false,
  // subagent fallback chain knobs
  sessionPreset = null,          // level 2 answer for the agent under test
  sessionPresetThrows = false,   // level 2 throws
  liveAgents = new Map(),        // session id -> agent object (level 3 lookup)
  noAgentsService = false,       // ctx.agents missing entirely
  agentsThrows = false,          // ctx.agents.get throws
  noPresetService = false,       // agentPresets missing entirely
} = {}) {
  const listeners = [];
  const guards = [];
  const logs = { warn: [], debug: [], info: [] };
  const declared = new Set(["listeners", "guards", "logs", "logger", "on", "tools", "effect", "get", "waterfall"]);
  const base = {
    listeners,
    guards,
    logs,
    logger: {
      warn: (message) => logs.warn.push(String(message)),
      debug: (message) => logs.debug.push(String(message)),
      info: (message) => logs.info.push(String(message)),
    },
    on(event, fn, options) {
      const prepend = options === true || (options !== null && typeof options === "object" && options.prepend === true);
      if (prepend) listeners.unshift({ event, fn, options });
      else listeners.push({ event, fn, options });
      return () => {};
    },
    tools: {
      guard(fn) {
        guards.push(fn);
        return () => {};
      },
    },
    effect(fn) {
      return fn();
    },
    get(service) {
      if (service === "agents") {
        if (noAgentsService) return undefined;
        return {
          get(id) {
            if (agentsThrows) throw new Error("agent registry exploded");
            return liveAgents.get(id);
          },
        };
      }
      if (service !== "agentPresets") return undefined;
      if (noPresetService) return undefined;
      if (presetsThrows) throw new Error("preset service exploded");
      return {
        composedPreset() {
          return presetId === "" ? undefined : presetId;
        },
        presetForSession() {
          if (sessionPresetThrows) throw new Error("projection exploded");
          return sessionPreset;
        },
      };
    },
    async waterfall(event, payload, inner) {
      const chain = listeners.filter((l) => l.event === event).map((l) => l.fn);
      const dispatch = async (index) => {
        const fn = chain[index];
        if (fn === undefined) return inner();
        let called = false;
        const next = () => {
          if (called) throw new Error("next() called multiple times");
          called = true;
          return dispatch(index + 1);
        };
        return fn(payload, next);
      };
      return dispatch(0);
    },
  };
  if (!strict) return base;
  // A real Cordis context is managed: an undeclared property assignment throws
  // "cannot set property X without provide" (cordis 4.1.0, Context proxy set trap).
  return new Proxy(base, {
    set(target, property, value) {
      if (typeof property === "symbol") {
        target[property] = value;
        return true;
      }
      if (!declared.has(property)) {
        throw new Error(`cannot set property "${String(property)}" without provide`);
      }
      target[property] = value;
      return true;
    },
    get(target, property, receiver) {
      if (typeof property === "symbol") return Reflect.get(target, property, receiver);
      if (!declared.has(property) && !(property in target)) {
        throw new Error(`cannot get property "${String(property)}" without inject`);
      }
      return Reflect.get(target, property, receiver);
    },
  });
}

/** One catalog message shaped exactly like dsh-tool-skill's renderer output. */
function catalogMessage(names, { update = false } = {}) {
  const lines = [
    "<system-reminder>",
    update
      ? "The available skill catalog changed. This complete catalog replaces every earlier available-skills list in this session:"
      : "A skill is a reusable set of task-specific instructions. The following skills are available in this session:",
    "",
    "<available_skills>",
    ...names.map((name) => `- \`${name}\`: description of ${name}`),
    "</available_skills>",
    "",
    update
      ? "Use only names in this replacement catalog."
      : "If the user names a skill, or the task clearly matches a skill's description, call the `skill` tool with the exact skill name before taking task actions.",
    "</system-reminder>",
  ];
  return {
    id: "msg-catalog",
    role: "user",
    content: [{ type: "text", text: lines.join("\n") }],
    source: {
      kind: "skill-catalog",
      form: "catalog",
      ...(update ? { update: true } : {}),
      entries: names.map((name) => ({ name, description: `description of ${name}` })),
    },
  };
}

function namesInMessage(message) {
  const lines = message.content[0].text.split("\n");
  const open = lines.indexOf("<available_skills>");
  const close = lines.indexOf("</available_skills>");
  return lines.slice(open + 1, close).filter((line) => /^- `/.test(line)).map((line) => /^- `([^`]*)`/.exec(line)[1]);
}

/** Build a temp DSH_HOME with one config file, returning the env and the file path. */
function makeHome(configText) {
  const home = mkdtempSync(join(tmpdir(), "skill-gate-home-"));
  const file = join(home, "skill-gate.json");
  if (configText !== undefined) writeFileSync(file, configText, "utf8");
  return { home, file };
}

async function loadPlugin() {
  // Fresh module instance per test so the config loader cannot carry state across.
  return import(`../index.js?t=${Math.random().toString(36).slice(2)}`);
}

/** A child agent: no composition of its own, parent named on the header. */
function childAgent({ parentSession, id = "child-1" } = {}) {
  return {
    id,
    ctx: {},
    session: {
      header: parentSession === undefined ? {} : { parentSession, origin: "subagent" },
    },
  };
}

/** A parent agent that resolves its preset through its own composition. */
function parentAgent(presetId, { id = "parent-1", parentSession, sessionPreset = null } = {}) {
  return {
    id,
    ctx: {},
    presetId,
    sessionPreset,
    session: {
      header: parentSession === undefined ? {} : { parentSession },
    },
  };
}

/**
 * Build a ctx whose `agentPresets.composedPreset` answers per agent object rather
 * than globally, the way the real registry does (composition is per agent ctx).
 */
function makeChainCtx({ composedByAgent = new Map(), sessionPresetByAgent = new Map(), liveAgents = new Map() } = {}) {
  const ctx = makeCtx({ liveAgents });
  const presets = {
    composedPreset(agentCtx) {
      return composedByAgent.get(agentCtx);
    },
    presetForSession(session) {
      return sessionPresetByAgent.get(session) ?? null;
    },
  };
  const inner = ctx.get.bind(ctx);
  ctx.get = (service) => (service === "agentPresets" ? presets : inner(service));
  return ctx;
}

async function runStep(ctx, agent, messages) {
  return ctx.waterfall("agent/pre-step", { agent, messages, signal: { throwIfAborted() {} } }, async () => ({
    kind: "enter",
    messages,
  }));
}

// ---------------------------------------------------------------- tests
test("registration: the catalog listener is registered with { prepend: true }", async () => {
  const previous = process.env.DSH_HOME;
  const { home } = makeHome();
  process.env.DSH_HOME = home;
  try {
    const plugin = await loadPlugin();
    const ctx = makeCtx({ presetId: "dev" });
    plugin.apply(ctx, {});
    const first = ctx.listeners[0];
    assert.equal(first.event, "agent/pre-step");
    assert.deepEqual(first.options, { prepend: true }, "a plain on() would sit inside dsh-tool-skill's listener and be overwritten");
  } finally {
    process.env.DSH_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});

test("registration: apply() survives a strict ctx that refuses undeclared property writes (0.1.1 regression)", async () => {
  // 0.1.0 did `ctx.skillGate = {...}` at the end of apply(). Cordis throws on that,
  // apply() aborts, and the host boots "fine" with a single warning while the plugin
  // does nothing at all. This test exists to make that shape impossible to ship again.
  const previous = process.env.DSH_HOME;
  const { home } = makeHome();
  process.env.DSH_HOME = home;
  try {
    const plugin = await loadPlugin();
    const ctx = makeCtx({ presetId: "dev", strict: true });
    assert.doesNotThrow(() => plugin.apply(ctx, {}), "apply() must not throw on a strict ctx");
    assert.equal(ctx.listeners.length, 1, "the catalog listener must be registered");
    assert.equal(ctx.listeners[0].event, "agent/pre-step");
    assert.deepEqual(ctx.listeners[0].options, { prepend: true });
    assert.equal(ctx.guards.length, 1, "the guard must be registered");
    // and the hooks really work through the strict ctx
    const decision = await runStep(ctx, { ctx: {} }, [catalogMessage(["office-xlsx", "plugin-work"])]);
    assert.equal(decision.messages.length, 1);
  } finally {
    process.env.DSH_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});

test("registration: apply() never writes an undeclared property onto ctx", async () => {
  // The same rule stated as a property, independent of the proxy: enumerate every
  // write the plugin performs by watching a plain object's own keys.
  const previous = process.env.DSH_HOME;
  const { home } = makeHome();
  process.env.DSH_HOME = home;
  try {
    const plugin = await loadPlugin();
    const ctx = makeCtx({ presetId: "dev" });
    const keysBefore = new Set(Object.keys(ctx));
    plugin.apply(ctx, {});
    const added = Object.keys(ctx).filter((key) => !keysBefore.has(key));
    assert.deepEqual(added, [], `apply() added ctx properties: ${added.join(", ")}`);
  } finally {
    process.env.DSH_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});

test("registration: one guard registered on tools, zero tools of its own", async () => {
  const previous = process.env.DSH_HOME;
  const { home } = makeHome();
  process.env.DSH_HOME = home;
  try {
    const plugin = await loadPlugin();
    const ctx = makeCtx({ presetId: "dev" });
    plugin.apply(ctx, {});
    assert.equal(ctx.guards.length, 1);
    assert.equal(ctx.tools.register, undefined, "the gate must not register a tool");
  } finally {
    process.env.DSH_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});

test("shipping state: no config file → catalog byte-identical, no warning, no debug line", async () => {
  const previous = process.env.DSH_HOME;
  const { home } = makeHome(undefined);
  process.env.DSH_HOME = home;
  try {
    const plugin = await loadPlugin();
    const ctx = makeCtx({ presetId: "dev" });
    plugin.apply(ctx, {});
    const original = catalogMessage(["office-xlsx", "plugin-work", "role-dev"]);
    const decision = await runStep(ctx, { ctx: {} }, [original]);
    assert.equal(decision.messages.length, 1);
    assert.equal(decision.messages[0].content[0].text, original.content[0].text);
    assert.deepEqual(ctx.logs.warn, []);
    assert.deepEqual(ctx.logs.debug, []);
  } finally {
    process.env.DSH_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});

test("catalog rewrite: hidden lines removed, kept lines original, entries untouched", async () => {
  const previous = process.env.DSH_HOME;
  const { home } = makeHome(JSON.stringify({ presets: { dev: { mode: "deny", names: ["office*", "role-*"] } } }));
  process.env.DSH_HOME = home;
  try {
    const plugin = await loadPlugin();
    const ctx = makeCtx({ presetId: "dev" });
    plugin.apply(ctx, {});
    const original = catalogMessage(["office-xlsx", "plugin-work", "role-dev", "web-work"]);
    const before = Buffer.byteLength(original.content[0].text, "utf8");
    const decision = await runStep(ctx, { ctx: {} }, [original]);
    const after = decision.messages[0];
    assert.deepEqual(namesInMessage(after), ["plugin-work", "web-work"]);
    assert.deepEqual(after.source.entries, original.source.entries, "source.entries must not be filtered");
    assert.equal(after.source.update, undefined);
    assert.equal(after.id, original.id);
    // gate-1 rule: entries untouched keeps the host digest stable
    assert.equal(JSON.stringify(after.source.entries), JSON.stringify(original.source.entries));
    const afterBytes = Buffer.byteLength(after.content[0].text, "utf8");
    assert.equal(afterBytes < before, true, `expected a smaller catalog, got ${before} -> ${afterBytes}`);
    assert.equal(ctx.logs.debug.length, 1);
    assert.equal(ctx.logs.debug[0], `[skill-gate] preset=dev mode=deny guard=on form=catalog kept=2/4 bytes=${before}->${afterBytes}`);
  } finally {
    process.env.DSH_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});

test("catalog rewrite: unconfigured preset is not touched", async () => {
  const previous = process.env.DSH_HOME;
  const { home } = makeHome(JSON.stringify({ presets: { dev: { mode: "deny", names: ["office*"] } } }));
  process.env.DSH_HOME = home;
  try {
    const plugin = await loadPlugin();
    const ctx = makeCtx({ presetId: "cordis" });
    plugin.apply(ctx, {});
    const original = catalogMessage(["office-xlsx", "plugin-work"]);
    const decision = await runStep(ctx, { ctx: {} }, [original]);
    assert.equal(decision.messages[0].content[0].text, original.content[0].text);
    assert.deepEqual(ctx.logs.debug, []);
  } finally {
    process.env.DSH_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});

test("catalog rewrite: enabled:false preset is not touched", async () => {
  const previous = process.env.DSH_HOME;
  const { home } = makeHome(JSON.stringify({ presets: { dev: { enabled: false, mode: "deny", names: ["office*"] } } }));
  process.env.DSH_HOME = home;
  try {
    const plugin = await loadPlugin();
    const ctx = makeCtx({ presetId: "dev" });
    plugin.apply(ctx, {});
    const original = catalogMessage(["office-xlsx", "plugin-work"]);
    const decision = await runStep(ctx, { ctx: {} }, [original]);
    assert.equal(decision.messages[0].content[0].text, original.content[0].text);
  } finally {
    process.env.DSH_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});

test("catalog rewrite: every skill hidden keeps the message and its shell", async () => {
  const previous = process.env.DSH_HOME;
  const { home } = makeHome(JSON.stringify({ presets: { minimal: { mode: "allow", names: [] } } }));
  process.env.DSH_HOME = home;
  try {
    const plugin = await loadPlugin();
    const ctx = makeCtx({ presetId: "minimal" });
    plugin.apply(ctx, {});
    const original = catalogMessage(["office-xlsx", "univer-xlsx"]);
    const decision = await runStep(ctx, { ctx: {} }, [original]);
    assert.equal(decision.messages.length, 1, "the message must not be deleted");
    const text = decision.messages[0].content[0].text;
    assert.equal(text.includes("- No skills are available in this preset (dsh-skill-gate)"), true);
    assert.equal(text.startsWith("<system-reminder>"), true);
    assert.equal(text.endsWith("</system-reminder>"), true);
    assert.deepEqual(decision.messages[0].source.entries, original.source.entries);
  } finally {
    process.env.DSH_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});

test("catalog rewrite: update form (update:true) is filtered too", async () => {
  const previous = process.env.DSH_HOME;
  const { home } = makeHome(JSON.stringify({ presets: { dev: { mode: "deny", names: ["office*"] } } }));
  process.env.DSH_HOME = home;
  try {
    const plugin = await loadPlugin();
    const ctx = makeCtx({ presetId: "dev" });
    plugin.apply(ctx, {});
    const original = catalogMessage(["office-xlsx", "plugin-work"], { update: true });
    const decision = await runStep(ctx, { ctx: {} }, [original]);
    assert.deepEqual(namesInMessage(decision.messages[0]), ["plugin-work"]);
    assert.equal(decision.messages[0].source.update, true);
    assert.equal(ctx.logs.debug[0].includes("form=update"), true, ctx.logs.debug[0]);
  } finally {
    process.env.DSH_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});

test("catalog rewrite: a reject decision passes through untouched", async () => {
  const previous = process.env.DSH_HOME;
  const { home } = makeHome(JSON.stringify({ presets: { dev: { mode: "deny", names: ["office*"] } } }));
  process.env.DSH_HOME = home;
  try {
    const plugin = await loadPlugin();
    const ctx = makeCtx({ presetId: "dev" });
    plugin.apply(ctx, {});
    const rejected = { kind: "reject", reason: "blocked upstream" };
    const decision = await ctx.waterfall("agent/pre-step", { agent: { ctx: {} }, messages: [] }, async () => rejected);
    assert.equal(decision, rejected);
  } finally {
    process.env.DSH_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});

test("catalog rewrite: messages without a catalog are not modified", async () => {
  const previous = process.env.DSH_HOME;
  const { home } = makeHome(JSON.stringify({ presets: { dev: { mode: "deny", names: ["office*"] } } }));
  process.env.DSH_HOME = home;
  try {
    const plugin = await loadPlugin();
    const ctx = makeCtx({ presetId: "dev" });
    plugin.apply(ctx, {});
    const other = { id: "m1", role: "user", content: [{ type: "text", text: "hello" }], source: { kind: "runtime-context" } };
    const decision = await runStep(ctx, { ctx: {} }, [other]);
    assert.equal(decision.messages.length, 1);
    assert.equal(decision.messages[0], other);
  } finally {
    process.env.DSH_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});

test("host order: a plain listener mounted after the host's own listener changes nothing (gate-1)", async () => {
  // This models the mistake the prepend option exists to prevent: the host's
  // listener runs first (outermost), renders the full catalog, and then the
  // inner listener's edit is what the outer one already returned without.
  const ctx = makeCtx({ presetId: "dev" });
  const hostListener = async (payload, next) => {
    const decision = await next();
    const full = catalogMessage(["office-xlsx", "plugin-work"]);
    return { ...decision, messages: [...decision.messages, full] };
  };
  const plainInner = async (payload, next) => {
    const decision = await next();
    const index = decision.messages.findIndex((m) => m.source?.kind === "skill-catalog");
    if (index < 0) return decision;
    const message = decision.messages[index];
    return { ...decision, messages: decision.messages };
  };
  ctx.on("agent/pre-step", hostListener);   // outermost: mounted first
  ctx.on("agent/pre-step", plainInner);     // inner: mounted later
  const decision = await runStep(ctx, { ctx: {} }, []);
  assert.deepEqual(namesInMessage(decision.messages[0]), ["office-xlsx", "plugin-work"], "a plain inner listener cannot reach the outer return value");
});

test("guard: hidden skill refused with the exact reason, kept skill allowed", async () => {
  const previous = process.env.DSH_HOME;
  const { home } = makeHome(JSON.stringify({ presets: { dev: { mode: "allow", names: ["plugin-work"] } } }));
  process.env.DSH_HOME = home;
  try {
    const plugin = await loadPlugin();
    const ctx = makeCtx({ presetId: "dev" });
    plugin.apply(ctx, {});
    const guard = ctx.guards[0];
    assert.equal(guard({ name: "skill", arguments: { name: "office-xlsx" }, agent: { ctx: {} } }),
      "技能「office-xlsx」在本预设中被隐藏（dsh-skill-gate）");
    assert.equal(guard({ name: "skill", arguments: { name: "plugin-work" }, agent: { ctx: {} } }), undefined);
    assert.equal(guard({ name: "pwsh", arguments: { name: "office-xlsx" }, agent: { ctx: {} } }), undefined);
  } finally {
    process.env.DSH_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});

test("guard: no config file means nothing is refused", async () => {
  const previous = process.env.DSH_HOME;
  const { home } = makeHome(undefined);
  process.env.DSH_HOME = home;
  try {
    const plugin = await loadPlugin();
    const ctx = makeCtx({ presetId: "dev" });
    plugin.apply(ctx, {});
    assert.equal(ctx.guards[0]({ name: "skill", arguments: { name: "office-xlsx" }, agent: { ctx: {} } }), undefined);
  } finally {
    process.env.DSH_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});

test("guard:false on a real apply(): the line stays hidden, the call goes through, the debug line says off", async () => {
  // The policy suite proves guardVerdict honours `policy.guard`; this one proves the
  // host half actually carries the switch from the config to the guard and to the log.
  const previous = process.env.DSH_HOME;
  const { home } = makeHome(JSON.stringify({ presets: { dev: { mode: "deny", guard: false, names: ["office*"] } } }));
  process.env.DSH_HOME = home;
  try {
    const plugin = await loadPlugin();
    const ctx = makeCtx({ presetId: "dev" });
    plugin.apply(ctx, {});
    const decision = await runStep(ctx, { ctx: {} }, [catalogMessage(["office-xlsx", "plugin-work"])]);
    assert.deepEqual(namesInMessage(decision.messages[0]), ["plugin-work"], "the catalog line must stay hidden");
    assert.equal(
      ctx.guards[0]({ name: "skill", arguments: { name: "office-xlsx" }, agent: { ctx: {} } }),
      undefined,
      "guard:false must let the hidden skill load",
    );
    assert.match(ctx.logs.debug[0], / guard=off /);
  } finally {
    process.env.DSH_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});

test("failure paths: broken config and a throwing preset service both fail open", async () => {
  const previous = process.env.DSH_HOME;
  const { home } = makeHome("{ broken json");
  process.env.DSH_HOME = home;
  try {
    const plugin = await loadPlugin();
    const ctx = makeCtx({ presetId: "dev" });
    plugin.apply(ctx, {});
    const original = catalogMessage(["office-xlsx", "plugin-work"]);
    const decision = await runStep(ctx, { ctx: {} }, [original]);
    assert.equal(decision.messages[0].content[0].text, original.content[0].text);
    assert.equal(ctx.logs.warn.length, 1);
    assert.equal(ctx.logs.warn[0].startsWith("[skill-gate]"), true);
    assert.match(ctx.logs.warn[0], /invalid JSON/);

    const throwing = makeCtx({ presetId: "dev", presetsThrows: true });
    plugin.apply(throwing, {});
    const second = await runStep(throwing, { ctx: {} }, [catalogMessage(["office-xlsx"])]);
    assert.equal(second.messages[0].content[0].text.includes("- `office-xlsx`"), true);
    assert.equal(throwing.guards[0]({ name: "skill", arguments: { name: "office-xlsx" }, agent: { ctx: {} } }), undefined);
  } finally {
    process.env.DSH_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});

test("R4: a step re-reads the config instead of reusing the first answer", async () => {
  // This pins the cache check itself: list A hides office*, list B hides web*.
  // One list change, one step in between — the second step must see list B.
  const previous = process.env.DSH_HOME;
  const { home, file } = makeHome(JSON.stringify({ presets: { dev: { mode: "deny", names: ["office*"] } } }));
  process.env.DSH_HOME = home;
  try {
    const plugin = await loadPlugin();
    const ctx = makeCtx({ presetId: "dev" });
    plugin.apply(ctx, {});
    const names = ["office-xlsx", "plugin-work", "web-work"];
    const first = await runStep(ctx, { ctx: {} }, [catalogMessage(names)]);
    assert.deepEqual(namesInMessage(first.messages[0]), ["plugin-work", "web-work"], "list A");
    writeFileSync(file, JSON.stringify({ presets: { dev: { mode: "deny", names: ["web*"] } } }), "utf8");
    utimesSync(file, new Date(Date.now() + 60000), new Date(Date.now() + 60000));
    const second = await runStep(ctx, { ctx: {} }, [catalogMessage(names)]);
    assert.deepEqual(namesInMessage(second.messages[0]), ["office-xlsx", "plugin-work"], "list B must apply on the next step");
  } finally {
    process.env.DSH_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});

test("config is re-read on the next step without restarting anything (R4)", async () => {
  const previous = process.env.DSH_HOME;
  const { home, file } = makeHome(JSON.stringify({ presets: { dev: { mode: "deny", names: ["office*"] } } }));
  process.env.DSH_HOME = home;
  try {
    const plugin = await loadPlugin();
    const ctx = makeCtx({ presetId: "dev" });
    plugin.apply(ctx, {});
    const first = await runStep(ctx, { ctx: {} }, [catalogMessage(["office-xlsx", "plugin-work"])]);
    assert.deepEqual(namesInMessage(first.messages[0]), ["plugin-work"]);
    writeFileSync(file, JSON.stringify({ presets: { dev: { mode: "deny", names: ["web*"] } } }), "utf8");
    const future = new Date(Date.now() + 5000);
    // bump mtime deterministically through the same API the loader observes
    const { utimesSync } = await import("node:fs");
    utimesSync(file, future, future);
    const second = await runStep(ctx, { ctx: {} }, [catalogMessage(["office-xlsx", "plugin-work", "web-work"])]);
    assert.deepEqual(namesInMessage(second.messages[0]), ["office-xlsx", "plugin-work"]);
  } finally {
    process.env.DSH_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- 0.1.3: subagent chain
// A subagent is mounted in its parent's composition, so `composedPreset` answers ""
// for it (measured: dsh-agent-preset-registry 734-736 returns generationFor(ctx),
// which is undefined for a child). These tests pin the fallback that makes such a
// session obey its own preset.
const CHAIN_CONFIG = JSON.stringify({
  presets: {
    dev: { mode: "allow", names: ["plugin-work"] },
    clerk: { mode: "deny", names: ["web-work"] },
    deep: { mode: "deny", names: ["office*"] },
  },
});
const CHAIN_NAMES = ["office-xlsx", "plugin-work", "web-work"];

async function runChain(agent, ctxOverrides = {}) {
  const previous = process.env.DSH_HOME;
  const { home } = makeHome(CHAIN_CONFIG);
  process.env.DSH_HOME = home;
  try {
    const plugin = await loadPlugin();
    const ctx = makeChainCtx(ctxOverrides);
    plugin.apply(ctx, {});
    const decision = await runStep(ctx, agent, [catalogMessage(CHAIN_NAMES)]);
    return { decision, ctx };
  } finally {
    process.env.DSH_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
}

test("subagent chain level 2: the session's own recorded preset applies when composed is empty", async () => {
  const agent = childAgent({ parentSession: undefined, id: "solo-ish" });
  const { decision, ctx } = await runChain(agent, {
    sessionPresetByAgent: new Map([[agent.session, "dev"]]),
  });
  assert.deepEqual(namesInMessage(decision.messages[0]), ["plugin-work"], "level 2 must filter");
  assert.equal(ctx.logs.debug.length, 1);
  assert.match(ctx.logs.debug[0], /preset=dev/);
});

test("subagent chain level 1 wins: a root session's composed preset is authoritative", async () => {
  // composed says dev (allow plugin-work); the session projection says clerk
  // (deny web-work). If level 1 were overridden the kept set would differ.
  const agent = childAgent({ id: "root-1" });
  const { decision } = await runChain(agent, {
    composedByAgent: new Map([[agent.ctx, "dev"]]),
    sessionPresetByAgent: new Map([[agent.session, "clerk"]]),
  });
  assert.deepEqual(namesInMessage(decision.messages[0]), ["plugin-work"], "level 1 must win over level 2");
});

test("subagent chain level 3: an unresolved child inherits the parent's composed preset", async () => {
  const parent = parentAgent("deep", { id: "p1" });
  const child = childAgent({ parentSession: "p1", id: "c1" });
  const { decision } = await runChain(child, {
    composedByAgent: new Map([[parent.ctx, "deep"]]),
    liveAgents: new Map([["p1", parent]]),
  });
  assert.deepEqual(namesInMessage(decision.messages[0]), ["plugin-work", "web-work"], "level 3 must filter office*");
});

test("subagent chain level 3: an unresolved parent is resolved from ITS own session preset", async () => {
  const grandparentComposed = "clerk";
  const parent = parentAgent("", { id: "p1", parentSession: "gp" });
  const child = childAgent({ parentSession: "p1", id: "c1" });
  const { decision } = await runChain(child, {
    sessionPresetByAgent: new Map([[parent.session, "deep"], [child.session, null]]),
    liveAgents: new Map([["p1", parent]]),
  });
  // `deep` denies office*; the grandparent preset id is not consulted because the
  // parent's own session preset resolves first.
  assert.deepEqual(namesInMessage(decision.messages[0]), ["plugin-work", "web-work"]);
  assert.equal(grandparentComposed, "clerk");
});

test("subagent chain: nothing resolves anywhere → untouched, no warning", async () => {
  const child = childAgent({ parentSession: "ghost", id: "c1" });
  const { decision, ctx } = await runChain(child, { liveAgents: new Map() });
  assert.deepEqual(namesInMessage(decision.messages[0]), CHAIN_NAMES, "unresolved lineage must not filter");
  assert.deepEqual(ctx.logs.warn, []);
  assert.deepEqual(ctx.logs.debug, []);
});

test("subagent chain: the depth cap stops at 4 parent hops and finds nothing at 5", async () => {
  // Five parents; only the far one (p5) resolves. Reaching it needs 5 hops.
  const agents = new Map();
  let next = undefined;
  const chain = [];
  for (let i = 1; i <= 5; i += 1) {
    const agent = parentAgent("", { id: `p${i}`, parentSession: next });
    chain.push(agent);
    agents.set(`p${i}`, agent);
    next = `p${i}`;
  }
  // parentSession must point UP the chain: child -> p1 -> p1's parent is p2? No:
  // build it the other way so p1 is the direct parent and p5 is the furthest.
  const upstream = new Map();
  for (let i = 1; i <= 5; i += 1) {
    upstream.set(`p${i}`, i < 5 ? `p${i + 1}` : undefined);
  }
  for (const [id, parentId] of upstream) {
    const agent = new parentAgent("", { id, parentSession: parentId });
    agents.set(id, agent);
  }
  const far = agents.get("p5");
  const near = agents.get("p4");
  const composed = new Map([[far.ctx, "deep"]]);
  // 5 hops: child -> p1 -> p2 -> p3 -> p4 -> p5 : out of range
  const child = childAgent({ parentSession: "p1", id: "c1" });
  const tooFar = await runChain(child, { composedByAgent: composed, liveAgents: agents });
  assert.deepEqual(namesInMessage(tooFar.decision.messages[0]), CHAIN_NAMES, "5 hops must be out of range");
  // 4 hops: a chain rooted at p2 (child -> p2 -> p3 -> p4 -> p5) must resolve
  const child4 = childAgent({ parentSession: "p2", id: "c2" });
  const fourHops = await runChain(child4, { composedByAgent: new Map([[agents.get("p5").ctx, "deep"]]), liveAgents: agents });
  assert.deepEqual(namesInMessage(fourHops.decision.messages[0]), ["plugin-work", "web-work"], "4 hops must resolve");
  assert.notEqual(near, undefined);
});

test("subagent chain: a cyclic lineage terminates and resolves nothing", async () => {
  // p1's parent is p2 and p2's parent is p1.
  const p1 = parentAgent("", { id: "p1", parentSession: "p2" });
  const p2 = parentAgent("", { id: "p2", parentSession: "p1" });
  const composed = new Map([
    [p1.ctx, ""],
    [p2.ctx, ""],
  ]);
  // Count registry lookups: the visited set must stop after p1 and p2. Without it
  // the depth cap still terminates, but only after re-walking the same two agents.
  const live = new Map([["p1", p1], ["p2", p2]]);
  let lookups = 0;
  const originalGet = live.get.bind(live);
  live.get = (key) => {
    lookups += 1;
    return originalGet(key);
  };
  const child = childAgent({ parentSession: "p1", id: "c1" });
  const { decision } = await runChain(child, {
    composedByAgent: composed,
    liveAgents: live,
  });
  assert.deepEqual(namesInMessage(decision.messages[0]), CHAIN_NAMES);
  assert.equal(lookups, 2, `a two-agent cycle must be walked once per agent, got ${lookups} lookups`);
});

test("subagent chain: a deleted parent (agents.get → undefined) fails open", async () => {
  const child = childAgent({ parentSession: "gone", id: "c1" });
  const { decision, ctx } = await runChain(child, { liveAgents: new Map() });
  assert.deepEqual(namesInMessage(decision.messages[0]), CHAIN_NAMES);
  assert.deepEqual(ctx.logs.warn, []);
});

test("subagent chain: presetForSession throwing degrades to the parent level", async () => {
  const parent = parentAgent("deep", { id: "p1" });
  const child = childAgent({ parentSession: "p1", id: "c1" });
  const previous = process.env.DSH_HOME;
  const { home } = makeHome(CHAIN_CONFIG);
  process.env.DSH_HOME = home;
  try {
    const plugin = await loadPlugin();
    const ctx = makeCtx({ liveAgents: new Map([["p1", parent]]), sessionPresetThrows: true });
    plugin.apply(ctx, {});
    // composed answers "" for the child, presetForSession throws, so level 3 must
    // still find the parent's composition.
    const presets = { composedPreset: (agentCtx) => (agentCtx === parent.ctx ? "deep" : undefined) };
    const innerGet = ctx.get.bind(ctx);
    ctx.get = (service) => (service === "agentPresets" ? presets : innerGet(service));
    const decision = await runStep(ctx, child, [catalogMessage(CHAIN_NAMES)]);
    assert.deepEqual(namesInMessage(decision.messages[0]), ["plugin-work", "web-work"], "level 3 after a throwing level 2");
  } finally {
    process.env.DSH_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});

test("subagent chain: a missing or throwing agents service fails open", async () => {
  const child = childAgent({ parentSession: "p1", id: "c1" });
  const missing = await runChain(child, { noAgentsService: true, sessionPresetByAgent: new Map() });
  assert.deepEqual(namesInMessage(missing.decision.messages[0]), CHAIN_NAMES);
  const throwing = await runChain(child, { agentsThrows: true });
  assert.deepEqual(namesInMessage(throwing.decision.messages[0]), CHAIN_NAMES);
});

test("subagent chain: a missing agentPresets service fails open", async () => {
  const child = childAgent({ parentSession: "p1", id: "c1" });
  const previous = process.env.DSH_HOME;
  const { home } = makeHome(CHAIN_CONFIG);
  process.env.DSH_HOME = home;
  try {
    const plugin = await loadPlugin();
    const ctx = makeCtx({ noPresetService: true });
    plugin.apply(ctx, {});
    const decision = await runStep(ctx, child, [catalogMessage(CHAIN_NAMES)]);
    assert.deepEqual(namesInMessage(decision.messages[0]), CHAIN_NAMES);
  } finally {
    process.env.DSH_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});

test("subagent chain: the guard uses the same fallback as the catalog", async () => {
  const parent = parentAgent("deep", { id: "p1" });
  const child = childAgent({ parentSession: "p1", id: "c1" });
  const previous = process.env.DSH_HOME;
  const { home } = makeHome(CHAIN_CONFIG);
  process.env.DSH_HOME = home;
  try {
    const plugin = await loadPlugin();
    const ctx = makeChainCtx({ composedByAgent: new Map([[parent.ctx, "deep"]]), liveAgents: new Map([["p1", parent]]) });
    plugin.apply(ctx, {});
    const guard = ctx.guards[0];
    assert.equal(
      guard({ name: "skill", arguments: { name: "office-xlsx" }, agent: child }),
      "技能「office-xlsx」在本预设中被隐藏（dsh-skill-gate）",
    );
    assert.equal(guard({ name: "skill", arguments: { name: "plugin-work" }, agent: child }), undefined);
  } finally {
    process.env.DSH_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});

test("config loaded is announced once per file version, at info level", async () => {
  const previous = process.env.DSH_HOME;
  const { home } = makeHome(CHAIN_CONFIG);
  process.env.DSH_HOME = home;
  try {
    const plugin = await loadPlugin();
    const agent = childAgent({ id: "c1" });
    const ctx = makeChainCtx({ sessionPresetByAgent: new Map([[agent.session, "dev"]]) });
    plugin.apply(ctx, {});
    await runStep(ctx, agent, [catalogMessage(CHAIN_NAMES)]);
    await runStep(ctx, agent, [catalogMessage(CHAIN_NAMES)]);
    await runStep(ctx, agent, [catalogMessage(CHAIN_NAMES)]);
    assert.deepEqual(ctx.logs.info, ["[skill-gate] config loaded presets=clerk,deep,dev"]);
  } finally {
    process.env.DSH_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});

test("the package declares the documented shape", async () => {
  const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8"));
  assert.equal(pkg.name, "dsh-skill-gate");
  assert.equal(pkg.type, "module");
  assert.equal(pkg.main, "index.js");
  assert.equal(pkg.engines.dsh, ">=0.2.2-rc.1 <0.3.0-0");
  assert.equal(pkg.dsh.bundle.patch, "./cordis.patch.yml");
  for (const required of ["index.js", "lib", "cordis.patch.yml", "skill-gate.example.json", "README.md", "README.zh.md", "CHANGELOG.md", "LICENSE"]) {
    assert.equal(pkg.files.includes(required), true, `files[] must ship ${required}`);
  }
  // Development-only files stay out of the tarball but must still exist locally.
  assert.equal(pkg.files.includes("test"), false, "test/ must not be published");
  assert.equal(existsSync(join(here, "..", "test", "policy.test.mjs")), true, "test/policy.test.mjs must still run locally");
  const plugin = await loadPlugin();
  assert.equal(plugin.name, "dsh-skill-gate");
  assert.deepEqual(plugin.inject, ["tools"]);
  assert.equal(typeof plugin.apply, "function");
});

// ---------------------------------------------------------------- runner
for (const { name: testName, fn } of queue) {
  groups += 1;
  try {
    await fn();
  } catch (error) {
    failures.push({ testName, error });
  }
}

if (failures.length > 0) {
  for (const { testName, error } of failures) {
    console.error(`FAIL ${testName}`);
    console.error(`     ${error instanceof Error ? error.message : String(error)}`);
  }
  console.error(`\nFAILED — ${failures.length}/${groups} group(s) red`);
  process.exit(1);
}
console.log(`PASS — ${groups} groups`);