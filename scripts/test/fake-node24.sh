#!/usr/bin/env bash
if [ "${1:-}" = "-p" ]; then
  printf '24\n'
  exit 0
fi
if [ -n "${COZYGATEWAY_TEST_DASHBOARD_HOME_LOG:-}" ] && [ "${1:-}" = - ] && [ "${5:-}" = 9119 ]; then
  printf '%s\n' "${3:-}" > "$COZYGATEWAY_TEST_DASHBOARD_HOME_LOG"
  [ "${3:-}" = "${COZYGATEWAY_TEST_EXPECTED_DASHBOARD_HOME:?}" ] || exit 42
  rm -f "${COZYGATEWAY_TEST_DASHBOARD_STOPPED_MARKER:-}"
  exit 0
fi
exec "${COZYGATEWAY_TEST_REAL_NODE:-node}" "$@"
