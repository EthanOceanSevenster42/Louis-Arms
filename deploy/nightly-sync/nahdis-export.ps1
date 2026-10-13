# ARMS nightly sync - export side. Runs on the NAHDIS server as arms_sync,
# forced by sshd_config, so the droplet's key can do this and nothing else.
#
# Reads the three ARMS databases (arms_sync is db_datareader only), keeps
# returns up to the end of the last complete month, and writes one zip to
# stdout as base64 between ARMS-SYNC-BEGIN / ARMS-SYNC-END markers.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$tables = @(
  'NAHDIS_FSA.AbattoirMaster', 'NAHDIS_FSA.Applications', 'NAHDIS_FSA.Industries',
  'NAHDIS_FSA.Organisation', 'NAHDIS_FSA.OrganisationAbattoirLinks',
  'NAHDIS_FSA.OrganisationApplications', 'NAHDIS_FSA.OrganisationSpecies',
  'NAHDIS_FSA.OrganisationType', 'NAHDIS_FSA.OrgUsers', 'NAHDIS_FSA.Regions',
  'NAHDIS_FSA.Species', 'NAHDIS_FSA.Users',
  'Schedule8.FormProperties', 'Schedule8.Forms', 'Schedule8.Groups', 'Schedule8.Items',
  'Schedule8.ItemsSpeciesLink', 'Schedule8.ItemTypes', 'Schedule8.LNK_ROLE_PERMISSION',
  'Schedule8.LNK_Users_ROLE', 'Schedule8.NotificationTemplates',
  'Schedule8.NotificationTemplates_Backup_BeforeURLFix', 'Schedule8.OtherItems',
  'Schedule8.Parts', 'Schedule8.PERMISSIONS', 'Schedule8.Reports', 'Schedule8.ROLES',
  'Schedule8Data.FormData', 'Schedule8Data.FormDataItemParts', 'Schedule8Data.FormDataItems',
  'Schedule8Data.FormDataSR1Link', 'Schedule8Data.NotificationData', 'Schedule8Data.SRF_SR1FormData'
)

# Last complete month: everything before the 1st of this month, server time (SAST).
$cutDate = (Get-Date -Day 1).ToString('yyyy-MM-dd')
$cut = "FRMD_StartDate < '$cutDate'"
$filter = @{
  'Schedule8Data.FormData'          = "WHERE $cut"
  'Schedule8Data.FormDataItems'     = "WHERE FRMD_ID IN (SELECT FRMD_Id FROM FormData WHERE $cut)"
  'Schedule8Data.FormDataItemParts' = "WHERE FDI_ID IN (SELECT i.FDI_Id FROM FormDataItems i JOIN FormData f ON f.FRMD_Id=i.FRMD_ID WHERE f.$cut)"
  'Schedule8Data.FormDataSR1Link'   = "WHERE FRMD_Id IN (SELECT FRMD_Id FROM FormData WHERE $cut)"
}

$inv = [Globalization.CultureInfo]::InvariantCulture
$utf8 = New-Object Text.UTF8Encoding $false
# Postgres COPY text format (and MySQL LOAD DATA): tab-separated, backslash escapes, \N for NULL.
function Esc($v) {
  if ($v -is [DBNull]) { return '\N' }
  if ($v -is [DateTime]) { return $v.ToString('yyyy-MM-dd HH:mm:ss', $inv) }
  if ($v -is [bool]) { if ($v) { return '1' } else { return '0' } }
  if ($v -is [byte[]]) { return [BitConverter]::ToString($v).Replace('-','') }
  if ($v -is [IFormattable]) { $s = $v.ToString($null, $inv) } else { $s = [string]$v }
  return $s.Replace('\','\\').Replace("`t",'\t').Replace("`n",'\n').Replace("`r",'\r').Replace([string][char]0,'\0')
}

$work = Join-Path 'C:\arms-sync\work' ([guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory $work | Out-Null
try {
  $manifest = New-Object Collections.Generic.List[string]
  $manifest.Add("cutoff`t$cutDate")
  foreach ($full in $tables) {
    $db, $t = $full.Split('.')
    $cn = New-Object System.Data.SqlClient.SqlConnection "Server=.\SQLEXPRESS;Database=$db;Integrated Security=true;ApplicationIntent=ReadOnly"
    $cn.Open()
    try {
      $cmd = $cn.CreateCommand(); $cmd.CommandTimeout = 900
      $cmd.CommandText = "SELECT * FROM [dbo].[$t] " + $filter[$full]
      $r = $cmd.ExecuteReader()
      $w = New-Object IO.StreamWriter((Join-Path $work "$full.tsv"), $false, $utf8)
      $w.NewLine = "`n"
      $w.WriteLine(((0..($r.FieldCount-1)) | % { $r.GetName($_) }) -join "`t")
      $n = 0
      $vals = New-Object object[] $r.FieldCount
      while ($r.Read()) { [void]$r.GetValues($vals); $w.WriteLine((($vals | % { Esc $_ }) -join "`t")); $n++ }
      $w.Close()
      $manifest.Add("$full`t$n")
    } finally { $cn.Close() }
  }
  [IO.File]::WriteAllLines((Join-Path $work 'manifest.tsv'), $manifest, $utf8)
  $zip = "$work.zip"
  Compress-Archive -Path "$work\*" -DestinationPath $zip
  $bytes = [IO.File]::ReadAllBytes($zip)
  $sha = [BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($bytes)).Replace('-','').ToLower()
  [Console]::Out.WriteLine("ARMS-SYNC-BEGIN $cutDate")
  [Console]::Out.WriteLine([Convert]::ToBase64String($bytes, 'InsertLineBreaks'))
  [Console]::Out.WriteLine("ARMS-SYNC-END $sha")
} catch {
  [Console]::Out.WriteLine("ARMS-SYNC-ERROR $($_.Exception.Message)")
  exit 1
} finally {
  Remove-Item $work, "$work.zip" -Recurse -Force -ErrorAction SilentlyContinue
}
