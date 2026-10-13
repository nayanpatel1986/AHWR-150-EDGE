# Tests of the installer that need no Windows: syntax (including Windows
# PowerShell 5.1 compatibility) and the module's pure functions.
#   pwsh -NoProfile -File installer/test/setup.tests.ps1 [<built package folder>]
# With a built package folder it also unpacks the real bundled components.
param([string]$Package = '')
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $PSScriptRoot
$setup = Join-Path $here 'setup'
$script:failures = 0; $script:passes = 0
function Assert([bool]$Condition, [string]$What) {
    if ($Condition) { $script:passes++ } else { $script:failures++; Write-Host "  FAIL $What" -ForegroundColor Red }
}
function Section([string]$Name) { Write-Host "-- $Name" }
$tmp = Join-Path ([IO.Path]::GetTempPath()) ("ahwr-setup-test-" + [Guid]::NewGuid().ToString('N').Substring(0, 8))
$null = New-Item -ItemType Directory -Path $tmp

Section 'syntax and Windows PowerShell 5.1 compatibility'
$scripts = @(Get-ChildItem -LiteralPath $setup -Include '*.ps1', '*.psm1' -Recurse)
$scripts += @(Get-ChildItem -LiteralPath (Split-Path -Parent $here) -Filter '*.ps1')
foreach ($f in $scripts) {
    $tokens = $null; $errors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseFile($f.FullName, [ref]$tokens, [ref]$errors)
    Assert (-not $errors) "$($f.Name) parses ($($errors | ForEach-Object { $_.Message }))"
    $ps7 = @($ast.FindAll({ param($n)
        $t = $n.GetType().Name
        $t -in @('TernaryExpressionAst', 'PipelineChainAst') -or
        ($t -eq 'BinaryExpressionAst' -and $n.Operator -in @('QuestionQuestion')) -or
        ($t -eq 'AssignmentStatementAst' -and $n.Operator -eq 'QuestionQuestionEquals') -or
        ($t -in @('MemberExpressionAst', 'InvokeMemberExpressionAst', 'IndexExpressionAst') -and $n.NullConditional)
    }, $true))
    Assert ($ps7.Count -eq 0) "$($f.Name) uses no PowerShell 7-only syntax ($($ps7 | ForEach-Object { $_.Extent.Text }))"
    $joins = @($ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.CommandAst] -and $n.GetCommandName() -eq 'Join-Path' -and
        @($n.CommandElements | Select-Object -Skip 1 | Where-Object { $_ -isnot [System.Management.Automation.Language.CommandParameterAst] }).Count -gt 2 }, $true))
    Assert ($joins.Count -eq 0) "$($f.Name) passes Join-Path one child only ($($joins | ForEach-Object { $_.Extent.Text }))"
    $parallel = @($ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.CommandParameterAst] -and $n.ParameterName -in @('Parallel', 'AsHashtable', 'AsByteStream', 'SkipCertificateCheck') }, $true))
    $parallel = @($parallel | Where-Object { $_.Extent.Text -notmatch 'SkipCertificateCheck' -or $f.Name -ne 'Start-AHWR-EDGE.ps1' })   # guarded by a version check there
    Assert ($parallel.Count -eq 0) "$($f.Name) uses no PowerShell 6+ parameters ($($parallel | ForEach-Object { $_.Extent.Text }))"
}
foreach ($f in @(Get-ChildItem -LiteralPath $setup -Include '*.ps1', '*.psm1', '*.bat' -Recurse) + @(Get-ChildItem -LiteralPath $here -Filter '*.bat') + @(Get-Item (Join-Path $here 'rig-settings.ini'))) {
    $bytes = [IO.File]::ReadAllBytes($f.FullName)
    Assert (-not @($bytes | Where-Object { $_ -gt 127 }).Count) "$($f.Name) is ASCII only"
}

Import-Module (Join-Path $setup 'AhwrSetup.psm1') -Force -DisableNameChecking

Section 'ini files'
$ini = Join-Path $tmp 'rig-settings.ini'
Copy-Item (Join-Path $here 'rig-settings.ini') $ini
$template = Read-IniFile $ini
$r = Test-RigSettings $template
Assert ($r.Errors.Count -ge 3) 'unfilled template is rejected'
Assert (@($r.Errors | Where-Object { $_ -match 'DeviceId' }).Count -ge 1) 'placeholder DeviceId named'
Assert (-not @($r.Errors | Where-Object { $_ -match '\[Domain\]' }).Count) 'Domain placeholders ignored while domain login is off'
$filled = (Get-Content $ini -Raw).Replace('<rig name>', 'AHWR-50-III').Replace('<asset, e.g. Ankleshwar>', 'Ankleshwar').
    Replace('<rig LAN subnet, e.g. 10.20.30.0/24>', '10.20.30.0/24, 10.20.31.0/24').Replace('<PLC IP address, e.g. 192.168.0.11>', '192.168.0.11')
