<#
.SYNOPSIS
  Upload the PostMind corpus videos to Cloudflare R2 with rclone (runbooks/corpus-upload.md).

.DESCRIPTION
  Copies exactly the files named in the upload list (written by
  `npm run corpus:scan -- <folder> --upload-list <file>`) from the video folder to
  <remote>:<bucket>/<prefix>. Safe to run again: rclone copy skips files that are already
  uploaded and unchanged, so a stopped upload resumes where it left off. Nothing is deleted,
  locally or in the bucket.

  The R2 key is read from the rclone config file written by `npm run corpus:rclone-config`.
  This script holds no secrets. Windows PowerShell 5.1 compatible.

  rclone flags used (https://rclone.org/docs/, https://rclone.org/filtering/,
  https://rclone.org/commands/rclone_check/, read 2026-09-29): --files-from-raw,
  --transfers, --checkers, --retries, --retries-sleep, --low-level-retries, --progress,
  --log-file, --log-level, --config; check: --one-way, --size-only, --missing-on-dst,
  --differ, --error.

.EXAMPLE
  .\scripts\corpus\upload.ps1 -Source "D:\Videos" -FilesFrom "$env:USERPROFILE\corpus-files.txt" -Test
  .\scripts\corpus\upload.ps1 -Source "D:\Videos" -FilesFrom "$env:USERPROFILE\corpus-files.txt"
  .\scripts\corpus\upload.ps1 -Source "D:\Videos" -FilesFrom "$env:USERPROFILE\corpus-files.txt" -Verify
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Source,
  [Parameter(Mandatory = $true)][string]$FilesFrom,
  [string]$Bucket = 'eu-corpus-source',
  [string]$Prefix = 'videos/',
  [string]$Remote = 'postmind-corpus',
  [string]$Config = (Join-Path $env:USERPROFILE '.config\rclone\postmind-corpus.conf'),
  [string]$LogDir = (Join-Path $env:USERPROFILE 'postmind-corpus-logs'),
  [switch]$Test,
  [int]$TestCount = 20,
  [switch]$Verify,
  [switch]$Quick,
  [switch]$DryRun,
  [int]$Transfers = 8,
  [int]$Checkers = 16,
  [string]$RcloneExe = 'rclone'
)

$ErrorActionPreference = 'Stop'
$utf8NoBom = New-Object System.Text.UTF8Encoding $false

function Fail([string]$Message) {
  Write-Host ''
  Write-Host "STOPPED: $Message" -ForegroundColor Red
  exit 2
}

if ($Test -and $Verify) { Fail 'Use -Test or -Verify, not both.' }
if (-not (Test-Path -LiteralPath $Source -PathType Container)) { Fail "The video folder '$Source' was not found. Is the drive plugged in?" }
if (-not (Test-Path -LiteralPath $FilesFrom -PathType Leaf)) { Fail "The upload list '$FilesFrom' was not found. Run: npm run corpus:scan -- `"$Source`" --upload-list `"$FilesFrom`"" }
if (-not (Test-Path -LiteralPath $Config -PathType Leaf)) { Fail "The rclone config '$Config' was not found. Run: npm run corpus:rclone-config" }
if (-not (Get-Command $RcloneExe -ErrorAction SilentlyContinue)) { Fail 'rclone is not installed. Install it with: winget install Rclone.Rclone  (then open a new PowerShell window)' }
if ($Remote -notmatch '^[A-Za-z0-9_-]+$') { Fail 'The remote name may only have letters, digits, - and _.' }
if ($Bucket -notmatch '^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$') { Fail "'$Bucket' is not a valid bucket name." }

$cleanPrefix = ($Prefix -replace '\\', '/').Trim('/')
$dest = if ($cleanPrefix) { "${Remote}:${Bucket}/${cleanPrefix}" } else { "${Remote}:${Bucket}" }

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$list = (Resolve-Path -LiteralPath $FilesFrom).Path

if ($Test) {
  # The first N files of the list, written as UTF-8 without a BOM and with LF line ends
  # (--files-from-raw reads every byte of a line).
  $all = [System.IO.File]::ReadAllLines($list, $utf8NoBom) | Where-Object { $_ -ne '' }
  $first = @($all | Select-Object -First $TestCount)
  $list = Join-Path $LogDir "test-batch-$stamp.txt"
  [System.IO.File]::WriteAllText($list, (($first -join "`n") + "`n"), $utf8NoBom)
  Write-Host "Test batch: the first $($first.Count) files of the list."
}

$count = @([System.IO.File]::ReadAllLines($list, $utf8NoBom) | Where-Object { $_ -ne '' }).Count
$common = @('--config', $Config, '--files-from-raw', $list, '--checkers', "$Checkers", '--log-level', 'INFO')

if ($Verify) {
  $log = Join-Path $LogDir "verify-$stamp.log"
  $missing = Join-Path $LogDir "verify-$stamp-missing.txt"
  $differ = Join-Path $LogDir "verify-$stamp-different.txt"
  $errors = Join-Path $LogDir "verify-$stamp-errors.txt"
  $rcloneArgs = @('check', $Source, $dest, '--one-way', '--missing-on-dst', $missing, '--differ', $differ, '--error', $errors, '--log-file', $log) + $common
  if ($Quick) { $rcloneArgs += '--size-only' }
  Write-Host "Checking $count files in $dest against '$Source'$(if ($Quick) { ' (sizes only)' } else { ' (sizes and checksums: reads every file, this takes a while)' })..."
} else {
  $log = Join-Path $LogDir "upload-$stamp.log"
  $rcloneArgs = @('copy', $Source, $dest, '--transfers', "$Transfers", '--retries', '5', '--retries-sleep', '30s', '--low-level-retries', '20', '--progress', '--log-file', $log) + $common
  if ($DryRun) { $rcloneArgs += '--dry-run' }
  Write-Host "Uploading $count files from '$Source' to $dest$(if ($DryRun) { ' (DRY RUN: nothing is sent)' })..."
  Write-Host 'Files already uploaded are skipped. You can stop with Ctrl+C and run the same command again later.'
}
Write-Host "Log: $log"
Write-Host ''

& $RcloneExe @rcloneArgs
$code = $LASTEXITCODE

Write-Host ''
if ($code -eq 0) {
  if ($Verify) { Write-Host "OK: all $count files are in the bucket and match." -ForegroundColor Green }
  else { Write-Host "OK: finished. $count files are in $dest." -ForegroundColor Green }
} else {
  Write-Host "rclone stopped with exit code $code. Nothing is lost: run the same command again to retry." -ForegroundColor Yellow
  Write-Host "Details are in the log: $log"
  if ($Verify) { Write-Host "Missing files: $missing  Different files: $differ  Read errors: $errors" }
}
exit $code
