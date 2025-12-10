/**
 * Chevron icon for collapsible sections.
 */
export function ChevronIcon({ direction }: { direction: "down" | "right" }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="none"
      style={{
        transform: direction === "down" ? "rotate(90deg)" : "rotate(0deg)",
        transition: "transform 0.15s ease",
      }}
    >
      <path d="M4.5 2L8.5 6L4.5 10" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}
