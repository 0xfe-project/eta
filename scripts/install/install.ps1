# Install eta (the terminal interface) and eta-host into %USERPROFILE%\.eta\bin, from a GitHub
# release or from a directory that holds one. Runs on Windows PowerShell 5.1 and PowerShell 7.
#
#   powershell -ExecutionPolicy Bypass -File install.ps1 [-Version <version>] [-Repo <repository>]
#     [-From <directory>] [-Force] [-AddToPath] [-Help]
#
# Dot-sourced (`. install.ps1`) it only defines its functions.

$EtaUserAgent = 'eta-install'
$EtaDefaultRepo = '0xfe-project/eta'
$EtaPlatform = 'windows-x64'
$EtaVersionPattern = '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?\z'
# The tag of a host's release, matched without case, as release.yml writes it; desktop-v0.1.0 is
# the app's.
$EtaHostTagPattern = '^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9a-z.-]+)?\z'
$EtaGitHubRepoPattern = '^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?/[A-Za-z0-9_.-]+\z'

$EtaUsage = @'
Usage: install.ps1 [-Version <version>] [-Repo <repository>] [-From <directory>] [-Force] [-AddToPath] [-Help]

Installs eta, the terminal interface, and eta-host into %USERPROFILE%\.eta\bin.

  -Version <version>  The release to install, such as 0.3.0.
                      Default: the newest full release of the host (a v* tag).
  -Repo <repository>  owner/name, https://github.com/owner/name, or the API address of a server
                      that answers like GitHub's releases API.
                      Default: $env:ETA_RELEASES_URL, then 0xfe-project/eta.
  -From <directory>   Take eta-windows-x64.exe, eta-host-windows-x64.exe and SHA256SUMS from a
                      directory instead of downloading them.
  -Force              Replace an eta-host of another version.
  -AddToPath          Add %USERPROFILE%\.eta\bin to your user Path.
  -Help               Print this and exit.

A token for github.com is taken from GH_TOKEN, GITHUB_TOKEN or `gh auth token`; another server
gets ETA_RELEASES_TOKEN only.
'@

function Write-EtaLine([string]$Text) {
  [Console]::Out.WriteLine($Text)
}

# Every line on stderr starts with `eta install: `, and a token this run has read shows as [token].
function Write-EtaError([string]$Text) {
  foreach ($token in $script:EtaTokens) {
    if ($token) { $Text = $Text.Replace($token, '[token]') }
  }
  foreach ($line in ($Text -split "`r?`n")) {
    [Console]::Error.WriteLine("eta install: $line")
  }
}

# The failure every function throws; Start-EtaInstall turns it into a message and an exit code.
function New-EtaFailure([string]$Message, [int]$ExitCode = 1) {
  $failure = [System.Exception]::new($Message)
  $failure.Data['EtaExitCode'] = $ExitCode
  return $failure
}

# Reads the command line into a hashtable; a usage error throws with exit code 2.
function Read-EtaArguments([object[]]$Arguments) {
  $options = @{ Version = $null; Repo = $null; From = $null; Force = $false; AddToPath = $false; Help = $false }
  $valued = @{ '-version' = 'Version'; '-repo' = 'Repo'; '-from' = 'From' }
  $switches = @{ '-force' = 'Force'; '-addtopath' = 'AddToPath'; '-help' = 'Help' }
  $tokens = @($Arguments | ForEach-Object { "$_" })
  for ($i = 0; $i -lt $tokens.Count; $i++) {
    $token = $tokens[$i]
    $name = $token
    $inline = $null
    $colon = $token.IndexOf(':')
    if ($token.StartsWith('-') -and $colon -gt 0) {
      $name = $token.Substring(0, $colon)
      if ($colon -lt $token.Length - 1) { $inline = $token.Substring($colon + 1) }
    }
    $key = $name.ToLowerInvariant()
    if ($switches.ContainsKey($key) -and $colon -lt 0) {
      $options[$switches[$key]] = $true
      if ($key -eq '-help') { return $options }
    }
    elseif ($valued.ContainsKey($key)) {
      if ($null -ne $inline) { $value = $inline }
      elseif ($i + 1 -lt $tokens.Count) { $i++; $value = $tokens[$i] }
      else { throw (New-EtaFailure "$name needs a value" 2) }
      $options[$valued[$key]] = $value
    }
    else {
      throw (New-EtaFailure "unknown argument: $token" 2)
    }
  }
  if ($null -ne $options.Version) {
    $version = $options.Version
    if ($version.StartsWith('v')) { $version = $version.Substring(1) }
    if ($version -cnotmatch $EtaVersionPattern) {
      throw (New-EtaFailure "not a version: $($options.Version) (write it as 0.3.0, v0.3.0 or 0.3.0-rc.1)" 2)
    }
    $options.Version = $version
  }
  return $options
}

