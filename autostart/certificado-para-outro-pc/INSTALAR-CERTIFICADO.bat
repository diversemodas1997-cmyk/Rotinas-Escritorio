@echo off
rem Prepara este computador para abrir o Rotinas-Escritorio em
rem https://rotinas.escritorio:3443 (certificado + nome + atalho).
rem Copie esta pasta inteira para o PC e de dois cliques. Pede Administrador.

net session >nul 2>&1
if errorlevel 1 (
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0configurar-pc.ps1"

echo.
echo Feche TODAS as janelas do navegador e abra pelo atalho
echo "Rotinas Escritorio" ou digite:  https://rotinas.escritorio:3443
echo.
pause
