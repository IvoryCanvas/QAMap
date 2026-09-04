import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { generateE2ePlan, generateQaDraft } from "../dist/index.js";

const execFileAsync = promisify(execFile);

test("Flutter repositories keep their platform and changed Dart test contracts", async (t) => {
  const root = await makeRepo(t);
  await writeProjectFile(root, "pubspec.yaml", flutterPubspec());
  await writeProjectFile(root, "android/app/src/main/AndroidManifest.xml", "<manifest><application /></manifest>\n");
  await writeProjectFile(root, "ios/Runner/Info.plist", "<plist><dict /></plist>\n");
  await writeProjectFile(
    root,
    "lib/screens/profile_screen.dart",
    "class ProfileScreen { String label(bool saved) => saved ? 'Saved' : 'Edit'; }\n",
  );
  await writeProjectFile(
    root,
    "test/profile_screen_test.dart",
    [
      "import 'package:flutter_test/flutter_test.dart';",
      "",
      "void main() {",
      "  testWidgets('shows the editable profile', (tester) async {});",
      "}",
      "",
    ].join("\n"),
  );
  await commitAll(root, "chore: initialize mobile profile");

  await git(root, ["switch", "-c", "fix/profile-restoration"]);
  await writeProjectFile(
    root,
    "lib/screens/profile_screen.dart",
    "class ProfileScreen { String label(bool saved) => saved ? 'Profile saved' : 'Edit profile'; }\n",
  );
  await writeProjectFile(
    root,
    "test/profile_screen_test.dart",
    [
      "import 'package:flutter_test/flutter_test.dart';",
      "",
      "void main() {",
      "  testWidgets('shows the editable profile', (tester) async {});",
      "  testWidgets('restores the saved profile after relaunch', (tester) async {});",
      "}",
      "",
    ].join("\n"),
  );
  await commitAll(root, "fix: restore the saved profile after relaunch");

  const plan = await generateE2ePlan(root, { base: "main", head: "HEAD" });
  const qa = await generateQaDraft(root, { base: "main", head: "HEAD" });

  assert.equal(plan.project.type, "flutter");
  assert.ok(plan.project.evidence.some((item) => /Flutter SDK/.test(item)));
  assert.equal(plan.testSuite.testFileCount, 1);
  assert.ok(plan.testSuite.frameworkSignals.includes("flutter"));
  assert.equal(qa.project, "flutter");
  assert.equal(qa.execution.status, "not-run");
  assert.ok(qa.changedTestContracts.some((contract) =>
    contract.framework === "dart" && contract.title === "restores the saved profile after relaunch"
  ));
  assert.equal(qa.route.command, "flutter test test/profile_screen_test.dart");
  assert.deepEqual(plan.suggestedCommands.slice(0, 3), [
    "flutter test test/profile_screen_test.dart",
    "flutter test",
    "flutter analyze",
  ]);
});

test("plain Dart packages prefer dart test without becoming Flutter", async (t) => {
  const root = await makeRepo(t);
  await writeProjectFile(
    root,
    "pubspec.yaml",
    [
      "name: text_parser",
      "environment:",
      "  sdk: '>=3.5.0 <4.0.0'",
      "dev_dependencies:",
      "  test: ^1.25.0",
      "",
    ].join("\n"),
  );
  await writeProjectFile(root, "lib/parser.dart", "String normalize(String value) => value.trim();\n");
  await writeProjectFile(
    root,
    "test/parser_test.dart",
    "import 'package:test/test.dart';\nvoid main() { test('trims input', () {}); }\n",
  );
  await commitAll(root, "chore: initialize parser");

  await git(root, ["switch", "-c", "fix/parser-boundary"]);
  await writeProjectFile(root, "lib/parser.dart", "String normalize(String value) => value.trim().toLowerCase();\n");
  await writeProjectFile(
    root,
    "test/parser_test.dart",
    "import 'package:test/test.dart';\nvoid main() {\n  test('trims input', () {});\n  test('normalizes case', () {});\n}\n",
  );
  await commitAll(root, "fix: normalize parser case");

  const plan = await generateE2ePlan(root, { base: "main", head: "HEAD" });
  const qa = await generateQaDraft(root, { base: "main", head: "HEAD" });

  assert.notEqual(plan.project.type, "flutter");
  assert.ok(plan.flows.every((flow) => flow.kind !== "ui"));
  assert.ok(plan.testSuite.frameworkSignals.includes("dart:test"));
  assert.equal(qa.route.command, "dart test test/parser_test.dart");
  assert.ok(qa.changedTestContracts.some((contract) =>
    contract.framework === "dart" && contract.title === "normalizes case"
  ));
});

