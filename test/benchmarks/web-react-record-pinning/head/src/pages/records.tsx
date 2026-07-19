import { useState } from "react";

type RecordItem = { title: string; pinned: boolean };

export function RecordsPage() {
  const [records, setRecords] = useState<RecordItem[]>([]);
  const [draft, setDraft] = useState("");
  const sortedRecords = [...records].sort((left, right) => Number(right.pinned) - Number(left.pinned));

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
            setRecords([...records, { title: draft.trim(), pinned: false }]);
            setDraft("");
          }
        }}
      >
        Add record
      </button>
      {sortedRecords.map((record) => (
        <article key={record.title}>
          <h2>{record.title}</h2>
          <button
            aria-label={record.pinned ? "Unpin record" : "Pin record"}
            data-testid="pin-record"
            type="button"
            onClick={() =>
              setRecords(records.map((item) => (
                item === record ? { ...item, pinned: !item.pinned } : item
              )))
            }
          >
            {record.pinned ? "Unpin" : "Pin"}
          </button>
          {record.pinned ? <p>Pinned record appears first</p> : null}
        </article>
      ))}
    </main>
  );
}
