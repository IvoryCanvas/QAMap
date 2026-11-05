import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { stateCacheSignals } from "../dist/qa-brief-state.js";

const directory = mkdtempSync(path.join(os.tmpdir(), "qamap-state-boundaries-"));
after(() => rmSync(directory, { recursive: true, force: true }));
const source = (...rows) => `${rows.join("\n")}\n`;

// Real git hunks preserve deletion-only and continuation-line changes. The
// fixtures are syntax evidence: none of their loaders or state functions run.
function signals(before, head) {
  writeFileSync(path.join(directory, "before.ts"), before);
  writeFileSync(path.join(directory, "head.ts"), head);
  let diff;
  try {
    diff = execFileSync("git", ["--no-pager", "diff", "--no-index", "--no-color", "--no-ext-diff", "--no-textconv",
      "--unified=3", "--", "before.ts", "head.ts"], { cwd: directory, encoding: "utf8" });
  } catch (error) {
    if (error.status !== 1) throw error;
    diff = error.stdout;
  }
  const hunks = [];
  for (const row of diff.split("\n")) {
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(row);
    if (match) {
      hunks.push({ oldStart: Number(match[1]), oldCount: Number(match[2] ?? 1),
        newStart: Number(match[3]), newCount: Number(match[4] ?? 1), lines: [] });
    } else if (hunks.length && /^[ +\-]/.test(row)) hunks.at(-1).lines.push(row);
  }
  assert.ok(hunks.length, "the fixture must produce a nonempty git diff");
  for (const hunk of hunks) {
    assert.equal(hunk.lines.filter(row => !row.startsWith("-")).length, hunk.newCount);
    assert.equal(hunk.lines.filter(row => !row.startsWith("+")).length, hunk.oldCount);
  }
  return stateCacheSignals("fixture.ts", hunks, head.replace(/\n$/, "").split("\n")).join("\n");
}

const transition = source("async function advance(phase) {", "  if (phase === 'idle') {",
  "    phase = 'running';", "  }", "}");

for (const [description, statement, evidence] of [
  ["await", "await pause();", /await at 3/],
  ["nonliteral assignment", "phase = next();", /intervening write at 3/],
  ["increment", "phase++;", /intervening write at 3/],
]) {
  test(`state drafts retain an inserted ${description} between unchanged guard and write`, () => {
    const output = signals(transition, transition.replace("    phase = 'running';", `    ${statement}\n    phase = 'running';`));
    assert.match(output, /state draft unresolved: `phase` guard 2, write 4/);
    assert.match(output, evidence);
    assert.match(output, /human review required/);
    assert.doesNotMatch(output, /state draft: `phase`.*idle.*running/);
  });
}

for (const [description, statement] of [
  ["await", "await pause();"],
  ["nonliteral assignment", "phase = next();"],
]) {
  test(`state drafts retain deletion of an intervening ${description} as changed evidence`, () => {
    const before = transition.replace("    phase = 'running';", `    ${statement}\n    phase = 'running';`);
    const output = signals(before, transition);
    assert.match(output, /state draft: `phase` "idle" -> "running" \(guard 2, write 3\)/);
    assert.doesNotMatch(output, /state draft unresolved:/);
  });
}

test("state drafts retain deletion of the previous switch case's break as fallthrough evidence", () => {
  const before = source("function advance(phase) {", "  switch (phase) {", "    case 'idle':", "      inspect();",
    "      break;", "    case 'paused':", "      phase = 'running';", "      break;", "  }", "}");
  const output = signals(before, before.replace("      inspect();\n      break;", "      inspect();"));
  assert.match(output, /state draft unresolved: `phase` guard 5, write 6.*case fallthrough/);
  assert.doesNotMatch(output, /state draft: `phase`.*paused.*running/);
});

test("deleting a nonterminal statement does not change the next switch case's state evidence", () => {
  const before = source("function advance(phase) {", "  switch (phase) {", "    case 'idle':", "      inspect();",
    "      break;", "    case 'paused':", "      phase = 'running';", "      break;", "  }", "}");
  assert.doesNotMatch(signals(before, before.replace("      inspect();\n", "")), /state draft/);
});

test("state drafts preserve a direct transition and its exact review coordinates", () => {
  const output = signals("", transition);
  assert.match(output, /state draft: `phase` "idle" -> "running" \(guard 2, write 3\); review intended transition/);
  assert.doesNotMatch(output, /unresolved|invalid transition|proof|specification/);
});

test("state drafts do not resolve through a same-binding var initializer", () => {
  const output = signals("", source("function advance() {", "  var phase = 'idle';", "  if (phase === 'idle') {",
    "    var phase = next();", "    phase = 'running';", "  }", "}"));
  assert.match(output, /state draft unresolved: `phase` guard 3, write 5.*intervening write at 4/);
  assert.doesNotMatch(output, /state draft: `phase`.*idle.*running/);
});

