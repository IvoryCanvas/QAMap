import { useState } from "react";

export default function ProfilePage() {
  const [displayName, setDisplayName] = useState("");

  return (
    <main>
      <h1>Profile</h1>
      <label>
        Display name
        <input
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
        />
      </label>
    </main>
  );
}
