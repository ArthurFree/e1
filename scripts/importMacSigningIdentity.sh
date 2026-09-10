#!/usr/bin/env bash
# R013：在 macOS Release runner 创建短生命周期临时 Keychain，
# 导入 Developer ID .p12，并把公证 .p8 落到 $RUNNER_TEMP。
# 只允许输出「已导入 / 已配置」类状态，禁止打印证书、密码或 p8 内容。
set -euo pipefail

if [[ -z "${RUNNER_TEMP:-}" ]]; then
  echo "::error::RUNNER_TEMP 未设置，拒绝在默认 Keychain 导入证书" >&2
  exit 1
fi

if [[ -z "${MAC_CERT_P12_BASE64:-}" || -z "${MAC_CERT_PASSWORD:-}" ]]; then
  echo "::error::Developer ID 证书未配置" >&2
  exit 1
fi

if [[ -z "${APPLE_API_KEY:-}" || -z "${APPLE_API_KEY_ID:-}" || -z "${APPLE_API_ISSUER:-}" ]]; then
  echo "::error::Notary API Key 未配置" >&2
  exit 1
fi

KEYCHAIN_PATH="${RUNNER_TEMP}/e1-signing.keychain-db"
P12_PATH="${RUNNER_TEMP}/e1-developer-id.p12"
AUTHKEY_PATH="${RUNNER_TEMP}/AuthKey.p8"
KEYCHAIN_PASSWORD="$(openssl rand -base64 32)"
IMPORT_OK=0

cleanup_on_fail() {
  if [[ "${IMPORT_OK}" != "1" ]]; then
    security delete-keychain "${KEYCHAIN_PATH}" >/dev/null 2>&1 || true
    rm -f "${P12_PATH}" "${AUTHKEY_PATH}"
  fi
}
trap cleanup_on_fail EXIT

umask 077
printf '%s' "${MAC_CERT_P12_BASE64}" | base64 --decode > "${P12_PATH}"
printf '%s' "${APPLE_API_KEY}" > "${AUTHKEY_PATH}"
chmod 600 "${P12_PATH}" "${AUTHKEY_PATH}"

security create-keychain -p "${KEYCHAIN_PASSWORD}" "${KEYCHAIN_PATH}"
security set-keychain-settings -lut 21600 "${KEYCHAIN_PATH}"
security unlock-keychain -p "${KEYCHAIN_PASSWORD}" "${KEYCHAIN_PATH}"
security import "${P12_PATH}" -k "${KEYCHAIN_PATH}" -P "${MAC_CERT_PASSWORD}" \
  -T /usr/bin/codesign -T /usr/bin/security >/dev/null
security set-key-partition-list -S apple-tool:,apple:,codesign: \
  -s -k "${KEYCHAIN_PASSWORD}" "${KEYCHAIN_PATH}" >/dev/null

existing=()
while IFS= read -r line; do
  line="${line//\"/}"
  line="${line#"${line%%[![:space:]]*}"}"
  line="${line%"${line##*[![:space:]]}"}"
  [[ -n "${line}" ]] && existing+=("${line}")
done < <(security list-keychains -d user)
security list-keychains -d user -s "${KEYCHAIN_PATH}" "${existing[@]}"

IDENTITY_LINE="$(security find-identity -v -p codesigning "${KEYCHAIN_PATH}" \
  | grep "Developer ID Application" | head -1 || true)"
if [[ -z "${IDENTITY_LINE}" ]]; then
  echo "::error::临时 Keychain 中没有 Developer ID Application 身份" >&2
  exit 1
fi
TEAM_ID="$(printf '%s\n' "${IDENTITY_LINE}" | sed -n 's/.*(\([A-Z0-9]\{10\}\))".*/\1/p')"
CSC_NAME="$(printf '%s\n' "${IDENTITY_LINE}" | sed -n 's/.*"\(Developer ID Application: .*\)"/\1/p')"
if [[ -z "${TEAM_ID}" || -z "${CSC_NAME}" ]]; then
  echo "::error::无法从导入证书解析 TeamIdentifier" >&2
  exit 1
fi
if [[ -n "${E1_EXPECTED_TEAM_IDENTIFIER:-}" && "${TEAM_ID}" != "${E1_EXPECTED_TEAM_IDENTIFIER}" ]]; then
  echo "::error::导入证书 TeamIdentifier 与期望不一致" >&2
  exit 1
fi

{
  echo "E1_SIGNING_KEYCHAIN=${KEYCHAIN_PATH}"
  echo "CSC_LINK=${P12_PATH}"
  echo "CSC_KEY_PASSWORD=${MAC_CERT_PASSWORD}"
  echo "CSC_NAME=${CSC_NAME}"
  echo "APPLE_API_KEY=${AUTHKEY_PATH}"
  echo "APPLE_API_KEY_ID=${APPLE_API_KEY_ID}"
  echo "APPLE_API_ISSUER=${APPLE_API_ISSUER}"
  echo "E1_TEAM_IDENTIFIER=${TEAM_ID}"
  echo "E1_RELEASE_SIGNING=1"
  echo "E1_REQUIRE_SIGNED=1"
} >> "${GITHUB_ENV}"

IMPORT_OK=1
echo "certificate imported = yes"
echo "notary credential configured = yes"
