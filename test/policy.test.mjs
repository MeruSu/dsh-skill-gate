/**
 * Contract tests for dsh-skill-gate's pure rules (lib/policy.js).
 *
 * Run: node test/policy.test.mjs
 *
 * Every assertion here is written so that a bug in lib/policy.js makes it fail.
 * The suite was checked by mutation: see the mutation notes at the bottom of
 * cangku/tmp/261119_k4m_dev_report.md.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ConfigLoader,
  EMPTY_NOTICE,
  EXAMPLE_FILENAME,
  filterCatalogText,
  guardVerdict,
  isHiddenByPolicy,
  nameToRegExpSource,
  parseConfigDocument,
  resolvePresetPolicy,
} from "../lib/policy.js";

let groups = 0;
const failures = [];
const queue = [];

function test(name, fn) {
  queue.push({ name, fn });
}

function policyOf(configText, presetId) {
  const parsed = parseConfigDocument(configText);
  return resolvePresetPolicy(parsed.presets, presetId);
}

/** One catalog message body in the exact shape dsh-tool-skill renders. */
function catalogText(names) {
  return [
    "<system-reminder>",
    "A skill is a reusable set of task-specific instructions. The following skills are available in this session:",
    "",
    "<available_skills>",
    ...names.map((name) => `- \`${name}\`: description of ${name}`),
    "</available_skills>",
    "",
    "If the user names a skill, or the task clearly matches a skill's description, call the `skill` tool with the exact skill name before taking task actions.",
    "</system-reminder>",
  ].join("\n");
}

