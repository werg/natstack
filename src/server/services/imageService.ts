/**
 * imageService — server-side image processing.
 *
 * Wraps the ported pi-coding-agent image utilities (image-resize.ts,
 * image-convert.ts, mime.ts) and exposes them as a NatStack service so
 * panels, workers, and the harness can resize/convert/sniff image bytes
 * without bundling photon-node into workerd. The DO sends bytes via RPC,
 * the server crunches them with the WASM module, and bytes come back.
 */
import { z } from "zod";
import type { ServiceDefinition } from "@natstack/shared/serviceDefinition";
import {
  resizeImage,
  formatDimensionNote,
  type ImageResizeOptions,
} from "@natstack/shared/image/image-resize";
import { convertImage } from "@natstack/shared/image/image-convert";
import { detectMimeFromBytes } from "@natstack/shared/image/mime";

const ResizeOptionsSchema = z
  .object({
    maxWidth: z.number().optional(),
    maxHeight: z.number().optional(),
    maxBytes: z.number().optional(),
    jpegQuality: z.number().optional(),
  })
  .optional();

/** Coerce arbitrary RPC payloads (Buffer/Uint8Array/array/base64/BinaryEnvelope)
 *  into a Uint8Array. The wire layer may encode binary data as:
 *  - Raw Uint8Array/Buffer (in-process or direct dispatch)
 *  - BinaryEnvelope: `{ __bin: true, data: "base64..." }` (HTTP RPC bridge)
 *  - Plain base64 string
 *  - Number array */
function toUint8Array(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    // BinaryEnvelope from RPC wire layer: { __bin: true, data: "base64..." }
    if (obj["__bin"] === true && typeof obj["data"] === "string") {
      return new Uint8Array(Buffer.from(obj["data"] as string, "base64"));
    }
    // JSON.stringify(Buffer) produces: { type: "Buffer", data: [72, 101, ...] }
    if (obj["type"] === "Buffer" && Array.isArray(obj["data"])) {
      return new Uint8Array(obj["data"] as number[]);
    }
    // ArrayBuffer view (e.g., DataView or typed array passed by reference)
    if ("buffer" in obj && (obj as any).buffer instanceof ArrayBuffer) {
      const v = obj as { buffer: ArrayBuffer; byteOffset?: number; byteLength?: number };
      return new Uint8Array(v.buffer, v.byteOffset ?? 0, v.byteLength ?? v.buffer.byteLength);
    }
  }
  if (Array.isArray(value)) return new Uint8Array(value as number[]);
  if (typeof value === "string") return new Uint8Array(Buffer.from(value, "base64"));
  throw new Error("imageService: expected binary data (Uint8Array/Buffer)");
}

export interface ImageResizeResult {
  data: Uint8Array;
  mimeType: string;
  width: number;
  height: number;
  originalWidth: number;
  originalHeight: number;
  wasResized: boolean;
  dimensionNote?: string;
}

export interface ImageConvertResult {
  data: Uint8Array;
  mimeType: string;
}

export function createImageService(): ServiceDefinition {
  return {
    name: "image",
    description: "Server-side image processing (resize, convert, mime detect)",
    policy: { allowed: ["shell", "panel", "worker", "server"] },
    methods: {
      resize: {
        description: "Resize image bytes to fit within dimension/byte limits",
        args: z.tuple([z.unknown(), z.string(), ResizeOptionsSchema]),
      },
      convert: {
        description: "Convert image bytes between formats (PNG/JPEG/WebP)",
        args: z.tuple([z.unknown(), z.string(), z.string()]),
      },
      detectMimeType: {
        description: "Detect supported image MIME type from raw bytes",
        args: z.tuple([z.unknown()]),
      },
    },
    handler: async (_ctx, method, args) => {
      switch (method) {
        case "resize": {
          const [rawData, mimeType, options] = args as [
            unknown,
            string,
            ImageResizeOptions | undefined,
          ];
          const data = toUint8Array(rawData);
          const base64 = Buffer.from(data).toString("base64");
          const result = await resizeImage(
            { type: "image", mimeType, data: base64 },
            options,
          );
          const out: ImageResizeResult = {
            data: new Uint8Array(Buffer.from(result.data, "base64")),
            mimeType: result.mimeType,
            originalWidth: result.originalWidth,
            originalHeight: result.originalHeight,
            width: result.width,
            height: result.height,
            wasResized: result.wasResized,
          };
          const note = formatDimensionNote(result);
          if (note !== undefined) out.dimensionNote = note;
          return out;
        }
        case "convert": {
          const [rawData, sourceMimeType, targetMimeType] = args as [
            unknown,
            string,
            string,
          ];
          const data = toUint8Array(rawData);
          const result = await convertImage(data, sourceMimeType, targetMimeType);
          if (!result) {
            throw new Error(
              `imageService.convert: failed to convert ${sourceMimeType} → ${targetMimeType}`,
            );
          }
          const out: ImageConvertResult = {
            data: result.data,
            mimeType: result.mimeType,
          };
          return out;
        }
        case "detectMimeType": {
          const [rawData] = args as [unknown];
          const data = toUint8Array(rawData);
          return detectMimeFromBytes(data);
        }
        default:
          throw new Error(`Unknown image method: ${method}`);
      }
    },
  };
}