function Assert-EtaPlatform {
  if ($env:OS -ne 'Windows_NT') {
    throw (New-EtaFailure 'this is not Windows: run install.sh in a POSIX shell instead')
  }
  $arch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
  if ($arch -ne 'AMD64') {
    throw (New-EtaFailure "there is no build for Windows on $arch. There are builds for $EtaPlatform.")
  }
}

function New-EtaNotARepository([string]$Given) {
  return New-EtaFailure "not a repository: $Given. Give owner/name, https://github.com/owner/name, or the http(s) address of a server that answers like GitHub's releases API."
}

# Kind (github or other), Api (where releases/... hangs from) and Label, from how the repository
# was given.
function Resolve-EtaRepository([string]$Given) {
  if ($Given.Contains('?') -or $Given.Contains('#')) { throw (New-EtaNotARepository $Given) }
  $scheme = [regex]::Match($Given, '^https?://')
  if ($scheme.Success) {
    $authority = $Given.Substring($scheme.Length).Split('/')[0]
    if ($authority.Contains('@')) {
      throw (New-EtaFailure 'a repository address cannot carry a login: give the token in ETA_RELEASES_TOKEN (GH_TOKEN for github.com)')
    }
  }
  $web = [regex]::Match($Given, '^https://(www\.)?github\.com(/(?<path>.*))?\z')
  $api = [regex]::Match($Given, '^https://api\.github\.com(?<path>/.*)?\z')
  if ($web.Success) {
    $path = $web.Groups['path'].Value
  }
  elseif ($api.Success) {
    $path = $api.Groups['path'].Value
    if (-not $path.StartsWith('/repos/')) { throw (New-EtaNotARepository $Given) }
    $path = $path.Substring(7)
  }
  elseif ($scheme.Success) {
    $root = $Given.TrimEnd('/')
    return [pscustomobject]@{ Kind = 'other'; Api = $root; Label = $root }
  }
  else {
    $path = $Given
  }
  if ($path.EndsWith('/')) { $path = $path.Substring(0, $path.Length - 1) }
  if ($path.EndsWith('.git')) { $path = $path.Substring(0, $path.Length - 4) }
  if ($path -cnotmatch $EtaGitHubRepoPattern) { throw (New-EtaNotARepository $Given) }
  if (@('.', '..') -contains $path.Split('/')[1]) { throw (New-EtaNotARepository $Given) }
  return [pscustomobject]@{ Kind = 'github'; Api = "https://api.github.com/repos/$path"; Label = $path }
}

# For github.com GH_TOKEN, GITHUB_TOKEN, then gh's; for another server ETA_RELEASES_TOKEN only.
# An empty string when there is none.
function Get-EtaToken($Repository) {
  if ($Repository.Kind -eq 'other') {
    if ($env:ETA_RELEASES_TOKEN) { return Resolve-EtaToken $env:ETA_RELEASES_TOKEN 'ETA_RELEASES_TOKEN' }
    return ''
  }
  if ($env:GH_TOKEN) { return Resolve-EtaToken $env:GH_TOKEN 'GH_TOKEN' }
  if ($env:GITHUB_TOKEN) { return Resolve-EtaToken $env:GITHUB_TOKEN 'GITHUB_TOKEN' }
  $fromGh = Get-EtaGhToken
  if ($fromGh) { return Resolve-EtaToken $fromGh 'gh' }
  return ''
}

# What `gh auth token` prints for github.com, or an empty string.
function Get-EtaGhToken {
  if (-not (Get-Command gh -ErrorAction SilentlyContinue)) { return '' }
  # Windows PowerShell turns a native program's stderr into errors, which 'Stop' would throw.
  $ErrorActionPreference = 'Continue'
  try {
    $global:LASTEXITCODE = 0
    $output = @(& gh auth token --hostname github.com 2>$null)
    if ($LASTEXITCODE -ne 0) { return '' }
    return ($output -join "`n")
  }
  catch {
    return ''
  }
}

