import { useState } from "react";

const defaultDensity = "comfortable";

export function PreferencesPage() {
  const [density, setDensity] = useState(defaultDensity);
  const [confirmationVisible, setConfirmationVisible] = useState(false);

  return (
    <main>
      <h1>Workspace preferences</h1>
      <label htmlFor="density-select">Layout density</label>
      <select
        data-testid="density-select"
        id="density-select"
        value={density}
        onChange={(event) => {
          setDensity(event.target.value);
          setConfirmationVisible(false);
        }}
      >
        <option value="comfortable">Comfortable</option>
        <option value="compact">Compact</option>
      </select>
      <p data-testid="density-summary">Current density: {density}</p>
      <button
        data-testid="reset-preferences"
        type="button"
        onClick={() => {
          setDensity(defaultDensity);
          setConfirmationVisible(true);
        }}
      >
        Reset preferences
      </button>
      {confirmationVisible ? (
        <p data-testid="reset-confirmation">Preferences restored to defaults</p>
      ) : null}
    </main>
  );
}
