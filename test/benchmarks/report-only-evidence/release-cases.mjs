// Mixed contracts exercise different operators and data shapes, not renamed copies
// of one implementation. Keep these fixtures and their oracle fixed during runs.
const contracts = [
  ["email", "v.trim().toLowerCase()", "v.toLowerCase()", "' A@B.COM '", "'a@b.com'", true],
  ["minimum", "Math.max(0, v)", "Math.abs(v)", "-3", "0", true],
  ["lastItem", "v[v.length - 1]", "v[0]", "[2, 7, 9]", "9", true],
  ["enabled", "v === true", "Boolean(v)", "'false'", "false", true],
  ["pageCount", "Math.ceil(v / 10)", "Math.floor(v / 10)", "11", "2", true],
  ["defaultPort", "v ?? 8080", "v || 8080", "0", "0", true],
  ["slug", "v.trim().replaceAll(' ', '-').toLowerCase()", "v.trim().toLowerCase().replaceAll(' ', '-')", "' Hello World '", "'hello-world'"],
  ["maximum", "Math.min(100, v)", "v > 100 ? 100 : v", "120", "100"],
  ["firstItem", "v.at(0)", "v[0]", "[4, 9]", "4"],
  ["isEmpty", "v.length === 0", "!v.length", "[]", "true"],
  ["uniqueItems", "Array.from(new Set(v))", "[...new Set(v)]", "[1, 2, 1]", "[1, 2]"],
  ["positiveSum", "v.filter(n => n > 0).reduce((a, n) => a + n, 0)", "v.reduce((a, n) => n > 0 ? a + n : a, 0)", "[-1, 2, 3]", "5"],
  ["hasOwner", "Object.hasOwn(v, 'owner')", "Object.prototype.hasOwnProperty.call(v, 'owner')", "{ owner: null }", "true"],
  ["compact", "v.filter(x => x != null)", "v.filter(x => x !== null && x !== undefined)", "[0, null, false, undefined]", "[0, false]"],
  ["descending", "[...v].sort((a, b) => b - a)", "v.slice().sort((a, b) => b - a)", "[2, 8, 1]", "[8, 2, 1]"],
  ["validDate", "Number.isFinite(Date.parse(v))", "!Number.isNaN(Date.parse(v))", "'not-a-date'", "false"],
  ["integer", "Number.isInteger(v)", "Number.isFinite(v) && Math.trunc(v) === v", "2.5", "false"],
  ["extension", "v.slice(v.lastIndexOf('.') + 1)", "v.substring(v.lastIndexOf('.') + 1)", "'archive.tar.gz'", "'gz'"],
  ["trimEnd", "v.replace(/ +$/, '')", "v.replace(new RegExp(' +$'), '')", "' a  '", "' a'"],
  ["prefix", "v.startsWith('api:')", "v.slice(0, 4) === 'api:'", "'api:users'", "true"],
  ["suffix", "v.endsWith('.json')", "v.slice(-5) === '.json'", "'data.json'", "true"],
  ["escapeHtml", "v.replaceAll('&', '&amp;').replaceAll('<', '&lt;')", "v.replace(/&/g, '&amp;').replace(/</g, '&lt;')", "'<a&b'", "'&lt;a&amp;b'"],
  ["statusClass", "Math.floor(v / 100)", "Math.floor(v / (10 * 10))", "404", "4"],
  ["timeout", "v === undefined ? 30 : v", "typeof v === 'undefined' ? 30 : v", "0", "0"],
  ["toPairs", "Object.entries(v)", "Object.keys(v).map(k => [k, v[k]])", "{ a: 1, b: 2 }", "[['a', 1], ['b', 2]]"],
  ["toMap", "Object.fromEntries(v)", "v.reduce((out, [k, value]) => ({ ...out, [k]: value }), {})", "[['a', 1], ['a', 2]]", "{ a: 2 }"],
  ["findAdmin", "v.find(x => x.role === 'admin')?.id ?? null", "v.filter(x => x.role === 'admin')[0]?.id ?? null", "[{ id: 3, role: 'admin' }]", "3"],
  ["allReady", "v.every(x => x.ready === true)", "!v.some(x => x.ready !== true)", "[{ ready: true }, { ready: false }]", "false"],
  ["containsNull", "v.includes(null)", "v.some(x => x === null)", "[undefined, 0, null]", "true"],
  ["removeId", "v.filter(x => x.id !== 2)", "v.flatMap(x => x.id === 2 ? [] : [x])", "[{ id: 1 }, { id: 2 }]", "[{ id: 1 }]"],
  ["stripQuery", "v.split('?')[0]", "v.includes('?') ? v.slice(0, v.indexOf('?')) : v", "'/page?a=1'", "'/page'"],
  ["readQuery", "new URL(v).searchParams.get('page')", "new URLSearchParams(new URL(v).search).get('page')", "'https://example.test/?page=2'", "'2'"],
  ["queryFlag", "new URLSearchParams(v).has('debug')", "Array.from(new URLSearchParams(v).keys()).includes('debug')", "'debug=&x=1'", "true"],
  ["milliseconds", "v * 1000", "1000 * v", "1.5", "1500"],
  ["percentage", "v / 100", "v / (10 * 10)", "25", "0.25"],
  ["between", "v >= 0 && v <= 10", "v <= 10 && v >= 0", "10", "true"],
  ["roundCents", "Math.round(v * 100)", "Math.round(100 * v)", "1.25", "125"],
  ["lowerBound", "v < 5 ? 5 : v", "!(v < 5) ? v : 5", "2", "5"],
  ["booleanText", "v ? 'yes' : 'no'", "!v ? 'no' : 'yes'", "false", "'no'"],
  ["parseCount", "Number.parseInt(v, 10)", "parseInt(v, 10)", "'012'", "12"],
];

