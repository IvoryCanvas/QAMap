export function PreferenceStatus({ isRestored }) {
  return <p>{isRestored ? "Preference restored" : "Preference unavailable"}</p>;
}
