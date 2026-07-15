#!/usr/bin/env sh
set -eu

NAMESPACE="${NAMESPACE:-color-turf}"
RELEASE="${RELEASE:-color-turf}"

echo "Emergency demo rollback: ${RELEASE}-server-canary in ${NAMESPACE}"
kubectl -n "${NAMESPACE}" rollout undo "deployment/${RELEASE}-server-canary"
kubectl -n "${NAMESPACE}" rollout status "deployment/${RELEASE}-server-canary" --timeout=120s

echo "Normal operation should use the platform deployment workflow; this script is for presentation recovery only."
