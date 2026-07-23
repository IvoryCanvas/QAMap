export interface TestPlanResult {
  suggestedCommands: string[];
  changedFiles: string[];
}

export function collectChangedFiles(): string[] {
  return [];
}

export function discoverSuggestedCommands(serviceName: string): string[] {
  const backgroundService = /(?:worker|scheduler|consumer)/i.test(serviceName);
  return backgroundService ? [] : ["test"];
}
