# Prepara um computador do escritorio para abrir https://rotinas.escritorio:3443
#   1. confia no certificado da fabrica (ca.crt, o mesmo do Gerador-OS);
#   2. ensina o nome rotinas.escritorio no arquivo hosts, apontando para o
#      endereco do servidor que ESTE computador alcanca (cabo .200 ou Wi-Fi .158);
#   3. cria o atalho "Rotinas Escritorio" na area de trabalho de todos os usuarios.
# Nao muda endereco de placa nenhuma. Roda como Administrador (o .bat pede).
# Para desfazer: apagar a linha "rotinas.escritorio" de
# C:\Windows\System32\drivers\etc\hosts e o atalho.

$NOME  = 'rotinas.escritorio'
$PORTA = 3443
$URL   = "https://${NOME}:$PORTA"
$hosts = "$env:SystemRoot\System32\drivers\etc\hosts"

Import-Certificate -FilePath (Join-Path $PSScriptRoot 'ca.crt') -CertStoreLocation Cert:\LocalMachine\Root | Out-Null
Write-Host 'OK - certificado da fabrica instalado.' -ForegroundColor Green

$ip = $null
foreach ($cand in '193.168.0.200', '192.168.1.158') {
  $ok = Test-NetConnection $cand -Port $PORTA -InformationLevel Quiet -WarningAction SilentlyContinue
  Write-Host ("   servidor em {0}: {1}" -f $cand, $(if ($ok) { 'ALCANCADO' } else { 'sem resposta' }))
  if ($ok -and -not $ip) { $ip = $cand }
}

if ($ip) {
  $linhas = @(Get-Content $hosts -ErrorAction SilentlyContinue | Where-Object { $_ -notmatch "\s$([regex]::Escape($NOME))(\s|$)" })
  $linhas += "$ip`t$NOME"
  Set-Content -Path $hosts -Value $linhas -Encoding ASCII
  ipconfig /flushdns | Out-Null
  Write-Host "OK - $NOME aponta para $ip neste computador." -ForegroundColor Green
} else {
  Write-Host "ATENCAO - nenhum endereco do servidor respondeu daqui. O nome NAO foi gravado." -ForegroundColor Red
  Write-Host "   Confira o cabo/Wi-Fi deste computador (ipconfig) e se o servidor esta ligado."
}

$atalho = Join-Path ([Environment]::GetFolderPath('CommonDesktopDirectory')) 'Rotinas Escritorio.url'
Set-Content -Path $atalho -Value "[InternetShortcut]`r`nURL=$URL/" -Encoding ASCII
Write-Host "OK - atalho 'Rotinas Escritorio' criado na area de trabalho." -ForegroundColor Green
