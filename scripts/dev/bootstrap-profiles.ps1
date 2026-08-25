# Bootstrap per-mode Claude settings (claude-api / claude-sub launchers) on a
# fresh machine, and repair stale plugin enablement keys after renames.
#
# Usage:  pwsh -File scripts/dev/bootstrap-profiles.ps1 [-ClaudeDir <path>]
#
# What it does, per mode file (settings.api.json / settings.subscription.json):
#   - creates it from templates/ if missing (never overwrites an existing one)
#   - ensures enabledPlugins contains "<plugin>@<marketplace>: true" using the
#     CURRENT names read from .claude-plugin/*.json (self-heals after renames)
#   - removes stale enablement keys for the same marketplace under old names
# Never touches auth: ANTHROPIC_API_KEY stays in ~/.secrets/claude-api.ps1.
param(
    [string]$ClaudeDir = (Join-Path $HOME '.claude')
)

$ErrorActionPreference = 'Stop'
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..')

$manifest = Get-Content (Join-Path $repoRoot '.claude-plugin\plugin.json') -Raw | ConvertFrom-Json
$mktManifest = Get-Content (Join-Path $repoRoot '.claude-plugin\marketplace.json') -Raw | ConvertFrom-Json
$plugin = $manifest.name
$marketplace = $mktManifest.name

$repoSlug = 'OWNER/REPO'
$url = git -C $repoRoot remote get-url origin 2>$null
if ($url) {
    $slug = ($url -replace '\.git$', '') -replace '^.*[:/](?=[^/]+/[^/]+$)', ''
    if ($slug -match '^[^/]+/[^/]+$') { $repoSlug = $slug }
}

Write-Output "plugin=$plugin marketplace=$marketplace repo=$repoSlug"
Write-Output "claude dir: $ClaudeDir"
if (-not (Test-Path $ClaudeDir)) { New-Item -ItemType Directory -Path $ClaudeDir | Out-Null }

function Render([string]$text) {
    $out = $text -replace '\{\{PLUGIN\}\}', $plugin
    $out = $out -replace '\{\{MARKETPLACE_REPO\}\}', $repoSlug
    $out = $out -replace '\{\{MARKETPLACE\}\}', $marketplace
    $out = $out -replace '\{\{HOME\}\}', ($HOME -replace '\\', '/')
    return $out
}

function Ensure-MarketplaceEntry([string]$text) {
    if ($text -match ('"' + [regex]::Escape($marketplace) + '"\s*:\s*\{')) { return $text }
    $entry = @"
    "$marketplace": {
      "source": {
        "source": "github",
        "repo": "$repoSlug"
      }
    }
"@
    $idx = $text.IndexOf('"extraKnownMarketplaces"')
    if ($idx -lt 0) { return $text }
    $open = $text.IndexOf('{', $idx)
    return $text.Insert($open + 1, $entry + ",`n")
}

function Repair-EnabledPlugins([string]$text) {
    # Drop every enablement key for this marketplace (current OR stale name),
    # then re-add the current one.
    $pattern = ('\s*"[^"]*@' + [regex]::Escape($marketplace) + '"\s*:\s*(true|false),?')
    $m = [regex]::Match($text, '"enabledPlugins"\s*:\s*\{')
    if (-not $m.Success) {
        Write-Warning 'no enabledPlugins block found - skipping key repair'
        return $text
    }
    $open = $text.IndexOf('{', $m.Index)
    $depth = 0; $end = -1
    for ($i = $open; $i -lt $text.Length; $i++) {
        if ($text[$i] -eq '{') { $depth++ }
        elseif ($text[$i] -eq '}') { $depth--; if ($depth -eq 0) { $end = $i; break } }
    }
    if ($end -lt 0) {
        Write-Warning 'unterminated enabledPlugins block - skipping'
        return $text
    }
    $inner = [regex]::Replace($text.Substring($open + 1, $end - $open - 1), $pattern, '')
    $inner = $inner.TrimEnd().TrimEnd(',')
    $key = "`n    `"$plugin@$marketplace`": true"
    if ($inner.Trim()) { $inner += ",$key" } else { $inner = $key }
    return $text.Substring(0, $open) + '{' + $inner + "`n  }" + $text.Substring($end + 1)
}

foreach ($mode in 'api', 'subscription') {
    $dst = Join-Path $ClaudeDir "settings.$mode.json"
    $src = Join-Path $repoRoot "templates\settings.$mode.json"
    if (-not (Test-Path $dst)) {
        Render (Get-Content $src -Raw) | Set-Content $dst -NoNewline
        Write-Output "[$mode] created from template"
    } else {
        Write-Output "[$mode] exists - repairing keys only"
    }

    $text = Get-Content $dst -Raw
    $before = $text
    try { $null = $text | ConvertFrom-Json } catch {
        Write-Warning "[$mode] unparseable JSON - refusing to touch it ($_)"
        continue
    }
    $text = Ensure-MarketplaceEntry $text
    $text = Repair-EnabledPlugins $text
    try { $check = $text | ConvertFrom-Json } catch {
        Write-Warning "[$mode] post-patch JSON invalid - leaving original intact ($_)"
        continue
    }
    if ($check.enabledPlugins."$plugin@$marketplace" -ne $true) {
        Write-Warning "[$mode] key still not enabled after patch - inspect manually"
        continue
    }
    if ($text -ne $before) { Set-Content $dst $text -NoNewline; Write-Output "[$mode] updated" }
    else { Write-Output "[$mode] already correct" }
}

Write-Output ''
Write-Output 'Next steps on a fresh machine:'
Write-Output "  claude plugin marketplace add `"$repoRoot`""
Write-Output "  claude plugin install $plugin@$marketplace"
Write-Output "  claude plugin enable $plugin@$marketplace"
