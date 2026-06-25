import { UsageError } from "./output.js";

/**
 * Declarative CLI command table. Each command belongs to a group
 * (`natstack <group> <name> ...`) and declares its flags up front so a
 * single parser drives dispatch, help text, and unknown-flag rejection.
 *
 * Extension point: later command groups (fs, git, eval, ...) export a
 * `CliCommand[]` and get appended to the registry in client.ts.
 */

export interface FlagSpec {
  /** Flag name without leading dashes, e.g. "ttl-ms". */
  name: string;
  /** Optional single-letter alias, e.g. "R" for `-R`. */
  short?: string;
  /** Whether the flag consumes the next argv token as its value. */
  takesValue: boolean;
  /**
   * Whether the flag may be repeated, accumulating every value (e.g.
   * `--repo a --repo b`). Repeated values are retrieved via
   * `ParsedInvocation.flagsMulti(name)`; `flags[name]` holds the last value.
   * Only meaningful with `takesValue: true`.
   */
  multiple?: boolean;
  description?: string;
}

export interface ParsedInvocation {
  positionals: string[];
  flags: Record<string, string | boolean>;
  /** Every value collected for a `multiple: true` value flag, in order. */
  flagsMulti(name: string): string[];
}

export interface CliCommand {
  group: string;
  name: string;
  aliases?: string[];
  summary: string;
  usage?: string;
  flags?: FlagSpec[];
  /**
   * Script-runner commands forward argv verbatim to an external script and
   * skip flag validation entirely.
   */
  passthrough?: boolean;
  /**
   * Forward --help/-h to the passthrough script instead of rendering the
   * registry usage — for scripts that own a richer help screen (e.g. the
   * pair server, which documents the resolved server entry).
   */
  passthroughHelp?: boolean;
  run: (inv: ParsedInvocation, rawArgs: string[]) => Promise<number>;
}

/** Common --json flag shared by commands that emit structured results. */
export const JSON_FLAG: FlagSpec = {
  name: "json",
  takesValue: false,
  description: "Emit JSON (automatic when stdout is not a TTY)",
};

export function findCommand(
  commands: CliCommand[],
  group: string,
  name: string
): CliCommand | undefined {
  return commands.find(
    (cmd) => cmd.group === group && (cmd.name === name || cmd.aliases?.includes(name))
  );
}

export function groupCommands(commands: CliCommand[], group: string): CliCommand[] {
  return commands.filter((cmd) => cmd.group === group);
}

/**
 * Parse argv against a command's declared flags. Unknown flags are usage
 * errors; everything else is collected as positionals in order.
 */
export function parseInvocation(command: CliCommand, argv: string[]): ParsedInvocation {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  const multi: Record<string, string[]> = {};
  const pushMulti = (name: string, value: string): void => {
    (multi[name] ??= []).push(value);
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    const isLong = arg.startsWith("--");
    const isShort = !isLong && /^-[A-Za-z]$/.test(arg);
    if (isLong || isShort) {
      // Long flags may carry an inline value: --flag=value.
      const eq = isLong ? arg.indexOf("=") : -1;
      const name = eq === -1 ? arg : arg.slice(0, eq);
      const inlineValue = eq === -1 ? undefined : arg.slice(eq + 1);
      const spec = isLong
        ? command.flags?.find((flag) => flag.name === name.slice(2))
        : command.flags?.find((flag) => flag.short === name.slice(1));
      if (!spec) {
        throw new UsageError(`Unknown flag for ${command.group} ${command.name}: ${name}`);
      }
      if (spec.takesValue) {
        if (inlineValue !== undefined) {
          flags[spec.name] = inlineValue;
          if (spec.multiple) pushMulti(spec.name, inlineValue);
          continue;
        }
        const value = argv[++i];
        if (value === undefined) throw new UsageError(`Flag ${arg} requires a value`);
        flags[spec.name] = value;
        if (spec.multiple) pushMulti(spec.name, value);
      } else if (inlineValue !== undefined) {
        if (inlineValue === "true") flags[spec.name] = true;
        else if (inlineValue === "false") flags[spec.name] = false;
        else throw new UsageError(`Flag ${name} is boolean; use ${name} or ${name}=true|false`);
      } else {
        flags[spec.name] = true;
      }
    } else {
      positionals.push(arg);
    }
  }
  return {
    positionals,
    flags,
    flagsMulti: (name: string) => multi[name] ?? [],
  };
}

/** Render per-command help: usage line plus declared flags. */
export function renderCommandHelp(command: CliCommand): string {
  const usage = command.usage ?? `natstack ${command.group} ${command.name}`;
  const lines = [`${command.summary}`, "", `Usage: ${usage}`];
  const flags = command.flags ?? [];
  if (flags.length > 0) {
    lines.push("", "Flags:");
    for (const flag of flags) {
      const label = flag.short ? `--${flag.name}, -${flag.short}` : `--${flag.name}`;
      const valueHint = flag.takesValue ? " <value>" : "";
      lines.push(`  ${(label + valueHint).padEnd(28)} ${flag.description ?? ""}`.trimEnd());
    }
    lines.push(
      "",
      "Value flags accept --flag value or --flag=value; boolean flags accept --flag or --flag=true|false."
    );
  }
  return lines.join("\n");
}

/** Render usage lines for one group's commands. */
export function renderGroupHelp(commands: CliCommand[], group: string): string {
  const lines = groupCommands(commands, group).map((cmd) => {
    const usage = cmd.usage ?? `natstack ${cmd.group} ${cmd.name}`;
    return `  ${usage.padEnd(52)} ${cmd.summary}`;
  });
  return lines.join("\n");
}
