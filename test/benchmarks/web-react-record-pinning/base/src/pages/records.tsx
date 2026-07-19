import { useState } from "react";

export function RecordsPage() {
  const [records, setRecords] = useState<string[]>([]);
  const [draft, setDraft] = useState("");

  return (
    <main>
      <h1>Workspace records</h1>
      <input
        data-testid="record-input"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
      />
      <button
        data-testid="add-record"
        type="button"
        onClick={() => {
          if (draft.trim()) {
            setRecords([...records, draft.trim()]);
            setDraft("");
          }
        }}
      >
        Add record
      </button>
      {records.map((record) => (
        <article key={record}>
          <h2>{record}</h2>
        </article>
      ))}
    </main>
  );
}
