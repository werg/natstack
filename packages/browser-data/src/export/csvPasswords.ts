import type { ImportedPassword } from "../types.js";

function escapeCsvField(field: string): string {
  if (
    field.includes(",") ||
    field.includes('"') ||
    field.includes("\n") ||
    field.includes("\r")
  ) {
    return '"' + field.replace(/"/g, '""') + '"';
  }
  return field;
}

function extractOrigin(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.origin;
  } catch {
    return url;
  }
}

export function exportCsvPasswords(
  passwords: ImportedPassword[],
  format: "chrome" | "firefox",
): string {
  const lines: string[] = [];

  if (format === "chrome") {
    lines.push("url,username,password,name");
    for (const pw of passwords) {
      lines.push(
        [
          escapeCsvField(pw.url),
          escapeCsvField(pw.username),
          escapeCsvField(pw.password),
          escapeCsvField(extractOrigin(pw.url)),
        ].join(","),
      );
    }
  } else {
    lines.push("url,username,password,httpRealm");
    for (const pw of passwords) {
      lines.push(
        [
          escapeCsvField(pw.url),
          escapeCsvField(pw.username),
          escapeCsvField(pw.password),
          escapeCsvField(pw.realm ?? ""),
        ].join(","),
      );
    }
  }

  return lines.join("\n") + "\n";
}
