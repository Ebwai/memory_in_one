param(
  [Parameter(Mandatory=$true)][string]$PlanPath,
  [ValidateSet('Prepare','Apply','Launch')][string]$Mode = 'Prepare',
  [ValidateRange(2,120)][int]$HealthTimeoutSeconds = 60
)
$ErrorActionPreference = 'Stop'
$plan = Get-Content -LiteralPath $PlanPath -Raw -Encoding UTF8 | ConvertFrom-Json
$root = [IO.Path]::GetFullPath($plan.root).TrimEnd('\')
$stage = [IO.Path]::GetFullPath($plan.stage).TrimEnd('\')
$parent = [IO.Directory]::GetParent($root).FullName
if ([IO.Directory]::GetParent($stage).FullName -ne $parent -or
    -not ([IO.Path]::GetFileName($stage).StartsWith('.workspace-update-')) -or
    [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($PlanPath)) -ne $stage -or
    $plan.executable -ne '工作空间.exe' -or $root -eq $stage) { throw 'Invalid update paths' }
if ($Mode -eq 'Launch') {
  # Give the installer its own hidden Windows console. DETACHED_PROCESS can make
  # Windows PowerShell exit without running a script; sharing the old console
  # can terminate it when Electron exits.
  $arguments = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', ('"' + $PSCommandPath + '"'), '-PlanPath', ('"' + $PlanPath + '"'), '-Mode', 'Apply')
  Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -ArgumentList $arguments -WindowStyle Hidden -RedirectStandardOutput (Join-Path $stage 'install.stdout.log') -RedirectStandardError (Join-Path $stage 'install.stderr.log')
  exit 0
}
$extracted = Join-Path $stage 'extracted'
$backup = Join-Path $stage 'previous'
$healthy = Join-Path $stage 'healthy'
$resultPath = Join-Path $stage 'result.json'
$utf8 = New-Object Text.UTF8Encoding($false)
function Write-Result([string]$status, [string]$message) {
  [IO.File]::WriteAllText($resultPath, (@{status=$status;message=$message} | ConvertTo-Json -Compress), $utf8)
}
function Read-NewRoot {
  $items = @(Get-ChildItem -LiteralPath $extracted -Force)
  if ($items.Count -ne 1 -or -not $items[0].PSIsContainer) { throw 'Expected one application folder' }
  $candidate = $items[0].FullName
  $manifest = Get-Content -LiteralPath (Join-Path $candidate 'workspace-release.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  $package = Get-Content -LiteralPath (Join-Path $candidate 'resources/app/package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($manifest.version -ne $plan.version -or $manifest.platform -ne 'win32' -or
      $manifest.arch -ne $plan.arch -or $package.version -ne $plan.version -or
      $package.name -ne 'personal-information-workspace' -or
      $package.main -ne 'apps/desktop/dist/host/workspace-main.js' -or
      -not (Test-Path -LiteralPath (Join-Path $candidate $plan.executable) -PathType Leaf) -or
      -not (Test-Path -LiteralPath (Join-Path $candidate 'resources/app/apps/desktop/dist/host/workspace-main.js') -PathType Leaf)) { throw 'Invalid application manifest' }
  return $candidate
}
function Move-WithRetry([string]$from, [string]$to) {
  for ($attempt = 0; $attempt -lt 40; $attempt++) {
    try { Move-Item -LiteralPath $from -Destination $to -ErrorAction Stop; return }
    catch { if ($attempt -eq 39) { throw }; Start-Sleep -Milliseconds 500 }
  }
}
if ($Mode -eq 'Prepare') {
  if ([IO.Path]::GetFullPath($plan.archive) -ne (Join-Path $stage 'update.zip')) { throw 'Invalid archive path' }
  $stream = [IO.File]::OpenRead($plan.archive)
  $algorithm = [Security.Cryptography.SHA256]::Create()
  try { $checksum = [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
  finally { $stream.Dispose(); $algorithm.Dispose() }
  if ($checksum -ne $plan.sha256) { throw 'Archive checksum mismatch' }
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zip = [IO.Compression.ZipFile]::OpenRead($plan.archive)
  try {
    $names = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    [long]$total = 0
    if ($zip.Entries.Count -gt 40000) { throw 'Too many archive entries' }
    foreach ($entry in $zip.Entries) {
      $name = $entry.FullName.Replace('/', '\')
      # Reject traversal, NTFS streams, device names, links and case aliases before extraction.
      if ($name -match '(^\\|:|(^|\\)\.\.?($|\\)|[\x00-\x1f]|[. ]($|\\)|(^|\\)(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$|\\))' -or
          (($entry.ExternalAttributes -shr 16) -band 0xF000) -eq 0xA000) { throw 'Unsafe archive entry' }
      $target = [IO.Path]::GetFullPath((Join-Path $extracted $name))
      if (-not $target.StartsWith($extracted + '\', [StringComparison]::OrdinalIgnoreCase) -or -not $names.Add($target.TrimEnd('\'))) { throw 'Archive path escapes staging or is duplicated' }
      $total += $entry.Length
      if ($total -gt 2GB) { throw 'Extracted application is too large' }
    }
  } finally { $zip.Dispose() }
  Expand-Archive -LiteralPath $plan.archive -DestinationPath $extracted
  $null = Read-NewRoot
  Write-Result 'prepared' 'Application verified; waiting for accepted exit.'
  exit 0
}

$applyLock = [IO.File]::Open((Join-Path $stage 'apply.lock'), [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
[IO.File]::WriteAllText((Join-Path $stage 'helper-started'), 'ready', $utf8)
Write-Result 'applying' 'Waiting for the original application to exit.'
$newRoot = Read-NewRoot
if (Test-Path -LiteralPath $backup) { throw 'Backup already exists; update will not overwrite it' }
# Do not terminate the original process. Unsaved-input cancellation keeps it alive.
$deadline = [DateTime]::UtcNow.AddSeconds(120)
while (Get-Process -Id $plan.parentPid -ErrorAction SilentlyContinue) {
  if (Test-Path -LiteralPath (Join-Path $stage 'abort')) { Write-Result 'aborted' 'Installer launch was cancelled.'; exit 1 }
  if ([DateTime]::UtcNow -ge $deadline) { Write-Result 'aborted' 'Original application is still running.'; exit 1 }
  Start-Sleep -Milliseconds 300
}
if (Test-Path -LiteralPath (Join-Path $stage 'abort')) { Write-Result 'aborted' 'Installer launch was cancelled.'; exit 1 }
$movedOld = $false
$movedNew = $false
$newProcess = $null
try {
  Move-WithRetry $root $backup
  $movedOld = $true
  Move-WithRetry $newRoot $root
  $movedNew = $true
  $env:WORKSPACE_UPDATE_PLAN = $PlanPath
  $newProcess = Start-Process -FilePath (Join-Path $root $plan.executable) -WorkingDirectory $root -WindowStyle Hidden -PassThru
  $deadline = [DateTime]::UtcNow.AddSeconds($HealthTimeoutSeconds)
  while ([DateTime]::UtcNow -lt $deadline) {
    if (Test-Path -LiteralPath $healthy) { Write-Result 'installed' 'Application started successfully; previous program retained.'; exit 0 }
    if ($newProcess.HasExited) { throw 'New application exited before startup acknowledgement' }
    Start-Sleep -Milliseconds 300
  }
  throw 'New application startup timed out'
} catch {
  $failure = $_.Exception.Message
  try {
    if ($newProcess -and -not $newProcess.HasExited) {
      # Only terminate the new child we launched, including its own Electron children.
      & taskkill.exe /PID $newProcess.Id /T /F 2>$null | Out-Null
      $newProcess.WaitForExit(10000) | Out-Null
    }
    if ($movedNew) { Move-WithRetry $root (Join-Path $stage 'failed-new') }
    if ($movedOld) { Move-WithRetry $backup $root }
    Write-Result 'rolled-back' $failure
    $env:WORKSPACE_UPDATE_PLAN = $PlanPath
    Start-Process -FilePath (Join-Path $root $plan.executable) -WorkingDirectory $root -WindowStyle Hidden
  } catch { Write-Result 'recovery-required' ($failure + '; ' + $_.Exception.Message); exit 1 }
  exit 1
}
