/**
 * Copy-paste eval snippets for the testkit skill. Each export is a runnable
 * helper so agents can also `import { ... } from "@workspace-skills/testkit"`
 * directly instead of pasting code.
 */
import {
  expect,
  heapSnapshot,
  listProfiles,
  listUnits,
  openPanel,
  panelText,
  profilePanel,
  profileWorkerd,
  listWorkerdTargets,
  runSuites,
  summarize,
  supervise,
  suite,
  waitForText,
  type RunSummary,
  type ProfileRef,
} from "@workspace/testkit";
import { allSuites } from "@workspace/testkit/suites";

/** Run all built-in suites (or a filtered subset) and return a compact summary. */
export async function runBuiltinSuites(filter?: {
  suite?: string;
  test?: string;
}): Promise<{ summary: RunSummary; full: unknown }> {
  const result = await runSuites(allSuites(), { filter });
  return { summary: summarize(result), full: result };
}

/** Smoke-test a single panel: opens, renders text, no console errors. */
export async function smokePanel(source: string, expectedText?: string | RegExp): Promise<RunSummary> {
  const s = suite(`smoke:${source}`).test("opens cleanly", async (t) => {
    const handle = await openPanel(source);
    t.defer(() => handle.close().then(() => undefined));
    if (expectedText) await waitForText(handle, expectedText);
    expect((await panelText(handle)).length, "rendered text").toBeGreaterThan(0);
  });
  return summarize(await runSuites(s));
}

/** Watch a set of worker/DO units while running a workload; throw on errors. */
export async function superviseUnits<T>(
  unitNames: string[],
  workload: () => Promise<T>,
  opts?: { allow?: RegExp[] }
): Promise<T> {
  const supervisor = supervise(unitNames);
  try {
    const value = await workload();
    await supervisor.assertClean(opts);
    return value;
  } finally {
    supervisor.stop();
  }
}

/** Profile a panel around a workload and return only the compact ref. */
export async function profilePanelWorkload(
  source: string,
  workload: (handle: Awaited<ReturnType<typeof openPanel>>) => Promise<void>
): Promise<ProfileRef> {
  const handle = await openPanel(source);
  try {
    return await profilePanel(handle, () => workload(handle));
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** One-line system overview: units + inspector targets + stored profiles. */
export async function observabilityOverview(): Promise<{
  units: Awaited<ReturnType<typeof listUnits>>;
  workerdTargets: Awaited<ReturnType<typeof listWorkerdTargets>>;
  profiles: ProfileRef[];
}> {
  const [units, workerdTargets, profiles] = await Promise.all([
    listUnits(),
    listWorkerdTargets().catch(() => []),
    listProfiles(),
  ]);
  return { units, workerdTargets, profiles };
}

export { heapSnapshot, profileWorkerd };
