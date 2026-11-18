@echo off
setlocal
set "W=%TEMP%\ytproxy-upd"
if not exist "%W%" mkdir "%W%"
copy /Y "%~dp0boot.ps1" "%W%\boot.ps1" >nul
for %%I in ("%~dp0..") do set "ROOTDIR=%%~fI"
powershell -NoProfile -ExecutionPolicy Bypass -File "%W%\boot.ps1" -RootDir "%ROOTDIR%" -Owner "%~1" -Repo "%~2"
endlocal
