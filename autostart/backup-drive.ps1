# Copia o backup diario do banco do Rotinas-Escritorio para o Google Drive.
#
# O proprio servidor ja grava, uma vez por dia, server\backups\database.<data>.sqlite
# com a API de backup do SQLite (copia consistente mesmo com o banco aberto em
# modo WAL -- copiar o database.sqlite direto daria um arquivo quase vazio).
# Este script so leva o mais recente desses para o Drive e guarda $Manter dias.
#
# Roda pela tarefa 'RotinasEscritorio-Backup-Drive' (instalar-backup-drive.ps1).
# Log: autostart\backup-drive.log

param(
  [string] $Destino = 'J:\Meu Drive\Backup Rotinas-Escritorio',
  [int]    $Manter  = 30
)

$ErrorActionPreference = 'Stop'
$aqui   = Split-Path -Parent $MyInvocation.MyCommand.Path
$origem = Join-Path $aqui '..\server\backups'
$log    = Join-Path $aqui 'backup-drive.log'
function Anotar($t) { Add-Content -Path $log -Value ("[{0:yyyy-MM-dd HH:mm}] {1}" -f (Get-Date), $t) -Encoding UTF8 }

try {
  # O Drive so existe como J: com a sessao aberta. Sem ele, gravar criaria a
  # pasta no disco local e daria a falsa impressao de backup na nuvem.
  $raiz = [System.IO.Path]::GetPathRoot($Destino)
  if ($raiz -and -not (Test-Path $raiz)) { Anotar "FALHA: unidade $raiz indisponivel (Google Drive fora do ar?). Nada gravado."; exit 1 }

  $ultimo = Get-ChildItem $origem -Filter 'database.????-??-??.sqlite' | Sort-Object Name | Select-Object -Last 1
  if (-not $ultimo) { Anotar "FALHA: nenhum database.<data>.sqlite em $origem (servidor ligado?)"; exit 1 }

  if (-not (Test-Path $Destino)) { New-Item -ItemType Directory -Path $Destino | Out-Null }
  Copy-Item $ultimo.FullName (Join-Path $Destino $ultimo.Name) -Force
  Anotar ("ok  {0} ({1:N0} KB) -> {2}" -f $ultimo.Name, ($ultimo.Length / 1KB), $Destino)

  $antigos = Get-ChildItem $Destino -Filter 'database.????-??-??.sqlite' | Sort-Object Name
  if ($antigos.Count -gt $Manter) {
    $antigos | Select-Object -First ($antigos.Count - $Manter) | ForEach-Object { Remove-Item $_.FullName; Anotar "apagado (mais de $Manter): $($_.Name)" }
  }
} catch {
  Anotar "FALHA: $($_.Exception.Message)"
  exit 1
}