# $Value without the white space around it, which must then be printable ASCII without spaces;
# $Source says where it came from. Remembers it, so that no error shows it.
function Resolve-EtaToken([string]$Value, [string]$Source) {
  $token = $Value.Trim()
  if ($token -cnotmatch '^[\x21-\x7E]+\z') {
    throw (New-EtaFailure "the token from $Source cannot be used: a token is printable ASCII, without spaces")
  }
  $script:EtaTokens += $token
  return $token
}

# scheme://host:port of $Uri, in lower case, with the port always written.
function Get-EtaOrigin([string]$Uri) {
  $parsed = [Uri]$Uri
  return "$($parsed.Scheme)://$($parsed.Host):$($parsed.Port)".ToLowerInvariant()
}

# One GET. The token goes in the first request only, and only when $Uri is on the API's origin:
# Invoke-WebRequest drops Authorization when it follows a redirect, which the signed address of
# a download needs. With -NotFoundIsNull a 404 returns $null instead of throwing.
function Invoke-EtaRequest {
  param([string]$Uri, [string]$Accept, [string]$Token, [string]$OutFile, [string]$What, $Repository, [switch]$NotFoundIsNull)
  $headers = @{ Accept = $Accept }
  if ($Token -and (Get-EtaOrigin $Uri) -eq (Get-EtaOrigin $Repository.Api)) {
    $headers['Authorization'] = "Bearer $Token"
  }
  $request = @{ Uri = $Uri; Headers = $headers; UserAgent = $EtaUserAgent; UseBasicParsing = $true; ErrorAction = 'Stop' }
  if ($OutFile) { $request['OutFile'] = $OutFile }
  try {
    return Invoke-WebRequest @request
  }
  catch {
    $status = $null
    $response = $_.Exception.Response
    if ($null -ne $response) {
      try { $status = [int]$response.StatusCode } catch { $status = $null }
    }
    if ($null -eq $status) {
      throw (New-EtaFailure "could not download ${Uri}: $($_.Exception.Message)")
    }
    if ($NotFoundIsNull -and $status -eq 404) { return $null }
    $hint = ''
    if (-not $Token -and @(401, 403, 404) -contains $status) {
      if ($Repository.Kind -eq 'github') {
        $hint = " ($($Repository.Label) may be a private repository: run ``gh auth login`` or set GH_TOKEN)"
      }
      else {
        $hint = ' (if the releases on this server are private: set ETA_RELEASES_TOKEN)'
      }
    }
    throw (New-EtaFailure "${What}: the server answered $status$hint")
  }
}

# The body of an Invoke-WebRequest answer as text: for some content types it is bytes.
function Get-EtaContent($Answer) {
  $content = $Answer.Content
  if ($content -is [byte[]]) { $content = [Text.Encoding]::UTF8.GetString($content) }
  return "$content"
}

# A release from the API; $What names it in the failure when the answer is not one.
function Get-EtaApiRelease([string]$Uri, [string]$Token, [string]$What, $Repository) {
  $answer = Invoke-EtaRequest -Uri $Uri -Accept 'application/vnd.github+json' -Token $Token -What $What -Repository $Repository
  return ConvertFrom-EtaRelease $answer $What
}

# An answer that is empty, only white space or null is no release: ConvertFrom-Json gives
# nothing for it rather than failing.
function ConvertFrom-EtaRelease($Answer, [string]$What) {
  $notARelease = New-EtaFailure "${What}: the answer is not a release as GitHub's API writes it"
  try { $release = (Get-EtaContent $Answer) | ConvertFrom-Json }
  catch { throw $notARelease }
  if ($null -eq $release) { throw $notARelease }
  return $release
}

# Whether $Value is the JSON literal true; the string "true" is not.
function Test-EtaTrue($Value) {
  return ($Value -is [bool]) -and $Value
}

function Test-EtaHostTag($Tag) {
  return ($Tag -is [string]) -and ($Tag -match $EtaHostTagPattern)
}

