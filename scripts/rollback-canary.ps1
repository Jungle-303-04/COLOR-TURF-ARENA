param(
  [string]$Namespace = "color-turf",
  [string]$Release = "color-turf",
  [string]$Chart = (Join-Path $PSScriptRoot "..\deploy\helm\color-turf")
)

$ErrorActionPreference = "Stop"
$deployment = "$Release-server-canary"
$resolvedChart = (Resolve-Path -LiteralPath $Chart).Path

Write-Host "Emergency Helm rollback: disable Canary in release $Release ($Namespace)"
helm upgrade $Release $resolvedChart `
  --namespace $Namespace `
  --reuse-values `
  --set canary.enabled=false `
  --wait `
  --timeout 2m

kubectl -n $Namespace rollout status "deployment/$Release-server-stable" --timeout=120s
kubectl -n $Namespace get "deployment/$deployment" 2>$null
if ($LASTEXITCODE -eq 0) {
  throw "Canary deployment still exists after Helm rollback: $deployment"
}

Write-Host "Canary Deployment가 Helm 상태와 함께 제거되었습니다."
