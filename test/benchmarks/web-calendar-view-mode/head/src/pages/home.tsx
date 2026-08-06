import { Calendar } from "lucide-react";

export function HomeView({ view, setView }) {
  return (
    <button
      aria-pressed={view === "calendar"}
      data-testid="calendar-view"
      onClick={() => setView("calendar")}
    >
      <Calendar />
      Calendar
    </button>
  );
}
