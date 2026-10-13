@echo off
rem Faz este computador confiar no certificado do servidor do escritorio
rem (https://193.168.0.200:3443). Copie esta pasta inteira para o PC que nao
rem abre o programa e de dois cliques neste arquivo. Ele pede Administrador.

net session >nul 2>&1
if errorlevel 1 (
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "Import-Certificate -FilePath '%~dp0ca.crt' -CertStoreLocation Cert:\LocalMachine\Root | Out-Null; Write-Host 'Certificado instalado.' -ForegroundColor Green; foreach ($ip in '193.168.0.200','192.168.1.158') { $ok = Test-NetConnection $ip -Port 3443 -InformationLevel Quiet -WarningAction SilentlyContinue; Write-Host ('Servidor em ' + $ip + ': ' + $(if ($ok) {'ALCANCADO'} else {'sem resposta'})) }"

echo.
echo Feche TODAS as janelas do navegador e abra de novo:
echo   https://193.168.0.200:3443   (computador no cabo)
echo   https://192.168.1.158:3443   (computador no Wi-Fi)
echo.
pause
