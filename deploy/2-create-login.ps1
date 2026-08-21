<#
  Create the SQL login the backend connects as, with exactly the rights it needs
  and none it does not.

      .\2-create-login.ps1 -Suffix "_ARMS"
      .\2-create-login.ps1 -Server "sqlprod,1433" -SqlUser sa -SqlPassword "..."

  It prints a generated password once. Put it in the backend's .env as
  SQL_PASSWORD and do not keep it anywhere else.

  WHY A DEDICATED LOGIN

  The backend must not run as sa, and it must not run as a Windows admin: on a
  Linux host there is no such thing, and the node driver used here is pure
  JavaScript with no integrated-security support. A SQL login with the minimum
  grants is the portable and the safer answer.

  THE GRANT THAT IS EASY TO MISS

  db_datareader does NOT include EXECUTE. The register query calls the scalar
  function NAHDIS_FSA..GetProvince, so without an explicit GRANT EXECUTE every
  page that touches the register dies with "The EXECUTE permission was denied on
  the object 'GetProvince'". That cost us an afternoon; it is one line here.

  WHY db_ddladmin ON THE DATA DATABASE

  `npm run init-db` creates the arms schema (AppUser, Session, AuditLog), three
  lookup indexes, and widens FormDataItems.FDI_Item from varchar(50) to (100) -
  one official disease name is 52 characters. If you would rather the app not
  hold DDL rights in production, run init-db once with an admin login, then
  re-run this script with -NoDdl to drop that membership.
#>
[CmdletBinding()]
param(
  [string]$Server = '.',
  [string]$Suffix = '',
  [string]$LoginName = 'arms_app',
  [string]$Password = '',
  [string]$SqlUser = '',
  [string]$SqlPassword = '',
  [switch]$NoDdl
)

$ErrorActionPreference = 'Stop'

function Invoke-Sql {
  param([string]$Query, [string]$Database = 'master')
  $args = @('-S', $Server, '-d', $Database, '-C', '-b', '-h', '-1', '-W', '-Q', $Query)
  if ($SqlUser) { $args += @('-U', $SqlUser, '-P', $SqlPassword) } else { $args += '-E' }
  $out = & sqlcmd @args
  if ($LASTEXITCODE -ne 0) { throw "sqlcmd failed: $($out -join "`n")" }
  return $out
}

$dataDb = 'Schedule8Data' + $Suffix
$regDb  = 'NAHDIS_FSA' + $Suffix
$formDb = 'Schedule8' + $Suffix

# ---- a password nobody has to invent ---------------------------------------
if (-not $Password) {
  # No look-alike characters: this gets read down a telephone often enough.
  $chars = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'.ToCharArray()
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  $bytes = New-Object byte[] 28
  $rng.GetBytes($bytes)
  $Password = (-join ($bytes | ForEach-Object { $chars[$_ % $chars.Length] })) + '_Aw7'
}

Write-Host ''
Write-Host "  creating login [$LoginName] on $Server" -ForegroundColor Cyan

$esc = $Password.Replace("'", "''")
Invoke-Sql @"
IF SUSER_ID('$LoginName') IS NULL
    CREATE LOGIN [$LoginName] WITH PASSWORD = '$esc', CHECK_POLICY = ON;
ELSE
    ALTER LOGIN [$LoginName] WITH PASSWORD = '$esc';
"@ | Out-Null

# ---- the data database: read, write, and (by default) DDL ------------------
$ddl = if ($NoDdl) { '' } else { "ALTER ROLE db_ddladmin ADD MEMBER [$LoginName];" }
Invoke-Sql -Database $dataDb @"
IF DATABASE_PRINCIPAL_ID('$LoginName') IS NULL CREATE USER [$LoginName] FOR LOGIN [$LoginName];
ALTER ROLE db_datareader ADD MEMBER [$LoginName];
ALTER ROLE db_datawriter ADD MEMBER [$LoginName];
$ddl
GRANT EXECUTE TO [$LoginName];
"@ | Out-Null
Write-Host "    $dataDb : read + write$(if ($NoDdl) { '' } else { ' + ddl' })"

# ---- the register and the form definition: read only -----------------------
foreach ($db in @($regDb, $formDb)) {
  Invoke-Sql -Database $db @"
IF DATABASE_PRINCIPAL_ID('$LoginName') IS NULL CREATE USER [$LoginName] FOR LOGIN [$LoginName];
ALTER ROLE db_datareader ADD MEMBER [$LoginName];
GRANT EXECUTE TO [$LoginName];
"@ | Out-Null
  Write-Host "    $db : read only (+ EXECUTE, for GetProvince)"
}

# ---- prove it, as the login itself -----------------------------------------
Write-Host ''
Write-Host '  checking the login can actually do its job' -ForegroundColor Cyan
$check = & sqlcmd -S $Server -U $LoginName -P $Password -C -b -h -1 -W -d $dataDb -Q @"
SET NOCOUNT ON;
SELECT '    approved returns  ' + CAST(COUNT(*) AS varchar) FROM dbo.FormData WHERE FRMD_Status='Approved';
SELECT '    GetProvince       ' + ISNULL([$regDb].dbo.GetProvince(1),'(null)');
SELECT '    form items        ' + CAST(COUNT(*) AS varchar) FROM [$formDb].dbo.Items;
"@
if ($LASTEXITCODE -ne 0) {
  Write-Host ($check -join "`n")
  throw "the login was created but cannot read what the backend needs"
}
$check | ForEach-Object { if ($_.Trim()) { Write-Host $_ } }

Write-Host ''
Write-Host '  Put these in the backend .env:' -ForegroundColor Cyan
Write-Host ''
Write-Host "    SQL_SERVER=$($Server.Split(',')[0])"
Write-Host "    SQL_PORT=$(if ($Server -match ',(\d+)$') { $Matches[1] } else { '1433' })"
Write-Host '    SQL_AUTH=sql'
Write-Host "    SQL_USER=$LoginName"
Write-Host "    SQL_PASSWORD=$Password"
Write-Host "    DB_DATA=$dataDb"
Write-Host "    DB_REGISTRY=$regDb"
Write-Host "    DB_FORMS=$formDb"
Write-Host ''
Write-Host '  The password is not stored anywhere else and cannot be shown again.' -ForegroundColor Yellow
Write-Host ''
