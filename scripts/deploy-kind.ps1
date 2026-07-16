param(
  [string]$Cluster = "kind",
  [string]$Version = "v1.1.3",
  [string]$PublicBaseUrl = "http://localhost:30080"
)

$ErrorActionPreference = "Stop"
$context = "kind-$Cluster"

if (-not (Get-Command kind -ErrorAction SilentlyContinue)) {
  throw "kind CLI를 찾지 못했습니다."
}
if (-not (Get-Command kubectl -ErrorAction SilentlyContinue)) {
  throw "kubectl CLI를 찾지 못했습니다."
}

$clusters = @(kind get clusters)
if ($LASTEXITCODE -ne 0 -or $clusters -notcontains $Cluster) {
  throw "kind cluster '$Cluster'를 찾지 못했습니다. 사용 가능한 cluster: $($clusters -join ', ')"
}

$contexts = @(kubectl config get-contexts -o name)
if ($LASTEXITCODE -ne 0 -or $contexts -notcontains $context) {
  throw "kubectl context '$context'를 찾지 못했습니다."
}

Write-Host "Deploy target: kind cluster '$Cluster' / kubectl context '$context'"
& "$PSScriptRoot/build-images.ps1" -Version $Version
kind load docker-image "paint-arena-game-api:$Version" "paint-arena-frontend:$Version" "color-turf-bot:$Version" --name $Cluster

kubectl --context $context apply -k (Join-Path $PSScriptRoot "..\deploy\k8s")
kubectl --context $context -n paint-arena create configmap paint-arena-config `
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
  --dry-run=client -o yaml | kubectl --context $context apply -f -
kubectl --context $context -n paint-arena set image deployment/paint-arena-game-api "game-api=paint-arena-game-api:$Version"
kubectl --context $context -n paint-arena set image deployment/paint-arena-frontend "frontend=paint-arena-frontend:$Version"
kubectl --context $context -n paint-arena rollout restart deployment/paint-arena-game-api deployment/paint-arena-frontend
kubectl --context $context -n paint-arena rollout status deployment/paint-arena-game-api --timeout=120s
kubectl --context $context -n paint-arena rollout status deployment/paint-arena-frontend --timeout=120s
kubectl --context $context -n paint-arena get pods,svc
