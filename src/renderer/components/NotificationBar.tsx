/**
 * NotificationBar — centralized notification display in the shell chrome area.
 *
 * Renders between TitleBar and the panel viewport. Uses the SavePasswordBar
 * pattern: reports its height via `view.updateLayout({ notificationBarHeight })`
 * so the ViewManager shrinks the panel viewport to make room.
 *
 * Supports notification types: info/success/warning/error as auto-dismissing
 * toast banners. Consent prompts are handled by ConsentDialog.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { Flex, Text, Button, Badge } from "@radix-ui/themes";
import {
  InfoCircledIcon,
  CheckCircledIcon,
  ExclamationTriangleIcon,
  CrossCircledIcon,
  Cross2Icon,
  LockClosedIcon,
} from "@radix-ui/react-icons";
import { useShellEvent } from "../shell/useShellEvent";
import { view, notification } from "../shell/client";
import type { NotificationPayload } from "@natstack/shared/events";

/** Default TTLs by notification type (ms). 0 = no auto-dismiss. */
const DEFAULT_TTLS: Record<NotificationPayload["type"], number> = {
  info: 5000,
  success: 3000,
  warning: 8000,
  error: 0,
  consent: 0,
};

const TYPE_COLORS: Record<NotificationPayload["type"], string> = {
  info: "blue",
  success: "green",
  warning: "orange",
  error: "red",
  consent: "violet",
};

const TYPE_BG: Record<NotificationPayload["type"], string> = {
  info: "var(--blue-3)",
  success: "var(--green-3)",
  warning: "var(--orange-3)",
  error: "var(--red-3)",
  consent: "var(--violet-3)",
};

const TYPE_BORDER: Record<NotificationPayload["type"], string> = {
  info: "var(--blue-6)",
  success: "var(--green-6)",
  warning: "var(--orange-6)",
  error: "var(--red-6)",
  consent: "var(--violet-6)",
};

function TypeIcon({ type }: { type: NotificationPayload["type"] }) {
  switch (type) {
    case "info":
      return <InfoCircledIcon />;
    case "success":
      return <CheckCircledIcon />;
    case "warning":
      return <ExclamationTriangleIcon />;
    case "error":
      return <CrossCircledIcon />;
    case "consent":
      return <LockClosedIcon />;
  }
}

export function NotificationBar() {
  const [notifications, setNotifications] = useState<Map<string, NotificationPayload>>(new Map());
  const timerCleanups = useRef<Map<string, () => void>>(new Map());
  const barRef = useRef<HTMLDivElement>(null);


  // Handle incoming notifications
  useShellEvent(
    "notification:show",
    useCallback((payload: NotificationPayload) => {
      setNotifications((prev) => {
        const next = new Map(prev);
        next.set(payload.id, payload);
        return next;
      });
    }, []),
  );

  const dismissNotification = useCallback((id: string) => {
    setNotifications((prev) => {
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
    const cleanup = timerCleanups.current.get(id);
    if (cleanup) {
      cleanup();
      timerCleanups.current.delete(id);
    }
    // Report dismissal to server so waitForAction() resolves immediately
    // instead of hanging for the full timeout
    void notification.reportAction(id, "dismiss");
  }, []);

  // Handle dismiss requests
  useShellEvent(
    "notification:dismiss",
    useCallback((payload: { id: string }) => {
      dismissNotification(payload.id);
    }, [dismissNotification]),
  );

  const handleAction = useCallback(
    (notificationId: string, actionId: string) => {
      // Report action to main process via RPC service
      void notification.reportAction(notificationId, actionId);
      dismissNotification(notificationId);
    },
    [dismissNotification],
  );

  // Auto-dismiss timers
  useEffect(() => {
    for (const [id, notif] of notifications) {
      if (timerCleanups.current.has(id)) continue;
      const ttl = notif.ttl ?? DEFAULT_TTLS[notif.type];
      if (ttl <= 0) continue;

      const timer = setTimeout(() => {
        dismissNotification(id);
      }, ttl);
      const cleanup = () => {
        clearTimeout(timer);
        timerCleanups.current.delete(id);
      };
      timerCleanups.current.set(id, cleanup);
    }

    // Clean up timers for removed notifications
    for (const [id, cleanup] of timerCleanups.current) {
      if (!notifications.has(id)) {
        cleanup();
      }
    }
  }, [notifications, dismissNotification]);

  // Clean up all timers on unmount
  useEffect(() => {
    return () => {
      for (const cleanup of timerCleanups.current.values()) {
        cleanup();
      }
    };
  }, []);

  // Report bar height to layout system
  const isVisible = notifications.size > 0;
  useEffect(() => {
    if (!isVisible) {
      void view.updateLayout({ notificationBarHeight: 0 });
      return;
    }
    const el = barRef.current;
    if (!el) return;
    void view.updateLayout({ notificationBarHeight: el.offsetHeight });
    const observer = new ResizeObserver(([entry]) => {
      if (entry) void view.updateLayout({ notificationBarHeight: entry.contentRect.height });
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
      void view.updateLayout({ notificationBarHeight: 0 });
    };
  }, [isVisible, notifications.size]);

  if (!isVisible) return null;

  // Show the most recent notification (last added)
  const entries = Array.from(notifications.values());
  const current = entries[entries.length - 1]!;
  const queueCount = entries.length - 1;

  return (
    <div ref={barRef}>
      <ToastNotification
        notification={current}
        queueCount={queueCount}
        onAction={handleAction}
        onDismiss={dismissNotification}
      />
    </div>
  );
}

// ---- Toast (info/success/warning/error) ----

function ToastNotification({
  notification,
  queueCount,
  onAction,
  onDismiss,
}: {
  notification: NotificationPayload;
  queueCount: number;
  onAction: (id: string, actionId: string) => void;
  onDismiss: (id: string) => void;
}) {
  return (
    <Flex
      align="center"
      justify="between"
      px="3"
      py="2"
      gap="3"
      style={{
        backgroundColor: TYPE_BG[notification.type],
        borderBottom: `1px solid ${TYPE_BORDER[notification.type]}`,
        flexShrink: 0,
      }}
    >
      <Flex align="center" gap="2" style={{ flex: 1, minWidth: 0 }}>
        <TypeIcon type={notification.type} />
        <Text size="2" weight="bold" truncate>
          {notification.title}
        </Text>
        {notification.message && (
          <Text size="2" color="gray" truncate>
            {notification.message}
          </Text>
        )}
        {queueCount > 0 && (
          <Badge size="1" variant="soft">
            +{queueCount}
          </Badge>
        )}
      </Flex>
      <Flex gap="2" style={{ flexShrink: 0 }}>
        {notification.actions?.map((action) => (
          <Button
            key={action.id}
            size="1"
            variant={action.variant ?? "soft"}
            onClick={() => onAction(notification.id, action.id)}
          >
            {action.label}
          </Button>
        ))}
        <Button
          size="1"
          variant="ghost"
          aria-label="Dismiss notification"
          onClick={() => onDismiss(notification.id)}
        >
          <Cross2Icon />
        </Button>
      </Flex>
    </Flex>
  );
}

