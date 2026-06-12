import * as fs from "node:fs/promises";
import * as path from "node:path";
import { JSON_FLAG, type CliCommand, type ParsedInvocation } from "../commandTable.js";
import { jsonMode, printError, printResult, UsageError } from "../output.js";
import { resolveSessionScope, SESSION_FLAG } from "./sessionContext.js";

/**
 * `natstack fs ...` — filesystem operations inside an agent session's context
 * folder, via the server `fs` service. Shell callers pass the contextId as
 * the explicit first argument of every fs.* call (fsService convention).
 */

/** JSON-RPC binary envelope used by fs.readFile/writeFile (see fsService.ts). */
interface BinaryEnvelope {
  __bin: true;
  data: string; // base64
}

function isBinaryEnvelope(value: unknown): value is BinaryEnvelope {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { __bin?: unknown }).__bin === true &&
    typeof (value as { data?: unknown }).data === "string"
  );
}

function encodeBinary(buf: Buffer): BinaryEnvelope {
  return { __bin: true, data: buf.toString("base64") };
}

interface DirentEntry {
  name: string;
  _isFile: boolean;
  _isDirectory: boolean;
  _isSymbolicLink: boolean;
}

interface GrepMatch {
  file: string;
  lineNumber: number;
  line: string;
  before: string[];
  after: string[];
}

interface GrepResult {
  matches: GrepMatch[];
  matchCount: number;
  truncated: boolean;
}

function requirePositional(inv: ParsedInvocation, index: number, label: string): string {
  const value = inv.positionals[index];
  if (!value) throw new UsageError(`missing ${label}`);
  return value;
}

function positiveInt(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new UsageError(`${flag} must be a positive integer`);
  }
  return parsed;
}

async function readStdin(): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

async function ls(inv: ParsedInvocation): Promise<number> {
  const json = jsonMode(inv.flags["json"] === true);
  try {
    const target = inv.positionals[0] ?? "/";
    const { client, contextId } = resolveSessionScope(inv);
    const entries = await client.call<DirentEntry[]>("fs.readdir", [
      contextId,
      target,
      { withFileTypes: true, recursive: inv.flags["recursive"] === true },
    ]);
    const rows = entries.map((entry) => ({
      name: entry.name,
      type: entry._isDirectory ? "dir" : entry._isSymbolicLink ? "symlink" : "file",
    }));
    printResult(rows, {
      json,
      human: () => {
        for (const row of rows) console.log(row.type === "dir" ? `${row.name}/` : row.name);
      },
    });
    return 0;
  } catch (error) {
    return printError(error, { json });
  }
}

async function read(inv: ParsedInvocation): Promise<number> {
  const json = jsonMode(inv.flags["json"] === true);
  try {
    const target = requirePositional(inv, 0, "PATH");
    const { client, contextId } = resolveSessionScope(inv);
    const result = await client.call<unknown>("fs.readFile", [contextId, target]);
    if (!isBinaryEnvelope(result)) {
      throw new Error("unexpected fs.readFile response (missing binary envelope)");
    }
    const buf = Buffer.from(result.data, "base64");
    const out = typeof inv.flags["out"] === "string" ? inv.flags["out"] : undefined;
    if (out) {
      await fs.writeFile(out, buf);
      printResult(
        { path: target, bytes: buf.length, out },
        { json, human: () => console.log(`wrote ${buf.length} bytes to ${out}`) }
      );
    } else {
      // Raw content goes to stdout verbatim (binary-safe), regardless of --json.
      process.stdout.write(buf);
    }
    return 0;
  } catch (error) {
    return printError(error, { json });
  }
}

async function write(inv: ParsedInvocation): Promise<number> {
  const json = jsonMode(inv.flags["json"] === true);
  try {
    const target = requirePositional(inv, 0, "PATH");
    const fromFile =
      typeof inv.flags["from-file"] === "string" ? inv.flags["from-file"] : undefined;
    const contentFlag = typeof inv.flags["content"] === "string" ? inv.flags["content"] : undefined;
    const contentPositional = inv.positionals[1];
    const sources = [fromFile, contentFlag, contentPositional].filter(
      (source) => source !== undefined
    );
    if (sources.length > 1) {
      throw new UsageError(
        "content was provided more than once (CONTENT positional, --content, and --from-file are mutually exclusive)"
      );
    }
    const content = contentFlag ?? contentPositional;
    if (content === undefined && fromFile === undefined && process.stdin.isTTY) {
      throw new UsageError(
        "no content: pass CONTENT, --content, --from-file, or pipe data on stdin"
      );
    }
    const data =
      fromFile !== undefined
        ? await fs.readFile(fromFile)
        : content !== undefined
          ? Buffer.from(content, "utf8")
          : await readStdin();
    const { client, contextId } = resolveSessionScope(inv);
    if (inv.flags["parents"] === true) {
      const dir = path.posix.dirname(target);
      if (dir && dir !== "/" && dir !== ".") {
        await client.call("fs.mkdir", [contextId, dir, { recursive: true }]);
      }
    }
    const append = inv.flags["append"] === true;
    await client.call(append ? "fs.appendFile" : "fs.writeFile", [
      contextId,
      target,
      encodeBinary(data),
    ]);
    printResult(
      { path: target, bytes: data.length, appended: append },
      {
        json,
        human: () =>
          console.log(`${append ? "appended" : "wrote"} ${data.length} bytes to ${target}`),
      }
    );
    return 0;
  } catch (error) {
    return printError(error, { json });
  }
}

