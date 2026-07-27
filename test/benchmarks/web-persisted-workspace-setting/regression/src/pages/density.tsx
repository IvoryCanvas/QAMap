import React, { useState } from "react";

export function DensityPage() {
  const [density, setDensity] = useState(
    () => window.localStorage.getItem("workspace-density") ?? "comfortable",
  );
  const [saved, setSaved] = useState(false);

  function saveDensity() {
    setSaved(true);
  }

  return (
    <main>
      <label>
        Workspace density
        <input
          aria-label="Workspace density"
          value={density}
          onChange={(event) => setDensity(event.target.value)}
        />
      </label>
      <button data-testid="density-save" onClick={saveDensity} type="button">
        Save density
      </button>
      {saved ? <p>Density saved</p> : null}
    </main>
  );
}
