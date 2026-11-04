# fix_platformio.ps1  (ASCII only on purpose: Windows PowerShell 5.1 mis-reads UTF-8 without BOM)
#
# WHAT IT FIXES
#   Build errors whose file path is INSIDE the PlatformIO framework, e.g.
#     C:/Users/xxx/.platformio/packages/framework-arduinoespressif32/libraries/WiFiClientSecure/src/WiFiClientSecure.h:303:3:
#       error: 'WiFiClientSecure' was not declared in this scope        (hundreds of them)
#   Root cause: a framework file was overwritten with pasted project code (radar_common.h). It is NOT a bug in
#   the firmware. The framework package is only a download cache, so the fix is to delete it and let
#   PlatformIO download a clean copy on the next Build.
#
# HOW TO RUN (close VSCode first):
#   Double-click fix_platformio.bat   (next to this file)    or
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\fix_platformio.ps1
#   Options:  -CheckOnly            only report, delete nothing
#             -Force                delete the framework even if no pollution is detected
#             -Projects D:\esp\node_a,D:\esp\node_b    also delete their .pio build folders
param(
  [string]$PkgRoot = "",
  [switch]$CheckOnly,
  [switch]$Force,
  [string[]]$Projects = @()
)

$ErrorActionPreference = "Continue"
if (-not $PkgRoot) {
  $h = $env:USERPROFILE
  if (-not $h) { $h = $HOME }
  $PkgRoot = Join-Path (Join-Path $h ".platformio") "packages"
}
Write-Host "[fix] packages folder: $PkgRoot"
if (-not (Test-Path $PkgRoot)) {
  Write-Host "[fix] folder not found - nothing to repair (PlatformIO has not downloaded anything yet)."
  exit 0
}

# strings that only exist in OUR project files, never in the Arduino-ESP32 framework
$markers = 'postRecs|KAGGLE_URL|RADAR_TOPIC|RADAR_COMMON_LOADED|radar_common|PAIR_MAGIC'
$exts = @(".h", ".hpp", ".c", ".cpp", ".ino")
$frameworks = @(Get-ChildItem -Path $PkgRoot -Directory -Filter "framework-arduinoespressif32*" -ErrorAction SilentlyContinue)
if ($frameworks.Count -eq 0) {
  Write-Host "[fix] no framework-arduinoespressif32 package found - nothing to repair."
}

$removed = 0
foreach ($fw in $frameworks) {
  Write-Host "[scan] $($fw.FullName)"
  $polluted = @()
  foreach ($sub in @("libraries", "cores", "variants")) {
    $p = Join-Path $fw.FullName $sub
    if (-not (Test-Path $p)) { continue }
    $hits = Get-ChildItem -Path $p -Recurse -File -ErrorAction SilentlyContinue |
      Where-Object { $exts -contains $_.Extension.ToLower() } |
      Select-String -Pattern $markers -List -ErrorAction SilentlyContinue
    foreach ($x in $hits) { $polluted += $x.Path }
  }
  if ($polluted.Count -gt 0) {
    Write-Host "[POLLUTED] $($polluted.Count) framework file(s) contain project code:"
    $polluted | ForEach-Object { Write-Host "    $_" }
  } else {
    Write-Host "[ok] no project code found inside this framework package."
  }
  if ($polluted.Count -gt 0 -or $Force) {
    if ($CheckOnly) {
      Write-Host "[skip] -CheckOnly given, not deleting."
    } else {
      try {
        Remove-Item -Recurse -Force -LiteralPath $fw.FullName -ErrorAction Stop
        Write-Host "[fixed] deleted $($fw.FullName)  (PlatformIO will re-download a clean copy on next Build)"
        $removed++
      } catch {
        Write-Host "[error] could not delete (is VSCode / pio still running? close it and retry): $($_.Exception.Message)"
      }
    }
  }
}

foreach ($pr in $Projects) {
  $pio = Join-Path $pr ".pio"
  if (Test-Path $pio) {
    if ($CheckOnly) { Write-Host "[skip] -CheckOnly: would delete $pio" }
    else { Remove-Item -Recurse -Force -LiteralPath $pio -ErrorAction SilentlyContinue; Write-Host "[fixed] deleted $pio" }
  }
}

Write-Host ""
if ($removed -gt 0) {
  Write-Host "[next] 1) open VSCode  2) open ONLY the node_a (or node_b) folder  3) PlatformIO: Build."
  Write-Host "       The first Build re-downloads the framework (hundreds of MB) - keep the network on."
}
Write-Host "[tip ] Prevent it: VSCode Settings -> search files.readonlyInclude -> add  **/.platformio/packages/**  = true"
Write-Host "       and never paste project code into a header you opened by Ctrl+clicking an #include line."
