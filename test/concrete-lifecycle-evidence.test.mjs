import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { generateQaDraft } from "../dist/qa.js";
import { collectSourceLifecycleContracts, connectTestLifecycleBodies } from "../dist/product-lifecycle.js";

test("web test bodies preserve separate fixture state and typing or paste actions", async (t) => {
  const file = "src/InputField.test.tsx";
  const source = [
    'test("shows typed value", async () => {',
    '  render(<InputField value="" />);',
    '  const input = screen.getByRole("textbox");',
    '  await user.type(input, "1234");',
    '  expect(input.value).toBe("12-34");',
    '});',
    'test("shows pasted value", async () => {',
    '  render(<InputField value="56" />);',
    '  const input = screen.getByRole("textbox");',
    '  await user.paste("5678");',
    '  expect(input.value).toBe("56-78");',
    '});',
  ].join("\n");
  const qa = await analyze(t, {
    "src/InputField.tsx": 'export function InputField({ value }) { return <input value={value} />; }',
    [file]: source,
  });
  const scenarios = contracts(qa, "changed-test-action");
  assert.equal(scenarios.length, 2);
  assert.match(scenarios[0].setup.join("\n"), /value=""/);
  assert.match(scenarios[0].steps.join("\n"), /user.type\(input, "1234"\)/);
  assert.doesNotMatch(JSON.stringify(scenarios[0]), /5678|pasted/);
  assert.match(scenarios[1].steps.join("\n"), /user.paste\("5678"\)/);
  assert.equal(qa.changeAnalysis.intents[0].scenarios[0].id, scenarios[0].id);
  assert.equal(scenarios[0].evidence.find((item) => item.symbol === "changed-test-action").startLine, 4);
  assert.equal(scenarios[0].evidence.find((item) => item.symbol === "changed-test-assertion").startLine, 5);
  assertHonest(qa, scenarios);
});

test("mobile recovery retains widget setup, tap, synchronization, and expected text", async (t) => {
  const qa = await analyze(t, {
    "lib/status_view.dart": "Widget statusView() => Text('Ready');",
    "test/status_view_test.dart": [
      "testWidgets('recovers after retry', (tester) async {",
      "  await tester.pumpWidget(StatusView(initialState: 'error'));",
      "  await tester.tap(find.text('Retry'));",
      "  await tester.pumpAndSettle();",
      "  expect(find.text('Ready'), findsOneWidget);",
      "});",
    ].join("\n"),
  }, { mobile: true });
  const scenarios = contracts(qa, "changed-test-action");
  assert.equal(scenarios.length, 1);
  assert.match(scenarios[0].setup.join("\n"), /initialState: 'error'/);
  assert.match(scenarios[0].steps.join("\n"), /tester.tap.*Retry/);
  assert.match(scenarios[0].steps.join("\n"), /pumpAndSettle/);
  assert.match(scenarios[0].assertions.join("\n"), /Ready/);
  assert.match(scenarios[0].edgeCases.join("\n"), /missing.*intermediate state transition/i);
  assertHonest(qa, scenarios);
});

test("Ruby request contracts retain explicit fixture and action without inventing payloads", async (t) => {
  const qa = await analyze(t, {
    "app/services/status_service.rb": "class StatusService\n  def call\n    { status: 'ready' }\n  end\nend",
    "test/services/status_service_test.rb": [
      'test "accepts a retry" do',
      "  input = { status: 'failed', retry: true }",
      "  result = service.call(input)",
      "  assert_equal 'ready', result.status",
      "end",
    ].join("\n"),
  });
  const scenarios = contracts(qa, "changed-test-action");
  assert.equal(scenarios.length, 1);
  assert.match(scenarios[0].setup.join("\n"), /status: 'failed', retry: true/);
  assert.match(scenarios[0].steps.join("\n"), /service.call\(input\)/);
  assert.match(scenarios[0].assertions.join("\n"), /assert_equal 'ready'/);
  assertHonest(qa, scenarios);
});