for (const [description, middle] of [
  ["object destructuring", "({ phase } = next());"],
  ["renamed destructuring", "({ value: phase } = next());"],
  ["nested destructuring", "({ state: { phase } } = next());"],
  ["array destructuring", "[phase] = next();"],
  ["array rest destructuring", "[...phase] = next();"],
]) {
  test(`state drafts mark ${description} of the guarded binding unresolved`, () => {
    const output = signals("", transition.replace("    phase = 'running';", `    ${middle}\n    phase = 'running';`));
    assert.match(output, /state draft unresolved: `phase` guard 2, write 4.*intervening write at 3/);
    assert.doesNotMatch(output, /state draft: `phase`.*idle.*running/);
  });
}

for (const [description, header] of [
  ["for-of", "for (phase of values)"],
  ["for-in", "for (phase in values)"],
  ["destructured for-of", "for ({ phase } of values)"],
  ["var for-of", "for (var phase of values)"],
]) {
  test(`state drafts mark a ${description} target write unresolved`, () => {
    const head = source("function advance(phase, values) {", "  if (phase === 'idle') {", `    ${header} {`,
      "      phase = 'running';", "    }", "  }", "}");
    const output = signals("", head);
    assert.match(output, /state draft unresolved: `phase` guard 2, write 4.*intervening write at 3/);
    assert.doesNotMatch(output, /state draft: `phase`.*idle.*running/);
  });
}

test("state mutation checks retain a separate property binding as review evidence", () => {
  const before = source("function expand(panel) {", "  if (panel.mode === 'collapsed') {",
    "    panel.mode = 'expanded';", "  }", "}");
  const output = signals(before, before.replace("    panel.mode = 'expanded';", "    ({ mode: panel.mode } = next());\n    panel.mode = 'expanded';"));
  assert.match(output, /state draft unresolved: `panel.mode` guard 2, write 4.*intervening write at 3/);
  assert.doesNotMatch(output, /state draft: `panel.mode`.*collapsed.*expanded/);
});

for (const [description, middle] of [
  ["unrelated binding", "other = next();"],
  ["block shadow", "{ let phase = next(); consume(phase); }"],
  ["loop shadow", "for (let phase of values) consume(phase);"],
  ["delayed callback", "later(() => { phase = next(); });"],
]) {
  test(`state mutation checks do not connect a ${description} to the outer binding`, () => {
    const output = signals("", transition.replace("    phase = 'running';", `    ${middle}\n    phase = 'running';`));
    assert.match(output, /state draft: `phase` "idle" -> "running"/);
    assert.doesNotMatch(output, /state draft unresolved:/);
  });
}

test("an unrelated deletion does not make an unchanged state relation relevant", () => {
  const before = transition.replace("    phase = 'running';", "    trace();\n    phase = 'running';");
  assert.doesNotMatch(signals(before, transition), /state draft/);
});

const domains = [
  { name: "localized text", owner: "locale", item: "item", load: "loadText" },
  { name: "image rendering", owner: "theme", item: "size", load: "buildImage" },
];
function cache({ owner = "locale", item = "item", load = "loadText", key = item,
  value = `${load}(${owner}, ${item})`, locals = [], reset = "", direct = false } = {}) {
  return source("const memo = new Map();", `function lookup(${owner}, ${item}) {`, ...locals.map(row => `  ${row}`),
    ...(reset ? [`  ${reset}`] : []), `  const hit = memo.get(${key});`,
    ...(direct ? [`  memo.set(${key}, ${value});`] : [`  const value = ${value};`, `  memo.set(${key}, value);`]), "}");
}

function assertScopeInput(output, input) {
  assert.match(output, /shared Map scope:/);
  assert.ok(output.includes(`omits value inputs \`${input}\``), output);
}

for (const domain of domains) {
  test(`shared Map scope retains a removed reset as a review question for ${domain.name}`, () => {
    const before = cache({ ...domain, reset: "memo.clear();" }), head = cache(domain);
    assert.doesNotMatch(signals("", before), /shared Map scope:/);
    const output = signals(before, head);
    assertScopeInput(output, domain.owner);
    assert.match(output, /key read 3, write 5/);
    assert.match(output, /review key scope/);
    assert.doesNotMatch(output, /data leak|unsafe cache|proved safe/i);
  });

  test(`shared Map scope retains a changed multiline property suffix for ${domain.name}`, () => {
    const before = source("const memo = new Map();", "function lookup(context) {", `  const hit = memo.get(context.${domain.item});`,
      `  const value = ${domain.load}(`, "    context", `      .${domain.item}`, "  );", `  memo.set(context.${domain.item}, value);`, "}");
    const output = signals(before, before.replace(`      .${domain.item}`, `      .${domain.owner}`));
    assertScopeInput(output, `context.${domain.owner}`);
    assert.match(output, /key read 3, write 8/);
  });
}

