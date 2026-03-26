import { useState, useEffect, useCallback, useRef } from "react";
import { Flex, Text, Button } from "@radix-ui/themes";
import { useShellEvent } from "../shell/useShellEvent";
import { autofill, view } from "../shell/client";

interface SavePromptData {
  panelId: string;
  origin: string;
  username: string;
  isUpdate: boolean;
}

interface SavePasswordBarProps {
  visiblePanelId: string | null;
}

export function SavePasswordBar({ visiblePanelId }: SavePasswordBarProps) {
  // Map of panelId -> prompt data; supports background panels queueing prompts
  const [prompts, setPrompts] = useState<Map<string, SavePromptData>>(new Map());
  const [confirmed, setConfirmed] = useState(false);

  useShellEvent(
    "autofill:save-prompt",
    useCallback(
      (data: SavePromptData) => {
        setConfirmed(false);
        setPrompts((prev) => {
          const next = new Map(prev);
          next.set(data.panelId, data);
          return next;
        });
      },
      [],
    ),
  );

  // The prompt for the currently visible panel (if any)
  const prompt = visiblePanelId ? prompts.get(visiblePanelId) ?? null : null;

  // Auto-dismiss each prompt after 60 seconds from when it was created
  // We track active timers per panelId
  const timerCleanups = useRef<Map<string, () => void>>(new Map());

  useEffect(() => {
    for (const [panelId, _data] of prompts) {
      if (timerCleanups.current.has(panelId)) continue; // already has a timer
      const timer = setTimeout(() => {
        void autofill.confirmSave(panelId, "dismiss").catch((err: unknown) => console.warn("[SavePasswordBar] Dismiss failed:", err));
        setPrompts((prev) => {
          const next = new Map(prev);
          next.delete(panelId);
          return next;
        });
        timerCleanups.current.delete(panelId);
      }, 60000);
      const cleanup = () => { clearTimeout(timer); timerCleanups.current.delete(panelId); };
      timerCleanups.current.set(panelId, cleanup);
    }

    // Clean up timers for removed prompts
    for (const [panelId, cleanup] of timerCleanups.current) {
      if (!prompts.has(panelId)) {
        cleanup();
      }
    }
  }, [prompts]);

  // Clean up all timers on unmount
  useEffect(() => {
    return () => {
      for (const cleanup of timerCleanups.current.values()) {
        cleanup();
      }
    };
  }, []);

  const barRef = useRef<HTMLDivElement>(null);

  // Report bar height to layout system so browser view shrinks to make room
  const isBarVisible = (prompt !== null) || confirmed;
  useEffect(() => {
    if (!isBarVisible) {
      void view.updateLayout({ saveBarHeight: 0 });
      return;
    }
    const el = barRef.current;
    if (el) {
      void view.updateLayout({ saveBarHeight: el.offsetHeight });
    }
    return () => { void view.updateLayout({ saveBarHeight: 0 }); };
  }, [isBarVisible]);

  // Show confirmation briefly then hide
  useEffect(() => {
    if (!confirmed) return;
    const timer = setTimeout(() => {
      setConfirmed(false);
    }, 1500);
    return () => clearTimeout(timer);
  }, [confirmed]);

  if (confirmed) {
    return (
      <Flex
        ref={barRef}
        align="center"
        px="3"
        py="2"
        style={{
          backgroundColor: "var(--green-3)",
          borderBottom: "1px solid var(--green-6)",
          flexShrink: 0,
        }}
      >
        <Text size="2" color="green">Password saved</Text>
      </Flex>
    );
  }

  if (!prompt) return null;

  const removePrompt = (panelId: string) => {
    setPrompts((prev) => {
      const next = new Map(prev);
      next.delete(panelId);
      return next;
    });
  };

  const handleSave = () => {
    void autofill.confirmSave(prompt.panelId, "save").catch((err: unknown) => console.error("[SavePasswordBar] Save failed:", err));
    removePrompt(prompt.panelId);
    setConfirmed(true);
  };

  const handleNever = () => {
    void autofill.confirmSave(prompt.panelId, "never").catch((err: unknown) => console.warn("[SavePasswordBar] Never-save failed:", err));
    removePrompt(prompt.panelId);
  };

  const handleDismiss = () => {
    void autofill.confirmSave(prompt.panelId, "dismiss").catch((err: unknown) => console.warn("[SavePasswordBar] Dismiss failed:", err));
    removePrompt(prompt.panelId);
  };

  let hostname: string;
  try {
    hostname = new URL(prompt.origin).hostname;
  } catch {
    hostname = prompt.origin;
  }

  const message = prompt.isUpdate
    ? `Update password for ${prompt.username} on ${hostname}?`
    : `Save password for ${prompt.username} on ${hostname}?`;

  return (
    <Flex
      ref={barRef}
      align="center"
      justify="between"
      px="3"
      py="2"
      gap="3"
      style={{
        backgroundColor: "var(--accent-3)",
        borderBottom: "1px solid var(--accent-6)",
        flexShrink: 0,
      }}
    >
      <Text size="2" style={{ flex: 1, minWidth: 0 }} truncate>
        {message}
      </Text>
      <Flex gap="2" style={{ flexShrink: 0 }}>
        <Button size="1" variant="solid" onClick={handleSave}>
          {prompt.isUpdate ? "Update" : "Save"}
        </Button>
        <Button size="1" variant="soft" onClick={handleNever}>
          Never
        </Button>
        <Button size="1" variant="ghost" onClick={handleDismiss}>
          Dismiss
        </Button>
      </Flex>
    </Flex>
  );
}