for (const committed of [true, false]) {
  test(`source-only state contracts connect exact inline actions to independent rendered outcomes (${committed})`, async (t) => {
    const qa = await analyze(t, { "src/RequestView.tsx": stateView() }, { committed });
    const scenarios = contracts(qa, "product-lifecycle-contract");
    assert.equal(scenarios.length, 3, JSON.stringify(qa.changeAnalysis, null, 2));
    for (const [value, text, button] of [["pending", "Working", "Load"], ["failed", "Unavailable", "Cancel"], ["ready", "Recovered", "Retry"]]) {
      const scenario = scenarios.find((item) => item.assertions.some((entry) => entry.includes(text)));
      assert.ok(scenario);
      assert.match(scenario.setup.join("\n"), /idle/);
      assert.ok(scenario.steps.some((entry) => entry.includes(button)));
      assert.ok(scenario.steps.some((entry) => entry.includes(`setPhase("${value}")`)));
      assert.equal(scenario.assertions.length, 1);
      assert.ok(scenario.evidence.every((item) => item.startLine > 0));
      assert.ok(!scenario.edgeCases.some((entry) => /Missing.*action/i.test(entry)));
    }
    assert.equal(qa.changeAnalysis.intents[0].scenarios[0].id, scenarios[0].id);
    assertHonest(qa, scenarios);
  });
}

test("source contracts stop on ambiguous actions and do not borrow a neighboring component's state", async (t) => {
  const source = stateView().replace(
    '    <button onClick={() => setPhase("pending")}>Load</button>',
    '    <button onClick={() => setPhase("pending")}>Load</button>\n    <button onClick={() => setPhase("pending")}>Reload</button>',
  ) + '\nexport function OtherView({ phase }) {\n  return <>\n    {phase === "pending" && <p>Other pending</p>}\n  </>;\n}';
  const qa = await analyze(t, { "src/RequestView.tsx": source });
  const scenarios = contracts(qa, "product-lifecycle-contract");
  const ambiguous = scenarios.find((item) => item.assertions.some((entry) => entry.includes("Working")));
  assert.deepEqual(ambiguous.steps, []);
  assert.match(ambiguous.edgeCases.join("\n"), /ambiguous.*action/i);
  const other = scenarios.find((item) => item.assertions.some((entry) => entry.includes("Other pending")));
  assert.deepEqual(other.steps, []);
  assert.ok(other.setup.every((entry) => !entry.includes("idle")));
  assert.match(other.edgeCases.join("\n"), /missing.*action/i);
});

test("concrete lifecycle contracts never displace critical delivery failures", async (t) => {
  const source = 'import badge from "./missing-badge.png";\n' + stateView();
  const qa = await analyze(t, { "src/RequestView.tsx": source });
  const scenarios = qa.changeAnalysis.intents.flatMap((item) => item.scenarios);
  const critical = scenarios.findIndex((item) => item.priority === "critical" && item.kind === "failure");
  const concrete = scenarios.findIndex((item) => item.evidence.some((entry) => entry.symbol === "product-lifecycle-contract"));
  assert.ok(critical >= 0 && concrete >= 0);
  assert.ok(critical < concrete);
});

test("comments, strings, and nested test scopes cannot supply lifecycle actions", async (t) => {
  const qa = await analyze(t, {
    "src/InputField.tsx": "export function InputField() { return <input />; }",
    "src/InputField.test.tsx": [
      'test("shows a value", () => {',
      '  const example = "user.type(input, 1234)";',
      '  const later = () => {',
      '    user.paste("secret");',
      '  };',
      '  expect(input.value).toBe("1234");',
      '});',
    ].join("\n"),
    "src/FakeView.tsx": [
      '/*',
      'export function FakeView() {',
      '  return <>',
      '    {phase === "ready" && <p>Not rendered</p>}',
      '  </>;',
      '}',
      '*/',
    ].join("\n"),
    "app/services/retry_service.rb": "class RetryService\n  def call\n    { status: 'ready' }\n  end\nend",
    "test/services/retry_service_test.rb": [
      'test "conditionally accepts a retry" do',
      "  input = { status: 'failed' }",
      "  unless blocked",
      "    result = service.call(input)",
      "  end",
      "  assert_equal 'ready', result.status",
      "end",
    ].join("\n"),
  });
  assert.equal(contracts(qa, "changed-test-action").length, 0);
  assert.equal(contracts(qa, "product-lifecycle-contract").length, 0);
});

test("a changed outcome can use unchanged state and action evidence from the same head", async (t) => {
  const file = "src/RequestView.tsx";
  const qa = await analyze(t, { [file]: stateView() }, {
    baseline: { [file]: stateView().replace("Working", "Queued") },
    afterCommit: (root) => write(root, file, stateView().replace('>Working<', '>Uncommitted<')),
  });
  const scenarios = contracts(qa, "product-lifecycle-contract");
  assert.equal(scenarios.length, 1);
  assert.match(scenarios[0].assertions[0], /Working/);
  assert.doesNotMatch(scenarios[0].assertions[0], /Queued|Uncommitted/);
  assert.match(scenarios[0].steps.join("\n"), /Load/);
});