for (const [description, suffix] of [
  ["unrelated statement", "function inspect() { trace(); }\n"],
  ["another function's reset", "function inspect() { memo.clear(); }\n"],
  ["another Map's reset", "const other = new Map();\nfunction inspect() { other.clear(); }\n"],
  ["shadowed Map's reset", "function inspect(memo) { memo.clear(); }\n"],
]) {
  test(`shared Map scope ignores a removed ${description} beside an unchanged cache`, () => {
    const head = cache();
    assert.doesNotMatch(signals(head + suffix, head), /shared Map scope:/);
  });
}

test("removing one reset does not revive a cache hint when an unconditional reset remains", () => {
  const head = cache({ reset: "memo.clear();" });
  const before = head.replace("  memo.clear();", "  memo.clear();\n  memo.clear();");
  assert.doesNotMatch(signals(before, head), /shared Map scope:/);
});

for (const method of ["get", "set"]) {
  for (const domain of domains) {
    test(`shared Map scope excludes a literal computed ${method} replacement for ${domain.name}`, () => {
      const head = cache(domain).replace("function lookup", `memo["${method}"] = other;\nfunction lookup`);
      assert.doesNotMatch(signals("", head), /shared Map scope:/);
    });
  }
}

test("computed method replacement remains excluded when the stored-value input also changes", () => {
  const before = cache({ value: "loadText(item)" }).replace("function lookup", "memo.get = other;\nfunction lookup");
  const head = cache().replace("function lookup", "memo['get'] = other;\nfunction lookup");
  assert.doesNotMatch(signals(before, head), /shared Map scope:/);
});

test("a computed method assignment to a shadowed Map does not suppress the outer Map", () => {
  const head = cache().replace("function lookup", "function replace(memo) { memo['get'] = other; }\nfunction lookup");
  assert.match(signals("", head), /shared Map scope:.*omits value inputs `locale`/);
});

for (const domain of domains) {
  test(`constant property-base aliases retain value inputs for ${domain.name}`, () => {
    const head = cache({ ...domain, owner: "context", locals: ["const scoped = context;"], value: `${domain.load}(scoped.${domain.owner}, ${domain.item})` });
    assertScopeInput(signals("", head), `context.${domain.owner}`);
  });

  test(`constant callee aliases retain callable inputs for ${domain.name}`, () => {
    const head = cache({ ...domain, owner: "load", locals: ["const loader = load;"], value: `loader(${domain.item})` });
    assert.match(signals("", head), /shared Map scope:.*omits value inputs `load`/);
  });
}

test("constant aliases of a complete key do not create a scope warning", () => {
  const head = cache({ owner: "context", key: "`${context.locale}:${item}`", locals: ["const scoped = context;"], value: "loadText(scoped.locale, item)" });
  assert.doesNotMatch(signals("", head), /shared Map scope:/);
});

test("an alias of a shadowed context keeps that local binding rather than the parameter", () => {
  const head = source("const memo = new Map();", "function lookup(context, item) {", "  {", "    const context = other;",
    "    const scoped = context;", "    const hit = memo.get(item);", "    memo.set(item, loadText(scoped.locale, item));", "  }", "}");
  assert.doesNotMatch(signals("", head), /shared Map scope:/);
});

for (const kind of ["callee", "property base"]) {
  for (const count of [5, 6]) {
    test(`${kind} aliases ${count === 5 ? "retain" : "stop beyond"} the five-binding limit`, () => {
      const owner = kind === "callee" ? "load" : "context";
      const locals = Array.from({ length: count }, (_, index) => `const alias${index + 1} = ${index ? `alias${index}` : owner};`);
      const value = kind === "callee" ? `alias${count}(item)` : `loadText(alias${count}.locale, item)`;
      const output = signals("", cache({ owner, locals, value, direct: true }));
      if (count === 5) assertScopeInput(output, `${owner}${kind === "callee" ? "" : ".locale"}`);
      else assert.doesNotMatch(output, /shared Map scope:/);
    });
  }
}

for (const [description, locals, value] of [
  ["mutable property alias", ["let scoped = context;"], "loadText(scoped.locale, item)"],
  ["reassigned property alias", ["const scoped = context;", "scoped = other;"], "loadText(scoped.locale, item)"],
  ["cyclic property aliases", ["const first = second;", "const second = first;"], "loadText(first.locale, item)"],
  ["mutable callee alias", ["let loader = context;"], "loader(item)"],
  ["reassigned callee alias", ["const loader = context;", "loader = other;"], "loader(item)"],
  ["cyclic callee aliases", ["const first = second;", "const second = first;"], "first(item)"],
]) {
  test(`shared Map scope does not infer identity through ${description}`, () => {
    assert.doesNotMatch(signals("", cache({ owner: "context", locals, value, direct: true })), /shared Map scope:/);
  });
}
