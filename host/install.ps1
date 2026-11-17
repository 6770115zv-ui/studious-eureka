$ErrorActionPreference = "Stop"
$extId = "kmheagojoblajngklnaajhdfkglpbgmk"
$hostName = "com.rafi.ytproxy.updater"
$hostDir = Split-Path -Parent $PSCommandPath
$batPath = Join-Path $hostDir "nm-host.bat"
$cfgDir = Join-Path $env:LOCALAPPDATA "ytproxy"
New-Item -ItemType Directory -Force -Path $cfgDir | Out-Null
$manifestPath = Join-Path $cfgDir "$hostName.json"
$manifest = [ordered]@{
  name = $hostName
  description = "YouTube Proxy Ultra self-updater"
  path = $batPath
  type = "stdio"
  allowed_origins = @("chrome-extension://$extId/")
}
[IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json -Depth 5), (New-Object Text.UTF8Encoding($false)))
$roots = @(
  "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$hostName",
  "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$hostName",
  "HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\$hostName"
)
foreach ($k in $roots) {
  try {
    New-Item -Path $k -Force | Out-Null
    Set-ItemProperty -Path $k -Name "(default)" -Value $manifestPath
  } catch {}
}
Write-Host "Updater registered successfully." -ForegroundColor Green