Set-Content -LiteralPath $ini -Value $filled -NoNewline
$r = Test-RigSettings (Read-IniFile $ini)
Assert ($r.Errors.Count -eq 0) "filled template is valid ($($r.Errors -join '; '))"
Assert (@($r.Warnings | Where-Object { $_ -match 'DeviceToken' }).Count -eq 1) 'missing token is a warning'
Assert ($r.Values.RigLanSubnet.Count -eq 2 -and $r.Values.PlcPort -eq 102 -and $r.Values.DataDrive -eq 'D:') 'subnets, S7 port, drive'
Assert ((Set-IniValue $ini 'CMF' 'DeviceToken' 'tok-0123456789') -eq $true) 'Set-IniValue finds the key'
Assert ((Get-IniValue (Read-IniFile $ini) 'CMF' 'DeviceToken') -eq 'tok-0123456789') 'Set-IniValue writes the value'
Assert ((Get-Content $ini -Raw) -match '; from the CMF administrator') 'comments kept'
$cleared = @(Clear-IniSecrets $ini)
Assert ($cleared -contains 'CMF.DeviceToken' -and -not (Get-IniValue (Read-IniFile $ini) 'CMF' 'DeviceToken')) 'Clear-IniSecrets blanks the token'
$bad = Read-IniFile $ini
$bad['Network']['PlcProtocol'] = 'Modbus'; $bad['Network']['RigLanSubnet'] = '10.20.30.0/33'; $bad['Rig']['DataDrive'] = 'DD'
$bad['CMF']['CentralUrl'] = 'http://crmf.ongc.local'; $bad['Domain']['Enabled'] = 'yes'; $bad['Domain']['DomainController'] = 'ldap://dc01:389'
$r = Test-RigSettings $bad
Assert ($r.Values.PlcPort -eq 502) 'Modbus port 502'
foreach ($word in @('RigLanSubnet', 'DataDrive', 'CentralUrl', 'ldaps', 'BindPassword', 'Domain\] Domain')) {
    Assert (@($r.Errors | Where-Object { $_ -match $word }).Count -ge 1) "error names $word"
}
$r2 = Test-RigSettings $bad ([ordered]@{ LDAP_BIND_PASSWORD = 'stored' })
Assert (-not @($r2.Errors | Where-Object { $_ -match 'BindPassword' }).Count) 'stored bind password satisfies a blank one'

