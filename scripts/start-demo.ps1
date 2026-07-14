param(
  [string]$PublicBaseUrl,
  [switch]$Observability
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($PublicBaseUrl)) {
  $defaultRoute = Get-NetRoute -AddressFamily IPv4 -DestinationPrefix "0.0.0.0/0" |
    Where-Object { $_.State -eq "Alive" } |
    Sort-Object RouteMetric, InterfaceMetric |
    Select-Object -First 1

  if (-not $defaultRoute) {
    throw "활성 IPv4 기본 경로를 찾지 못했습니다. -PublicBaseUrl을 직접 지정하세요."
  }

  $lanAddress = Get-NetIPAddress -AddressFamily IPv4 -InterfaceIndex $defaultRoute.InterfaceIndex |
    Where-Object {
      $_.AddressState -eq "Preferred" -and
      $_.IPAddress -notlike "127.*" -and
      $_.IPAddress -notlike "169.254*"
    } |
    Select-Object -First 1

  if (-not $lanAddress) {
    throw "활성 LAN IPv4 주소를 찾지 못했습니다. -PublicBaseUrl을 직접 지정하세요."
  }

  $PublicBaseUrl = "http://$($lanAddress.IPAddress):8080"
  Write-Host "감지한 LAN 주소를 QR 기준 주소로 사용합니다: $PublicBaseUrl"
}

$env:PUBLIC_BASE_URL = $PublicBaseUrl.TrimEnd("/")

if ($Observability) {
  docker compose --profile observability up --build -d
} else {
  docker compose up --build -d
}

docker compose ps
Write-Host "Admin: $PublicBaseUrl/admin"
Write-Host "Ops:   $PublicBaseUrl/ops"
