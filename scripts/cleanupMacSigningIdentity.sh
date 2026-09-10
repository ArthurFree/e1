#!/usr/bin/env bash
# R013：删除临时 Keychain 与 $RUNNER_TEMP 上的 p12/p8。
# 始终清已知路径，不依赖 GITHUB_ENV 是否写过。失败不阻断。
set -u

if [[ -n "${RUNNER_TEMP:-}" ]]; then
  security delete-keychain "${RUNNER_TEMP}/e1-signing.keychain-db" >/dev/null 2>&1 || true
  rm -f "${RUNNER_TEMP}/e1-developer-id.p12" "${RUNNER_TEMP}/AuthKey.p8"
fi

if [[ -n "${E1_SIGNING_KEYCHAIN:-}" && "${E1_SIGNING_KEYCHAIN}" != "${RUNNER_TEMP:-}/e1-signing.keychain-db" ]]; then
  security delete-keychain "${E1_SIGNING_KEYCHAIN}" >/dev/null 2>&1 || true
fi

echo "temporary signing material removed = yes"
