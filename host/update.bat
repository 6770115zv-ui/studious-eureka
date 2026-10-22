@echo off
powershell -NoProfile -ExecutionPolicy Bypass -Command "$w=Join-Path $env:TEMP 'ytproxy-upd'; New-Item -ItemType Directory -Force -Path $w ^| Out-Null; Copy-Item -LiteralPath (Join-Path '%~dp0' 'boot.ps1') -Destination $w -Force; & (Join-Path $w 'boot.ps1') -RootDir (Split-Path -Parent '%~dp0'.TrimEnd('\')) -Owner '%~1' -Repo '%~2'"
