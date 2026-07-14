param(
  [string]$Cluster = "kind",
  [string]$Version = "v1.1.3",
  [string]$PublicBaseUrl = "http://localhost:30080"
)

$ErrorActionPreference = "Stop"
& "$PSScriptRoot/build-images.ps1" -Version $Version
kind load docker-image "paint-arena-game-api:$Version" "paint-arena-frontend:$Version" "color-turf-bot:$Version" --name $Cluster

kubectl apply -k (Join-Path $PSScriptRoot "..\deploy\k8s")
kubectl -n paint-arena create configmap paint-arena-config `
  --from-literal="APP_VERSION=$Version" `
  --from-literal="SERVER_VERSION=$Version" `
  --from-literal="GIT_SHA=local" `
  --from-literal="CLUSTER_NAME=primary" `
  --from-literal="RELEASE_CHANNEL=stable" `
  --from-literal="BROADCAST_MODE=delta" `
  --from-literal="SNAPSHOT_INTERVAL_MS=1000" `
  --from-literal="ADMIN_TOKEN=demo-admin" `
  --from-literal="OPS_EVENT_TOKEN=demo-ops" `
  --from-literal="IMAGE_TAG=paint-arena-game-api:$Version" `
  --from-literal="PUBLIC_BASE_URL=$PublicBaseUrl" `
  --from-literal="KUBERNETES_LABEL_SELECTOR=app.kubernetes.io/name=paint-arena-game-api" `
  --from-literal="KUBERNETES_DEPLOYMENT_NAME=paint-arena-game-api" `
  --dry-run=client -o yaml | kubectl apply -f -
kubectl -n paint-arena set image deployment/paint-arena-game-api "game-api=paint-arena-game-api:$Version"
kubectl -n paint-arena set image deployment/paint-arena-frontend "frontend=paint-arena-frontend:$Version"
kubectl -n paint-arena rollout restart deployment/paint-arena-game-api deployment/paint-arena-frontend
kubectl -n paint-arena rollout status deployment/paint-arena-game-api --timeout=120s
kubectl -n paint-arena rollout status deployment/paint-arena-frontend --timeout=120s
kubectl -n paint-arena get pods,svc
