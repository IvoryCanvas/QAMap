import { useState } from "react";

export function RecordsPage() {
  const [isPinned, setPinned] = useState(false);

  return (
    <main>
      <h1>Workspace records</h1>
      <article>
        <h2>Quarterly plan</h2>
        <button
          aria-label={isPinned ? "Unpin record" : "Pin record"}
          data-testid="pin-record"
          type="button"
          onClick={() => setPinned((current) => !current)}
        >
          {isPinned ? "Unpin" : "Pin"}
        </button>
        {isPinned ? <p>Pinned record appears first</p> : null}
      </article>
    </main>
  );
}
