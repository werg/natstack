/**
 * tokens service method schemas.
 */

import { z } from "zod";
import type { CallerKind } from "../serviceDispatcher.js";
import type { MethodAccessDescriptor } from "../servicePolicy.js";
import { defineServiceMethods } from "../typedServiceClient.js";

// Access descriptors shared across the tokens methods. Bearer-token issuance and
// admin-token rotation are privileged operations, so every method is 'admin'
// sensitivity. The service-level `policy` (server/shell) stays the enforced
// caller gate; we omit `access.callers` here.
const TOKEN_READ_ACCESS: MethodAccessDescriptor = {
  sensitivity: "admin",
};
const TOKEN_CREATE_ACCESS: MethodAccessDescriptor = {
  sensitivity: "admin",
};
const TOKEN_ENSURE_ACCESS: MethodAccessDescriptor = {
  sensitivity: "admin",
};
const TOKEN_REVOKE_ACCESS: MethodAccessDescriptor = {
  sensitivity: "admin",
};
const TOKEN_ROTATE_ADMIN_ACCESS: MethodAccessDescriptor = {
  sensitivity: "admin",
};

export const tokensMethods = defineServiceMethods({
  create: {
    description:
      "Mint a fresh bearer token for a non-panel caller id with the given caller kind, replacing any existing token for that id.",
    args: z.tuple([z.string(), z.custom<CallerKind>()]),
    returns: z.string(),
    access: TOKEN_CREATE_ACCESS,
  },
  ensure: {
    description:
      "Return the existing bearer token for a caller id, minting one with the given caller kind only if none exists yet (idempotent).",
    args: z.tuple([z.string(), z.custom<CallerKind>()]),
    returns: z.string(),
    access: TOKEN_ENSURE_ACCESS,
  },
  revoke: {
    description:
      "Revoke the bearer token for a caller id; a no-op if no token is registered for it.",
    args: z.tuple([z.string()]),
    returns: z.void(),
    access: TOKEN_REVOKE_ACCESS,
  },
  get: {
    description: "Look up the current bearer token for a caller id, or null if none is registered.",
    args: z.tuple([z.string()]),
    returns: z.string().nullable(),
    access: TOKEN_READ_ACCESS,
  },
  rotateAdmin: {
    description:
      "Generate a new random admin token, persist it (when persistence is configured) before swapping it in, and return the new value.",
    args: z.tuple([]),
    returns: z.string(),
    access: TOKEN_ROTATE_ADMIN_ACCESS,
  },
});
