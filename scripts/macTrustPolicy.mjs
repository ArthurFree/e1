/**
 * R013：macOS 签名 / 公证 / Gatekeeper 策略常量与纯解析。
 * 不执行 codesign / spctl / stapler——便于 Linux CI 单测。
 * 真实验证见 verifyMacSigning / verifyMacEntitlements / verifyMacDistribution。
 */
export const PRODUCT_IDENTIFIER = "com.e1.notes";
export const PRODUCT_NAME = "E1";
export const REQUIRED_AUTHORITY_PREFIX = "Developer ID Application";

/** 正式 Release 必须齐备的 secret 名（只报 yes/no，永不打印值）。 */
export const REQUIRED_SIGNING_SECRETS = [
  "MAC_CERT_P12_BASE64",
  "MAC_CERT_PASSWORD",
];
export const REQUIRED_NOTARY_SECRETS = [
  "APPLE_API_KEY",
  "APPLE_API_KEY_ID",
  "APPLE_API_ISSUER",
];

/** 本地 unsigned 构建与 E2E 启动前必须剥离，禁止进入 Electron 运行时。 */
export const SIGNING_ENV_KEYS = [
  "MAC_CERT_P12_BASE64",
  "MAC_CERT_PASSWORD",
  "APPLE_API_KEY",
  "APPLE_API_KEY_ID",
  "APPLE_API_ISSUER",
  "CSC_LINK",
  "CSC_KEY_PASSWORD",
  "CSC_NAME",
  "E1_SIGNING_KEYCHAIN",
  "E1_SIGNING_KEYCHAIN_PASSWORD",
];

export function isUnsignedCodesignFailure(text) {
  return (
    /code object is not signed(?: at all)?/i.test(text) ||
    /object is not signed at all/i.test(text)
  );
}

export function stripSigningEnv(env) {
  const next = { ...env };
  for (const key of SIGNING_ENV_KEYS) delete next[key];
  return next;
}

/** 主 app 与 helper 必须具备。 */
export const REQUIRED_ENTITLEMENTS = ["com.apple.security.cs.allow-jit"];

/** 无独立失败现象不得加入（R013 §8）。 */
export const FORBIDDEN_ENTITLEMENTS = [
  "com.apple.security.get-task-allow",
  "com.apple.security.cs.disable-library-validation",
  "com.apple.security.cs.allow-dyld-environment-variables",
];

/**
 * 允许出现的 entitlement 闭集。当前仅 JIT；未来若必须扩权，
 * 先在本表登记并附失败现象 / 最小复现 / 安全影响。
 */
export const ALLOWED_ENTITLEMENTS = [...REQUIRED_ENTITLEMENTS];

export function secretConfigured(value) {
  return typeof value === "string" && value.trim().length > 0;
}

/** 预检：只返回配置与否，不回传 secret 内容。 */
export function evaluateSigningPreflight(env = process.env) {
  const missingCertificate = REQUIRED_SIGNING_SECRETS.filter(
    (name) => !secretConfigured(env[name]),
  );
  const missingNotary = REQUIRED_NOTARY_SECRETS.filter(
    (name) => !secretConfigured(env[name]),
  );
  return {
    certificateConfigured: missingCertificate.length === 0,
    notaryConfigured: missingNotary.length === 0,
    missingCertificate,
    missingNotary,
    ok: missingCertificate.length === 0 && missingNotary.length === 0,
  };
}

export function formatPreflightLog(result) {
  return [
    `certificate configured = ${result.certificateConfigured ? "yes" : "no"}`,
    `notary credential configured = ${result.notaryConfigured ? "yes" : "no"}`,
  ].join("\n");
}

/**
 * 解析 `codesign -dv --verbose=4` 的 stderr 文本。
 * codesign 把显示信息写到 stderr。
 */
