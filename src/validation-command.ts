export type PythonValidationRunner = "pytest" | "tox" | "ruff" | "mypy";
export type PythonValidationWrapper = "uv" | "poetry";

export interface HostPythonValidationCommand {
  boundary: "host";
  command: string;
  wrapper?: PythonValidationWrapper;
  runner: PythonValidationRunner;
  argumentsSuffix: string;
}

export interface ComposePythonValidationCommand {
  boundary: "compose";
  command: string;
  composeFile?: string;
  service: string;
  wrapper?: PythonValidationWrapper;
  runner: PythonValidationRunner;
  argumentsSuffix: string;
}

export type ParsedPythonValidationCommand =
  | HostPythonValidationCommand
  | ComposePythonValidationCommand;

const hostPythonValidationPattern =
  /^(?:(uv|poetry)\s+run\s+)?(pytest|tox|ruff|mypy)(\s.*)?$/i;
const composePythonValidationPattern =
  /^docker compose(?: -f ([A-Za-z0-9_./:@=-]+))? run --rm ([A-Za-z0-9_.-]+) (?:(uv|poetry) run )?(pytest|tox|ruff|mypy)(\s.*)?$/i;

export function parsePythonValidationCommand(
  command: string,
): ParsedPythonValidationCommand | undefined {
  const compose = command.match(composePythonValidationPattern);
  if (compose) {
    return {
      boundary: "compose",
      command,
      ...(compose[1] ? { composeFile: compose[1] } : {}),
      service: compose[2],
      ...(compose[3]
        ? { wrapper: compose[3].toLowerCase() as PythonValidationWrapper }
        : {}),
      runner: compose[4].toLowerCase() as PythonValidationRunner,
      argumentsSuffix: compose[5] ?? "",
    };
  }

  const host = command.match(hostPythonValidationPattern);
  if (!host) {
    return undefined;
  }
  return {
    boundary: "host",
    command,
    ...(host[1]
      ? { wrapper: host[1].toLowerCase() as PythonValidationWrapper }
      : {}),
    runner: host[2].toLowerCase() as PythonValidationRunner,
    argumentsSuffix: host[3] ?? "",
  };
}

export function composeCommandWithoutPythonWrapper(
  command: ComposePythonValidationCommand,
): string {
  const composeFile = command.composeFile ? ` -f ${command.composeFile}` : "";
  return `docker compose${composeFile} run --rm ${command.service} ${command.runner}${command.argumentsSuffix}`;
}

export function composePythonProbeArgs(
  command: ComposePythonValidationCommand,
): string[] {
  const script = command.wrapper
    ? `if command -v ${command.wrapper} >/dev/null 2>&1; then exit 0; ` +
      `elif command -v ${command.runner} >/dev/null 2>&1; then exit 10; else exit 20; fi`
    : `if command -v ${command.runner} >/dev/null 2>&1; then exit 0; else exit 20; fi`;
  return [
    "compose",
    ...(command.composeFile ? ["-f", command.composeFile] : []),
    "run",
    "--rm",
    "--no-deps",
    "--entrypoint",
    "sh",
    command.service,
    "-lc",
    script,
  ];
}
