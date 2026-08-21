<#
  Restore the three ARMS databases onto a SQL Server instance.

  This is the whole "make the cloud server have data in it" step. It is a
  PowerShell script rather than a page of instructions because every one of the
  things it does caught us out at least once, and a script cannot forget them.

  USAGE (run on the database server, as a Windows admin or with -SqlUser):

      .\1-restore-databases.ps1 -BakFolder "D:\arms-baks"
      .\1-restore-databases.ps1 -BakFolder "D:\arms-baks" -Suffix "_ARMS"
      .\1-restore-databases.ps1 -BakFolder "D:\arms-baks" -Server "sqlprod,1433" `
                                -SqlUser sa -SqlPassword (Read-Host -AsSecureString)

  WHAT IT HANDLES, AND WHY

  1. SQL Server's service account, not you, opens the .bak file. It usually
     cannot read a user profile folder, and the failure is a bare
     "Operating system error 5 (Access is denied)" that looks like the file is
     corrupt. The script stages the files somewhere the service can read and
     grants that folder to the service account.

  2. The backups came off a different instance, so their .mdf/.ldf paths do not
     exist on the target. Every restore needs MOVE clauses built from
     RESTORE FILELISTONLY - hardcoding them breaks on the next machine.

  3. The names are parameters. The handover says the databases live on
     .\SQLEXPRESS as Schedule8Data / NAHDIS_FSA / Schedule8; on the build
     machine they are the default instance under _ARMS names. Whatever you
     choose here goes into the backend's .env - nothing is hardcoded either side.

  4. THE NAME NAHDIS_FSA IS NOT FREE. The 2016 trigger on FormData writes
     `NAHDIS_FSA..regions` literally. If some other database on the instance
     carries that name, the trigger silently reads it instead of the real
     register. The script warns when it sees one.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$BakFolder,
  [string]$Server = '.',
  [string]$Suffix = '',
  [string]$StagingFolder = 'C:\arms-restore',
  [string]$SqlUser = '',
  [string]$SqlPassword = '',
  [switch]$Force
)

$ErrorActionPreference = 'Stop'

function Invoke-Sql {
  param([string]$Query, [string]$Database = 'master', [int]$Timeout = 1800)
  $args = @('-S', $Server, '-d', $Database, '-C', '-b', '-h', '-1', '-W', '-t', $Timeout, '-Q', $Query)
  if ($SqlUser) { $args += @('-U', $SqlUser, '-P', $SqlPassword) } else { $args += '-E' }
  # Never 2>&1 a native exe in PowerShell 5.1 - it wraps stderr in an error
  # record and reports failure on success.
  $out = & sqlcmd @args
  if ($LASTEXITCODE -ne 0) { throw "sqlcmd failed: $($out -join "`n")" }
  return $out
}

Write-Host ''
Write-Host '  ARMS - restoring the databases' -ForegroundColor Cyan
Write-Host "  target instance: $Server"
Write-Host ''

# ---- 1. the files ----------------------------------------------------------
$wanted = @{
  'Schedule8Data.bak' = 'Schedule8Data'
  'NAHDIS_FSA.bak'    = 'NAHDIS_FSA'
  'Schedule8.bak'     = 'Schedule8'
}

foreach ($f in $wanted.Keys) {
  $p = Join-Path $BakFolder $f
  if (-not (Test-Path $p)) { throw "missing backup: $p" }
}

# ---- 2. stage where the SQL service account can read -----------------------
# SQL opens the file as its own service account. A user profile path fails with
# operating system error 5, which reads like a corrupt file and is not.
$staged = $StagingFolder
if ((Resolve-Path $BakFolder).Path -ne $staged) {
  New-Item -ItemType Directory -Force $staged | Out-Null
  foreach ($f in $wanted.Keys) { Copy-Item (Join-Path $BakFolder $f) $staged -Force }
  Write-Host "  staged the backups in $staged"

  $svc = (Invoke-Sql "SET NOCOUNT ON; SELECT TOP 1 service_account FROM sys.dm_server_services WHERE servicename LIKE 'SQL Server (%'").Trim()
  if ($svc) {
    # icacls is quiet about a name it cannot map; check rather than assume.
    & icacls $staged /grant "${svc}:(OI)(CI)R" /T | Out-Null
    if ($LASTEXITCODE -eq 0) { Write-Host "  granted read to $svc" }
    else { Write-Warning "could not grant $svc read on $staged - if the restore fails with operating system error 5, do it by hand" }
  }
}

