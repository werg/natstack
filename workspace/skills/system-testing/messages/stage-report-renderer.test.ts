// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { assertMessageTypesHealthy, installDoctorHostModules } from "@workspace/agentic-core";
import { STAGE_REPORT_TYPE } from "./report.js";

const REPO_ROOT = path.resolve(__dirname, "../../..");
const STAGE_REPORT_PATH = "skills/system-testing/messages/stage-report.tsx";
const STAGE_REPORT_IMPORTS: Record<string, string> = {
  "@radix-ui/themes": "npm:^3.2.1",
  "@radix-ui/react-icons": "npm:^1.3.2",
};

describe("system-testing stage report renderer", () => {
  it("passes the custom message render pipeline", async () => {
    installDoctorHostModules({
      react: await import("react"),
      "react/jsx-runtime": await import("react/jsx-runtime"),
      "react/jsx-dev-runtime": await import("react/jsx-dev-runtime"),
      "@radix-ui/themes": await import("@radix-ui/themes"),
      "@radix-ui/react-icons": await import("@radix-ui/react-icons"),
    });

    await expect(
      assertMessageTypesHealthy(
        [
          {
            typeId: STAGE_REPORT_TYPE,
            displayMode: "row",
            source: { type: "file", path: STAGE_REPORT_PATH },
            imports: STAGE_REPORT_IMPORTS,
          },
        ],
        {
          loadSourceFile: (filePath: string) => fs.readFile(path.join(REPO_ROOT, filePath), "utf8"),
        }
      )
    ).resolves.toBeUndefined();
  }, 30_000);
});
