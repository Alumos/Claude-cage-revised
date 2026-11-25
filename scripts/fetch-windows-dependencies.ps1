#requires -Version 7.0
# Downloads and verifies the pinned archives that build-windows.ps1 bundles,
# so a network failure appears before the build and CI can cache them.
[CmdletBinding()]
param([string]$DependencyCache)
. (Join-Path $PSScriptRoot 'windows-common.ps1')
$repository = Split-Path $PSScriptRoot -Parent
if (-not $DependencyCache) { $DependencyCache = Join-Path $repository '_output/windows-deps' }
$dependencies = Get-Content (Join-Path $repository 'packaging/windows/dependencies.json') -Raw | ConvertFrom-Json
foreach ($name in @('mihomoSource', 'openssh', 'qemu', 'webview2', 'qemuKeycodemap')) {
    $path = Get-VerifiedDependency $dependencies.$name $DependencyCache
    Write-Host "Verified $name at $path"
}
foreach ($wheel in $dependencies.qemuPythonWheels) {
    $path = Get-VerifiedDependency $wheel (Join-Path $DependencyCache 'qemu-python-wheels')
    Write-Host "Verified QEMU build wheel $($wheel.name) at $path"
}
Push-Location $repository
try {
    $node = Get-BuildCommand @('node.exe', 'node')
    Invoke-BuildTool $node @('scripts/bundle-cloud-kit.mjs', '--prefetch')
    Invoke-BuildTool $node @(
        'scripts/build-meowx-core.mjs',
        '--os', 'windows', '--arch', 'amd64',
        '--out', (Join-Path $DependencyCache $dependencies.mihomo.file),
        '--cache-dir', $DependencyCache
    )
} finally { Pop-Location }