function makeCase(crossPackage) {
  const entry = {
    id: crossPackage ? "mixed-package-contracts" : "mixed-direct-contracts",
    kind: "mixed-regression", tier: "release",
    message: "refactor: simplify data helpers while preserving their callers",
    rationale: "Six seeded disagreements among forty distinct changed contracts; safe changes are negative controls, not inferred equivalent for every possible input.",
    base: { "package.json.fixture": '{"name":"mixed-contract-fixture","version":"1.0.0","type":"module","scripts":{"test":"node --test"}}\n' },
    head: {}, anchors: [], failingTests: [], contracts: [],
  };
  if (crossPackage) {
    entry.base["packages/core/package.json"] = '{"name":"@fixture/core","type":"module","exports":{"./*":"./src/*.mjs"}}\n';
    entry.base["packages/client/package.json"] = '{"name":"@fixture/client","type":"module"}\n';
  }
  for (const [name, before, after, input, expected, fails = false] of contracts) {
    const source = `${crossPackage ? "packages/core/src" : "src"}/${name}.mjs`;
    entry.base[source] = `export function ${name}(v) {\n  return ${before};\n}\n`;
    entry.head[source] = `export function ${name}(v) {\n  return ${after};\n}\n`;
    const title = `${name} preserves its caller contract`;
    const testFile = `test/${name}.test.mjs`;
    let imported = source, importedName = name;
    if (crossPackage) {
      const barrel = `packages/core/${name}.mjs`, consumer = `packages/client/src/${name}.mjs`;
      entry.base[barrel] = `export { ${name} as transform } from './src/${name}.mjs';\n`;
      entry.base[consumer] = `import { transform } from '../../core/${name}.mjs';\nexport function consume(v) { return transform(v); }\n`;
      imported = consumer; importedName = "consume";
      entry.anchors.push({ id: `${name}-consumer`, file: consumer, line: 2, text: entry.base[consumer].split("\n")[1], role: "consumer" });
    }
    const assertion = `test('${title}', () => { assert.deepEqual(${importedName}(${input}), ${expected}); });`;
    entry.base[testFile] = `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { ${importedName} } from '../${imported}';\n${assertion}\n`;
    entry.anchors.push({ id: `${name}-implementation`, file: source, line: 2, text: `  return ${after};`, role: "implementation" },
      { id: `${name}-expectation`, file: testFile, line: 4, text: assertion, role: "assertion" });
    if (fails) entry.failingTests.push(title);
    entry.contracts.push({ name, source, testFile, consumer: crossPackage ? imported : null, expectedDisagreement: fails });
  }
  return entry;
}

export const cases = [makeCase(false), makeCase(true)];