Section 'settings.env'
$values = (Test-RigSettings (Read-IniFile $ini)).Values
$values.DeviceToken = 'tok-0123456789'; $values.HaveToken = $true
$fresh = ConvertTo-EdgeSettings $values ([ordered]@{}) 'C:\AHWR' 'C:\AHWR\certs\ongc-ca.pem'
Assert ($fresh['JWT_SECRET'] -match '^[0-9a-f]{64}$' -and $fresh['PG_SUPERUSER_PASSWORD'] -match '^[0-9a-f]{64}$') 'secrets generated'
Assert ($fresh['JWT_SECRET'] -ne $fresh['PGPASSWORD']) 'secrets differ'
Assert ($fresh['SYNC_ENABLED'] -eq 'true' -and $fresh['ETP_ENABLED'] -eq 'false' -and $fresh['AUTH_MODE'] -eq 'local') 'sync on, ETP off, local auth'
Assert ($fresh['NODE_EXTRA_CA_CERTS'] -eq 'C:\AHWR\certs\ongc-ca.pem' -and $fresh['PG_MODE'] -eq 'bundled' -and $fresh['SYNC_BUFFER_DAYS'] -eq '15') 'CA, bundled database, 15-day buffer'
$existing = [ordered]@{ JWT_SECRET = 'keep-jwt'; PGPASSWORD = 'keep-app'; TELEGRAF_DB_PASSWORD = 'keep-tg'; PG_SUPERUSER_PASSWORD = 'keep-pg'; PORT = '9090'; DEVICE_TOKEN = 'old-token-123' }
$values.DeviceToken = ''; $values.HaveToken = $true; $values.DomainEnabled = $true
$values.DomainController = 'ldaps://dc01.ongc.local:636'; $values.BindAccount = 'CN=svc,DC=ongc'; $values.BindPassword = ''
$repair = ConvertTo-EdgeSettings $values $existing 'C:\AHWR'
Assert (-not $repair.Contains('JWT_SECRET') -and -not $repair.Contains('PORT')) 'repair keeps secrets and one-time values'
Assert (-not $repair.Contains('DEVICE_TOKEN') -and $repair['SYNC_ENABLED'] -eq 'true') 'blank token keeps the stored one'
Assert ($repair['AUTH_MODE'] -eq 'both' -and $repair['LDAP_STARTTLS'] -eq 'false' -and -not $repair.Contains('LDAP_BIND_PASSWORD')) 'domain login: both, LDAPS, bind password kept'
$env1 = Join-Path $tmp 'settings.env'
[IO.File]::WriteAllText($env1, ([char]0xFEFF + "ADMIN_USERNAME=admin`r`n# comment`r`nPORT=8080`r`nPORT=8081`r`nOLD=1`r`n"))
$read = Read-EnvFile $env1
Assert ($read['ADMIN_USERNAME'] -eq 'admin' -and $read['PORT'] -eq '8081') 'Read-EnvFile strips the BOM; last value wins'
Update-EnvFile $env1 ([ordered]@{ PORT = '9000'; NEW_KEY = 'x=y' }) @('OLD')
$text = Get-Content $env1 -Raw
Assert (([regex]::Matches($text, '(?m)^PORT=')).Count -eq 1 -and $text -match '(?m)^PORT=9000' -and $text -match '(?m)^NEW_KEY=x=y' -and $text -notmatch 'OLD=' -and $text -match '# comment') 'Update-EnvFile replaces, de-duplicates, appends, removes, keeps comments'
Assert ([IO.File]::ReadAllBytes($env1)[0] -ne 0xEF) 'settings.env written without BOM'

Section 'secrets and addresses'
$pw = New-Password
Assert ($pw.Length -eq 20 -and $pw -cmatch '[A-Z]' -and $pw -cmatch '[a-z]' -and $pw -match '\d' -and $pw -cnotmatch '[0O1lI]') 'password shape'
Assert ((New-Secret 16) -match '^[0-9a-f]{32}$') 'secret shape'
Assert ((Test-Ipv4 '192.168.0.11') -and -not (Test-Ipv4 '192.168.0.256') -and -not (Test-Ipv4 'plc01')) 'IPv4'
Assert ((Test-Ipv4Cidr '10.0.0.0/8') -and -not (Test-Ipv4Cidr '10.0.0.0') -and -not (Test-Ipv4Cidr '10.0.0.0/40')) 'CIDR'
$u = Get-UriParts 'https://crmf.ongc.local' 443
Assert ($u.Scheme -eq 'https' -and $u.Port -eq 443 -and (Get-UriParts 'ldaps://dc01:636' 636).Port -eq 636) 'URL parts'

Section 'package checksums'
$pkg = Join-Path $tmp 'pkg'; $null = New-Item -ItemType Directory -Path (Join-Path $pkg 'sub')
Set-Content (Join-Path $pkg 'a.txt') 'alpha'; Set-Content (Join-Path $pkg 'sub/b.txt') 'beta'
$lines = foreach ($rel in @('a.txt', 'sub/b.txt')) { '{0}  {1}' -f (Get-FileHash (Join-Path $pkg $rel)).Hash.ToLower(), $rel }
Set-Content (Join-Path $pkg 'SHA256SUMS.txt') $lines
Assert (@(Get-PackageChecksumProblems $pkg).Count -eq 0) 'intact package passes'
Set-Content (Join-Path $pkg 'a.txt') 'tampered'; Remove-Item (Join-Path $pkg 'sub/b.txt')
$p = @(Get-PackageChecksumProblems $pkg)
Assert ($p.Count -eq 2 -and ($p -join ' ') -match 'changed: a.txt' -and ($p -join ' ') -match 'missing: sub/b.txt') 'changed and missing files named'

