# ARMS nightly sync - one-time setup on the NAHDIS server. Run as Administrator,
# from a folder that also holds nahdis-export.ps1:
#
#   powershell -ExecutionPolicy Bypass -File .\setup-nahdis.ps1
#
# Creates the local user arms_sync (key logon only; its password is random and
# never recorded), C:\arms-sync with the export and the droplet's public key,
# a SQL login that is db_datareader on the three ARMS databases and nothing
# else, and an sshd_config block that lets that account run the export and
# only the export. Safe to run twice.
$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'
$pub = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIH4dtV4km5e+ND4I5/PkXY4gStIhorFLw+62ULhUziSK arms-sync@aps-droplet'
# 1. Windows user: key logon only; the password is random and never recorded.
if (-not (Get-LocalUser arms_sync -ea 0)) {
  Add-Type -AssemblyName System.Web
  $pw = ConvertTo-SecureString ([System.Web.Security.Membership]::GeneratePassword(32, 6) + 'aA1!') -AsPlainText -Force
  New-LocalUser arms_sync -Password $pw -PasswordNeverExpires -UserMayNotChangePassword -Description 'ARMS nightly sync: read-only export, key only' | Out-Null
  Add-LocalGroupMember -Group Users -Member arms_sync
  "user arms_sync created"
} else { "user arms_sync exists" }

# 2. C:\arms-sync - no inherited 'Authenticated Users: Modify' from C:\.
$d = 'C:\arms-sync'
New-Item -ItemType Directory "$d\work" -Force | Out-Null
icacls $d /inheritance:r /grant:r 'SYSTEM:(OI)(CI)F' 'Administrators:(OI)(CI)F' 'arms_sync:(OI)(CI)RX' | Out-Null
icacls "$d\work" /grant 'arms_sync:(OI)(CI)M' | Out-Null
Copy-Item (Join-Path $PSScriptRoot 'nahdis-export.ps1') "$d\export.ps1" -Force
[IO.File]::WriteAllText("$d\authorized_keys", "$pub`n", (New-Object Text.UTF8Encoding $false))
icacls "$d\authorized_keys" /inheritance:r /grant:r 'SYSTEM:F' 'Administrators:F' 'arms_sync:R' | Out-Null
"files written"

# 3. SQL login: db_datareader on the three ARMS databases, nothing else.
$sql = @"
SET NOCOUNT ON;
IF SUSER_ID(N'WIN-2H3HGT1GHFC\arms_sync') IS NULL CREATE LOGIN [WIN-2H3HGT1GHFC\arms_sync] FROM WINDOWS WITH DEFAULT_DATABASE=[Schedule8Data];
USE [NAHDIS_FSA];    IF USER_ID(N'arms_sync') IS NULL CREATE USER [arms_sync] FOR LOGIN [WIN-2H3HGT1GHFC\arms_sync]; ALTER ROLE db_datareader ADD MEMBER [arms_sync];
USE [Schedule8];     IF USER_ID(N'arms_sync') IS NULL CREATE USER [arms_sync] FOR LOGIN [WIN-2H3HGT1GHFC\arms_sync]; ALTER ROLE db_datareader ADD MEMBER [arms_sync];
USE [Schedule8Data]; IF USER_ID(N'arms_sync') IS NULL CREATE USER [arms_sync] FOR LOGIN [WIN-2H3HGT1GHFC\arms_sync]; ALTER ROLE db_datareader ADD MEMBER [arms_sync];
SELECT 'sql login ok';
"@
sqlcmd -S .\SQLEXPRESS -E -b -h -1 -Q $sql

# 4. sshd: this account may only run the export.
$cfg = 'C:\ProgramData\ssh\sshd_config'
if (-not (Select-String -Path $cfg -Pattern '^Match User arms_sync' -Quiet)) {
  Copy-Item $cfg "$cfg.bak-arms-sync-20261011"
  $block = @"

# ARMS nightly sync - the droplet's key can run the export and nothing else.
Match User arms_sync
       AuthorizedKeysFile C:/arms-sync/authorized_keys
       ForceCommand powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File C:\arms-sync\export.ps1
       PasswordAuthentication no
       AllowTcpForwarding no
       AllowAgentForwarding no
       PermitTTY no
       X11Forwarding no
"@
  Add-Content -Path $cfg -Value $block -Encoding ascii
  & C:\Windows\System32\OpenSSH\sshd.exe -t 2>&1
  if ($LASTEXITCODE -ne 0) { Copy-Item "$cfg.bak-arms-sync-20261011" $cfg -Force; "sshd_config INVALID - restored backup" } else { "sshd_config valid (restart needed)" }
} else { "sshd_config already has the block" }

# 5. Restart sshd from a one-off SYSTEM task, so the restart cannot cut off this session mid-way.
if ((Select-String -Path $cfg -Pattern '^Match User arms_sync' -Quiet)) {
  $at = (Get-Date).AddMinutes(1).ToString('HH:mm')
  schtasks /create /tn ARMS-sshd-restart /tr "powershell -NoProfile -Command Restart-Service sshd" /sc once /st $at /ru SYSTEM /f | Out-Null
  schtasks /run /tn ARMS-sshd-restart | Out-Null
  "sshd restart requested"
}
