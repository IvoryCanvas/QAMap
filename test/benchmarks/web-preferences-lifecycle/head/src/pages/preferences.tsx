import { useState } from "react";

export function PreferencesPage() {
  const [saved, setSaved] = useState(false);

  async function onSubmitPreferences() {
    await fetch("/api/preferences", { method: "POST" });
    setSaved(true);
  }

  return (
    <main>
      <label>
        Timezone
        <input aria-label="Timezone" defaultValue="UTC" />
      </label>
      <button data-testid="preferences-save" onClick={onSubmitPreferences} type="button">
        Save preferences
      </button>
      {saved ? <p>Preferences saved</p> : null}
    </main>
  );
}
