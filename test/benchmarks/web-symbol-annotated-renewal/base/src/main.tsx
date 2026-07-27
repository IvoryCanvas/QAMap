import React, { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import RenewalPage from "./pages/renewal";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RenewalPage />
  </StrictMode>,
);
