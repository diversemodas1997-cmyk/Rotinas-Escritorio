# Deixa as maquinas do escritorio chegarem ao Rotinas-Escritorio neste servidor.
#
#   3443 -> o endereco de uso: https://193.168.0.200:3443 (cabo)
#                              https://192.168.1.158:3443 (Wi-Fi)
#   3001 -> so redireciona para o 3443 (atalhos antigos com http://IP:3001)
#
# Precisa ser rodado como ADMINISTRADOR (botao direito -> Executar com o
# PowerShell como administrador, ou pelo LIBERAR-FIREWALL.bat).
#
# Tambem confere regras de BLOQUEIO para o node.exe: quando alguem clica
# "Cancelar" no aviso do Firewall do Windows na primeira vez que o Node abre uma
# porta, o Windows grava uma regra de bloqueio -- e bloqueio ganha de permissao.
#
# Para desfazer:
#   Remove-NetFirewallRule -DisplayName 'Rotinas-Escritorio *'

$ErrorActionPreference = 'Continue'

$p = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Host "Este script precisa ser rodado como ADMINISTRADOR." -ForegroundColor Red
  exit 1
}

foreach ($porta in 3443, 3001) {
  $nome = "Rotinas-Escritorio $porta"
  if (Get-NetFirewallRule -DisplayName $nome -ErrorAction SilentlyContinue) {
    Write-Host "OK - regra '$nome' ja existe" -ForegroundColor Green
  } else {
    New-NetFirewallRule -DisplayName $nome -Direction Inbound -Protocol TCP -LocalPort $porta -Action Allow -Profile Any | Out-Null
    Write-Host "OK - regra '$nome' criada" -ForegroundColor Green
  }
}

$bloqueios = Get-NetFirewallApplicationFilter -ErrorAction SilentlyContinue |
  Where-Object { $_.Program -like '*node.exe' } |
  Get-NetFirewallRule -ErrorAction SilentlyContinue |
  Where-Object { $_.Action -eq 'Block' -and $_.Direction -eq 'Inbound' -and $_.Enabled -eq 'True' }
if ($bloqueios) {
  foreach ($r in $bloqueios) {
    Disable-NetFirewallRule -Name $r.Name
    Write-Host "OK - regra de bloqueio do node.exe desligada: $($r.DisplayName) ($($r.Profile))" -ForegroundColor Yellow
  }
} else {
  Write-Host "OK - nenhum bloqueio para o node.exe" -ForegroundColor Green
}

Write-Host ""
Write-Host "Pronto. Teste numa maquina do escritorio: https://193.168.0.200:3443" -ForegroundColor Cyan
