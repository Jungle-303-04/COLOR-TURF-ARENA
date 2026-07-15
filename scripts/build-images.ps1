param([string]$Version = "v1.1.3")

$ErrorActionPreference = "Stop"
docker build -f services/game-api/Dockerfile -t "paint-arena-game-api:$Version" .
docker build -f apps/web/Dockerfile -t "paint-arena-frontend:$Version" .
docker build -f apps/bot/Dockerfile -t "color-turf-bot:$Version" .
Write-Host "Built Color Turf Arena images with version $Version"
