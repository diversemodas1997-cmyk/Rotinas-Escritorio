@echo off
:: Pede administrador e roda o liberar-portas-firewall.ps1 ao lado.
net session >nul 2>&1
if %errorlevel% neq 0 (
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0liberar-portas-firewall.ps1"
pause
