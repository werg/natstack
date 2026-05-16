/**
 * Workerd-specific type augmentations.
 *
 * These extend the standard Response type with workerd-specific upgrade
 * metadata used by non-DO worker routes.
 */

interface ResponseInit {
  webSocket?: WebSocket;
}