# ---- 3. where the data files should go -------------------------------------
$dataDir = (Invoke-Sql "SET NOCOUNT ON; SELECT CAST(SERVERPROPERTY('InstanceDefaultDataPath') AS varchar(300))").Trim()
if (-not $dataDir) { throw 'could not read the instance default data path' }
Write-Host "  data files will go to $dataDir"
Write-Host ''

# ---- 4. restore ------------------------------------------------------------
foreach ($bak in $wanted.Keys) {
  $db = $wanted[$bak] + $Suffix
  $path = Join-Path $staged $bak

  $exists = (Invoke-Sql "SET NOCOUNT ON; SELECT COUNT(*) FROM sys.databases WHERE name = '$db'").Trim()
  if ($exists -ne '0' -and -not $Force) {
    Write-Warning "$db already exists. Re-run with -Force to overwrite it, or choose a different -Suffix."
    Write-Warning 'Nothing was changed.'
    continue
  }

  # MOVE clauses from the backup's own file list. The .mdf/.ldf paths inside a
  # backup are the ones from the machine it was taken on and will not exist here.
  $fileList = Invoke-Sql "SET NOCOUNT ON; RESTORE FILELISTONLY FROM DISK='$path'"
  $moves = @()
  foreach ($line in $fileList) {
    if ([string]::IsNullOrWhiteSpace($line)) { continue }
    $parts = $line -split '\|'
    if ($parts.Count -lt 3) { continue }
    $logical = $parts[0].Trim()
    $ext = if ($parts[2].Trim() -eq 'L') { 'ldf' } else { 'mdf' }
    $moves += "MOVE N'$logical' TO N'$dataDir\${db}_$logical.$ext'"
  }
  if (-not $moves) { throw "could not read the file list from $path" }

  Write-Host "  restoring $db ..." -NoNewline
  $sql = "RESTORE DATABASE [$db] FROM DISK='$path' WITH " + ($moves -join ', ') + ', REPLACE, RECOVERY, STATS=25'
  Invoke-Sql $sql | Out-Null
  Write-Host ' done'
}

# ---- 5. say what landed ----------------------------------------------------
$dataDb = 'Schedule8Data' + $Suffix
$regDb  = 'NAHDIS_FSA' + $Suffix
$formDb = 'Schedule8' + $Suffix

Write-Host ''
Write-Host '  what was restored' -ForegroundColor Cyan
Invoke-Sql @"
SET NOCOUNT ON;
SELECT '    returns            ' + CAST(COUNT(*) AS varchar) FROM [$dataDb].dbo.FormData;
SELECT '    approved           ' + CAST(COUNT(*) AS varchar) FROM [$dataDb].dbo.FormData WHERE FRMD_Status='Approved';
SELECT '    items              ' + CAST(COUNT(*) AS varchar) FROM [$dataDb].dbo.FormDataItems;
SELECT '    organ rows         ' + CAST(COUNT(*) AS varchar) FROM [$dataDb].dbo.FormDataItemParts;
SELECT '    abattoirs          ' + CAST(COUNT(*) AS varchar) FROM [$regDb].dbo.AbattoirMaster;
SELECT '    form items         ' + CAST(COUNT(*) AS varchar) FROM [$formDb].dbo.Items;
SELECT '    period             ' + CONVERT(varchar(7),MIN(FRMD_StartDate),120) + ' to ' + CONVERT(varchar(7),MAX(FRMD_StartDate),120) FROM [$dataDb].dbo.FormData;
"@ | ForEach-Object { if ($_.Trim()) { Write-Host $_ } }

# ---- 6. the trap worth naming ---------------------------------------------
if ($Suffix -ne '') {
  $clash = (Invoke-Sql "SET NOCOUNT ON; SELECT COUNT(*) FROM sys.databases WHERE name = 'NAHDIS_FSA'").Trim()
  Write-Host ''
  if ($clash -ne '0') {
    Write-Warning 'A database called NAHDIS_FSA also exists on this instance, and it is NOT the one you just restored.'
    Write-Warning 'The 2016 trigger on FormData writes NAHDIS_FSA..regions literally, so it will read that one.'
    Write-Warning 'Set LEGACY_NOTIFY_TRIGGER=disable in the backend .env, or restore without -Suffix.'
  } else {
    Write-Warning "You restored with the suffix '$Suffix'. The 2016 trigger on FormData writes NAHDIS_FSA..regions"
    Write-Warning 'literally and will fail on approval. Set LEGACY_NOTIFY_TRIGGER=disable in the backend .env.'
  }
}

Write-Host ''
Write-Host '  next: .\2-create-login.ps1' -ForegroundColor Cyan
Write-Host ''
