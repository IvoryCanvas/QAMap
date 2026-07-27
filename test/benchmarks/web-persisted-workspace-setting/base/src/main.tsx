import React, { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { DensityPage } from "./pages/density";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <DensityPage />
  </StrictMode>,
);
