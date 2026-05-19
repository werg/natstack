export interface ParsedNotification {
  title?: string;
  message: string;
}

const oscPattern = /\x1b\](9;([^\x07]*)|99;(?:[^;\x07]*;)*([^\x07]*)|777;notify;([^;\x07]*);([^\x07]*))\x07/g;

export function parseNotifications(data: string): ParsedNotification[] {
  const out: ParsedNotification[] = [];
  for (const match of data.matchAll(oscPattern)) {
    if (match[2]) out.push({ message: match[2] });
    else if (match[3]) out.push({ message: match[3] });
    else if (match[4] || match[5]) out.push({ title: match[4], message: match[5] ?? match[4] ?? "" });
  }
  return out;
}
