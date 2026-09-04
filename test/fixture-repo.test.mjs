import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  isDependencyManifestName,
  materializeFixtureRepo,
} from "../scripts/lib/fixture-repo.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("committed benchmark dependency manifests stay inert", async () => {
  const benchmarkRoot = path.join(repositoryRoot, "test/benchmarks");
  const files = await collectFiles(benchmarkRoot);
  const activeManifests = files.filter((file) => isDependencyManifestName(path.basename(file)));

  assert.deepEqual(activeManifests, []);
  assert.ok(
    files.some((file) => file.endsWith("package.json.fixture")),
    "the benchmark corpus should retain package metadata as inert fixture input",
  );
});

test("fixture repositories restore dependency manifests before committing overlays", async (context) => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "qamap-fixture-source-"));
  context.after(() => rm(fixtureRoot, { recursive: true, force: true }));

  await mkdir(path.join(fixtureRoot, "base", "service"), { recursive: true });
  await mkdir(path.join(fixtureRoot, "head", "service"), { recursive: true });
  await writeFile(
    path.join(fixtureRoot, "base", "package.json.fixture"),
    '{"name":"fixture-app","version":"1.0.0"}\n',
  );
  await writeFile(
    path.join(fixtureRoot, "base", "service", "requirements.txt.fixture"),
    "framework==1.0.0\n",
  );
  await writeFile(
    path.join(fixtureRoot, "base", "service", "pyproject.toml.fixture"),
    '[project]\nname = "fixture-service"\n',
  );
  await writeFile(
    path.join(fixtureRoot, "base", "pubspec.yaml.fixture"),
    "name: fixture_app\n",
  );
  await writeFile(
    path.join(fixtureRoot, "head", "package.json.fixture"),
    '{"name":"fixture-app","version":"1.1.0"}\n',
  );

  const materialized = await materializeFixtureRepo({
    fixtureRoot,
    commits: [{ dir: "head", message: "update fixture manifest" }],
  });
  context.after(materialized.cleanup);

  assert.equal(
    await readFile(path.join(materialized.repositoryRoot, "package.json"), "utf8"),
    '{"name":"fixture-app","version":"1.1.0"}\n',
  );
  assert.equal(
    await readFile(path.join(materialized.repositoryRoot, "service", "requirements.txt"), "utf8"),
    "framework==1.0.0\n",
  );
  assert.equal(
    await readFile(path.join(materialized.repositoryRoot, "service", "pyproject.toml"), "utf8"),
    '[project]\nname = "fixture-service"\n',
  );
  assert.equal(
    await readFile(path.join(materialized.repositoryRoot, "pubspec.yaml"), "utf8"),
    "name: fixture_app\n",
  );

  await assert.rejects(
    access(path.join(materialized.repositoryRoot, "package.json.fixture")),
    { code: "ENOENT" },
  );
  assert.equal(
    await readFile(path.join(fixtureRoot, "base", "package.json.fixture"), "utf8"),
    '{"name":"fixture-app","version":"1.0.0"}\n',
  );
});

async function collectFiles(root) {
  const files = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectFiles(absolute));
    } else if (entry.isFile()) {
      files.push(absolute);
    }
  }
  return files;
}
