import React, { useState, useEffect, useRef } from "react";

type HLJSApi = typeof import("highlight.js/lib/core").default;
let hljsInstance: HLJSApi | null = null;
let hljsPromise: Promise<HLJSApi> | null = null;
async function getHljs(): Promise<HLJSApi> {
  if (hljsInstance) return hljsInstance;
  if (!hljsPromise) {
    hljsPromise = Promise.all([
      import("highlight.js/lib/core"),
      import("highlight.js/lib/languages/typescript"),
    ]).then(([core, ts]) => {
      hljsInstance = core.default;
      hljsInstance.registerLanguage("typescript", ts.default);
      return hljsInstance;
    });
  }
  return hljsPromise;
}

/** Syntax-highlighted TypeScript code preview with lazy-loaded highlight.js. */
export function CodePreview({ code }: { code: string }) {
  const ref = useRef<HTMLElement>(null);
  const [highlighted, setHighlighted] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getHljs().then((hljs) => {
      if (cancelled) return;
      const result = hljs.highlight(code, { language: "typescript" });
      setHighlighted(result.value);
    });
    return () => { cancelled = true; };
  }, [code]);

  return (
    <pre className="ns-codeblock" style={{ margin: 0, maxHeight: 400, overflow: "auto", borderRadius: 4, fontSize: "12px" }}>
      {highlighted ? (
        <code ref={ref} className="hljs language-typescript" dangerouslySetInnerHTML={{ __html: highlighted }} />
      ) : (
        <code style={{ whiteSpace: "pre-wrap" }}>{code}</code>
      )}
    </pre>
  );
}
