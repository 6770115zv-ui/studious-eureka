$ErrorActionPreference = "Stop"
try {
  $stdin = [Console]::OpenStandardInput()
  $stdout = [Console]::OpenStandardOutput()
  $owner = ""; $repo = ""
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
    }
  }
  $hostDir = Split-Path -Parent $PSCommandPath
  $ok = $true; $err = ""
  try {
    $argsList = @()
    if ($owner -and $repo) { $argsList = @($owner, $repo) }
    $p = Start-Process -FilePath (Join-Path $hostDir "update.bat") -ArgumentList $argsList -WorkingDirectory $hostDir -WindowStyle Hidden -Wait -PassThru
    if ($p.ExitCode -ne 0) { $ok = $false; $err = "Exit code $($p.ExitCode)" }
  } catch { $ok = $false; $err = $_.Exception.Message }
  $bytes = [Text.Encoding]::UTF8.GetBytes((@{ ok = $ok; error = $err } | ConvertTo-Json -Compress))
  $stdout.Write([BitConverter]::GetBytes([int]$bytes.Length), 0, 4)
  $stdout.Write($bytes, 0, $bytes.Length)
  $stdout.Flush()
} catch {}
