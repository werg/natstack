import { useState } from "react";

export default function TestPanel() {
  const [count, setCount] = useState(0);

  return (
    <div style={{ padding: 24, fontFamily: "system-ui, sans-serif" }}>
      <h1>🧪 Test Panel</h1>
      <p>Hello from the test panel! It works.</p>
      <button
        onClick={() => setCount((c) => c + 1)}
        style={{
          padding: "8px 16px",
          fontSize: 16,
          borderRadius: 6,
          border: "1px solid #ccc",
          cursor: "pointer",
        }}
      >
        Clicked {count} times
      </button>
    </div>
  );
}
