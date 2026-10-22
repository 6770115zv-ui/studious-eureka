param([Parameter(Mandatory=$true)][string]$RootDir, [string]$Owner="", [string]$Repo="")
$ErrorActionPreference = "Stop"
$ExtDir = Join-Path $RootDir "extension"
$work = Join-Path $env:TEMP "ytproxy-upd"
New-Item -ItemType Directory -Force -Path $work | Out-Null
try {
  $cfgPath = Join-Path $ExtDir "config.js"
  if ((-not $Owner -or -not $Repo) -and (Test-Path -LiteralPath $cfgPath)) {
    $t = Get-Content -LiteralPath $cfgPath -Raw
    if (-not $Owner) { $Owner = [regex]::Match($t, 'updateOwner:\s*"([^"]*)"').Groups[1].Value }
    if (-not $Repo)  { $Repo  = [regex]::Match($t, 'updateRepo:\s*"([^"]*)"').Groups[1].Value }
  }
  if (-not $Owner -or -not $Repo) { throw "Missing updateOwner/updateRepo" }
  $zip = Join-Path $work "src.zip"
  $ex = Join-Path $work "extract"
  if (Test-Path -LiteralPath $ex) { Remove-Item -LiteralPath $ex -Recurse -Force }
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  Invoke-WebRequest -Uri "https://github.com/$Owner/$Repo/archive/refs/heads/main.zip" -OutFile $zip -UseBasicParsing
  Expand-Archive -LiteralPath $zip -DestinationPath $ex -Force
  $srcExt = Join-Path $ex "$Repo-main\extension"
  $srcFull = (Resolve-Path -LiteralPath $srcExt).Path
  Get-ChildItem -LiteralPath $srcExt -Recurse -File | ForEach-Object {
    $rel = $_.FullName.Substring($srcFull.Length).TrimStart("\", "/")
    if ($rel -ieq "config.js" -or $rel -ieq "config.example.js") { return }
    $dest = Join-Path $ExtDir $rel
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dest) | Out-Null
    Copy-Item -LiteralPath $_.FullName -Destination $dest -Force
  }
  exit 0
} catch { exit 1 }
