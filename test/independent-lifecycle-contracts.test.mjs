import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { generateQaDraft } from "../dist/qa.js";

const inputContracts = [
  ["shows a masked value after typing", "expect(input.value).toBe('12-34')"],
  ["shows a normalized value after paste", "expect(input.value).toBe('56-78')"],
  ["shows the display mask when unfocused", "expect(input.value).toBe('**-78')"],
  ["preserves the raw value after submission", "expect(request.value).toBe('5678')"],
];

for (const committed of [true, false]) {
  test(`input lifecycle contracts keep independent conditions and assertions (${committed ? "commit" : "working tree"})`, async (t) => {
    const { qa, file } = await analyzeContracts(t, inputContracts, { committed });
    const scenarios = assertIndependentContracts(qa, file, inputContracts);
    for (const [index, scenario] of scenarios.entries()) {
      const ownContext = ["After typing.", "After paste.", "When unfocused.", "After submission."][index];
      assert.ok([...scenario.setup, ...scenario.steps].includes(ownContext));
    }
    assert.equal(qa.execution.status, "not-run");
  });
}

test("mobile asynchronous outcomes retain pending, success, failure, and recovery contracts", async (t) => {
  const contracts = [
    ["shows loading while the request is pending", "expect(find.text('Loading'), findsOneWidget)"],
    ["shows the result after the request succeeds", "expect(find.text('Ready'), findsOneWidget)"],
    ["shows an error after the request fails", "expect(find.text('Unavailable'), findsOneWidget)"],
    ["shows the result after retry succeeds", "expect(find.text('Recovered'), findsOneWidget)"],
  ];
  const { qa, file } = await analyzeContracts(t, contracts, { mobile: true });
  const scenarios = assertIndependentContracts(qa, file, contracts);
  assert.deepEqual(scenarios[0].setup, ["While the request is pending."]);
  assert.ok(scenarios[3].steps.includes("After retry succeeds."));
  assert.equal(qa.execution.status, "not-run");
});

test("equal test titles keep different expectations and evidence locations", async (t) => {
  const contracts = [
    ["shows the value after input", "expect(input.value).toBe('12-34')"],
    ["shows the value after input", "expect(input.value).toBe('56-78')"],
  ];
  const { qa, file } = await analyzeContracts(t, contracts);
  const scenarios = assertIndependentContracts(qa, file, contracts);
  assert.equal(new Set(scenarios.map((scenario) => scenario.id)).size, 2);
  const stages = qa.changeAnalysis.intents.flatMap((intent) => intent.lifecycle)
    .filter((stage) => stage.kind === "observable-outcome" && stage.symbol === "changed-test-contract");
  assert.equal(stages.length, 2);
  assert.equal(new Set(stages.map((stage) => stage.id)).size, 2);
  for (const stage of stages) {
    assert.equal(stage.evidence.filter((item) => item.symbol === "changed-test-assertion").length, 1);
  }
});

test("test contracts do not invent missing actions or promote existence checks", async (t) => {
  const contracts = [
    ["shows a valid value", "expect(input.value).toBe('12-34')"],
    ["shows an empty value", "expect(input.value).toBe('')"],
    ["shows an error after retry", "expect(helper).toBeDefined()"],
  ];
  const { qa, file } = await analyzeContracts(t, contracts);
  const scenarios = assertIndependentContracts(qa, file, contracts.slice(0, 2));
  for (const scenario of scenarios) {
    assert.deepEqual(scenario.steps, []);
    assert.deepEqual(scenario.setup, []);
    assert.equal(scenario.reviewRequired, true);
    assert.equal(scenario.confidence, "medium");
  }
  assert.ok(!scenarios.some((scenario) => /helper|retry/.test(JSON.stringify(scenario))));
});

function assertIndependentContracts(qa, file, contracts) {
  const scenarios = qa.changeAnalysis.intents.flatMap((intent) => intent.scenarios)
    .filter((scenario) => scenario.evidence.some((item) =>
      item.file === file && item.symbol === "changed-test-assertion"
    ));
  assert.equal(scenarios.length, contracts.length, JSON.stringify(scenarios, null, 2));
  return contracts.map(([title, assertion]) => {
    const expected = `Verify repository-authored assertion \`${assertion}\`.`;
    const scenario = scenarios.find((candidate) => candidate.assertions.includes(expected));
    assert.ok(scenario, `Missing separate contract: ${title}\n${JSON.stringify(scenarios, null, 2)}`);
    assert.deepEqual(scenario.assertions, [expected]);
    const declarations = scenario.evidence.filter((item) => item.symbol === "changed-test-contract");
    assert.equal(declarations.length, 1);
    assert.equal(declarations[0].value, `Changed test contract: ${title}`);
    assert.equal(declarations[0].file, file);
    return scenario;
  });
}

async function analyzeContracts(t, contracts, { committed = true, mobile = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "qamap-independent-contracts-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  git(root, "init", "-b", "main");
  git(root, "config", "user.email", "qamap@example.test");
  git(root, "config", "user.name", "QAMap Test");
  git(root, "config", "gc.auto", "0");
  git(root, "config", "maintenance.auto", "false");
  const sourceFile = mobile ? "lib/status_view.dart" : "src/MaskedInput.tsx";
  const file = mobile ? "test/status_view_test.dart" : "src/MaskedInput.test.tsx";
  if (mobile) {
    await write(root, "pubspec.yaml", "name: status_app\ndependencies:\n  flutter:\n    sdk: flutter\n");
  } else {
    await write(root, "package.json", JSON.stringify({
      name: "input-app", scripts: { test: "node --test" }, dependencies: { react: "19.0.0" },
    }));
  }
  await write(root, sourceFile, mobile
    ? "Widget statusView() => Text('Idle');\n"
    : "export function MaskedInput() { return <input />; }\n");
  await write(root, file, mobile
    ? "import 'package:flutter_test/flutter_test.dart';\n"
    : "import { MaskedInput } from './MaskedInput';\n");
  git(root, "add", ".");
  git(root, "commit", "-m", "chore: baseline");
  git(root, "checkout", "-b", "fix/state-contracts");
  await write(root, sourceFile, mobile
    ? "Widget statusView(bool pending) => Text(pending ? 'Loading' : 'Ready');\n"
    : "export function MaskedInput({ value, onChange, onPaste }) {\n  return <input value={value} onChange={onChange} onPaste={onPaste} />;\n}\n");
  await write(root, file, [
    mobile ? "import 'package:flutter_test/flutter_test.dart';" : "import { MaskedInput } from './MaskedInput';",
    ...contracts.flatMap(([title, assertion]) => [
      mobile
        ? `testWidgets(${JSON.stringify(title)}, (tester) async {`
        : `test(${JSON.stringify(title)}, () => {`,
      `  ${assertion};`,
      "});",
    ]),
    "",
  ].join("\n"));
  if (committed) {
    git(root, "add", ".");
    git(root, "commit", "-m", "fix: show the changed state after input");
  }
  const qa = await generateQaDraft(root, { base: "main", head: "HEAD", includeWorkingTree: !committed });
  return { qa, file };
}

async function write(root, file, text) {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await writeFile(path.join(root, file), text);
}

function git(root, ...args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
