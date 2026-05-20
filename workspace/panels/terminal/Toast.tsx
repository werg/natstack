import { Card, Text } from "@radix-ui/themes";
import { useCallback, useEffect, useState } from "react";

export interface PaneToast {
  id: number;
  title: string;
  message?: string;
}

export function useToast(): { toast: PaneToast | null; showToast(title: string, message?: string): void } {
  const [toast, setToast] = useState<PaneToast | null>(null);

  const showToast = useCallback((title: string, message?: string) => {
    setToast({ id: Date.now(), title, message });
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 1200);
    return () => clearTimeout(timer);
  }, [toast]);

  return { toast, showToast };
}

export function Toast(props: { toast: PaneToast | null }) {
  if (!props.toast) return null;
  return (
    <Card
      size="1"
      style={{
        position: "absolute",
        right: "var(--space-3)",
        bottom: "var(--space-3)",
        zIndex: 10,
        background: "var(--gray-1)",
        boxShadow: "var(--shadow-4)",
        transition: "opacity 150ms, transform 150ms",
      }}
    >
      <Text size="2" weight="medium">{props.toast.title}</Text>
      {props.toast.message ? <Text size="1" color="gray" as="div">{props.toast.message}</Text> : null}
    </Card>
  );
}
