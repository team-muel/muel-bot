$ErrorActionPreference = "Stop"

$botToken = [Environment]::GetEnvironmentVariable("DISCORD_BOT_TOKEN", "User")
if (-not $botToken) {
  $botToken = [Environment]::GetEnvironmentVariable("DISCORD_BOT_TOKEN", "Machine")
}

if (-not $botToken) {
  throw "Missing DISCORD_BOT_TOKEN in Windows User or Machine environment."
}

$applicationId = [Environment]::GetEnvironmentVariable("DISCORD_APPLICATION_ID", "User")
if (-not $applicationId) {
  $applicationId = [Environment]::GetEnvironmentVariable("DISCORD_APPLICATION_ID", "Machine")
}

$env:DISCORD_BOT_TOKEN = $botToken
if ($applicationId) {
  $env:DISCORD_APPLICATION_ID = $applicationId
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$serverPath = Join-Path $repoRoot "dist\mcpServer.js"

node $serverPath
