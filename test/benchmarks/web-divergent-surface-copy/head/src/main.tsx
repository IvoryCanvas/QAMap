import React from "react";
import { createRoot } from "react-dom/client";
import { SummaryPage } from "./pages/summary";
import { ConfirmationPage } from "./pages/confirmation";

const page = location.hash === "#confirmed" ? <ConfirmationPage /> : <SummaryPage />;
createRoot(document.getElementById("root")!).render(page);
