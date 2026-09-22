import { cases as extended } from "./extended-cases.mjs";

// Strengthen the policy oracle separately; keep previously frozen suites unchanged.
const policy = structuredClone(extended.find(entry => entry.id === "runtime-policy-choice"));
policy.id = "runtime-policy-literal";
policy.anchors.push({ id: "policy-implementation", file: "src/policy.mjs", line: 1,
  text: "export const accept = value => value >= 0;", role: "implementation" });

const large = {
  id: "independent-160-contracts", kind: "regression", tier: "scale",
  message: "refactor: simplify independent lower bounds",
  rationale: "Every distinct changed rule and assertion must remain recoverable beyond graph and response preview limits.",
  base: { "package.json.fixture": '{"name":"evidence-completeness-fixture","version":"1.0.0","type":"module","scripts":{"test":"node --test"}}\n' },
  head: {}, anchors: [], failingTests: [],
};
for (let i = 0; i < 160; i++) {
  const file = `src/rule-${i}.mjs`, testFile = `test/rule-${i}.test.mjs`, name = `check${i}`;
  const title = `rule ${i} preserves its lower bound`;
  large.base[file] = `export function ${name}(value) { return Math.max(0, value); }\n`;
  large.head[file] = `export function ${name}(value) { return value; }\n`;
  const assertion = `test('${title}', () => { assert.equal(${name}(-1), 0); });`;
  large.base[testFile] = `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { ${name} } from '../${file}';\n${assertion}\n`;
  large.anchors.push({ id: `${name}-implementation`, file, line: 1, text: large.head[file].trimEnd(), role: "implementation" },
    { id: `${name}-expectation`, file: testFile, line: 4, text: assertion, role: "assertion" });
  large.failingTests.push(title);
}

export const cases = [policy, large];
