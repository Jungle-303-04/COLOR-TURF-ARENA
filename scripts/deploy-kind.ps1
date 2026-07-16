param(
  [string]$Cluster = "kind",
  [string]$Version = "v1.1.3",
  [string]$PublicBaseUrl = "http://localhost:30080",
  [string]$AdminToken = "",
  [string]$OpsEventToken = "",
  [switch]$AllowServerShutdown
)

$ErrorActionPreference = "Stop"
$context = "kind-$Cluster"
$namespace = "paint-arena"
$manifestRoot = Join-Path $PSScriptRoot "..\deploy\k8s"

function New-StrongToken {
  param([int]$ByteLength = 32)

  $bytes = New-Object byte[] $ByteLength
  $generator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $generator.GetBytes($bytes)
  }
  finally {
    $generator.Dispose()
  }

  return [Convert]::ToBase64String($bytes).TrimEnd("=").Replace("+", "-").Replace("/", "_")
}

function Assert-NativeCommandSucceeded {
  param([string]$Operation)

  if ($LASTEXITCODE -ne 0) {
    throw "$Operation failed with exit code $LASTEXITCODE."
  }
}

if (-not (Get-Command kind -ErrorAction SilentlyContinue)) {
  throw "kind CLI was not found."
}
if (-not (Get-Command kubectl -ErrorAction SilentlyContinue)) {
  throw "kubectl CLI was not found."
}

$clusters = @(kind get clusters)
if ($LASTEXITCODE -ne 0 -or $clusters -notcontains $Cluster) {
  throw "kind cluster '$Cluster' was not found. Available clusters: $($clusters -join ', ')"
}

$contexts = @(kubectl config get-contexts -o name)
if ($LASTEXITCODE -ne 0 -or $contexts -notcontains $context) {
  throw "kubectl context '$context' was not found."
}

$effectiveAdminToken = if ([string]::IsNullOrWhiteSpace($AdminToken)) { New-StrongToken } else { $AdminToken }
$effectiveOpsEventToken = if ([string]::IsNullOrWhiteSpace($OpsEventToken)) { New-StrongToken } else { $OpsEventToken }
$adminTokenWasGenerated = [string]::IsNullOrWhiteSpace($AdminToken)
$opsTokenWasGenerated = [string]::IsNullOrWhiteSpace($OpsEventToken)

Write-Host "Deploy target: kind cluster '$Cluster' / kubectl context '$context'"
& "$PSScriptRoot/build-images.ps1" -Version $Version
Assert-NativeCommandSucceeded "Image build"
kind load docker-image "paint-arena-game-api:$Version" "paint-arena-frontend:$Version" "color-turf-bot:$Version" --name $Cluster
Assert-NativeCommandSucceeded "kind image load"

kubectl --context $context apply -f (Join-Path $manifestRoot "namespace.yaml")
Assert-NativeCommandSucceeded "Namespace apply"
kubectl --context $context -n $namespace create secret generic paint-arena-auth `
  --from-literal="ADMIN_TOKEN=$effectiveAdminToken" `
  --from-literal="OPS_EVENT_TOKEN=$effectiveOpsEventToken" `
  --dry-run=client -o yaml | kubectl --context $context apply -f -
Assert-NativeCommandSucceeded "Authentication Secret apply"
kubectl --context $context apply -k $manifestRoot
Assert-NativeCommandSucceeded "Kustomize apply"
kubectl --context $context -n $namespace create configmap paint-arena-config `
  --from-literal="APP_VERSION=$Version" `
  --from-literal="SERVER_VERSION=$Version" `
  --from-literal="GIT_SHA=local" `
  --from-literal="CLUSTER_NAME=primary" `
  --from-literal="RELEASE_CHANNEL=stable" `
  --from-literal="BROADCAST_MODE=delta" `
  --from-literal="SNAPSHOT_INTERVAL_MS=1000" `
  --from-literal="ALLOW_DEMO_SERVER_SHUTDOWN=$($AllowServerShutdown.IsPresent.ToString().ToLowerInvariant())" `
  --from-literal="IMAGE_TAG=paint-arena-game-api:$Version" `
  --from-literal="PUBLIC_BASE_URL=$PublicBaseUrl" `
  --from-literal="KUBERNETES_LABEL_SELECTOR=app.kubernetes.io/name=paint-arena-game-api" `
  --from-literal="KUBERNETES_DEPLOYMENT_NAME=paint-arena-game-api" `
  --dry-run=client -o yaml | kubectl --context $context apply -f -
Assert-NativeCommandSucceeded "Runtime ConfigMap apply"
kubectl --context $context -n $namespace set image deployment/paint-arena-game-api "game-api=paint-arena-game-api:$Version"
Assert-NativeCommandSucceeded "Game API image update"
kubectl --context $context -n $namespace set image deployment/paint-arena-frontend "frontend=paint-arena-frontend:$Version"
Assert-NativeCommandSucceeded "Frontend image update"
kubectl --context $context -n $namespace rollout restart deployment/paint-arena-game-api deployment/paint-arena-frontend
Assert-NativeCommandSucceeded "Deployment restart"
kubectl --context $context -n $namespace rollout status deployment/paint-arena-game-api --timeout=120s
Assert-NativeCommandSucceeded "Game API rollout"
kubectl --context $context -n $namespace rollout status deployment/paint-arena-frontend --timeout=120s
Assert-NativeCommandSucceeded "Frontend rollout"
kubectl --context $context -n $namespace get pods,svc
Assert-NativeCommandSucceeded "Workload status query"

$adminUrl = "$($PublicBaseUrl.TrimEnd('/'))/admin"
Write-Host ""
Write-Host "Admin access"
Write-Host "  URL:   $adminUrl"
Write-Host "  Token: $effectiveAdminToken"
if ($adminTokenWasGenerated) {
  Write-Host "  The admin token was generated for this deployment. Save it in a password manager."
}
if ($opsTokenWasGenerated) {
  Write-Host "  A separate OPS_EVENT_TOKEN was generated and stored in Secret paint-arena-auth."
}
if ($AllowServerShutdown.IsPresent) {
  Write-Warning "Demo server shutdown is enabled. Use only in an isolated cluster with a working restart policy."
}
Write-Host "  Reuse credentials by passing -AdminToken and -OpsEventToken on the next deployment."