# Published, a host's tag, and not a pre-release.
function Test-EtaHostRelease($Release) {
  $tag = $Release.tag_name
  return (Test-EtaHostTag $tag) -and -not $tag.Contains('-') -and
  -not (Test-EtaTrue $Release.draft) -and -not (Test-EtaTrue $Release.prerelease)
}

# Whether the version $A (X.Y.Z) is the same as $B or higher. Each part is compared as text of
# equal length, so a number of any size compares as a number.
function Test-EtaVersionAtLeast([string]$A, [string]$B) {
  $left = $A.Split('.')
  $right = $B.Split('.')
  for ($i = 0; $i -lt 3; $i++) {
    $x = $left[$i].TrimStart('0')
    $y = $right[$i].TrimStart('0')
    if ($x -eq '') { $x = '0' }
    if ($y -eq '') { $y = '0' }
    if ($x.Length -ne $y.Length) { return $x.Length -gt $y.Length }
    $order = [string]::CompareOrdinal($x, $y)
    if ($order -ne 0) { return $order -gt 0 }
  }
  return $true
}

# The tag of the newest host release in the list $Content, or $null when there is none. The
# newest has the highest numbers, compared part by part, and of two equal ones the later in the
# list.
function Select-EtaNewestHostTag([string]$Content, [string]$What) {
  $notAList = New-EtaFailure "${What}: the answer is not a list of releases as GitHub's API writes it"
  # An object would be read as a list of one release, and PowerShell 7 reads a list cut short
  # without complaint.
  $trimmed = $Content.Trim()
  if (-not ($trimmed.StartsWith('[') -and $trimmed.EndsWith(']'))) { throw $notAList }
  try { $listed = $Content | ConvertFrom-Json }
  catch { throw $notAList }
  $newest = $null
  # foreach, not @(): Windows PowerShell hands a JSON array on as one object.
  foreach ($release in $listed) {
    if (-not (Test-EtaHostRelease $release)) { continue }
    $tag = $release.tag_name
    if ($null -eq $newest -or (Test-EtaVersionAtLeast $tag.Substring(1) $newest.Substring(1))) { $newest = $tag }
  }
  return $newest
}

# The newest published host release that is not a pre-release, and what to call it. GitHub's
# latest release is that, unless it is the desktop app's or a draft, or there is none; then it is
# the newest host release in the first page of the list. The rule is Releases.latest() in
# packages/releases, which eta-host upgrade and the desktop app follow.
function Get-EtaLatestRelease($Repository, [string]$Token) {
  $what = "the latest release of $($Repository.Label)"
  $request = @{ Accept = 'application/vnd.github+json'; Token = $Token; What = $what; Repository = $Repository }
  $answer = Invoke-EtaRequest -Uri "$($Repository.Api)/releases/latest" @request -NotFoundIsNull
  if ($null -ne $answer) {
    $release = ConvertFrom-EtaRelease $answer $what
    if ((Test-EtaHostTag $release.tag_name) -and -not (Test-EtaTrue $release.draft)) {
      return [pscustomobject]@{ What = $what; Release = $release }
    }
  }
  $listed = Invoke-EtaRequest -Uri "$($Repository.Api)/releases?per_page=100" @request
  $tag = Select-EtaNewestHostTag (Get-EtaContent $listed) $what
  if ($null -eq $tag) {
    throw (New-EtaFailure "${what}: $($Repository.Label) has no host release (a v* tag). Give -Version <version> to install a release by its version.")
  }
  $what = "$tag of $($Repository.Label)"
  $release = Get-EtaApiRelease "$($Repository.Api)/releases/tags/$tag" $Token $what $Repository
  return [pscustomobject]@{ What = $what; Release = $release }
}

# Downloads the three files of the release into $Work.
function Get-EtaRelease {
  param([string]$Given, [string]$Version, [string[]]$Assets, [string]$Work)
  $repository = Resolve-EtaRepository $Given
  $token = Get-EtaToken $repository
  if ($Version) {
    $what = "v$Version of $($repository.Label)"
    $release = Get-EtaApiRelease "$($repository.Api)/releases/tags/v$Version" $token $what $repository
  }
  else {
    $latest = Get-EtaLatestRelease $repository $token
    $what = $latest.What
    $release = $latest.Release
  }
  if ($release.draft -eq $true) { throw (New-EtaFailure "$what is a draft, not a published release") }
  $urls = @{}
  $missing = @()
  foreach ($name in $Assets) {
    $asset = @($release.assets | Where-Object { $_.name -ceq $name }) | Select-Object -First 1
    if ($null -eq $asset -or -not $asset.url) { $missing += $name } else { $urls[$name] = $asset.url }
  }
  if ($missing.Count -gt 0) { throw (New-EtaFailure "$what does not have: $($missing -join ' ')") }
  foreach ($name in $Assets) {
    Invoke-EtaRequest -Uri $urls[$name] -Accept 'application/octet-stream' -Token $token -OutFile (Join-Path $Work $name) -What $name -Repository $repository | Out-Null
  }
}