async function rm(inv: ParsedInvocation): Promise<number> {
  const json = jsonMode(inv.flags["json"] === true);
  try {
    const target = requirePositional(inv, 0, "PATH");
    const { client, contextId } = resolveSessionScope(inv);
    await client.call("fs.rm", [contextId, target, { recursive: inv.flags["recursive"] === true }]);
    printResult({ removed: target }, { json, human: () => console.log(`removed ${target}`) });
    return 0;
  } catch (error) {
    return printError(error, { json });
  }
}

async function mv(inv: ParsedInvocation): Promise<number> {
  const json = jsonMode(inv.flags["json"] === true);
  try {
    const src = requirePositional(inv, 0, "SRC");
    const dest = requirePositional(inv, 1, "DEST");
    const { client, contextId } = resolveSessionScope(inv);
    await client.call("fs.rename", [contextId, src, dest]);
    printResult({ from: src, to: dest }, { json, human: () => console.log(`${src} -> ${dest}`) });
    return 0;
  } catch (error) {
    return printError(error, { json });
  }
}

async function cp(inv: ParsedInvocation): Promise<number> {
  const json = jsonMode(inv.flags["json"] === true);
  try {
    const src = requirePositional(inv, 0, "SRC");
    const dest = requirePositional(inv, 1, "DEST");
    const { client, contextId } = resolveSessionScope(inv);
    await client.call("fs.copyFile", [contextId, src, dest]);
    printResult({ from: src, to: dest }, { json, human: () => console.log(`${src} -> ${dest}`) });
    return 0;
  } catch (error) {
    return printError(error, { json });
  }
}

async function mkdir(inv: ParsedInvocation): Promise<number> {
  const json = jsonMode(inv.flags["json"] === true);
  try {
    const target = requirePositional(inv, 0, "PATH");
    const { client, contextId } = resolveSessionScope(inv);
    await client.call("fs.mkdir", [
      contextId,
      target,
      { recursive: inv.flags["parents"] === true },
    ]);
    printResult({ created: target }, { json, human: () => console.log(`created ${target}`) });
    return 0;
  } catch (error) {
    return printError(error, { json });
  }
}

async function stat(inv: ParsedInvocation): Promise<number> {
  const json = jsonMode(inv.flags["json"] === true);
  try {
    const target = requirePositional(inv, 0, "PATH");
    const { client, contextId } = resolveSessionScope(inv);
    const result = await client.call("fs.stat", [contextId, target]);
    printResult(result, { json });
    return 0;
  } catch (error) {
    return printError(error, { json });
  }
}

/** Render a GrepResult in classic grep style (`file:line: text`, `-` context). */
export function renderGrepMatches(result: GrepResult): string[] {
  const lines: string[] = [];
  for (const match of result.matches) {
    let lineNo = match.lineNumber - match.before.length;
    for (const before of match.before) lines.push(`${match.file}:${lineNo++}- ${before}`);
    lines.push(`${match.file}:${match.lineNumber}: ${match.line}`);
    lineNo = match.lineNumber + 1;
    for (const after of match.after) lines.push(`${match.file}:${lineNo++}- ${after}`);
  }
  if (result.truncated) lines.push(`(truncated at ${result.matchCount} matches)`);
  return lines;
}

async function grep(inv: ParsedInvocation): Promise<number> {
  const json = jsonMode(inv.flags["json"] === true);
  try {
    const pattern = requirePositional(inv, 0, "PATTERN");
    const options: {
      path?: string;
      glob?: string;
      caseInsensitive?: boolean;
      contextLines?: number;
      maxMatches?: number;
    } = {};
    if (inv.positionals[1]) options.path = inv.positionals[1];
    if (typeof inv.flags["glob"] === "string") options.glob = inv.flags["glob"];
    if (inv.flags["ignore-case"] === true) options.caseInsensitive = true;
    if (typeof inv.flags["context"] === "string") {
      options.contextLines = positiveInt(inv.flags["context"], "-C/--context");
    }
    if (typeof inv.flags["max"] === "string") {
      options.maxMatches = positiveInt(inv.flags["max"], "--max");
    }
    const { client, contextId } = resolveSessionScope(inv);
    const result = await client.call<GrepResult>("fs.grep", [contextId, pattern, options]);
    printResult(result, {
      json,
      human: () => {
        for (const line of renderGrepMatches(result)) console.log(line);
      },
    });
    return 0;
  } catch (error) {
    return printError(error, { json });
  }
}