export function parseCodesignDisplay(text) {
  const identifier = matchGroup(text, /^Identifier=(.+)$/m);
  const teamIdentifier = matchGroup(text, /^TeamIdentifier=(.+)$/m);
  const authorities = [...text.matchAll(/^Authority=(.+)$/gm)].map((m) =>
    m[1].trim(),
  );
  const flagsLine = matchGroup(text, /^CodeDirectory[^\n]*flags=([^\n]+)$/m);
  const hardenedRuntime =
    /\(runtime\)/.test(flagsLine ?? "") || /\bruntime\b/.test(flagsLine ?? "");
  return {
    identifier,
    teamIdentifier:
      !teamIdentifier || teamIdentifier === "not set" ? null : teamIdentifier,
    authorities,
    hardenedRuntime,
    flagsLine,
  };
}

export function evaluateSigningInfo(info, options = {}) {
  const expectedIdentifier = options.identifier ?? PRODUCT_IDENTIFIER;
  const expectedTeam =
    options.teamIdentifier ?? process.env.E1_TEAM_IDENTIFIER ?? null;
  const errors = [];
  if (info.identifier !== expectedIdentifier) {
    errors.push(
      `Identifier 期望 ${expectedIdentifier}，实际 ${info.identifier ?? "(缺失)"}`,
    );
  }
  const hasDeveloperId = info.authorities.some((authority) =>
    authority.startsWith(REQUIRED_AUTHORITY_PREFIX),
  );
  if (!hasDeveloperId) {
    errors.push(
      `Authority 必须包含 ${REQUIRED_AUTHORITY_PREFIX}，实际：${info.authorities.join(" | ") || "(无)"}`,
    );
  }
  if (!info.teamIdentifier) {
    errors.push("TeamIdentifier 缺失");
  } else if (expectedTeam && info.teamIdentifier !== expectedTeam) {
    errors.push(
      `TeamIdentifier 与导入证书不一致：期望 ${expectedTeam}，实际 ${info.teamIdentifier}`,
    );
  }
  if (!info.hardenedRuntime) {
    errors.push("Hardened Runtime 未生效（CodeDirectory flags 无 runtime）");
  }
  return { ok: errors.length === 0, errors };
}

export function parseEntitlementKeysFromPlist(xml) {
  const keys = [];
  for (const match of xml.matchAll(/<key>([^<]+)<\/key>/g)) {
    keys.push(match[1]);
  }
  return keys;
}

export function evaluateEntitlements(keys, options = {}) {
  const requireRequired = options.requireRequired !== false;
  const unique = [...new Set(keys)];
  const missing = requireRequired
    ? REQUIRED_ENTITLEMENTS.filter((key) => !unique.includes(key))
    : [];
  const forbidden = unique.filter((key) =>
    FORBIDDEN_ENTITLEMENTS.includes(key),
  );
  const unexpected = unique.filter(
    (key) =>
      !ALLOWED_ENTITLEMENTS.includes(key) &&
      !FORBIDDEN_ENTITLEMENTS.includes(key),
  );
  const errors = [
    ...missing.map((key) => `缺少必需 entitlement：${key}`),
    ...forbidden.map((key) => `禁止 entitlement 存在：${key}`),
    ...unexpected.map((key) => `未在白名单中的 entitlement：${key}`),
  ];
  return { ok: errors.length === 0, errors, missing, forbidden, unexpected };
}

export function parseSpctlAssess(text) {
  const accepted = /\baccepted\b/i.test(text);
  const source = matchGroup(text, /source=(.+)$/m);
  const notarizedDeveloperId = /Notarized Developer ID/i.test(text);
  return { accepted, source, notarizedDeveloperId };
}

export function evaluateGatekeeper(assess) {
  const errors = [];
  if (!assess.accepted) errors.push("spctl assess 未 accepted");
  if (!assess.notarizedDeveloperId) {
    errors.push(
      `Gatekeeper source 必须为 Notarized Developer ID，实际：${assess.source ?? "(缺失)"}`,
    );
  }
  return { ok: errors.length === 0, errors };
}

export function parseStaplerValidate(text) {
  return {
    ok:
      /The validate action worked!/i.test(text) ||
      /validation succeeded/i.test(text),
    text,
  };
}

function matchGroup(text, regex) {
  return text.match(regex)?.[1]?.trim() ?? null;
}
