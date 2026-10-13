param(
    [Parameter(Mandatory = $true)]
    [string]$Workspace,
    [switch]$InstallProvider,
    [switch]$CheckOnly
)

$ErrorActionPreference = 'Stop'
$providerVersion = '1.2.1'
$providerPackage = "@microsoft/artifacts-npm-credprovider@$providerVersion"
$providerIntegrity = 'sha512-mzM9ZVLh7Loo6ioGgYLXo8D8yPOqoBgKEhv9Y0fRjqofWlbUkM91ybTaSUtPAwxloOSr1z20VVoPo15fciWBXg=='
$providerRegistry = 'https://pkgs.dev.azure.com/artifacts-public/PublicTools/_packaging/AzureArtifacts/npm/registry/'
$configPath = Join-Path (Resolve-Path -LiteralPath $Workspace) '.yarnrc.yml'
$expectedRegistries = @(
    'https://office.pkgs.visualstudio.com/_packaging/AugmentationLoop/npm/registry/',
    'https://office.pkgs.visualstudio.com/_packaging/Office/npm/registry/'
)

function Write-Preflight {
    param(
        [Parameter(Mandatory = $true)]
        [string]$State,
        [string]$Reason,
        [bool]$Install = $false
    )

    $result = [ordered]@{
        state = $State
        provider = 'artifacts-npm-credprovider'
        providerVersion = $providerVersion
        feedCount = $expectedRegistries.Count
        tokenRecorded = $false
    }
    if ($State -eq 'action-required-auth') {
        $result.reason = $Reason
        $result.installProvider = $Install
    }
    Write-Output "PILOT_VALIDATION_AUTH_PREFLIGHT:$($result | ConvertTo-Json -Compress)"
}

function Invoke-CredentialProvider {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Provider,
        [Parameter(Mandatory = $true)]
        [string[]]$Arguments
    )

    $previousPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $output = @(& $Provider @Arguments 2>&1)
        $exitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previousPreference
    }
    return [pscustomobject]@{
        ExitCode = $exitCode
        Output = $output
    }
}

if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
    throw "OfficeAgent Yarn configuration was not found: $configPath"
}
$yarnConfig = Get-Content -LiteralPath $configPath -Raw
foreach ($registry in $expectedRegistries) {
    $pattern = '(?m)^\s*npmRegistryServer:\s*["'']?' +
        [regex]::Escape($registry) + '["'']?\s*$'
    if ($yarnConfig -notmatch $pattern) {
        throw "OfficeAgent Yarn configuration is missing expected registry: $registry"
    }
}

$provider = Get-Command artifacts-npm-credprovider -ErrorAction SilentlyContinue
$installedVersion = if ($null -ne $provider) {
    (& $provider.Source --version).Trim()
} else {
    $null
}

if ($installedVersion -ne $providerVersion) {
    if ($CheckOnly) {
        Write-Preflight 'action-required-auth' 'provider-missing' $true
        exit 0
    }
    if (-not $InstallProvider) {
        throw "artifacts-npm-credprovider $providerVersion is required. Re-run with -InstallProvider after approving the pinned package installation."
    }
    $publishedIntegrity = (
        & npm view $providerPackage dist.integrity --registry $providerRegistry
    ).Trim()
    if ($LASTEXITCODE -ne 0 -or $publishedIntegrity -ne $providerIntegrity) {
        throw "Published integrity for $providerPackage does not match the approved value"
    }
    & npm install --global $providerPackage --registry $providerRegistry
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to install $providerPackage"
    }
    $provider = Get-Command artifacts-npm-credprovider -ErrorAction Stop
    $installedVersion = (& $provider.Source --version).Trim()
    if ($installedVersion -ne $providerVersion) {
        throw "Expected artifacts-npm-credprovider $providerVersion, found $installedVersion"
    }
}

$validation = Invoke-CredentialProvider $provider.Source @(
    '--validate-only', '--config-file', $configPath, '--verbosity', 'minimal'
)
$needsAuthentication = $validation.ExitCode -ne 0 -or
    ($validation.Output -join "`n") -match 'need refresh'
if ($CheckOnly) {
    if ($needsAuthentication) {
        Write-Preflight 'action-required-auth' 'interactive-sign-in-required'
    }
    else {
        Write-Preflight 'ready'
    }
    exit 0
}

if ($needsAuthentication) {
    $acquisition = Invoke-CredentialProvider $provider.Source @(
        '--config-file', $configPath, '--verbosity', 'minimal'
    )
    if ($acquisition.ExitCode -ne 0) {
        throw "Azure Artifacts authentication failed with code $($acquisition.ExitCode)"
    }
    $validation = Invoke-CredentialProvider $provider.Source @(
        '--validate-only', '--config-file', $configPath, '--verbosity', 'minimal'
    )
    if ($validation.ExitCode -ne 0 -or ($validation.Output -join "`n") -match 'need refresh') {
        throw 'Azure Artifacts credentials are not valid for every configured OfficeAgent feed'
    }
}

Write-Output "OfficeAgent Azure Artifacts authentication is ready with provider $installedVersion."
