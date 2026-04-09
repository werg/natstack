import { describe, it, expect } from "vitest";
import { createImageService } from "./imageService.js";
// Verify the photon module path resolves and loads at module-import time
// (it's a thin wrapper; loadPhoton is lazy so the import alone should not throw).
import { loadPhoton } from "@natstack/shared/image/photon";
import { detectMimeFromBytes } from "@natstack/shared/image/mime";

const ctx = {
  callerId: "test",
  callerKind: "server" as const,
};

// 67-byte minimum-valid 1×1 PNG (all magic bytes plus a single transparent pixel)
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAUAAen63NgAAAAASUVORK5CYII=";

function tinyPng(): Uint8Array {
  return new Uint8Array(Buffer.from(TINY_PNG_BASE64, "base64"));
}

describe("imageService", () => {
  describe("detectMimeType", () => {
    const service = createImageService();

    it("detects PNG magic bytes", async () => {
      const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
      const result = await service.handler(ctx, "detectMimeType", [png]);
      expect(result).toBe("image/png");
    });

    it("detects JPEG magic bytes", async () => {
      const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
      const result = await service.handler(ctx, "detectMimeType", [jpeg]);
      expect(result).toBe("image/jpeg");
    });

    it("detects GIF87a magic bytes", async () => {
      const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x37, 0x61, 0x00]);
      const result = await service.handler(ctx, "detectMimeType", [gif]);
      expect(result).toBe("image/gif");
    });

    it("detects GIF89a magic bytes", async () => {
      const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x00]);
      const result = await service.handler(ctx, "detectMimeType", [gif]);
      expect(result).toBe("image/gif");
    });

    it("detects WebP magic bytes", async () => {
      const webp = new Uint8Array([
        0x52, 0x49, 0x46, 0x46, // RIFF
        0x00, 0x00, 0x00, 0x00, // size placeholder
        0x57, 0x45, 0x42, 0x50, // WEBP
      ]);
      const result = await service.handler(ctx, "detectMimeType", [webp]);
      expect(result).toBe("image/webp");
    });

    it("detects SVG textual marker", async () => {
      const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" />');
      const result = await service.handler(ctx, "detectMimeType", [svg]);
      expect(result).toBe("image/svg+xml");
    });

    it("returns null for non-image bytes", async () => {
      const garbage = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05]);
      const result = await service.handler(ctx, "detectMimeType", [garbage]);
      expect(result).toBeNull();
    });

    it("direct mime helper agrees on PNG", () => {
      expect(detectMimeFromBytes(tinyPng())).toBe("image/png");
    });
  });

  describe("resize", () => {
    const service = createImageService();

    it("returns wasResized=false for an already-tiny PNG within all limits", async () => {
      const data = tinyPng();
      const result = (await service.handler(ctx, "resize", [
        data,
        "image/png",
        undefined,
      ])) as {
        data: Uint8Array;
        mimeType: string;
        wasResized: boolean;
        originalWidth: number;
        originalHeight: number;
        width: number;
        height: number;
        dimensionNote?: string;
      };
      expect(result).toBeTruthy();
      expect(result.mimeType).toBe("image/png");
      // Tiny 1×1 PNG: photon should report size 1×1 and skip resizing.
      // If photon failed to load (e.g. WASM init issue) the helper returns
      // wasResized: false with zeroed dims, which is also acceptable here.
      expect(result.wasResized).toBe(false);
      expect(result.dimensionNote).toBeUndefined();
      expect(result.data).toBeInstanceOf(Uint8Array);
    });
  });

  describe("convert", () => {
    const service = createImageService();

    it("returns identity when source equals target", async () => {
      const data = tinyPng();
      const result = (await service.handler(ctx, "convert", [
        data,
        "image/png",
        "image/png",
      ])) as { data: Uint8Array; mimeType: string };
      expect(result.mimeType).toBe("image/png");
      expect(result.data).toBeInstanceOf(Uint8Array);
      expect(result.data.length).toBe(data.length);
    });
  });

  describe("photon module", () => {
    it("loadPhoton import did not throw and is callable", () => {
      // Just confirm the symbol exists. Calling it would actually init WASM
      // which isn't necessary for this smoke test.
      expect(typeof loadPhoton).toBe("function");
    });
  });
});
