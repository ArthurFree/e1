// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
  detectDarwinDeveloperIdSigned,
  resolveMacAppBundleFromExe,
} from "./detectMacCodeSignature.js";

describe("detectMacCodeSignature", () => {
  it("从 exe 路径还原 .app bundle", () => {
    expect(
      resolveMacAppBundleFromExe(
        "/tmp/release/mac-arm64/E1.app/Contents/MacOS/E1",
      ),
    ).toBe("/tmp/release/mac-arm64/E1.app");
    expect(resolveMacAppBundleFromExe("/usr/bin/electron")).toBeNull();
  });

  it("codesign 失败 → false", () => {
    const run = vi.fn(() => ({ status: 1, stdout: "", stderr: "not signed" }));
    expect(
      detectDarwinDeveloperIdSigned(
        "/tmp/E1.app/Contents/MacOS/E1",
        run as never,
      ),
    ).toBe(false);
  });

  it("darwin 上 Developer ID + runtime 才为 true", () => {
    const run = vi.fn((_cmd: string, args: string[]) => {
      if (args.includes("--verify"))
        return { status: 0, stdout: "", stderr: "" };
      return {
        status: 0,
        stdout: "",
        stderr:
          "Identifier=com.e1.notes\nAuthority=Developer ID Application: Example (ABCDE12345)\nCodeDirectory flags=0x10000(runtime)\n",
      };
    });
    const result = detectDarwinDeveloperIdSigned(
      "/tmp/E1.app/Contents/MacOS/E1",
      run as never,
    );
    if (process.platform === "darwin") {
      expect(result).toBe(true);
    } else {
      expect(result).toBe(false);
      expect(run).not.toHaveBeenCalled();
    }
  });
});