async function glob(inv: ParsedInvocation): Promise<number> {
  const json = jsonMode(inv.flags["json"] === true);
  try {
    const pattern = requirePositional(inv, 0, "PATTERN");
    const options: { path?: string } = {};
    if (inv.positionals[1]) options.path = inv.positionals[1];
    const { client, contextId } = resolveSessionScope(inv);
    const files = await client.call<string[]>("fs.glob", [contextId, pattern, options]);
    printResult(files, {
      json,
      human: () => {
        for (const file of files) console.log(file);
      },
    });
    return 0;
  } catch (error) {
    return printError(error, { json });
  }
}

export const fsCommands: CliCommand[] = [
  {
    group: "fs",
    name: "ls",
    summary: "List a directory in the session context",
    usage: "natstack fs ls [PATH] [-R]",
    flags: [
      {
        name: "recursive",
        short: "R",
        takesValue: false,
        description: "Recurse into subdirectories",
      },
      SESSION_FLAG,
      JSON_FLAG,
    ],
    run: ls,
  },
  {
    group: "fs",
    name: "read",
    summary: "Print a file (binary-safe) or save it locally",
    usage: "natstack fs read PATH [--out FILE]",
    flags: [
      { name: "out", takesValue: true, description: "Write content to a local file" },
      SESSION_FLAG,
      JSON_FLAG,
    ],
    run: read,
  },
  {
    group: "fs",
    name: "write",
    summary: "Write a file from CONTENT, --content, --from-file, or stdin",
    usage:
      "natstack fs write PATH [CONTENT] [--content TEXT | --from-file F] [--append] [--parents]",
    flags: [
      { name: "from-file", takesValue: true, description: "Read content from a local file" },
      { name: "content", takesValue: true, description: "Literal content" },
      { name: "append", takesValue: false, description: "Append instead of overwrite" },
      { name: "parents", takesValue: false, description: "Create parent directories first" },
      SESSION_FLAG,
      JSON_FLAG,
    ],
    run: write,
  },
  {
    group: "fs",
    name: "rm",
    summary: "Remove a file or directory",
    usage: "natstack fs rm PATH [-r]",
    flags: [
      {
        name: "recursive",
        short: "r",
        takesValue: false,
        description: "Remove directories recursively",
      },
      SESSION_FLAG,
      JSON_FLAG,
    ],
    run: rm,
  },
  {
    group: "fs",
    name: "mv",
    summary: "Move/rename a file or directory",
    usage: "natstack fs mv SRC DEST",
    flags: [SESSION_FLAG, JSON_FLAG],
    run: mv,
  },
  {
    group: "fs",
    name: "cp",
    summary: "Copy a file",
    usage: "natstack fs cp SRC DEST",
    flags: [SESSION_FLAG, JSON_FLAG],
    run: cp,
  },
  {
    group: "fs",
    name: "mkdir",
    summary: "Create a directory",
    usage: "natstack fs mkdir PATH [-p]",
    flags: [
      { name: "parents", short: "p", takesValue: false, description: "Create parent directories" },
      SESSION_FLAG,
      JSON_FLAG,
    ],
    run: mkdir,
  },
  {
    group: "fs",
    name: "stat",
    summary: "Stat a file or directory",
    usage: "natstack fs stat PATH",
    flags: [SESSION_FLAG, JSON_FLAG],
    run: stat,
  },
  {
    group: "fs",
    name: "grep",
    summary: "Search file contents in the session context",
    usage: "natstack fs grep PATTERN [PATH] [-i] [--glob G] [-C N] [--max N]",
    flags: [
      {
        name: "ignore-case",
        short: "i",
        takesValue: false,
        description: "Case-insensitive search",
      },
      { name: "glob", takesValue: true, description: "Filter candidate files by glob" },
      {
        name: "context",
        short: "C",
        takesValue: true,
        description: "Context lines around matches",
      },
      { name: "max", takesValue: true, description: "Stop after N matches" },
      SESSION_FLAG,
      JSON_FLAG,
    ],
    run: grep,
  },
  {
    group: "fs",
    name: "glob",
    summary: "Find files by glob pattern (mtime-sorted)",
    usage: "natstack fs glob PATTERN [PATH]",
    flags: [SESSION_FLAG, JSON_FLAG],
    run: glob,
  },
];
