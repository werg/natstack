import { app } from "electron";

/**
 * Relaunch the Electron app and terminate the current process — the
 * `app.relaunch()` + `app.exit()` pair that the startup, workspace-switch, and
 * remote-credential recovery paths all repeated inline (the old `relaunchWithArgs`
 * helper was lost in the rewrite). `exitCode` defaults to 0 (a clean, intentional
 * relaunch); the crash-recovery path passes 1 so the exit reflects the failure.
 * Pass `args` to override the relaunched process's argv (Electron otherwise reuses
 * the current args).
 */
export function relaunchApp(opts: { args?: string[]; exitCode?: number } = {}): void {
  if (opts.args) app.relaunch({ args: opts.args });
  else app.relaunch();
  app.exit(opts.exitCode ?? 0);
}
