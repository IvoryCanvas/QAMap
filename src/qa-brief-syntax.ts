import ts from "typescript";

export interface BriefSnapshot { source: ts.SourceFile; checker: ts.TypeChecker }
export interface BriefHunk { newStart: number; newCount: number; lines: string[] }

export function bindBriefSource(file: string, head: string[]): BriefSnapshot | undefined {
  const filename = `/${file}`, text = head.join("\n");
  const source = ts.createSourceFile(filename, text, ts.ScriptTarget.Latest, true);
  // Bind only this file's text; never load imports, libraries or project configuration.
  const host: ts.CompilerHost = {
    getSourceFile: name => name === filename ? source : undefined,
    getDefaultLibFileName: () => "", writeFile: () => {}, getCurrentDirectory: () => "/",
    getDirectories: () => [], fileExists: name => name === filename,
    readFile: name => name === filename ? text : undefined,
    getCanonicalFileName: name => name, useCaseSensitiveFileNames: () => true, getNewLine: () => "\n",
  };
  const program = ts.createProgram([filename], { allowJs: true, noLib: true, noResolve: true }, host);
  if (program.getSyntacticDiagnostics(source).length) return undefined;
  return { source, checker: program.getTypeChecker() };
}

// Reconstruct compared text and retain coordinates of surviving head lines.
export function comparedBaseLines(hunks: BriefHunk[], head: string[]): Array<{ text: string; headLine?: number }> | undefined {
  const rows: Array<{ text: string; headLine?: number }> = head.map((text, index) => ({ text, headLine: index + 1 }));
  for (const hunk of [...hunks].reverse()) {
    const start = hunk.newStart - (hunk.newCount ? 1 : 0);
    const current = hunk.lines.filter(line => !line.startsWith("-")).map(line => line.slice(1));
    if (start < 0 || current.length !== hunk.newCount || current.some((text, index) => rows[start + index]?.text !== text)) return undefined;
    let offset = 0;
    const old = hunk.lines.flatMap(line => line.startsWith("+") ? (offset++, [])
      : [{ text: line.slice(1), headLine: line.startsWith("-") ? undefined : rows[start + offset++]?.headLine }]);
    rows.splice(start, hunk.newCount, ...old);
  }
  return rows;
}
