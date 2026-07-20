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

function New-BundleDependencyPolicy {
    param([object]$ToolConfig)

    $bundleGroups = $ToolConfig.bundleGroups
    $forbiddenBundleDependencies = @($ToolConfig.forbiddenBundleDependencies)

    if (-not $bundleGroups -or $forbiddenBundleDependencies.Count -eq 0) {
        return $null
    }

    $bundleToGroup = @{}
    foreach ($groupProperty in ($bundleGroups.PSObject.Properties | Sort-Object Name)) {
        $groupName = $groupProperty.Name

        foreach ($bundleNameValue in @($groupProperty.Value)) {
            $bundleName = [string]$bundleNameValue
            if ([string]::IsNullOrWhiteSpace($bundleName)) {
                throw "Bundle group '$groupName' contains an empty bundle name."
            }

            if ($bundleToGroup.ContainsKey($bundleName)) {
                throw "Bundle '$bundleName' belongs to multiple groups: '$($bundleToGroup[$bundleName])' and '$groupName'."
            }

            $bundleToGroup[$bundleName] = $groupName
        }
    }

    $rules = [System.Collections.Generic.List[object]]::new()
    foreach ($bundleRule in $forbiddenBundleDependencies) {
        $fromGroup = [string]$bundleRule.fromGroup
        $toGroups = [System.Collections.Generic.List[string]]::new()

        if ($bundleRule.toGroup) {
            $toGroups.Add([string]$bundleRule.toGroup)
        }
        if ($bundleRule.toGroups) {
            foreach ($toGroupValue in @($bundleRule.toGroups)) {
                $toGroups.Add([string]$toGroupValue)
            }
        }

        if ([string]::IsNullOrWhiteSpace($fromGroup) -or -not $bundleGroups.PSObject.Properties[$fromGroup]) {
            throw "Bundle dependency rule '$($bundleRule.name)' references unknown fromGroup '$fromGroup'."
        }
        if ($toGroups.Count -eq 0) {
            throw "Bundle dependency rule '$($bundleRule.name)' does not define toGroup or toGroups."
        }

        foreach ($toGroup in $toGroups) {
            if ($toGroup -ne '*' -and -not $bundleGroups.PSObject.Properties[$toGroup]) {
                throw "Bundle dependency rule '$($bundleRule.name)' references unknown target group '$toGroup'."
            }
        }

        $ruleName = [string]$bundleRule.name
        if ([string]::IsNullOrWhiteSpace($ruleName)) {
            throw 'A bundle dependency rule is missing its name.'
        }

        $rules.Add([PSCustomObject]@{
            Name = $ruleName
            FromGroup = $fromGroup
            ToGroups = @($toGroups)
        })
    }

    $unknownBundlePolicy = [string]$ToolConfig.unknownBundlePolicy
    if ([string]::IsNullOrWhiteSpace($unknownBundlePolicy)) {
        $unknownBundlePolicy = 'error'
    }
    if ($unknownBundlePolicy -notin @('error', 'ignore')) {
        throw "Unsupported unknownBundlePolicy '$unknownBundlePolicy'. Expected 'error' or 'ignore'."
    }

    return [PSCustomObject]@{
        BundleToGroup = $bundleToGroup
        Rules = @($rules)
        UnknownBundlePolicy = $unknownBundlePolicy
    }
}

function Find-ForbiddenBundleDependencyRule {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Policy,

        [Parameter(Mandatory = $true)]
        [string]$FromBundle,

        [Parameter(Mandatory = $true)]
        [string]$ToBundle
    )

    if (-not $Policy.BundleToGroup.ContainsKey($FromBundle) -or -not $Policy.BundleToGroup.ContainsKey($ToBundle)) {
        return $null
    }

    $fromGroup = [string]$Policy.BundleToGroup[$FromBundle]
    $toGroup = [string]$Policy.BundleToGroup[$ToBundle]

    foreach ($rule in $Policy.Rules) {
        if ($rule.FromGroup -eq $fromGroup -and ($rule.ToGroups -contains '*' -or $rule.ToGroups -contains $toGroup)) {
            return $rule
        }
    }

    return $null
}

