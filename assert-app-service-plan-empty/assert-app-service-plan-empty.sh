#!/usr/bin/env bash

set -euo pipefail

if [[ -z "${APP_SERVICE_PLAN_ID:-}" ]]; then
  echo "::error::APP_SERVICE_PLAN_ID must be set."
  exit 1
fi

query="Resources | where type =~ 'microsoft.web/sites' or type =~ 'microsoft.web/sites/slots' | where tostring(properties.serverFarmId) =~ '${APP_SERVICE_PLAN_ID}' | project id | order by id asc"
request_body="{\"query\":\"${query}\"}"

attachment_output=$(az rest \
  --method post \
  --url "https://management.azure.com/providers/Microsoft.ResourceGraph/resources?api-version=2024-04-01" \
  --body "$request_body" \
  --query "data[].id" \
  --output tsv \
  --only-show-errors)

attachment_ids=()
if [[ -n "$attachment_output" ]]; then
  mapfile -t attachment_ids <<<"$attachment_output"
fi

if (( ${#attachment_ids[@]} > 0 )); then
  echo "::error::App Service plan still has attached apps or deployment slots."
  echo "Residual resource IDs:"
  printf '%s\n' "${attachment_ids[@]}"
  exit 1
fi

echo "No apps or deployment slots are attached to ${APP_SERVICE_PLAN_ID}."
