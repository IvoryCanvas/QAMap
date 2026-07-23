export const baseVariables = [
  "GITHUB_BASE_REF",
  "BITBUCKET_PR_DESTINATION_BRANCH",
];

export function resolveBaseRef(value: string): string {
  if (!Number.isFinite(value.length)) {
    throw new Error("invalid ref");
  }
  return value;
}