# Copies the three files from the directory $From into $Work.
function Copy-EtaRelease([string]$From, [string[]]$Assets, [string]$Work) {
  $missing = @($Assets | Where-Object { -not (Test-Path -LiteralPath (Join-Path $From $_) -PathType Leaf) })
  if ($missing.Count -gt 0) { throw (New-EtaFailure "$From does not have: $($missing -join ' ')") }
  foreach ($name in $Assets) {
    Copy-Item -LiteralPath (Join-Path $From $name) -Destination (Join-Path $Work $name)
  }
}

# The SHA-256 that SHA256SUMS gives for $Name, in lower case, or $null.
function Get-EtaListedHash([string]$Sums, [string]$Name) {
  foreach ($line in (Get-Content -LiteralPath $Sums)) {
    $match = [regex]::Match($line.TrimEnd("`r"), '^([0-9A-Fa-f]{64}) [ *](.+)\z')
    if ($match.Success -and $match.Groups[2].Value -ceq $Name) {
      return $match.Groups[1].Value.ToLowerInvariant()
    }
  }
  return $null
}

function Assert-EtaSums([string]$Work, [string[]]$Names) {
  $sums = Join-Path $Work 'SHA256SUMS'
  $problems = @()
  foreach ($name in $Names) {
    $listed = Get-EtaListedHash $sums $name
    if ($null -eq $listed) {
      $problems += "SHA256SUMS has no line for $name."
      continue
    }
    $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $Work $name)).Hash.ToLowerInvariant()
    if ($actual -ne $listed) { $problems += "$name does not match its SHA-256 in SHA256SUMS." }
  }
  if ($problems.Count -gt 0) {
    throw (New-EtaFailure "the download is not the release that was published: $($problems -join ' ') Nothing was installed.")
  }
}

# What `<path> --version` prints, and whether it ran and said it is an eta-host.
function Get-EtaHostVersion([string]$Path) {
  # Windows PowerShell turns a native program's stderr into errors, which 'Stop' would throw.
  $ErrorActionPreference = 'Continue'
  try {
    $global:LASTEXITCODE = 0
    $lines = @(& $Path --version 2>&1 | ForEach-Object { "$_" })
    $text = ($lines -join "`n").TrimEnd()
    $ok = ($LASTEXITCODE -eq 0) -and $text.StartsWith('eta-host ')
    return [pscustomobject]@{ Ok = $ok; Text = $text }
  }
  catch {
    return [pscustomobject]@{ Ok = $false; Text = $_.Exception.Message }
  }
}

# A running exe cannot be overwritten or deleted, but it can be renamed.
# The old file is moved aside first and put back if the new one cannot be moved in, so a failure
# half way leaves the old file where it was.
function Move-EtaIntoPlace([string]$Source, [string]$Target) {
  $aside = $null
  if (Test-Path -LiteralPath $Target) {
    $aside = "$Target.old"
    if (Test-Path -LiteralPath $aside) {
      try { Remove-Item -LiteralPath $aside -Force -ErrorAction Stop }
      catch { $aside = "$Target.$([Guid]::NewGuid().ToString('N').Substring(0, 8)).old" }
    }
    Move-Item -LiteralPath $Target -Destination $aside -ErrorAction Stop
  }
  try {
    Move-Item -LiteralPath $Source -Destination $Target -ErrorAction Stop
  }
  catch {
    if ($null -ne $aside) { Move-Item -LiteralPath $aside -Destination $Target -ErrorAction Stop }
    throw
  }
  if ($null -ne $aside) {
    try { Remove-Item -LiteralPath $aside -Force -ErrorAction Stop } catch { }
  }
}

