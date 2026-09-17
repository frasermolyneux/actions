#!/usr/bin/env bash

set -euo pipefail

action_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
temp_dir=$(mktemp -d)
trap 'rm -rf "$temp_dir"' EXIT

cat >"$temp_dir/az" <<'EOF'
#!/usr/bin/env bash
if [[ "${AZ_TEST_EXIT_CODE:-0}" -ne 0 ]]; then
  exit "$AZ_TEST_EXIT_CODE"
fi
printf '%s' "${AZ_TEST_RESPONSE}"
EOF
chmod +x "$temp_dir/az"

export PATH="$temp_dir:$PATH"
export APP_SERVICE_PLAN_ID="/subscriptions/test/resourceGroups/rg/providers/Microsoft.Web/serverfarms/asp-test"

AZ_TEST_RESPONSE='' bash "$action_dir/assert-app-service-plan-empty.sh"

set +e
output=$(AZ_TEST_RESPONSE=$'/subscriptions/test/resourceGroups/rg/providers/Microsoft.Web/sites/app-one\n/subscriptions/test/resourceGroups/rg/providers/Microsoft.Web/sites/app-one/slots/staging' \
  bash "$action_dir/assert-app-service-plan-empty.sh" 2>&1)
status=$?
set -e

if [[ "$status" -eq 0 ]]; then
  echo "Expected attached resources to fail the assertion."
  exit 1
fi

grep -Fq "/subscriptions/test/resourceGroups/rg/providers/Microsoft.Web/sites/app-one" <<<"$output"
grep -Fq "/subscriptions/test/resourceGroups/rg/providers/Microsoft.Web/sites/app-one/slots/staging" <<<"$output"

set +e
AZ_TEST_EXIT_CODE=1 AZ_TEST_RESPONSE='' bash "$action_dir/assert-app-service-plan-empty.sh" >/dev/null 2>&1
status=$?
set -e

if [[ "$status" -eq 0 ]]; then
  echo "Expected an Azure CLI failure to fail the assertion."
  exit 1
fi
