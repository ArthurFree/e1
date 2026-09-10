#!/usr/bin/env bash
# R013：dist:mac 之后从后续 step 环境剥离签名凭证。
# GitHub Actions 以空赋值覆盖 GITHUB_ENV；不打印任何值。
set -u

if [[ -z "${GITHUB_ENV:-}" ]]; then
  echo "::error::GITHUB_ENV 未设置" >&2
  exit 1
fi

{
  echo "CSC_LINK="
  echo "CSC_KEY_PASSWORD="
  echo "CSC_NAME="
  echo "APPLE_API_KEY="
  echo "APPLE_API_KEY_ID="
  echo "APPLE_API_ISSUER="
  echo "MAC_CERT_P12_BASE64="
  echo "MAC_CERT_PASSWORD="
  echo "E1_SIGNING_KEYCHAIN="
} >> "${GITHUB_ENV}"

echo "signing env cleared = yes"
