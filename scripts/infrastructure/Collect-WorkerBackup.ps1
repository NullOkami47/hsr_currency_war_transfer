# Run on an approved Windows backup host, never on either publishing VM.
[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$Config,
    [switch]$AuthoriseServicePause
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (-not $AuthoriseServicePause) { throw 'Separate approval for a brief production admission/service pause is required.' }
$cfg = Get-Content -Raw -LiteralPath $Config | ConvertFrom-Json
if ($cfg.sshTarget -notmatch '^[a-zA-Z0-9_-]+@[a-zA-Z0-9.-]+$') { throw 'Invalid SSH target' }
foreach ($remotePath in @($cfg.remoteScript, $cfg.remoteConfig, $cfg.remoteBackupDirectory)) {
    if ($remotePath -notmatch '^/[a-zA-Z0-9_./-]+$' -or $remotePath.Contains('..')) { throw 'Invalid remote path' }
}
$destination = [IO.Path]::GetFullPath($cfg.backupDirectory)
if ($destination -notmatch '^[Dd]:\\' -or -not (Test-Path -LiteralPath $destination -PathType Container)) { throw 'An existing approved protected D: backup directory is required.' }
$originalPassphrase = [Environment]::GetEnvironmentVariable('HSR_BACKUP_KEY_PASSPHRASE', 'Process')
if (-not $originalPassphrase) {
    if (-not $cfg.PSObject.Properties['passphraseCredentialPath']) { throw 'A DPAPI-protected passphrase or process-only passphrase is required.' }
    $secure = Import-Clixml -LiteralPath $cfg.passphraseCredentialPath
    if ($secure -isnot [Security.SecureString]) { throw 'Expected a DPAPI-protected SecureString for this Windows user and host.' }
    $credential = New-Object System.Management.Automation.PSCredential('backup', $secure)
    [Environment]::SetEnvironmentVariable('HSR_BACKUP_KEY_PASSPHRASE', $credential.GetNetworkCredential().Password, 'Process')
}
$repo = [IO.Path]::GetFullPath($cfg.repository)
if ($destination.Equals($repo, [StringComparison]::OrdinalIgnoreCase) -or $destination.StartsWith($repo.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Backups cannot be stored inside the repository.' }
$lockPath = Join-Path $destination '.collector.lock'
$lock = [IO.File]::Open($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
try {
    $sshOptions = @('-i', $cfg.sshKeyPath, '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=15')
    $remoteCommand = "sudo -n /usr/bin/node $($cfg.remoteScript) $($cfg.remoteConfig) --authorise-service-pause"
    $output = & ssh @sshOptions $cfg.sshTarget $remoteCommand
    if ($LASTEXITCODE -ne 0) { throw 'Remote backup failed. Check production health before retrying.' }
    $result = ($output -join "`n") | ConvertFrom-Json
    $snapshot = $result.localSnapshot
    $prefix = $cfg.remoteBackupDirectory.TrimEnd('/') + '/'
    foreach ($path in @($snapshot.file, $snapshot.receiptFile)) {
        if (-not $path.StartsWith($prefix, [StringComparison]::Ordinal) -or $path.Substring($prefix.Length) -notmatch '^hsr-state-[a-zA-Z0-9_-]+\.(enc|receipt)\.json$') { throw 'Unexpected backup output path' }
        & scp @sshOptions "$($cfg.sshTarget):$path" $destination
        if ($LASTEXITCODE -ne 0) { throw 'Encrypted backup delivery failed; no success receipt will be recorded.' }
    }
    $backupPath = Join-Path $destination ([IO.Path]::GetFileName($snapshot.file))
    $receiptPath = Join-Path $destination ([IO.Path]::GetFileName($snapshot.receiptFile))
    if ((Get-FileHash -LiteralPath $backupPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $snapshot.sha256) { throw 'Transport checksum mismatch' }
    $verificationConfig = Join-Path $destination '.verification-config.json'
    try {
        @{
            backupDirectory=$destination; backupPath=$backupPath; receiptPath=$receiptPath;
            privateKeyPath=$cfg.privateKeyPath
        } | ConvertTo-Json | Set-Content -LiteralPath $verificationConfig -Encoding utf8
        & node (Join-Path $repo 'scripts\infrastructure\worker-state-backup.mjs') verify $verificationConfig
        if ($LASTEXITCODE -ne 0) { throw 'Off-VM decryption or manifest integrity verification failed.' }
        & node (Join-Path $repo 'scripts\infrastructure\worker-state-backup.mjs') prune $verificationConfig
        if ($LASTEXITCODE -ne 0) { throw 'Retention failed; keep the new backup and investigate.' }
        @{
            verifiedAt=[DateTime]::UtcNow.ToString('o'); snapshotCreatedAt=$snapshot.createdAt;
            sha256=$snapshot.sha256; backupPath=$backupPath; receiptPath=$receiptPath;
            offVmDeliveryVerified=$true; syntheticRestoreRequired=$true
        } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $destination 'latest-verified.json') -Encoding utf8
        Write-Output 'Encrypted off-VM backup verified. Seven-day retention applied. No state is synchronised to another running worker.'
    } finally {
        if (Test-Path -LiteralPath $verificationConfig) { Remove-Item -LiteralPath $verificationConfig }
    }
} finally {
    $lock.Dispose()
    [Environment]::SetEnvironmentVariable('HSR_BACKUP_KEY_PASSPHRASE', $originalPassphrase, 'Process')
}
