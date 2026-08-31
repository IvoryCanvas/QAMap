import { useState } from "react";

export default function ReportsPage() {
  const [status, setStatus] = useState("Select a report");

  async function loadReport() {
    const response = await fetch("/api/reports/report-1");
    if (!response.ok) {
      setStatus("Report unavailable");
      return;
    }
    const report = await response.json();
    setStatus(report.state === "ready" ? "Report ready" : "Report pending");
  }

  return (
    <main>
      <h1>Reports</h1>
      <button data-testid="report-load" type="button" onClick={loadReport}>
        Load report
      </button>
      <p role="status">{status}</p>
    </main>
  );
}