Section 'zip handling'
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
function New-TestZip([string]$Path, [hashtable]$Entries) {
    $fs = [IO.File]::Create($Path); $zip = New-Object IO.Compression.ZipArchive($fs, [IO.Compression.ZipArchiveMode]::Create)
    foreach ($k in $Entries.Keys) { $w = New-Object IO.StreamWriter($zip.CreateEntry($k).Open()); $w.Write($Entries[$k]); $w.Dispose() }
    $zip.Dispose(); $fs.Dispose()
}
$z = Join-Path $tmp 'pg.zip'
New-TestZip $z @{ 'pgsql/bin/postgres.exe' = 'x'; 'pgsql/pgAdmin 4/big.bin' = 'x'; 'pgsql/share/extension/plpgsql.control' = 'x'; 'other/file' = 'x' }
$dest = Join-Path $tmp 'pg'
Expand-ZipTo $z $dest 'pgsql/' @('pgAdmin 4/')
Assert ((Test-Path (Join-Path $dest 'bin/postgres.exe')) -and -not (Test-Path (Join-Path $dest 'pgAdmin 4')) -and -not (Test-Path (Join-Path $dest 'other'))) 'strip and exclude'
$z2 = Join-Path $tmp 'nssm.zip'
New-TestZip $z2 @{ 'nssm-2.24/win64/nssm.exe' = '64'; 'nssm-2.24/win32/nssm.exe' = '32'; 'nssm-2.24/win64/readme' = 'x' }
Expand-ZipTo $z2 (Join-Path $tmp 'nssm') 'nssm-2.24/win64/' @() @('nssm.exe')
Assert ((Get-Content (Join-Path $tmp 'nssm/nssm.exe') -Raw) -eq '64' -and -not (Test-Path (Join-Path $tmp 'nssm/readme'))) 'only list'
$z3 = Join-Path $tmp 'evil.zip'
New-TestZip $z3 @{ '../escaped.txt' = 'x' }
$threw = $false
try { Expand-ZipTo $z3 (Join-Path $tmp 'evil') } catch { $threw = $_.Exception.Message -match 'Unsafe path' }
Assert ($threw -and -not (Test-Path (Join-Path $tmp 'escaped.txt'))) 'zip-slip entry refused'

Section 'python embeddable layout'
$embed = Join-Path $tmp 'embed.zip'
New-TestZip $embed @{ 'python.exe' = 'x'; 'python312.zip' = 'x'; 'python312._pth' = "python312.zip`r`n.`r`n#import site`r`n" }
$wheels = Join-Path $tmp 'wheels'; $null = New-Item -ItemType Directory -Path $wheels
New-TestZip (Join-Path $wheels 'demo-1.0-py3-none-any.whl') @{ 'demo/__init__.py' = 'x'; 'demo-1.0.dist-info/METADATA' = 'Name: demo' }
Install-PythonEmbedded $embed $wheels (Join-Path $tmp 'py')
$pth = (Get-Content (Join-Path $tmp 'py/python312._pth')) -join '|'
Assert ($pth -eq 'python312.zip|.|Lib\site-packages|import site') "._pth enables site-packages ($pth)"
Assert (Test-Path (Join-Path $tmp 'py/Lib/site-packages/demo/__init__.py')) 'wheel unpacked into site-packages'

Section 'stages and report'
Reset-CheckResults
Invoke-Stage 1 2 'Good' { Add-Check 'one' 'OK' 'fine'; Add-Check 'two' 'WARNING' 'hmm' }
$threw = $false
try { Invoke-Stage 2 2 'Bad' { Add-Check 'three' 'FAILED' 'broken' } } catch { $threw = $_.Exception.Message -match 'Stage 2 \(Bad\) failed: broken' }
Assert $threw 'a FAILED check stops the stage'
$st = @(Get-StageResults)
Assert ($st.Count -eq 2 -and $st[0].Status -eq 'WARNING' -and $st[1].Status -eq 'FAILED') 'stage results'
$report = Join-Path $tmp 'report.html'
Write-SetupReport $report 'Test <report>' 'INSTALLATION FAILED' ([ordered]@{ Rig = 'AHWR-50-III' })
$html = Get-Content $report -Raw
Assert ($html -match 'Test &lt;report&gt;' -and $html -match 'class="FAILED"' -and $html -match 'AHWR-50-III') 'HTML report, escaped'

Section 'installed component record'
$env:AHWR_INSTALL_ROOT = Join-Path $tmp 'AHWR'
Set-InstalledComponent $env:AHWR_INSTALL_ROOT 'node' 'abc'
Set-InstalledComponent $env:AHWR_INSTALL_ROOT 'telegraf' 'def'
$m = Get-InstalledComponents $env:AHWR_INSTALL_ROOT
Assert ($m['node'] -eq 'abc' -and $m['telegraf'] -eq 'def') 'component markers'
Remove-Item Env:\AHWR_INSTALL_ROOT

