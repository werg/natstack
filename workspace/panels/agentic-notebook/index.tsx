import { NotebookAppWithProvider } from "./components/NotebookApp";

// Re-export the main component
export { NotebookAppWithProvider as NotebookApp };

/**
 * Default export for panel registration.
 * The panelId should be provided by the panel framework.
 */
export default function AgenticNotebook() {
  // In production, panelId would come from the panel registration context
  // For now, use a default ID
  const panelId = "default";

  return <NotebookAppWithProvider panelId={panelId} />;
}
