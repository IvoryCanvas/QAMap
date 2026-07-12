// Terminal presentation for human-facing reports. Colors are additive sugar:
// they are applied only when writing to an interactive terminal, so files,
// pipes, CI logs, and machine formats always receive the plain text.

const RESET = "[0m";
const BOLD = "[1m";
const DIM = "[2m";
const RED = "[31m";
const GREEN = "[32m";
const YELLOW = "[33m";
const CYAN = "[36m";

export function shouldColorize(stream: NodeJS.WriteStream = process.stdout): boolean {
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== "") {
    return false;
  }
  if (process.env.FORCE_COLOR !== undefined && process.env.FORCE_COLOR !== "" && process.env.FORCE_COLOR !== "0") {
    return true;
  }
  return Boolean(stream.isTTY);
}

export function colorizeReport(text: string): string {
  // Machine formats pass through untouched.
  const head = text.trimStart();
  if (head.startsWith("{") || head.startsWith("[")) {
    return text;
  }
  return text
    .split("\n")
    .map((line) => colorizeLine(line))
    .join("\n");
}

function colorizeLine(line: string): string {
  if (/^#{1,3} /.test(line)) {
    return `${BOLD}${CYAN}${line}${RESET}`;
  }
  if (line.startsWith("> ")) {
    return `${DIM}${line}${RESET}`;
  }
  let output = line;
  output = output.replace(
    /^(- (?:Affected|Change intent|Behavior lifecycle|Do next|Blocking(?: \d+)?|Base|Head|Project|Automation adapter|Recommended runner|Manifest|Stage|Draft flows)):/,
    `${BOLD}$1${RESET}:`,
  );
  output = output.replace(/\[(required|missing|error)\]/g, `${RED}[$1]${RESET}`);
  output = output.replace(/\[(recommended|warning|skipped)\]/g, `${YELLOW}[$1]${RESET}`);
  output = output.replace(/\[(covered|ready|created|updated|pass)\]/g, `${GREEN}[$1]${RESET}`);
  output = output.replace(
    /\b(Readiness|runnable|self-check|Status|status)(\[0m)?: (blocked|failed|fail|missing)\b/g,
    `$1$2: ${RED}$3${RESET}`,
  );
  output = output.replace(
    /\b(Readiness|runnable|self-check|Status|status)(\[0m)?: (needs-work|near-runnable|review-only|warning|proposed)\b/g,
    `$1$2: ${YELLOW}$3${RESET}`,
  );
  output = output.replace(
    /\b(Readiness|runnable|self-check|Status|status)(\[0m)?: (ready|runnable-candidate|pass|passed|created|applied)\b/g,
    `$1$2: ${GREEN}$3${RESET}`,
  );
  output = output.replace(
    /\b(Stage)(\[0m)?: (setup needed|draft in progress|almost runnable)\b/g,
    `$1$2: ${YELLOW}$3${RESET}`,
  );
  output = output.replace(
    /\b(Stage)(\[0m)?: (ready to run)\b/g,
    `$1$2: ${GREEN}$3${RESET}`,
  );
  output = output.replace(/`([^`\n]+)`/g, `${CYAN}$1${RESET}`);
  return output;
}
