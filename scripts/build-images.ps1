param([string]$Version = "v1.1.3")

$ErrorActionPreference = "Stop"

function Assert-DockerBuildSucceeded {
  param([string]$Image)

  if ($LASTEXITCODE -ne 0) {
    throw "Docker build for '$Image' failed with exit code $LASTEXITCODE."
  }
}

docker build -f services/game-api/Dockerfile -t "paint-arena-game-api:$Version" .
Assert-DockerBuildSucceeded "paint-arena-game-api:$Version"
docker build -f apps/web/Dockerfile -t "paint-arena-frontend:$Version" .
Assert-DockerBuildSucceeded "paint-arena-frontend:$Version"
docker build -f apps/bot/Dockerfile -t "color-turf-bot:$Version" .
Assert-DockerBuildSucceeded "color-turf-bot:$Version"
Write-Host "Built Color Turf Arena images with version $Version"
