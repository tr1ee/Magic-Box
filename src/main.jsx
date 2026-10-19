import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import StartupExperience from "./components/StartupExperience.jsx";
import "./styles.css";

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <StartupExperience><App /></StartupExperience>
  </StrictMode>
);
