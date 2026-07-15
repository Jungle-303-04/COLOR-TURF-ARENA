param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("DEPLOYMENT_STARTED", "DEPLOYMENT_COMPLETED", "CANARY_STARTED", "SLO_BREACH", "ROLLBACK_STARTED", "ROLLBACK_COMPLETED", "PRIMARY_UNHEALTHY", "FAILOVER_STARTED", "SNAPSHOT_RESTORED", "FAILOVER_COMPLETED", "SERVICE_RECOVERED")]
  [string]$Type,
  [string]$Message = "Color Turf demo operations event",
  [string]$BaseUrl = "http://localhost:8080",
  [string]$Token = $env:OPS_EVENT_TOKEN,
  [string]$RoomId = ""
)

$ErrorActionPreference = "Stop"
if ([string]::IsNullOrWhiteSpace($Token)) { $Token = "demo-ops" }
$body = @{
  type = $Type
  timestamp = (Get-Date).ToString("o")
  service = "game-server"
  message = $Message
}
if ($RoomId) { $body.roomId = $RoomId }

Invoke-RestMethod -Method Post -Uri "$($BaseUrl.TrimEnd('/'))/api/ops/events" `
  -Headers @{ Authorization = "Bearer $Token" } `
  -ContentType "application/json" `
  -Body ($body | ConvertTo-Json)
