const TRANSCRIPT_CONTENT_TYPES = new Set([
  "action",
  "error",
  "feedback_custom",
  "feedback_form",
  "image",
  "inline_ui",
  "text",
  "thinking",
  "toolCall",
]);

export interface TranscriptRouteWire {
  type?: string;
  contentType?: string;
}

export function isTranscriptContentType(contentType: string | undefined): boolean {
  return contentType === undefined || TRANSCRIPT_CONTENT_TYPES.has(contentType);
}

export function isTranscriptWireMessage(wire: TranscriptRouteWire): boolean {
  return wire.type === "message" && isTranscriptContentType(wire.contentType);
}
