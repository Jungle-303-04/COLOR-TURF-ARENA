import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";
import { FatalErrorBoundary } from "./components/FatalErrorBoundary";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <FatalErrorBoundary>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </FatalErrorBoundary>
  </StrictMode>,
);