# Removes what earlier replacements set aside, as far as nothing still runs it.
function Remove-EtaLeftovers([string]$Bin) {
  foreach ($file in @(Get-ChildItem -LiteralPath $Bin -File -Force | Where-Object { $_.Name -like '*.old' })) {
    try { Remove-Item -LiteralPath $file.FullName -Force -ErrorAction Stop } catch { }
  }
}

function Test-EtaSameDirectory([string]$Entry, [string]$Directory) {
  if ($Entry -eq '') { return $false }
  return $Entry.TrimEnd('\') -ieq $Directory.TrimEnd('\')
}

# Adds $Directory to the Path value under $Key, keeping what is there unexpanded and the value's
# type. Returns whether it changed anything: an entry that is the directory, written in any case,
# with a trailing backslash or with %VARIABLES%, counts as there.
function Add-UserPathEntry {
  param(
    [Parameter(Mandatory = $true)][string]$Directory,
    [string]$Key = 'HKCU:\Environment'
  )
  $item = Get-Item -LiteralPath $Key
  $raw = [string]$item.GetValue('Path', '', 'DoNotExpandEnvironmentNames')
  $kind = [Microsoft.Win32.RegistryValueKind]::ExpandString
  if (@($item.GetValueNames()) -contains 'Path') { $kind = $item.GetValueKind('Path') }
  foreach ($entry in ($raw -split ';')) {
    if ((Test-EtaSameDirectory $entry $Directory) -or
      (Test-EtaSameDirectory ([Environment]::ExpandEnvironmentVariables($entry)) $Directory)) {
      return $false
    }
  }
  $value = if ($raw -eq '') { $Directory } elseif ($raw.EndsWith(';')) { "$raw$Directory" } else { "$raw;$Directory" }
  New-ItemProperty -LiteralPath $Key -Name 'Path' -Value $value -PropertyType $kind.ToString() -Force | Out-Null
  return $true
}

# Tells running programs that the user's environment changed: setting a user variable through
# .NET broadcasts WM_SETTINGCHANGE, and the variable is removed straight away.
function Send-EnvironmentChange {
  $name = 'ETA_INSTALL_REFRESH'
  [Environment]::SetEnvironmentVariable($name, '1', 'User')
  [Environment]::SetEnvironmentVariable($name, $null, 'User')
}

# $InSession: the installer runs in the user's own session (as a script block), so what it adds
# to $env:Path is on PATH there; run as a file, it is a process of its own.
function Update-EtaPath([string]$Directory, [bool]$AddToPath, [bool]$InSession) {
  foreach ($entry in ("$env:Path" -split ';')) {
    if (Test-EtaSameDirectory $entry $Directory) { return }
  }
  if (-not $AddToPath) {
    Write-EtaLine ''
    Write-EtaLine "$Directory is not on your PATH. Run the installer again with -AddToPath to add it to your user Path."
    return
  }
  $where = if ($InSession) { 'It is on PATH in this session; open a new terminal for the others.' } else { 'Open a new terminal to use it.' }
  Write-EtaLine ''
  if (Add-UserPathEntry -Directory $Directory) {
    Send-EnvironmentChange
    Write-EtaLine "Added $Directory to your user Path. $where"
  }
  else {
    Write-EtaLine "Your user Path already has $Directory. $where"
  }
  $env:Path = if ("$env:Path".EndsWith(';') -or "$env:Path" -eq '') { "$env:Path$Directory" } else { "$env:Path;$Directory" }
}

function Invoke-EtaInstall([object[]]$Arguments) {
  $options = Read-EtaArguments $Arguments
  if ($options.Help) {
    Write-EtaLine $EtaUsage
    return
  }
  Assert-EtaPlatform
  $tuiAsset = "eta-$EtaPlatform.exe"
  $hostAsset = "eta-host-$EtaPlatform.exe"
  $assets = @($tuiAsset, $hostAsset, 'SHA256SUMS')

  if ($null -eq $options.From) {
    $repo = if ($null -ne $options.Repo) { $options.Repo } elseif ($env:ETA_RELEASES_URL) { $env:ETA_RELEASES_URL } else { $EtaDefaultRepo }
    # Refuses an address it cannot read before anything is created.
    Resolve-EtaRepository $repo | Out-Null
  }

  if (-not $env:USERPROFILE) { throw (New-EtaFailure 'USERPROFILE is not set, and eta is installed under it') }
  $bin = Join-Path $env:USERPROFILE '.eta\bin'
  New-Item -ItemType Directory -Path $bin -Force | Out-Null
  $work = Join-Path $bin ('.install.' + [Guid]::NewGuid().ToString('N').Substring(0, 8))
  New-Item -ItemType Directory -Path $work | Out-Null
  try {
    if ($null -ne $options.From) {
      Copy-EtaRelease $options.From $assets $work
    }
    else {
      Get-EtaRelease -Given $repo -Version $options.Version -Assets $assets -Work $work
    }
    Assert-EtaSums $work @($tuiAsset, $hostAsset)

    $new = Get-EtaHostVersion (Join-Path $work $hostAsset)
    if (-not $new.Ok) {
      throw (New-EtaFailure "the downloaded eta-host does not run on this machine, so nothing was installed. It said: $($new.Text)")
    }

    $tuiTarget = Join-Path $bin 'eta.exe'
    $hostTarget = Join-Path $bin 'eta-host.exe'
    $action = 'install'
    $oldText = ''
    if (Test-Path -LiteralPath $hostTarget) {
      $old = Get-EtaHostVersion $hostTarget
      $oldText = $old.Text
      if ($old.Ok -and $old.Text -ceq $new.Text) { $action = 'same' }
      elseif ($options.Force) { $action = 'replace' }
      else { $action = 'keep' }
      if (-not $old.Ok) {
        $said = if ($old.Text) { $old.Text } else { 'no output' }
        $oldText = "an eta-host that does not run ($said)"
      }
    }

    Remove-EtaLeftovers $bin
    Move-EtaIntoPlace (Join-Path $work $tuiAsset) $tuiTarget
    if ($action -eq 'install' -or $action -eq 'replace') {
      Move-EtaIntoPlace (Join-Path $work $hostAsset) $hostTarget
    }

    Write-EtaLine "Installed into ${bin}:"
    Write-EtaLine "  $tuiTarget"
    switch ($action) {
      'install' { Write-EtaLine "  $hostTarget ($($new.Text))" }
      'same' { Write-EtaLine "  $hostTarget is already $($new.Text), and was left as it is" }
      'replace' {
        Write-EtaLine "  $hostTarget ($($new.Text)), replacing $oldText"
        Write-EtaLine 'An eta-host that is running goes on with the old file until it restarts.'
      }
      'keep' {
        Write-EtaLine "  $hostTarget was left as it is ($oldText)"
        Write-EtaError ("$hostTarget was left as it is: it is $oldText, and this release has $($new.Text).`n" +
          'To upgrade it, run `eta-host upgrade`: it backs up the database, restarts the service, and rolls back if anything fails.' + "`n" +
          'To replace the file instead, run the installer again with -Force.')
      }
    }
  }
  finally {
    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
  }
  Update-EtaPath -Directory $bin -AddToPath $options.AddToPath -InSession (-not $PSCommandPath)
}

# Runs the installer and returns its exit code: 0, 1 for a failure, 2 for a usage error.
function Start-EtaInstall([object[]]$Arguments) {
  $ErrorActionPreference = 'Stop'
  # The tokens this run reads (Resolve-EtaToken), which Write-EtaError keeps out of its text.
  $script:EtaTokens = @()
  # Windows PowerShell's progress bar slows a large download many times over.
  $ProgressPreference = 'SilentlyContinue'
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  try {
    Invoke-EtaInstall $Arguments
    return 0
  }
  catch {
    $failure = $_.Exception
    $code = 1
    if ($failure.Data.Contains('EtaExitCode')) { $code = [int]$failure.Data['EtaExitCode'] }
    Write-EtaError $failure.Message
    if ($code -eq 2) { [Console]::Error.WriteLine($EtaUsage) }
    return $code
  }
  finally {
    # Run as a script block, this scope is the user's session: leave no token in it.
    $script:EtaTokens = @()
  }
}

if ($MyInvocation.InvocationName -eq '.') { return }

$EtaExitCode = Start-EtaInstall $args
# Run as a script block, `exit` would end the user's whole session: leave the code instead.
if ($PSCommandPath) { exit $EtaExitCode }
$global:LASTEXITCODE = $EtaExitCode