function Get-ProjectRelativePath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ProjectRoot,

        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    $rootPrefix = $ProjectRoot.TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
    if ($Path.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        return $Path.Substring($rootPrefix.Length)
    }

    return $Path
}

function Get-SourceBundleNameForPath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,

        [Parameter(Mandatory = $true)]
        [object[]]$BundleRoots
    )

    foreach ($bundleRoot in $BundleRoots) {
        $rootPrefix = $bundleRoot.Path.TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
        if ($Path.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
            return $bundleRoot.Name
        }
    }

    return $null
}

function Get-SourceBundleRoots {
    param(
        [Parameter(Mandatory = $true)]
        [string]$AssetsPath,

        [Parameter(Mandatory = $true)]
        [object]$Policy
    )

    $rootsByName = @{}
    $unknownBundles = [System.Collections.Generic.List[string]]::new()

    foreach ($metaFile in (Get-ChildItem -LiteralPath $AssetsPath -Recurse -File -Filter '*.meta' | Sort-Object FullName)) {
        try {
            $meta = Get-Content -LiteralPath $metaFile.FullName -Encoding utf8 -Raw | ConvertFrom-Json
        }
        catch {
            throw "Invalid Cocos meta JSON: $($metaFile.FullName). $($_.Exception.Message)"
        }

        if ($meta.importer -ne 'directory' -or $meta.userData.isBundle -ne $true) {
            continue
        }

        $bundlePath = $metaFile.FullName.Substring(0, $metaFile.FullName.Length - '.meta'.Length)
        if (-not (Test-Path -LiteralPath $bundlePath -PathType Container)) {
            continue
        }

        $bundleName = [string]$meta.userData.bundleName
        if ([string]::IsNullOrWhiteSpace($bundleName)) {
            $bundleName = Split-Path -Leaf $bundlePath
        }

        if (-not $Policy.BundleToGroup.ContainsKey($bundleName)) {
            if ($Policy.UnknownBundlePolicy -eq 'error') {
                $unknownBundles.Add("$bundleName ($bundlePath)")
            }
            else {
                Write-Warning "Ignoring unregistered source bundle '$bundleName': $bundlePath"
            }
            continue
        }

        if ($rootsByName.ContainsKey($bundleName)) {
            throw "Bundle '$bundleName' has multiple source roots: '$($rootsByName[$bundleName])' and '$bundlePath'."
        }

        $rootsByName[$bundleName] = $bundlePath
    }

    if ($unknownBundles.Count -gt 0) {
        throw "Unregistered source bundles were found: $($unknownBundles -join ', ')"
    }

    $bundleRoots = [System.Collections.Generic.List[object]]::new()
    foreach ($bundleName in ($rootsByName.Keys | Sort-Object)) {
        $bundleRoots.Add([PSCustomObject]@{
            Name = $bundleName
            Path = [string]$rootsByName[$bundleName]
        })
    }

    return @($bundleRoots | Sort-Object { $_.Path.Length } -Descending)
}