if ($Package) {
    Section "built package $Package"
    $problems = @(Get-PackageChecksumProblems $Package)
    Assert ($problems.Count -eq 0) "package checksums ($($problems | Select-Object -First 3))"
    foreach ($f in @(Get-ChildItem -LiteralPath $Package -Recurse -Include '*.ps1', '*.psm1' | Where-Object { $_.FullName -notmatch 'node_modules' })) {
        $b = [IO.File]::ReadAllBytes($f.FullName)
        Assert ($b.Length -ge 3 -and $b[0] -eq 0xEF -and $b[1] -eq 0xBB -and $b[2] -eq 0xBF) "$($f.Name) has a UTF-8 BOM"
    }
    foreach ($f in @(Get-ChildItem -LiteralPath $Package -Filter '*.bat') + @(Get-Item (Join-Path $Package 'rig-settings.ini'))) {
        $t = [IO.File]::ReadAllText($f.FullName)
        Assert (($t -replace "`r`n", '') -notmatch "`n") "$($f.Name) uses CRLF"
    }
    $comps = @{}
    foreach ($c in (Read-ComponentManifest (Join-Path $Package 'components/components.json'))) { $comps[$c.name] = $c }
    $cdir = Join-Path $Package 'components'
    $rt = Join-Path $tmp 'runtime'
    Expand-ZipTo (Join-Path $cdir $comps['pgsql'].file) (Join-Path $rt 'pgsql') $comps['pgsql'].strip @('pgAdmin 4/', 'StackBuilder/', 'doc/', 'include/')
    foreach ($exe in @('postgres.exe', 'initdb.exe', 'pg_ctl.exe', 'psql.exe', 'pg_dump.exe', 'pg_restore.exe')) { Assert (Test-Path (Join-Path $rt "pgsql/bin/$exe")) "pgsql bin/$exe" }
    Assert (-not (Test-Path (Join-Path $rt 'pgsql/pgAdmin 4'))) 'pgAdmin left out'
    Expand-ZipTo (Join-Path $cdir $comps['timescaledb'].file) (Join-Path $rt 'ts') $comps['timescaledb'].strip
    Assert ((Test-Path (Join-Path $rt 'ts/timescaledb.control')) -and @(Get-ChildItem (Join-Path $rt 'ts') -Filter 'timescaledb-2.30.2.dll').Count -eq 1 -and @(Get-ChildItem (Join-Path $rt 'ts') -Filter 'timescaledb--*2.30.2.sql').Count -gt 10) 'TimescaleDB files'
    Assert (Test-Path (Join-Path $rt 'pgsql/lib')) 'pgsql lib for the TimescaleDB DLLs'
    Assert (Test-Path (Join-Path $rt 'pgsql/share/extension')) 'pgsql share/extension for the TimescaleDB SQL'
    foreach ($pair in @(@('telegraf', 'telegraf.exe', @()), @('node', 'node.exe', @()), @('nssm', 'nssm.exe', @('nssm.exe')))) {
        Expand-ZipTo (Join-Path $cdir $comps[$pair[0]].file) (Join-Path $rt $pair[0]) $comps[$pair[0]].strip @() $pair[2]
        Assert (Test-Path (Join-Path $rt "$($pair[0])/$($pair[1])")) "$($pair[0])/$($pair[1])"
    }
    Install-PythonEmbedded (Join-Path $cdir $comps['python'].file) (Join-Path $cdir $comps['python-wheels'].dir) (Join-Path $rt 'python')
    Assert ((Test-Path (Join-Path $rt 'python/python.exe')) -and (Test-Path (Join-Path $rt 'python/Lib/site-packages/asyncua/__init__.py')) -and (Test-Path (Join-Path $rt 'python/Lib/site-packages/cryptography'))) 'python with asyncua and cryptography'
    Assert (((Get-Content (Join-Path $rt 'python/python312._pth')) -join '|') -eq 'python312.zip|.|Lib\site-packages|import site') 'python ._pth'
    foreach ($need in @('app/Start-AHWR-EDGE.ps1', 'app/Install-AHWR-EDGE-Services.ps1', 'app/app/backend/server.js', 'app/app/backend/node_modules/express/package.json', 'app/app/frontend/dist/index.html', 'app/app/sql/02-schema.sql', 'app/app/collector.py')) {
        Assert (Test-Path (Join-Path $Package $need)) "package has $need"
    }
}

Remove-Item -LiteralPath $tmp -Recurse -Force
Write-Host ''
$color = 'Green'; if ($script:failures) { $color = 'Red' }
Write-Host "$($script:passes) passed, $($script:failures) failed" -ForegroundColor $color
exit ([int][bool]$script:failures)
