// A filename convention is collected evidence, not proof that a test executes.
// Keep canonical names such as test.js and spec.mjs aligned with suffixed names.
export function isJavaScriptTestFileName(file: string): boolean {
  return /(?:^|[/.-])(?:test|spec)\.[cm]?[jt]sx?$/i.test(file);
}
