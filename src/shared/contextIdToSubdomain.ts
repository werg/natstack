/**
 * Convert a contextId to a valid DNS subdomain label.
 *
 * Extracted as a standalone module with no Node.js dependencies so it can be
 * imported by both the main app (which uses Node.js `crypto` elsewhere in
 * panelIdUtils) and the React Native mobile app (where Metro cannot bundle
 * Node.js built-ins).
 *
 * Modern browsers (Chrome 73+, Firefox 84+) resolve *.localhost → 127.0.0.1
 * per the WHATWG URL Standard, giving each subdomain a distinct origin.
 */
export function contextIdToSubdomain(contextId: string): string {
  const label = contextId
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 63);
  return label || "default";
}
