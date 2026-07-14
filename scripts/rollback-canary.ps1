param(
  [string]$Namespace = "color-turf",
  [string]$Release = "color-turf"
)

$ErrorActionPreference = "Stop"
$deployment = "$Release-server-canary"
Write-Host "Emergency demo rollback: $deployment in $Namespace"
kubectl -n $Namespace rollout undo "deployment/$deployment"
kubectl -n $Namespace rollout status "deployment/$deployment" --timeout=120s
Write-Host "일반 운영에서는 플랫폼 배포 워크플로우를 사용하고, 이 스크립트는 발표 비상 복구에만 사용하세요."