test("formatting and unrelated source edits do not create new state contracts", async (t) => {
  const file = "src/RequestView.tsx";
  const baseline = stateView() + '\nexport const metric = 1;';
  const qa = await analyze(t, { [file]: baseline.replace("metric = 1", "metric = 2") }, { baseline: { [file]: baseline } });
  assert.equal(contracts(qa, "product-lifecycle-contract").length, 0);
  const formatted = await analyze(t, { [file]: stateView().replace('    {phase === "pending"', '      {phase === "pending"') }, { baseline: { [file]: stateView() } });
  assert.equal(contracts(formatted, "product-lifecycle-contract").length, 0);
});

test("source contract ordering is independent of concurrent file read order", () => {
  const files = { "src/ZView.tsx": stateView(), "src/AView.tsx": stateView() };
  const evidence = Object.fromEntries(Object.entries(files).map(([file, text]) => [file, [{
    file, startLine: 1, endLine: 11, hunkHeader: "@@ -0,0 +1,11 @@",
    lines: text.split("\n").map((text, index) => ({ text, line: index + 1 })),
  }]]));
  assert.deepEqual(collectSourceLifecycleContracts(files, evidence),
    collectSourceLifecycleContracts(Object.fromEntries(Object.entries(files).reverse()), evidence));
});

test("a missing source line cannot connect a test fixture to a later action", () => {
  const contract = { file: "src/Field.test.tsx", line: 1, title: "shows the value", framework: "javascript", assertion: 'expect(input.value).toBe("1234")' };
  const lines = [
    { line: 1, text: 'test("shows the value", () => {' },
    { line: 2, text: '  render(<InputField value="" />);' },
    { line: 4, text: '  user.type(input, "1234");' },
    { line: 5, text: '  expect(input.value).toBe("1234");' },
  ];
  const result = connectTestLifecycleBodies([contract], { [contract.file]: [{ file: contract.file, startLine: 1, endLine: 5, hunkHeader: "", lines }] });
  assert.equal(result[0].body, undefined);
});

function stateView() {
  return [
    'export function RequestView() {',
    '  const [phase, setPhase] = useState("idle");',
    '  return <>',
    '    <button onClick={() => setPhase("pending")}>Load</button>',
    '    <button onClick={() => setPhase("failed")}>Cancel</button>',
    '    <button onClick={() => setPhase("ready")}>Retry</button>',
    '    {phase === "pending" && <p>Working</p>}',
    '    {phase === "failed" && <p>Unavailable</p>}',
    '    {phase === "ready" && <p>Recovered</p>}',
    '  </>;',
    '}',
  ].join("\n");
}

function contracts(qa, symbol) {
  return qa.changeAnalysis.intents.flatMap((item) => item.scenarios)
    .filter((item) => item.evidence.some((entry) => entry.symbol === symbol));
}

function assertHonest(qa, scenarios) {
  assert.equal(qa.execution.status, "not-run");
  for (const scenario of scenarios) {
    assert.equal(scenario.reviewRequired, true);
    assert.notEqual(scenario.confidence, "high");
  }
}

async function analyze(t, files, { committed = true, mobile = false, baseline = {}, afterCommit } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "qamap-concrete-lifecycle-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  git(root, "init", "-b", "main");
  git(root, "config", "user.name", "QAMap Test");
  git(root, "config", "user.email", "qamap@example.test");
  git(root, "config", "gc.auto", "0");
  git(root, "config", "maintenance.auto", "false");
  if (mobile) await write(root, "pubspec.yaml", "name: sample\ndependencies:\n  flutter:\n    sdk: flutter\n");
  else await write(root, "package.json", JSON.stringify({ name: "sample", scripts: { test: "node --test" }, dependencies: { react: "19.0.0" } }));
  await write(root, "README.md", "# Fixture\n");
  for (const [file, text] of Object.entries(baseline)) await write(root, file, text + "\n");
  git(root, "add", ".");
  git(root, "commit", "-m", "chore: baseline");
  git(root, "checkout", "-b", "fix/lifecycle");
  for (const [file, text] of Object.entries(files)) await write(root, file, text + "\n");
  if (committed) {
    git(root, "add", ".");
    git(root, "commit", "-m", "fix: preserve state after input and retry");
  }
  if (afterCommit) await afterCommit(root);
  return generateQaDraft(root, { base: "main", head: "HEAD", includeWorkingTree: !committed });
}

async function write(root, file, text) {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await writeFile(path.join(root, file), text);
}

function git(root, ...args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
