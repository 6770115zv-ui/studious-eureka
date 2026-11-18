$ErrorActionPreference = "Stop"
try {
  $stdin = [Console]::OpenStandardInput()
  $stdout = [Console]::OpenStandardOutput()
  $owner = ""; $repo = ""; $token = ""
  $lenBuf = New-Object byte[] 4
  if ($stdin.Read($lenBuf, 0, 4) -ge 4) {
    $len = [BitConverter]::ToInt32($lenBuf, 0)
    if ($len -gt 0 -and $len -lt 1048576) {
      $msg = New-Object byte[] $len
      $off = 0
      while ($off -lt $len) {
        $n = $stdin.Read($msg, $off, $len - $off)
        if ($n -le 0) { break }
        $off += $n
      }
      $payload = [Text.Encoding]::UTF8.GetString($msg) | ConvertFrom-Json
      if ($payload.updateOwner) { $owner = [string]$payload.updateOwner }
      if ($payload.updateRepo)  { $repo  = [string]$payload.updateRepo }
      if ($payload.token)       { $token = [string]$payload.token }
    }
  }

  $ok = $true; $err = ""
  if ($owner -and $owner -notmatch '^[a-zA-Z0-9._-]+$') { throw "Invalid updateOwner format" }
  if ($repo  -and $repo  -notmatch '^[a-zA-Z0-9._-]+$') { throw "Invalid updateRepo format" }

  $hostDir = Split-Path -Parent $PSCommandPath
  $rootDir = Split-Path -Parent $hostDir
  $workDir = Join-Path $env:TEMP "ytproxy-upd"
  New-Item -ItemType Directory -Force -Path $workDir | Out-Null
  $bootCopy = Join-Path $workDir "boot.ps1"
  Copy-Item -LiteralPath (Join-Path $hostDir "boot.ps1") -Destination $bootCopy -Force

  try {
    $env:YTPROXY_UPDATE_TOKEN = $token
    $psArgs = @(
      "-NoProfile", "-ExecutionPolicy", "Bypass",
      "-File", $bootCopy,
      "-RootDir", $rootDir
    )
    if ($owner) { $psArgs += @("-Owner", $owner) }
    if ($repo)  { $psArgs += @("-Repo", $repo) }

    $p = Start-Process -FilePath "powershell.exe" -ArgumentList $psArgs -WorkingDirectory $workDir -WindowStyle Hidden -Wait -PassThru
    if ($p.ExitCode -ne 0) { $ok = $false; $err = "Exit code $($p.ExitCode)" }
  } catch {
    $ok = $false; $err = $_.Exception.Message
  } finally {
    Remove-Item Env:\YTPROXY_UPDATE_TOKEN -ErrorAction SilentlyContinue
  }

  $bytes = [Text.Encoding]::UTF8.GetBytes((@{ ok = $ok; error = $err } | ConvertTo-Json -Compress))
  $stdout.Write([BitConverter]::GetBytes([int]$bytes.Length), 0, 4)
  $stdout.Write($bytes, 0, $bytes.Length)
  $stdout.Flush()
} catch {
  try {
    $stdout = [Console]::OpenStandardOutput()
    $bytes = [Text.Encoding]::UTF8.GetBytes((@{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress))
    $stdout.Write([BitConverter]::GetBytes([int]$bytes.Length), 0, 4)
    $stdout.Write($bytes, 0, $bytes.Length)
    $stdout.Flush()
  } catch {}
}
