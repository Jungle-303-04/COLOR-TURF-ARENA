#!/usr/bin/env sh
set -eu

NAMESPACE="${NAMESPACE:-color-turf}"
RELEASE="${RELEASE:-color-turf}"
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
CHART="${CHART:-${SCRIPT_DIR}/../deploy/helm/color-turf}"

echo "Emergency Helm rollback: disable Canary in release ${RELEASE} (${NAMESPACE})"
helm upgrade "${RELEASE}" "${CHART}" \
  --namespace "${NAMESPACE}" \
  --reuse-values \
  --set canary.enabled=false \
  --wait \
  --timeout 2m

kubectl -n "${NAMESPACE}" rollout status "deployment/${RELEASE}-server-stable" --timeout=120s
if kubectl -n "${NAMESPACE}" get "deployment/${RELEASE}-server-canary" >/dev/null 2>&1; then
  echo "Canary deployment still exists after Helm rollback" >&2
  exit 1
fi

echo "Canary Deployment was removed together with its Helm state."
