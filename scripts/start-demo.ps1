param(
  [string]$PublicBaseUrl,
  [switch]$Observability
)

$ErrorActionPreference = "Stop"

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  throw "Docker CLI를 찾지 못했습니다. Docker Desktop을 설치하고 다시 실행하세요."
}
docker info --format '{{.ServerVersion}}' *> $null
if ($LASTEXITCODE -ne 0) {
  throw "Docker Engine에 연결할 수 없습니다. Docker Desktop을 시작한 뒤 다시 실행하세요."
}

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

  $networkProfile = Get-NetConnectionProfile -InterfaceIndex $defaultRoute.InterfaceIndex -ErrorAction SilentlyContinue
  if ($networkProfile.NetworkCategory -eq "Public") {
    Write-Warning "현재 Windows 네트워크 프로필이 Public입니다. 휴대폰 접속이 막히면 Private 프로필 또는 개인 핫스팟을 사용하고 TCP 8080 인바운드 규칙을 확인하세요."
  }
}

$env:PUBLIC_BASE_URL = $PublicBaseUrl.TrimEnd("/")

if ($env:PUBLIC_BASE_URL -match '://(localhost|127\.0\.0\.1)(:|/)') {
  Write-Warning "localhost 주소는 휴대폰에서 열리지 않습니다. 물리 기기 검증에는 PC의 LAN IPv4를 사용하세요."
}

if ($Observability) {
  docker compose --profile observability up --build -d
} else {
  docker compose up --build -d
}
if ($LASTEXITCODE -ne 0) {
  throw "Docker Compose 시작에 실패했습니다. 위 build/up 오류를 확인하세요."
}

docker compose ps
$deadline = (Get-Date).AddSeconds(90)
$healthy = $false
do {
  try {
    $health = Invoke-RestMethod -Uri "$($env:PUBLIC_BASE_URL)/healthz" -TimeoutSec 3
    $ready = Invoke-RestMethod -Uri "$($env:PUBLIC_BASE_URL)/readyz" -TimeoutSec 3
    $healthy = $health.status -eq "ok" -and $ready.status -eq "ready"
  } catch {
    Start-Sleep -Seconds 2
  }
} while (-not $healthy -and (Get-Date) -lt $deadline)

if (-not $healthy) {
  throw "90초 안에 LAN 주소의 health/readiness를 확인하지 못했습니다: $($env:PUBLIC_BASE_URL)"
}

Write-Host "Admin: $PublicBaseUrl/admin"
Write-Host "Ops:   $PublicBaseUrl/ops"
if ($Observability) { Write-Host "Prometheus: http://localhost:9090" }
Write-Host "Health/Readiness: OK"
