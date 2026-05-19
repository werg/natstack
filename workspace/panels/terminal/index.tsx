import { createRoot } from "react-dom/client";
import { TerminalApp } from "./TerminalApp.js";

const root = createRoot(document.getElementById("root") ?? document.body.appendChild(document.createElement("div")));
root.render(<TerminalApp />);
