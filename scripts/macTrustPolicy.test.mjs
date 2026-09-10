// @vitest-environment node
/**
 * R013：签名 / 公证策略纯函数——不调用 codesign，Linux CI 可跑。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ALLOWED_ENTITLEMENTS,
  FORBIDDEN_ENTITLEMENTS,
  PRODUCT_IDENTIFIER,
  REQUIRED_ENTITLEMENTS,
  evaluateEntitlements,
  evaluateGatekeeper,
  evaluateSigningInfo,
  evaluateSigningPreflight,
  formatPreflightLog,
  isUnsignedCodesignFailure,
  parseCodesignDisplay,
  stripSigningEnv,
  parseEntitlementKeysFromPlist,
  parseSpctlAssess,
  parseStaplerValidate,
} from "./macTrustPolicy.mjs";
import { buildElectronBuilderArgs } from "./runElectronBuilder.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

const VALID_CODESIGN = `
Identifier=com.e1.notes
Format=app bundle with Mach-O thin (arm64)
CodeDirectory v=20500 size=123 flags=0x10000(runtime) hashes=10+5
Authority=Developer ID Application: Example (ABCDE12345)
Authority=Developer ID Certification Authority
Authority=Apple Root CA
TeamIdentifier=ABCDE12345
`;

describe("macOS trust policy（R013）", () => {
  it("正式 Release 预检：缺任一 secret 即失败，日志不含 secret 内容", () => {
    const missing = evaluateSigningPreflight({});
    expect(missing.ok).toBe(false);
    expect(missing.certificateConfigured).toBe(false);
    expect(missing.notaryConfigured).toBe(false);
    const log = formatPreflightLog(missing);
    expect(log).toContain("certificate configured = no");
    expect(log).toContain("notary credential configured = no");
    expect(log).not.toMatch(/BEGIN|MII|-----/);

    const ok = evaluateSigningPreflight({
      MAC_CERT_P12_BASE64: "base64-cert",
      MAC_CERT_PASSWORD: "secret-password",
      APPLE_API_KEY: "p8-body",
      APPLE_API_KEY_ID: "KEYID",
      APPLE_API_ISSUER: "issuer-uuid",
    });
    expect(ok.ok).toBe(true);
    expect(formatPreflightLog(ok)).toContain("certificate configured = yes");
    expect(formatPreflightLog(ok)).not.toContain("secret-password");
    expect(formatPreflightLog(ok)).not.toContain("p8-body");
  });

  it("codesign 显示信息：身份 / Team / Hardened Runtime 必须齐", () => {
    const info = parseCodesignDisplay(VALID_CODESIGN);
    expect(evaluateSigningInfo(info, { teamIdentifier: "ABCDE12345" })).toEqual(
      { ok: true, errors: [] },
    );
    expect(info.identifier).toBe(PRODUCT_IDENTIFIER);

    const unsigned = parseCodesignDisplay("Identifier=com.e1.notes\n");
    const failed = evaluateSigningInfo(unsigned);
    expect(failed.ok).toBe(false);
    expect(failed.errors.join(" ")).toMatch(
      /Authority|TeamIdentifier|Hardened Runtime/,
    );

    const mismatch = evaluateSigningInfo(info, {
      teamIdentifier: "OTHERTEAM1",
    });
    expect(mismatch.ok).toBe(false);
    expect(mismatch.errors.join(" ")).toMatch(/TeamIdentifier/);
  });

  it("只把 codesign「未签名」当成本地 skip，不把 rejected / unsigned-executable 算进去", () => {
    expect(isUnsignedCodesignFailure("code object is not signed at all")).toBe(
      true,
    );
    expect(
      isUnsignedCodesignFailure("E1.app: rejected\nsource=Unnotarized"),
    ).toBe(false);
    expect(
      isUnsignedCodesignFailure(
        "未在白名单中的 entitlement：com.apple.security.cs.allow-unsigned-executable-memory",
      ),
    ).toBe(false);
  });

  it("entitlement 白名单：JIT 必须在，调试类 entitlement 必须不在", () => {
    expect(REQUIRED_ENTITLEMENTS).toEqual(["com.apple.security.cs.allow-jit"]);
    expect(ALLOWED_ENTITLEMENTS).toEqual(["com.apple.security.cs.allow-jit"]);
    expect(FORBIDDEN_ENTITLEMENTS).toEqual(
      expect.arrayContaining([
        "com.apple.security.get-task-allow",
        "com.apple.security.cs.disable-library-validation",
        "com.apple.security.cs.allow-dyld-environment-variables",
      ]),
    );

    expect(evaluateEntitlements(["com.apple.security.cs.allow-jit"]).ok).toBe(
      true,
    );
    expect(evaluateEntitlements([]).missing).toContain(
      "com.apple.security.cs.allow-jit",
    );
    expect(evaluateEntitlements([], { requireRequired: false }).ok).toBe(true);
    expect(
      evaluateEntitlements([
        "com.apple.security.cs.allow-jit",
        "com.apple.security.get-task-allow",
      ]).forbidden,
    ).toContain("com.apple.security.get-task-allow");
    expect(
      evaluateEntitlements([
        "com.apple.security.cs.allow-jit",
        "com.apple.security.cs.allow-unsigned-executable-memory",
      ]).unexpected,
    ).toContain("com.apple.security.cs.allow-unsigned-executable-memory");
  });

  it("从 entitlements plist 抽出 key", () => {
    const xml = readFileSync(
      path.join(root, "build/entitlements.mac.plist"),
      "utf8",
    );
    expect(parseEntitlementKeysFromPlist(xml)).toEqual([
      "com.apple.security.cs.allow-jit",
    ]);
    const inherit = readFileSync(
      path.join(root, "build/entitlements.mac.inherit.plist"),
      "utf8",
    );
    expect(parseEntitlementKeysFromPlist(inherit)).toEqual([
      "com.apple.security.cs.allow-jit",
    ]);
  });

  it("Gatekeeper / stapler 文本门禁", () => {
    const assess = parseSpctlAssess(
      "E1.app: accepted\nsource=Notarized Developer ID",
    );
    expect(evaluateGatekeeper(assess)).toEqual({ ok: true, errors: [] });
    expect(
      evaluateGatekeeper(
        parseSpctlAssess("E1.app: rejected\nsource=Unnotarized Developer ID"),
      ).ok,
    ).toBe(false);
    expect(parseStaplerValidate("The validate action worked!").ok).toBe(true);
    expect(parseStaplerValidate("Does not have a ticket").ok).toBe(false);
  });

  it("electron-builder 本地默认 unsigned，Release 强制签名+公证", () => {
    const local = buildElectronBuilderArgs(["--mac"], {
      CSC_LINK: "/tmp/cert.p12",
      CSC_KEY_PASSWORD: "secret",
      APPLE_API_KEY: "/tmp/AuthKey.p8",
    });
    expect(local.release).toBe(false);
    expect(local.args).toContain("--config.mac.identity=null");
    expect(local.env.CSC_IDENTITY_AUTO_DISCOVERY).toBe("false");
    expect(local.env.CSC_LINK).toBeUndefined();
    expect(local.env.CSC_KEY_PASSWORD).toBeUndefined();
    expect(local.env.APPLE_API_KEY).toBeUndefined();
    expect(stripSigningEnv({ CSC_LINK: "x", FOO: "1" })).toEqual({ FOO: "1" });

    const release = buildElectronBuilderArgs(["--mac", "--publish", "never"], {
      E1_RELEASE_SIGNING: "1",
      CSC_IDENTITY_AUTO_DISCOVERY: "false",
    });
    expect(release.release).toBe(true);
    expect(release.args).toContain("--config.forceCodeSigning=true");
    expect(release.args).toContain("--config.mac.notarize=true");
    expect(release.args).not.toContain("--config.mac.identity=null");
    expect(release.env.CSC_IDENTITY_AUTO_DISCOVERY).toBeUndefined();
  });

  it("正式配置不再写 identity: null，且启用 Hardened Runtime + entitlements", () => {
    const yml = readFileSync(path.join(root, "electron-builder.yml"), "utf8");
    const active = yml
      .split("\n")
      .filter((line) => !/^\s*#/.test(line))
      .join("\n");
    expect(active).not.toMatch(/identity:\s*null/);
    expect(active).toMatch(/hardenedRuntime:\s*true/);
    expect(active).toMatch(/entitlements:\s*build\/entitlements\.mac\.plist/);
    expect(active).toMatch(
      /entitlementsInherit:\s*build\/entitlements\.mac\.inherit\.plist/,
    );
  });
});