test("React Native detection remains independent from Flutter pubspec evidence", async (t) => {
  const root = await makeRepo(t);
  await writeProjectFile(
    root,
    "package.json",
    `${JSON.stringify({ name: "native-client", dependencies: { "react-native": "0.81.0" } }, null, 2)}\n`,
  );
  await writeProjectFile(root, "ios/App/project.pbxproj", "// project\n");
  await writeProjectFile(root, "android/app/src/main/AndroidManifest.xml", "<manifest />\n");
  await writeProjectFile(root, "src/screens/ProfileScreen.tsx", "export const ProfileScreen = () => null;\n");
  await commitAll(root, "chore: initialize native client");

  await git(root, ["switch", "-c", "fix/profile-copy"]);
  await writeProjectFile(root, "src/screens/ProfileScreen.tsx", "export const ProfileScreen = () => <Text>Profile</Text>;\n");
  await commitAll(root, "fix: show profile copy");

  const plan = await generateE2ePlan(root, { base: "main", head: "HEAD" });
  assert.equal(plan.project.type, "react-native");
});

test("Flutter platform version metadata does not become asynchronous product QA", async (t) => {
  const root = await makeRepo(t);
  await writeProjectFile(root, "pubspec.yaml", flutterPubspec());
  await writeProjectFile(
    root,
    "android/app/src/main/AndroidManifest.xml",
    '<manifest android:versionCode="1"><application /></manifest>\n',
  );
  await commitAll(root, "chore: initialize mobile build");

  await git(root, ["switch", "-c", "chore/mobile-version"]);
  await writeProjectFile(
    root,
    "android/app/src/main/AndroidManifest.xml",
    '<manifest android:versionCode="2"><application /></manifest>\n',
  );
  await commitAll(root, "chore: update mobile version metadata");

  const plan = await generateE2ePlan(root, { base: "main", head: "HEAD" });
  const scenarioText = plan.changeAnalysis.intents
    .flatMap((intent) => intent.scenarios)
    .map((scenario) => `${scenario.title} ${scenario.rationale}`)
    .join("\n");

  assert.equal(plan.project.type, "flutter");
  assert.doesNotMatch(scenarioText, /async|pending|callback|lifecycle ordering/i);
});

function flutterPubspec() {
  return [
    "name: profile_app",
    "environment:",
    "  sdk: '>=3.5.0 <4.0.0'",
    "dependencies:",
    "  flutter:",
    "    sdk: flutter",
    "dev_dependencies:",
    "  flutter_test:",
    "    sdk: flutter",
    "flutter:",
    "  uses-material-design: true",
    "",
  ].join("\n");
}

async function makeRepo(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "qamap-flutter-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await git(root, ["init"]);
  await git(root, ["config", "user.email", "tests@example.test"]);
  await git(root, ["config", "user.name", "QAMap Tests"]);
  await git(root, ["branch", "-M", "main"]);
  return root;
}

async function writeProjectFile(root, relativePath, contents) {
  const file = path.join(root, relativePath);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, contents);
}

async function commitAll(root, message) {
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", message]);
}

async function git(root, args) {
  await execFileAsync("git", args, { cwd: root });
}
