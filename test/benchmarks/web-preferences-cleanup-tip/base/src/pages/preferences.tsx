import { useState } from "react";

export function PreferencesPage() {
  const [density, setDensity] = useState("comfortable");

  return (
    <main>
      <h1>Workspace preferences</h1>
      <label htmlFor="density-select">Layout density</label>
      <select
        data-testid="density-select"
        id="density-select"
        value={density}
        onChange={(event) => setDensity(event.target.value)}
      >
        <option value="comfortable">Comfortable</option>
        <option value="compact">Compact</option>
      </select>
      <p data-testid="density-summary">Current density: {density}</p>
    </main>
  );
}
