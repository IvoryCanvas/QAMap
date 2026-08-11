function normalizePath(filePath: string): string {
  return filePath.replaceAll("\\", "/");
}

export function isBenchmarkRevisionFixturePath(filePath: string): boolean {
  return /(?:^|\/)benchmarks?\/[^/]+\/(?:base|head(?:-\d+)?|regression)(?:\/|$)/i.test(
    normalizePath(filePath),
  );
}

export function isBenchmarkValidationStructurePath(filePath: string): boolean {
  const normalized = normalizePath(filePath);
  if (isBenchmarkRevisionFixturePath(normalized)) {
    return true;
  }
  if (/(?:^|\/)scripts\/(?:bench|benchmark)(?:[._-][^/]*)?\.[^/]+$/i.test(normalized)) {
    return true;
  }
  const basename = normalized.split("/").at(-1) ?? "";
  return /(?:^|[._-])bench(?:mark)?(?:[._-]|$)/i.test(basename) &&
    /(?:^|[._-])config(?:[._-]|$)/i.test(basename);
}

export function isRepositoryBenchmarkScript(name: string, command: string): boolean {
  if (!/(?:^|[:_-])bench(?:mark)?(?:$|[:_-])/i.test(name)) {
    return false;
  }
  return /(?:^|[\s"'])(?:\.\/)?(?:scripts\/)?(?:bench|benchmark)[^\s"']*\.(?:[cm]?[jt]s|py|rb|sh)(?:[\s"']|$)/i.test(
    command,
  ) || /(?:^|\s)--config(?:=|\s+)[^\s]*bench(?:mark)?[^\s]*/i.test(command);
}
