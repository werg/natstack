import { describe, expect, it, vi } from "vitest";
import type { StoredCookie } from "@natstack/browser-data";

vi.mock("electron", () => ({
  session: {
    fromPartition: vi.fn(),
  },
}));

import { toElectronCookie } from "./browserSessionSync.js";

function storedCookie(partial: Partial<StoredCookie>): StoredCookie {
  return {
    id: 1,
    name: "sid",
    value: "value",
    domain: "example.com",
    host_only: 1,
    path: "/",
    expiration_date: null,
    secure: 1,
    http_only: 1,
    same_site: "lax",
    source_scheme: "secure",
    source_port: 443,
    source_browser: null,
    created_at: 1,
    last_accessed: null,
    ...partial,
  };
}

describe("toElectronCookie", () => {
  it("preserves host-only cookies by omitting domain", () => {
    expect(toElectronCookie(storedCookie({ host_only: 1 }))).not.toHaveProperty("domain");
  });

  it("sets domain for domain cookies", () => {
    expect(toElectronCookie(storedCookie({ host_only: 0, domain: ".example.com" }))).toMatchObject({
      domain: ".example.com",
    });
  });
});