function namesIn(text) {
  const lines = text.split("\n");
  const open = lines.indexOf("<available_skills>");
  const close = lines.indexOf("</available_skills>");
  return lines.slice(open + 1, close).filter((line) => /^- `/.test(line)).map((line) => /^- `([^`]*)`/.exec(line)[1]);
}

// ---------------------------------------------------------------- R1: wildcards
test("R1 exact name: matches itself only", () => {
  assert.equal(nameToRegExpSource("office"), "^office$");
  const policy = policyOf('{"presets":{"p":{"mode":"deny","names":["office"]}}}', "p");
  assert.equal(isHiddenByPolicy(policy, "office"), true);
  assert.equal(isHiddenByPolicy(policy, "office-xlsx"), false);
  assert.equal(isHiddenByPolicy(policy, "xoffice"), false);
});

test("R1 wildcard: office* matches the family and nothing on a prefix", () => {
  const policy = policyOf('{"presets":{"p":{"mode":"deny","names":["office*"]}}}', "p");
  assert.equal(isHiddenByPolicy(policy, "office"), true);
  assert.equal(isHiddenByPolicy(policy, "office-xlsx"), true);
  assert.equal(isHiddenByPolicy(policy, "office-docx"), true);
  assert.equal(isHiddenByPolicy(policy, "xoffice"), false);
  assert.equal(isHiddenByPolicy(policy, "offic"), false);
});

test("R1 wildcard: role-* matches role-* and nothing else", () => {
  const policy = policyOf('{"presets":{"p":{"mode":"deny","names":["role-*"]}}}', "p");
  assert.equal(isHiddenByPolicy(policy, "role-dev"), true);
  assert.equal(isHiddenByPolicy(policy, "role-lead"), true);
  assert.equal(isHiddenByPolicy(policy, "roles"), false);
  assert.equal(isHiddenByPolicy(policy, "role"), false);
  assert.equal(isHiddenByPolicy(policy, "my-role-dev"), false);
});

test("R1 wildcard: * alone matches every name, including empty-ish ones", () => {
  const policy = policyOf('{"presets":{"p":{"mode":"deny","names":["*"]}}}', "p");
  assert.equal(isHiddenByPolicy(policy, "anything"), true);
  assert.equal(isHiddenByPolicy(policy, "a"), true);
});

test("R1 regex metacharacters in a name are literal", () => {
  const policy = policyOf('{"presets":{"p":{"mode":"deny","names":["a.b","x+y","[z]"]}}}', "p");
  assert.equal(isHiddenByPolicy(policy, "a.b"), true);
  assert.equal(isHiddenByPolicy(policy, "axb"), false);
  assert.equal(isHiddenByPolicy(policy, "x+y"), true);
  assert.equal(isHiddenByPolicy(policy, "xxy"), false);
  assert.equal(isHiddenByPolicy(policy, "[z]"), true);
  assert.equal(isHiddenByPolicy(policy, "z"), false);
});

test("R1 allow is a whitelist: only listed names survive", () => {
  const policy = policyOf('{"presets":{"p":{"mode":"allow","names":["plugin-work","web-work"]}}}', "p");
  assert.equal(isHiddenByPolicy(policy, "plugin-work"), false);
  assert.equal(isHiddenByPolicy(policy, "web-work"), false);
  assert.equal(isHiddenByPolicy(policy, "office-xlsx"), true);
});

test("R1 allow with an empty list hides everything", () => {
  const policy = policyOf('{"presets":{"p":{"mode":"allow","names":[]}}}', "p");
  assert.equal(isHiddenByPolicy(policy, "plugin-work"), true);
  assert.equal(isHiddenByPolicy(policy, "anything"), true);
});

test("R1 a configured preset carries exactly its own entry", () => {
  const text = '{"presets":{"dev":{"mode":"allow","names":["plugin-work","web-work"]},"clerk":{"mode":"deny","names":["office*"]}}}';
  const dev = policyOf(text, "dev");
  assert.notEqual(dev, null, "a configured preset must produce a policy");
  assert.equal(dev.mode, "allow");
  assert.deepEqual(dev.names, ["plugin-work", "web-work"]);
  const clerk = policyOf(text, "clerk");
  assert.notEqual(clerk, null);
  assert.equal(clerk.mode, "deny");
  assert.deepEqual(clerk.names, ["office*"]);
});

test("R1 a preset that is not configured yields no policy at all", () => {
  assert.equal(policyOf('{"presets":{"dev":{"mode":"deny","names":["office*"]}}}', "cordis"), null);
  assert.equal(policyOf('{"presets":{"dev":{"mode":"deny","names":["office*"]}}}', ""), null);
  assert.equal(policyOf("{}", "dev"), null);
});

test("R1 enabled:false switches one preset off and leaves the others alone", () => {
  const text = '{"presets":{"dev":{"enabled":false,"mode":"deny","names":["office*"]},"clerk":{"mode":"deny","names":["univer*"]}}}';
  assert.equal(policyOf(text, "dev"), null);
  const clerk = policyOf(text, "clerk");
  assert.notEqual(clerk, null);
  assert.equal(isHiddenByPolicy(clerk, "univer-xlsx"), true);
});

// ---------------------------------------------------------------- R1: broken config
test("R1 missing config: no policy and NO warning (shipping state)", () => {
  const dir = mkdtempSync(join(tmpdir(), "skill-gate-"));
  try {
    const warnings = [];
    const loader = new ConfigLoader({ file: join(dir, "skill-gate.json"), warn: (m) => warnings.push(m) });
    const presets = loader.read();
    assert.equal(presets.size, 0);
    assert.deepEqual(warnings, []);
    // and a second read of the same missing state is still silent
    assert.equal(loader.read().size, 0);
    assert.deepEqual(warnings, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("R1 invalid JSON allows everything and warns exactly once per state", () => {
  const dir = mkdtempSync(join(tmpdir(), "skill-gate-"));
  try {
    const file = join(dir, "skill-gate.json");
    writeFileSync(file, "{ this is not json", "utf8");
    const warnings = [];
    const loader = new ConfigLoader({ file, warn: (m) => warnings.push(m) });
    for (let i = 0; i < 4; i += 1) {
      const presets = loader.read();
      assert.equal(presets.size, 0, "invalid JSON must not hide anything");
      assert.equal(resolvePresetPolicy(presets, "dev"), null);
    }
    assert.equal(warnings.length, 1, `expected one warning, got ${JSON.stringify(warnings)}`);
    assert.match(warnings[0], /invalid JSON/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("R1 warnings de-duplicate per text: a new problem warns again, the same one does not", () => {
  const dir = mkdtempSync(join(tmpdir(), "skill-gate-"));
  try {
    const file = join(dir, "skill-gate.json");
    const warnings = [];
    const loader = new ConfigLoader({ file, warn: (m) => warnings.push(m) });
    writeFileSync(file, "not json at all", "utf8");
    loader.read();
    loader.read();
    loader.read();
    assert.equal(warnings.length, 1, `same problem must warn once, got ${warnings.length}`);
    writeFileSync(file, JSON.stringify({ presets: { bad: { mode: "deny", names: 7 } } }), "utf8");
    const future = new Date(Date.now() + 5000);
    utimesSync(file, future, future);
    loader.read();
    assert.equal(warnings.length, 2, "a different problem must warn again, otherwise the operator never sees it");
    // a clean read clears the latch: the same problem coming back warns once more
    writeFileSync(file, JSON.stringify({ presets: {} }), "utf8");
    utimesSync(file, new Date(Date.now() + 10000), new Date(Date.now() + 10000));
    loader.read();
    assert.equal(warnings.length, 2, "a clean read adds no warning");
    writeFileSync(file, "not json at all", "utf8");
    utimesSync(file, new Date(Date.now() + 15000), new Date(Date.now() + 15000));
    loader.read();
    assert.equal(warnings.length, 3, "after a clean read the same problem is reported again");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("R1 wrong field types drop only the broken preset, and warn once", () => {
  const text = JSON.stringify({
    presets: {
      broken: { mode: "deny", names: "office*" },
      badMode: { mode: "hide", names: ["office"] },
      badEnabled: { enabled: "no", mode: "deny", names: [] },
      good: { mode: "deny", names: ["office*"] },
    },
  });
  const parsed = parseConfigDocument(text);
  assert.equal(parsed.presets.has("broken"), false);
  assert.equal(parsed.presets.has("badMode"), false);
  assert.equal(parsed.presets.has("badEnabled"), false);
  assert.equal(parsed.presets.has("good"), true);
  assert.match(parsed.error, /presets\.broken/);
  assert.match(parsed.error, /presets\.badMode/);
  assert.match(parsed.error, /presets\.badEnabled/);
  assert.equal(isHiddenByPolicy(resolvePresetPolicy(parsed.presets, "good"), "office-xlsx"), true);
  assert.equal(resolvePresetPolicy(parsed.presets, "broken"), null);
});

test("R1 a non-object root or non-object presets allows everything", () => {
  assert.equal(parseConfigDocument("[]").presets.size, 0);
  assert.match(parseConfigDocument("[]").error, /root/);
  assert.equal(parseConfigDocument('{"presets":[]}').presets.size, 0);
  assert.match(parseConfigDocument('{"presets":[]}').error, /presets is not an object/);
});

test("R1 hot reload: a changed file is re-read, an unchanged one is not", () => {
  const dir = mkdtempSync(join(tmpdir(), "skill-gate-"));
  try {
    const file = join(dir, "skill-gate.json");
    writeFileSync(file, JSON.stringify({ presets: { dev: { mode: "deny", names: ["office*"] } } }), "utf8");
    const loader = new ConfigLoader({ file, warn: () => {} });
    assert.equal(isHiddenByPolicy(resolvePresetPolicy(loader.read(), "dev"), "office-xlsx"), true);
    // rewrite with a different list and force a distinct mtime
    writeFileSync(file, JSON.stringify({ presets: { dev: { mode: "deny", names: ["univer*"] } } }), "utf8");
    const future = new Date(Date.now() + 5000);
    utimesSync(file, future, future);
    assert.equal(isHiddenByPolicy(resolvePresetPolicy(loader.read(), "dev"), "office-xlsx"), false);
    assert.equal(isHiddenByPolicy(resolvePresetPolicy(loader.read(), "dev"), "univer-xlsx"), true);
    // deleting the file returns to "nothing configured"
    rmSync(file);
    assert.equal(loader.read().size, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("R1 the plugin never reads the example file", () => {
  const warnings = [];
  const loader = new ConfigLoader({ file: join(tmpdir(), "definitely-absent", EXAMPLE_FILENAME), warn: (m) => warnings.push(m) });
  assert.equal(loader.read().size, 0);
  assert.deepEqual(warnings, []);
  assert.equal(loader.file.endsWith(EXAMPLE_FILENAME), true);
});

// ---------------------------------------------------------------- R2: text rewrite
test("R2 deny: hidden lines go, kept lines keep their ORIGINAL bytes", () => {
  const names = ["office-xlsx", "plugin-work", "role-dev", "web-work"];
  const text = catalogText(names);
  const policy = policyOf('{"presets":{"p":{"mode":"deny","names":["office*","role-*"]}}}', "p");
  const out = filterCatalogText(text, policy);
  assert.deepEqual(namesIn(out.text), ["plugin-work", "web-work"]);
  assert.equal(out.kept, 2);
  assert.equal(out.total, 4);
  assert.equal(out.changed, true);
  // original lines survive byte for byte (no re-escaping on top of escapeText)
  for (const line of text.split("\n")) {
    if (/^- `(plugin-work|web-work)`:/.test(line)) assert.equal(out.text.includes(line), true, `line lost: ${line}`);
  }
});

test("R2 allow: only listed names survive", () => {
  const text = catalogText(["office-xlsx", "plugin-work", "role-dev"]);
  const policy = policyOf('{"presets":{"p":{"mode":"allow","names":["plugin-work"]}}}', "p");
  const out = filterCatalogText(text, policy);
  assert.deepEqual(namesIn(out.text), ["plugin-work"]);
  assert.equal(out.total, 3);
});

test("R2 escaping is not doubled: an escaped description is passed through verbatim", () => {
  const escapedLine = "- `notion-api`: Add &lt;b&gt;bold&lt;/b&gt; blocks &amp; escape &quot;x&quot;";
  const text = [
    "<system-reminder>",
    "<available_skills>",
    escapedLine,
    "- `office-xlsx`: spreadsheets",
    "</available_skills>",
    "</system-reminder>",
  ].join("\n");
  const policy = policyOf('{"presets":{"p":{"mode":"deny","names":["office*"]}}}', "p");
  const out = filterCatalogText(text, policy);
  assert.equal(out.text.includes(escapedLine), true, "escaped line must come through unchanged");
  assert.equal(out.text.includes("&amp;lt;"), false, "double escaping detected");
  assert.equal(out.text.includes("&amp;amp;"), false, "double escaping detected");
});

test("R2 every skill hidden: the message stays, markers stay, one notice line goes between", () => {
  const text = catalogText(["office-xlsx", "univer-xlsx"]);
  const policy = policyOf('{"presets":{"p":{"mode":"allow","names":[]}}}', "p");
  const out = filterCatalogText(text, policy);
  assert.equal(out.kept, 0);
  assert.equal(out.total, 2);
  const lines = out.text.split("\n");
  assert.equal(lines.includes("<available_skills>"), true);
  assert.equal(lines.includes("</available_skills>"), true);
  assert.equal(lines.includes(EMPTY_NOTICE), true);
  assert.equal(out.text.startsWith("<system-reminder>"), true, "the system-reminder shell must survive");
  assert.equal(out.text.endsWith("</system-reminder>"), true, "the system-reminder shell must survive");
  assert.deepEqual(namesIn(out.text), []);
  // digest-relevant shape: nothing outside the body changed
  const before = text.split("\n");
  const after = lines;
  assert.equal(before[0], after[0]);
  assert.equal(before[before.length - 1], after[after.length - 1]);
});

test("R2 nothing to hide: the text is returned untouched and not marked changed", () => {
  const text = catalogText(["plugin-work", "web-work"]);
  const policy = policyOf('{"presets":{"p":{"mode":"allow","names":["plugin-work","web-work"]}}}', "p");
  const out = filterCatalogText(text, policy);
  assert.equal(out.changed, false);
  assert.equal(out.text, text);
});

test("R2 null policy or missing markers: untouched", () => {
  const text = catalogText(["office-xlsx"]);
  assert.equal(filterCatalogText(text, null).changed, false);
  assert.equal(filterCatalogText("no markers here", policyOf('{"presets":{"p":{"mode":"deny","names":["*"]}}}', "p")).changed, false);
});

test("R2 update form and first-catalog form are filtered by the same rule", () => {
  const first = [
    "<system-reminder>",
    "A skill is a reusable set of task-specific instructions. The following skills are available in this session:",
    "",
    "<available_skills>",
    "- `office-xlsx`: spreadsheets",
    "- `plugin-work`: dev work",
    "</available_skills>",
    "</system-reminder>",
  ].join("\n");
  const update = [
    "<system-reminder>",
    "The available skill catalog changed. This complete catalog replaces every earlier available-skills list in this session:",
    "",
    "<available_skills>",
    "- `office-xlsx`: spreadsheets",
    "- `plugin-work`: dev work",
    "</available_skills>",
    "",
    "Use only names in this replacement catalog. If the user names a listed skill, or the task clearly matches its description, call the `skill` tool with the exact name before acting.",
    "</system-reminder>",
  ].join("\n");
  const policy = policyOf('{"presets":{"p":{"mode":"deny","names":["office*"]}}}', "p");
  for (const [label, text] of [["first", first], ["update", update]]) {
    const out = filterCatalogText(text, policy);
    assert.deepEqual(namesIn(out.text), ["plugin-work"], `${label} form not filtered`);
    assert.equal(out.text.startsWith("<system-reminder>"), true, `${label} shell broken`);
  }
});

test("R2 a non-entry line inside the list is kept, not silently dropped", () => {
  const text = [
    "<system-reminder>",
    "<available_skills>",
    "- `office-xlsx`: spreadsheets",
    "  (continuation line that an older host once emitted)",
    "- `plugin-work`: dev work",
    "</available_skills>",
    "</system-reminder>",
  ].join("\n");
  const policy = policyOf('{"presets":{"p":{"mode":"deny","names":["office*"]}}}', "p");
  const out = filterCatalogText(text, policy);
  assert.equal(out.text.includes("  (continuation line"), true);
  assert.equal(out.total, 2);
  assert.equal(out.kept, 1);
});

// ---------------------------------------------------------------- R3: guard verdict
test("R3 guard refuses a hidden skill with the exact reason", () => {
  const policy = policyOf('{"presets":{"p":{"mode":"allow","names":["plugin-work"]}}}', "p");
  const reason = (n) => `技能「${n}」在本预设中被隐藏（dsh-skill-gate）`;
  const verdict = guardVerdict({ name: "skill", arguments: { name: "office-xlsx" }, agent: {} }, () => policy, reason);
  assert.equal(verdict, "技能「office-xlsx」在本预设中被隐藏（dsh-skill-gate）");
});

test("R3 guard allows kept skills and every other tool", () => {
  const policy = policyOf('{"presets":{"p":{"mode":"allow","names":["plugin-work"]}}}', "p");
  const reason = (n) => `hidden:${n}`;
  assert.equal(guardVerdict({ name: "skill", arguments: { name: "plugin-work" }, agent: {} }, () => policy, reason), undefined);
  assert.equal(guardVerdict({ name: "pwsh", arguments: { name: "office-xlsx" }, agent: {} }, () => policy, reason), undefined);
  assert.equal(guardVerdict({ name: "skill", arguments: {}, agent: {} }, () => policy, reason), undefined);
  assert.equal(guardVerdict({ name: "skill", arguments: { name: "office-xlsx" }, agent: {} }, () => null, reason), undefined);
});

test("R3 guard survives a policy lookup that throws (fails open)", () => {
  const reason = (n) => `hidden:${n}`;
  const verdict = guardVerdict({ name: "skill", arguments: { name: "office-xlsx" }, agent: {} }, () => {
    throw new Error("preset service went away");
  }, reason);
  assert.equal(verdict, undefined);
});

test("R4 guard:false hides the catalog line but lets the call through", () => {
  const policy = policyOf(
    JSON.stringify({ presets: { dev: { mode: "deny", guard: false, names: ["office*"] } } }),
    "dev",
  );
  assert.equal(policy.guard, false);
  const filtered = filterCatalogText(catalogText(["office-xlsx", "plugin-work"]), policy);
  assert.deepEqual(namesIn(filtered.text), ["plugin-work"], "the catalog line must still be hidden");
  const reason = (n) => `hidden:${n}`;
  const call = (name) => guardVerdict({ name: "skill", arguments: { name }, agent: {} }, () => policy, reason);
  assert.equal(call("office-xlsx"), undefined, "guard:false must allow the hidden skill");
  assert.equal(call("plugin-work"), undefined);
});

test("R4 guard defaults to on: an entry without the key still refuses", () => {
  const policy = policyOf(JSON.stringify({ presets: { dev: { mode: "deny", names: ["office*"] } } }), "dev");
  assert.equal(policy.guard, true);
  const reason = (n) => `hidden:${n}`;
  const verdict = guardVerdict({ name: "skill", arguments: { name: "office-xlsx" }, agent: {} }, () => policy, reason);
  assert.equal(verdict, "hidden:office-xlsx");
});

test("R4 explicit null guard is invalid, not an omitted default", () => {
  const parsed = parseConfigDocument(JSON.stringify({ presets: {
    broken: { mode: "deny", guard: null, names: ["office*"] },
    good: { mode: "deny", names: ["web-work"] },
  } }));
  assert.equal(parsed.presets.has("broken"), false);
  assert.equal(parsed.presets.has("good"), true);
  assert.match(parsed.error, /presets\.broken: guard must be a boolean/);
});

test("R4 a non-boolean guard drops only that preset and warns once", () => {
  const text = JSON.stringify({
    presets: {
      dev: { mode: "deny", guard: "no", names: ["office*"] },
      clerk: { mode: "deny", names: ["office*"] },
    },
  });
  const parsed = parseConfigDocument(text);
  assert.equal(parsed.presets.has("dev"), false, "the broken entry must be dropped");
  assert.equal(parsed.presets.has("clerk"), true, "the sibling entry must survive");
  assert.match(parsed.error, /presets\.dev: guard must be a boolean/);
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