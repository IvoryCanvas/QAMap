export async function loadPolicy(moduleId) {
  const policy = await import(moduleId);
  return policy.normalize;
}
