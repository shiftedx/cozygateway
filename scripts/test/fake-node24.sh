#!/usr/bin/env bash
if [ "${1:-}" = "-p" ]; then
  printf '24\n'
  exit 0
fi
exec "${COZYGATEWAY_TEST_REAL_NODE:-node}" "$@"