function Invoke-SourceBundleDependencyCheck {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ProjectRoot,

        [Parameter(Mandatory = $true)]
        [object]$Policy
    )

    $assetsPath = Join-Path $ProjectRoot 'assets'
    $bundleRoots = @(Get-SourceBundleRoots -AssetsPath $assetsPath -Policy $Policy)
    $uuidIndex = @{}

    foreach ($metaFile in (Get-ChildItem -LiteralPath $AssetsPath -Recurse -File -Filter '*.meta' | Sort-Object FullName)) {
        $targetBundle = Get-SourceBundleNameForPath -Path $metaFile.FullName -BundleRoots $bundleRoots
        if ([string]::IsNullOrWhiteSpace($targetBundle)) {
            continue
        }

        $targetAsset = $metaFile.FullName.Substring(0, $metaFile.FullName.Length - '.meta'.Length)
        $metaText = Get-Content -LiteralPath $metaFile.FullName -Encoding utf8 -Raw

        foreach ($uuidMatch in [regex]::Matches($metaText, '"uuid"\s*:\s*"([^"]+)"')) {
            $uuid = $uuidMatch.Groups[1].Value
            if ($uuidIndex.ContainsKey($uuid)) {
                $existing = $uuidIndex[$uuid]
                if ($existing.Asset -ne $targetAsset) {
                    throw "Duplicate asset UUID '$uuid': '$($existing.Asset)' and '$targetAsset'."
                }
                continue
            }

            $uuidIndex[$uuid] = [PSCustomObject]@{
                Bundle = $targetBundle
                Asset = $targetAsset
            }
        }
    }

    $serializedAssetExtensions = @('.anim', '.labelatlas', '.material', '.mtl', '.particle', '.prefab', '.scene', '.spriteatlas')
    $violationByKey = @{}

    foreach ($sourceFile in (Get-ChildItem -LiteralPath $AssetsPath -Recurse -File | Where-Object { $serializedAssetExtensions -contains $_.Extension } | Sort-Object FullName)) {
        $sourceBundle = Get-SourceBundleNameForPath -Path $sourceFile.FullName -BundleRoots $bundleRoots
        if ([string]::IsNullOrWhiteSpace($sourceBundle)) {
            continue
        }

        foreach ($matchInfo in (Select-String -LiteralPath $sourceFile.FullName -Encoding utf8 -Pattern '"__uuid__"\s*:\s*"([^"]+)"' -AllMatches)) {
            foreach ($uuidMatch in $matchInfo.Matches) {
                $uuid = $uuidMatch.Groups[1].Value
                if (-not $uuidIndex.ContainsKey($uuid)) {
                    continue
                }

                $target = $uuidIndex[$uuid]
                if ($target.Bundle -eq $sourceBundle) {
                    continue
                }

                $rule = Find-ForbiddenBundleDependencyRule -Policy $Policy -FromBundle $sourceBundle -ToBundle $target.Bundle
                if (-not $rule) {
                    continue
                }

                $violationKey = "$sourceBundle|$($target.Bundle)|$($sourceFile.FullName)|$($target.Asset)|$($rule.Name)"
                if (-not $violationByKey.ContainsKey($violationKey)) {
                    $violationByKey[$violationKey] = [PSCustomObject]@{
                        SourceBundle = $sourceBundle
                        SourceGroup = [string]$Policy.BundleToGroup[$sourceBundle]
                        SourceFile = $sourceFile.FullName
                        SourceLine = $matchInfo.LineNumber
                        TargetBundle = $target.Bundle
                        TargetGroup = [string]$Policy.BundleToGroup[$target.Bundle]
                        TargetAsset = $target.Asset
                        Uuid = $uuid
                        Rule = $rule.Name
                    }
                }
            }
        }
    }

    $violations = @($violationByKey.Values | Sort-Object SourceBundle, SourceFile, TargetBundle, TargetAsset)
    if ($violations.Count -gt 0) {
        $details = [System.Collections.Generic.List[string]]::new()
        foreach ($violation in $violations) {
            $sourcePath = Get-ProjectRelativePath -ProjectRoot $ProjectRoot -Path $violation.SourceFile
            $targetPath = Get-ProjectRelativePath -ProjectRoot $ProjectRoot -Path $violation.TargetAsset
            $details.Add("- $($violation.SourceBundle) [$($violation.SourceGroup)] -> $($violation.TargetBundle) [$($violation.TargetGroup)] (rule: $($violation.Rule))`n  source: ${sourcePath}:$($violation.SourceLine)`n  target: $targetPath`n  uuid: $($violation.Uuid)")
        }

        throw "Forbidden source asset UUID references were found:`n$($details -join "`n")"
    }

    Write-Host "Source bundle UUID dependency validation succeeded. Indexed $($uuidIndex.Count) UUIDs across $($bundleRoots.Count) source bundles."
}

function Invoke-BuiltBundleDependencyCheck {
    param(
        [Parameter(Mandatory = $true)]
        [string]$OutputPath,

        [Parameter(Mandatory = $true)]
        [object]$Policy
    )

    $bundleAssetsPath = Join-Path $OutputPath 'assets'
    $violations = [System.Collections.Generic.List[string]]::new()
    $bundleDirectories = @(Get-ChildItem -LiteralPath $bundleAssetsPath -Directory -ErrorAction Stop | Sort-Object Name)

    foreach ($bundleDirectory in $bundleDirectories) {
        $bundleName = $bundleDirectory.Name

        if (-not $Policy.BundleToGroup.ContainsKey($bundleName)) {
            if ($Policy.UnknownBundlePolicy -eq 'error') {
                $violations.Add("unregistered bundle: $bundleName")
            }
            else {
                Write-Warning "Ignoring unregistered bundle '$bundleName'."
            }
            continue
        }

        $bundleConfigFile = Get-ChildItem -LiteralPath $bundleDirectory.FullName -File -Filter 'config*.json' -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTime -Descending |
            Select-Object -First 1

        if (-not $bundleConfigFile) {
            throw "Bundle config was not found for '$bundleName' under: $($bundleDirectory.FullName)"
        }

        $bundleConfig = Get-Content -LiteralPath $bundleConfigFile.FullName -Encoding utf8 -Raw | ConvertFrom-Json
        $dependencies = @($bundleConfig.deps)
        $dependencyText = if ($dependencies.Count -gt 0) { $dependencies -join ', ' } else { '<none>' }
        Write-Host "Bundle dependencies: $bundleName -> $dependencyText"

        foreach ($dependencyNameValue in $dependencies) {
            $dependencyName = [string]$dependencyNameValue
            if (-not $Policy.BundleToGroup.ContainsKey($dependencyName)) {
                if ($Policy.UnknownBundlePolicy -eq 'error') {
                    $violations.Add("$bundleName -> unregistered bundle: $dependencyName")
                }
                continue
            }

            $rule = Find-ForbiddenBundleDependencyRule -Policy $Policy -FromBundle $bundleName -ToBundle $dependencyName
            if ($rule) {
                $fromGroup = [string]$Policy.BundleToGroup[$bundleName]
                $toGroup = [string]$Policy.BundleToGroup[$dependencyName]
                $violations.Add("$bundleName [$fromGroup] -> $dependencyName [$toGroup] (rule: $($rule.Name))")
            }
        }
    }

    if ($violations.Count -gt 0) {
        throw "Cocos Creator build succeeded, but bundle dependency policy violations were found: $($violations -join ', ')"
    }

    Write-Host 'Built bundle dependency validation succeeded.'
}

$projectRoot = (Resolve-Path $ProjectRoot).Path
$configPath = (Resolve-Path $ConfigPath).Path
$toolConfigPath = (Resolve-Path $ToolConfigPath).Path
$buildConfig = Get-Content -LiteralPath $configPath -Encoding utf8 -Raw | ConvertFrom-Json
$toolConfig = Get-Content -LiteralPath $toolConfigPath -Encoding utf8 -Raw | ConvertFrom-Json
$bundleDependencyPolicy = New-BundleDependencyPolicy -ToolConfig $toolConfig

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

if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
    throw "Build config was not found: $configPath"
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
elseif ($bundleDependencyPolicy) {
    Invoke-SourceBundleDependencyCheck -ProjectRoot $projectRoot -Policy $bundleDependencyPolicy
}
else {
    Write-Host 'No bundle dependency policy is configured.'
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

if ($SkipBundleDependencyCheck) {
    exit 0
}

if (-not $bundleDependencyPolicy) {
    exit 0
}

Invoke-BuiltBundleDependencyCheck -OutputPath $outputPath -Policy $bundleDependencyPolicy
exit 0
