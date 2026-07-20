[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ProjectRoot,

    [Parameter(Mandatory = $true)]
    [string]$ConfigPath,

    [Parameter(Mandatory = $true)]
    [string]$ToolConfigPath,

    [string]$CreatorExe,
    [switch]$SkipBundleDependencyCheck
)

$ErrorActionPreference = 'Stop'
$utf8Encoding = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = $utf8Encoding
[Console]::OutputEncoding = $utf8Encoding
$OutputEncoding = $utf8Encoding

trap {
    Write-Host ''
    Write-Host 'Build failed:' -ForegroundColor Red
    Write-Host $_.Exception.Message -ForegroundColor Red
    exit 1
}

function Get-RunningCreatorMainProcesses {
    try {
        $creatorProcesses = @(Get-CimInstance Win32_Process -Filter "Name = 'CocosCreator.exe'" -ErrorAction Stop)

        return @($creatorProcesses | Where-Object {
            $commandLine = [string]$_.CommandLine
            if (-not [string]::IsNullOrWhiteSpace($commandLine)) {
                return $commandLine -notmatch '(?:^|\s)--type='
            }

            $process = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue
            return $process -and $process.MainWindowHandle -ne 0
        })
    }
    catch {
        return @(Get-Process -Name 'CocosCreator' -ErrorAction SilentlyContinue | Where-Object {
            $_.MainWindowHandle -ne 0
        })
    }
}

$projectRoot = (Resolve-Path $ProjectRoot).Path
$configPath = (Resolve-Path $ConfigPath).Path
$toolConfigPath = (Resolve-Path $ToolConfigPath).Path
$buildConfig = Get-Content -LiteralPath $configPath -Encoding utf8 -Raw | ConvertFrom-Json
$toolConfig = Get-Content -LiteralPath $toolConfigPath -Encoding utf8 -Raw | ConvertFrom-Json

$buildPath = [string]$buildConfig.buildPath
$outputName = [string]$buildConfig.outputName

if ([string]::IsNullOrWhiteSpace($buildPath)) {
    throw "buildPath is not configured in: $configPath"
}
if ([string]::IsNullOrWhiteSpace($outputName)) {
    throw "outputName is not configured in: $configPath"
}

if ($buildPath.StartsWith('project://', [StringComparison]::OrdinalIgnoreCase)) {
    $relativeBuildPath = $buildPath.Substring('project://'.Length).TrimStart('/', '\')
    $resolvedBuildPath = Join-Path $projectRoot $relativeBuildPath
}
elseif ($buildPath.StartsWith('file://', [StringComparison]::OrdinalIgnoreCase)) {
    $resolvedBuildPath = ([Uri]$buildPath).LocalPath
}
elseif ([IO.Path]::IsPathRooted($buildPath)) {
    $resolvedBuildPath = $buildPath
}
else {
    throw "Unsupported buildPath '$buildPath' in: $configPath"
}

$outputPath = Join-Path $resolvedBuildPath $outputName
$logDirectory = Join-Path $projectRoot 'temp\builder\log'
$logPath = Join-Path $logDirectory "$outputName-cli.log"
$dependencyCheckerPath = Join-Path $PSScriptRoot 'check-bundle-dependencies.js'

if ([string]::IsNullOrWhiteSpace($CreatorExe)) {
    $CreatorExe = $env:COCOS_CREATOR_EXE
}
if ([string]::IsNullOrWhiteSpace($CreatorExe)) {
    $CreatorExe = [string]$toolConfig.creatorExe
}
if ([string]::IsNullOrWhiteSpace($CreatorExe)) {
    throw "Cocos Creator executable is not configured. Set creatorExe in: $toolConfigPath"
}
if (-not (Test-Path -LiteralPath $CreatorExe -PathType Leaf)) {
    throw "Cocos Creator executable was not found: $CreatorExe. Update creatorExe in: $toolConfigPath"
}

$requiredCreatorVersion = [string]$toolConfig.creatorVersion
if ([string]::IsNullOrWhiteSpace($requiredCreatorVersion)) {
    throw "creatorVersion is not configured in: $toolConfigPath"
}

$creatorVersion = (Get-Item -LiteralPath $CreatorExe).VersionInfo.ProductVersion
if ($creatorVersion -ne $requiredCreatorVersion) {
    throw "Cocos Creator $requiredCreatorVersion is required, but '$creatorVersion' was found at: $CreatorExe"
}

$runningCreatorProcesses = @(Get-RunningCreatorMainProcesses)
if ($runningCreatorProcesses.Count -gt 0) {
    throw 'Cocos Creator is already running. Save the project and close all Creator windows before starting a command-line build.'
}

New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
$buildOptions = "configPath=$configPath;logDest=$logPath"

Write-Host "Cocos Creator: $CreatorExe"
Write-Host "Version:       $creatorVersion"
Write-Host "Project:       $projectRoot"
Write-Host "Config:        $configPath"
Write-Host "Tool config:   $toolConfigPath"
Write-Host "Output:        $outputPath"
Write-Host "Log:           $logPath"

if ($SkipBundleDependencyCheck) {
    Write-Warning 'Source UUID and built bundle dependency validation will be skipped.'
}
else {
    if (-not (Test-Path -LiteralPath $dependencyCheckerPath -PathType Leaf)) {
        throw "Bundle dependency checker was not found: $dependencyCheckerPath"
    }

    $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
    if (-not $nodeCommand) {
        throw 'Node.js was not found. Install Node.js and ensure node.exe is available in PATH.'
    }

    & $nodeCommand.Source $dependencyCheckerPath '--mode' 'source' '--project-root' $projectRoot '--tool-config' $toolConfigPath
    if ($LASTEXITCODE -ne 0) {
        exit $LASTEXITCODE
    }
}

$previousElectronRunAsNode = $env:ELECTRON_RUN_AS_NODE

try {
    Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
    $creatorArguments = @(
        '--project'
        ('"{0}"' -f $projectRoot.Replace('"', '\"'))
        '--build'
        ('"{0}"' -f $buildOptions.Replace('"', '\"'))
    )
    $creatorProcess = Start-Process -FilePath $CreatorExe -ArgumentList $creatorArguments -NoNewWindow -Wait -PassThru
    $creatorExitCode = $creatorProcess.ExitCode
}
finally {
    if ($null -ne $previousElectronRunAsNode) {
        $env:ELECTRON_RUN_AS_NODE = $previousElectronRunAsNode
    }
}

if ($creatorExitCode -ne 36) {
    throw "Cocos Creator build failed with exit code $creatorExitCode. See log: $logPath"
}

$settingsFile = Get-ChildItem -LiteralPath (Join-Path $outputPath 'src') -File -Filter 'settings*.json' -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1

if (-not $settingsFile) {
    throw "Cocos Creator reported success, but no settings JSON was found under: $outputPath\src"
}

Write-Host "Cocos Creator build succeeded: $($settingsFile.FullName)"

if (-not $SkipBundleDependencyCheck) {
    & $nodeCommand.Source $dependencyCheckerPath '--mode' 'built' '--output' $outputPath '--tool-config' $toolConfigPath
    if ($LASTEXITCODE -ne 0) {
        exit $LASTEXITCODE
    }
}

exit 0
