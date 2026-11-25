<#
.SYNOPSIS
  Build OpenWrt for the Xiaomi AX9000 inside Docker.
  The QCN9074 BDF is generated from bdf\upstream at build time (a git-ignored
  bdf\board-xiaomi_ax9000.qcn9074 overrides it). -OemFirmware is optional: it only cross-checks the stock BDF
  frequency range; Xiaomi's BDF is never installed.
.EXAMPLE
  .\build.ps1
.EXAMPLE
  .\build.ps1 -OemFirmware firmware\miwifi_ra70_firmware_cc424_1.0.168.bin
#>
param(
    [string]$OemFirmware = "",
    [switch]$ForceBdf,
    [int]$Jobs = 0,
    [switch]$Shell
)
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

$out = Join-Path $PSScriptRoot "out"
New-Item -ItemType Directory -Force -Path $out | Out-Null
if ($PSBoundParameters.ContainsKey('Jobs') -and $Jobs -le 0) {
    Write-Error "-Jobs must be a positive integer (got $Jobs)"; exit 64
}
if ($Jobs -le 0) {
    $Jobs = [int](docker info --format '{{.NCPU}}')
    if ($Jobs -le 0) { $Jobs = 4 }
}

# Parallel worktrees use separate trees by setting AX9000_TREE_VOLUME.
$treeVolume = if ($env:AX9000_TREE_VOLUME) { $env:AX9000_TREE_VOLUME } else { "ax9000-openwrt" }

docker build -q -t ax9000-builder docker/ | Out-Null
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$force = if ($ForceBdf) { "1" } else { "0" }
$dargs = @("--rm", "-v", "${PSScriptRoot}:/src:ro", "-v", "${out}:/out",
           "-v", "${treeVolume}:/work/openwrt", "-v", "ax9000-dl:/work/dl",
           "-v", "ax9000-ccache:/work/ccache",
           "-e", "JOBS=$Jobs", "-e", "FORCE_BDF=$force")
if ($OemFirmware) {
    if (-not (Test-Path -LiteralPath $OemFirmware -PathType Leaf)) {
        Write-Error "firmware file not found: $OemFirmware"; exit 1
    }
    $fw = (Resolve-Path -LiteralPath $OemFirmware).Path
    $dargs += @("-v", "$(Split-Path $fw -Parent):/firmware:ro",
                "-e", "OEM_FW=/firmware/$(Split-Path $fw -Leaf)")
}
if ($Shell) {
    docker run -it @dargs -w /work/openwrt ax9000-builder bash
} else {
    docker run @dargs ax9000-builder bash /src/scripts/build-openwrt.sh
}
exit $LASTEXITCODE
