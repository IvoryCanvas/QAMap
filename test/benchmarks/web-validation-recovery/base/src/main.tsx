import React, { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { FeedbackPage } from "./pages/feedback";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <FeedbackPage />
  </StrictMode>,
);
