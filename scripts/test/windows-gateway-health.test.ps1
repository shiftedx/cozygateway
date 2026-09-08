$ErrorActionPreference='Stop'
$tokens=$null; $errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot '..\install.ps1'),[ref]$tokens,[ref]$errors)
foreach($name in @('Fail','Assert-BootstrapPath','Assert-BootstrapPathAndParents','Assert-BootstrapRegularFile','Get-WindowsGatewayBundleVersion','Wait-WindowsGatewayReady')) {
    $fn=$ast.FindAll({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name},$true) | Select-Object -First 1
    Invoke-Expression $fn.Extent.Text
}
function Assert-True([bool]$Value,[string]$Message){if(-not $Value){throw "ASSERT: $Message"}}
$root=Join-Path ([IO.Path]::GetTempPath()) ('cozy-health-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path (Join-Path $root 'local'),(Join-Path $root 'bin') -Force | Out-Null
$node=(Get-Command node.exe).Source
$bundle=Join-Path $root 'bin\cozygateway.mjs'
$config=Join-Path $root 'local\cozygateway.config.json'
$state=Join-Path $root 'local\install-state'
[IO.File]::WriteAllText($state,"node_resolved=$node`n")
$server=$null
try {
    [IO.File]::WriteAllText($bundle,'var GATEWAY_VERSION = "0.7.9";')
    Assert-True ((Get-WindowsGatewayBundleVersion $bundle) -eq '0.7.9') 'bundle version must parse without executing it'
    foreach($bad in @('console.log("no version");','var GATEWAY_VERSION = "bad";','var GATEWAY_VERSION = "0.7.9"; var GATEWAY_VERSION = "0.8.0";')) {
        [IO.File]::WriteAllText($bundle,$bad)
        $failed=$false; try {Get-WindowsGatewayBundleVersion $bundle | Out-Null} catch {$failed=$true}
        Assert-True $failed 'ambiguous or missing version must fail'
    }
    [IO.File]::WriteAllText($bundle,'var GATEWAY_VERSION = "0.7.9";')
    $fixture=Join-Path $root 'server.cjs'
    [IO.File]::WriteAllText($fixture,@'
const fs=require('node:fs'),http=require('node:http'),path=require('node:path');
const root=process.argv[2];let count=0;
const db=new (require('node:sqlite').DatabaseSync)(path.join(root,'local','cozygateway.db'));
db.exec('CREATE TABLE IF NOT EXISTS deleted_bots (bot TEXT PRIMARY KEY)');
db.prepare('INSERT OR IGNORE INTO deleted_bots VALUES (?)').run('deleted');
db.close();
const oldDb=new (require('node:sqlite').DatabaseSync)(path.join(root,'local','old.db'));
oldDb.exec('CREATE TABLE IF NOT EXISTS legacy (id TEXT)');oldDb.close();
const handle=(req,res)=>{
 const mode=fs.readFileSync(path.join(root,'mode'),'utf8');
 count++;res.setHeader('Content-Type','application/json');
 if(mode==='oversized'){res.end('x'.repeat(70000));return;}
 if(mode==='malformed'){res.end('{');return;}
 if(mode==='zero'){res.end(JSON.stringify({version:'0.7.9',attach:{deadLetters:0,hermes:{configured:0,online:0}}}));return;}
 res.end(JSON.stringify({version:mode==='wrong'||(mode==='later'&&count<3)?'0.7.8':'0.7.9',attach:{configured:2,online:2,deadLetters:mode==='dead'?1:0,hermes:{configured:mode==='count'?1:2,online:mode==='offline'?1:2}}}));
};
const server=fs.existsSync(path.join(root,'tls'))?require('node:https').createServer({cert:fs.readFileSync(path.join(root,'cert.pem')),key:fs.readFileSync(path.join(root,'key.pem'))},handle):http.createServer(handle);
server.listen(0,'127.0.0.1',function(){fs.writeFileSync(path.join(root,'port'),String(this.address().port));});
'@)
    [IO.File]::WriteAllText((Join-Path $root 'mode'),'later')
    $server=Start-Process -FilePath $node -ArgumentList @(('"'+$fixture+'"'),('"'+$root+'"')) -WindowStyle Hidden -PassThru
    $deadline=[DateTime]::UtcNow.AddSeconds(10)
    while(-not (Test-Path (Join-Path $root 'port')) -and [DateTime]::UtcNow -lt $deadline){Start-Sleep -Milliseconds 50}
    $port=[int][IO.File]::ReadAllText((Join-Path $root 'port'))
    [IO.File]::WriteAllText($config,(@{host='0.0.0.0';port=$port;hermesEndpoints=@(@{id='default';url='http://unused/1';profiles=@{default=@{tokenEnv='DEFAULT'};work=@{tokenEnv='WORK'}}})}|ConvertTo-Json -Depth 6))
    Wait-WindowsGatewayReady $root -TimeoutSeconds 4
    foreach($mode in @('wrong','offline','count','dead','malformed','oversized')) {
        [IO.File]::WriteAllText((Join-Path $root 'mode'),$mode)
        $failed=$false;try {Wait-WindowsGatewayReady $root -TimeoutSeconds 1} catch {$failed=$true}
        Assert-True $failed "health $mode must not count as ready"
    }
    [IO.File]::WriteAllText((Join-Path $root 'mode'),'ready')
    [IO.File]::WriteAllText($config,(@{host='127.0.0.1';port=$port;hermesEndpoints=@(@{id='default';profiles=@{default=@{tokenEnv='DEFAULT'};work=@{tokenEnv='WORK'};DELETED=@{tokenEnv='DELETED'}}})}|ConvertTo-Json -Depth 6))
    $databaseHash=(Get-FileHash (Join-Path $root 'local\cozygateway.db')).Hash
    Wait-WindowsGatewayReady $root -TimeoutSeconds 2
    Assert-True ((Get-FileHash (Join-Path $root 'local\cozygateway.db')).Hash -eq $databaseHash) 'readiness must not modify tombstones or migrate the database'
    [IO.File]::WriteAllText((Join-Path $root 'mode'),'zero')
    [IO.File]::WriteAllText($config,(@{host='127.0.0.1';port=$port;hermesEndpoints=@(@{id='default';profiles=@{deleted=@{tokenEnv='DELETED'}}})}|ConvertTo-Json -Depth 6))
    Wait-WindowsGatewayReady $root -TimeoutSeconds 2
    [IO.File]::WriteAllText($config,(@{host='127.0.0.1';port=$port;dbPath='missing.db';hermesEndpoints=@(@{id='default';profiles=@{default=@{tokenEnv='DEFAULT'}}})}|ConvertTo-Json -Depth 6))
    $failed=$false;try {Wait-WindowsGatewayReady $root -TimeoutSeconds 1} catch {$failed=$true}
    Assert-True ($failed -and -not (Test-Path (Join-Path $root 'local\missing.db'))) 'readiness must not create an absent database'
    [IO.File]::WriteAllText((Join-Path $root 'mode'),'ready')
    [IO.File]::WriteAllText($config,(@{host='127.0.0.1';port=$port;hermesEndpoints=@(@{id='one';profiles=@{same=@{tokenEnv='ONE'}}},@{id='two';profiles=@{same=@{tokenEnv='TWO'}}})}|ConvertTo-Json -Depth 6))
    Wait-WindowsGatewayReady $root -TimeoutSeconds 2
    $gatewayEnv=Join-Path $root 'local\gateway.env'
    [IO.File]::WriteAllText($config,(@{host='192.0.2.1';port=1;dbPath='absent-config.db';hermesEndpoints=@(@{id='default';profiles=@{default=@{tokenEnv='DEFAULT'};work=@{tokenEnv='WORK'}}})}|ConvertTo-Json -Depth 6))
    [IO.File]::WriteAllText($gatewayEnv,"COZYGATEWAY_HOST='127.0.0.1'`nCOZYGATEWAY_PORT=$port`nCOZYGATEWAY_DB_PATH=old.db`n")
    Wait-WindowsGatewayReady $root -TimeoutSeconds 2
    Assert-True (-not (Test-Path (Join-Path $root 'local\absent-config.db'))) 'persisted DB override must not create the unused configured DB'
    Remove-Item -LiteralPath $gatewayEnv
    New-Item -ItemType Directory -Path $gatewayEnv | Out-Null
    $failed=$false;try {Wait-WindowsGatewayReady $root -TimeoutSeconds 1} catch {$failed=$true}
    Assert-True $failed 'gateway.env must be a regular file before readiness reads it'
    Remove-Item -LiteralPath $gatewayEnv
    [IO.File]::WriteAllText((Join-Path $root 'mode'),'offline')
    [IO.File]::WriteAllText($config,(@{host='127.0.0.1';port=$port;hermesEndpoints=@()}|ConvertTo-Json))
    Wait-WindowsGatewayReady $root -TimeoutSeconds 2
    [IO.File]::WriteAllText($config,(@{host='127.0.0.1';port=$port}|ConvertTo-Json))
    Wait-WindowsGatewayReady $root -TimeoutSeconds 2
    $openssl=Join-Path $env:ProgramFiles 'Git\usr\bin\openssl.exe'
    if(Test-Path -LiteralPath $openssl) {
        Stop-Process -Id $server.Id -Force; $server.WaitForExit(); $server.Dispose(); $server=$null
        $cert=Join-Path $root 'cert.pem'; $key=Join-Path $root 'key.pem'
        $certificateProcess=Start-Process -FilePath $openssl -ArgumentList @('req','-x509','-newkey','rsa:2048','-nodes','-keyout',('"'+$key+'"'),'-out',('"'+$cert+'"'),'-days','1','-subj','/CN=localhost') -WindowStyle Hidden -PassThru -Wait -RedirectStandardError (Join-Path $root 'openssl.log')
        Assert-True ($certificateProcess.ExitCode -eq 0) 'test certificate generation must succeed'
        $certificateProcess.Dispose()
        [IO.File]::WriteAllText((Join-Path $root 'tls'),'1')
        Remove-Item -LiteralPath (Join-Path $root 'port')
        $server=Start-Process -FilePath $node -ArgumentList @(('"'+$fixture+'"'),('"'+$root+'"')) -WindowStyle Hidden -PassThru
        $deadline=[DateTime]::UtcNow.AddSeconds(10)
        while(-not (Test-Path (Join-Path $root 'port')) -and [DateTime]::UtcNow -lt $deadline){Start-Sleep -Milliseconds 50}
        $port=[int][IO.File]::ReadAllText((Join-Path $root 'port'))
        [IO.File]::WriteAllText($config,(@{host='127.0.0.1';port=$port;hermesEndpoints=@();tls=@{certFile='../cert.pem'}}|ConvertTo-Json -Depth 4))
        Wait-WindowsGatewayReady $root -TimeoutSeconds 2
        [IO.File]::WriteAllText($config,(@{host='192.0.2.1';port=1;hermesEndpoints=@()}|ConvertTo-Json -Depth 4))
        [IO.File]::WriteAllText($gatewayEnv,"COZYGATEWAY_HOST=127.0.0.1`nCOZYGATEWAY_PORT=$port`nCOZY_TLS_CERT_FILE='../cert.pem'`nCOZY_TLS_KEY_FILE='../key.pem'`n")
        Wait-WindowsGatewayReady $root -TimeoutSeconds 2
        [IO.File]::WriteAllText($gatewayEnv,"COZYGATEWAY_HOST=127.0.0.1`nCOZYGATEWAY_PORT=$port`nCOZY_TLS_CERT_FILE='../cert.pem'`n")
        $failed=$false;try {Wait-WindowsGatewayReady $root -TimeoutSeconds 1} catch {$failed=$true}
        Assert-True $failed 'half-configured persisted TLS override must fail closed'
        Remove-Item -LiteralPath $gatewayEnv
        [IO.File]::WriteAllText($config,(@{host='127.0.0.1';port=$port;hermesEndpoints=@();tls=@{certFile=$key}}|ConvertTo-Json -Depth 4))
        $failed=$false;try {Wait-WindowsGatewayReady $root -TimeoutSeconds 1} catch {$failed=$true}
        Assert-True $failed 'invalid configured TLS certificate must fail closed'
    } else {Write-Host 'TLS fixture skipped: Git OpenSSL unavailable'}
    Write-Host 'Windows gateway health tests passed'
} finally {
    if($server){if(-not $server.HasExited){Stop-Process -Id $server.Id -Force};$server.WaitForExit();$server.Dispose()}
    $resolved=[IO.Path]::GetFullPath($root)
    if(-not $resolved.StartsWith([IO.Path]::GetFullPath([IO.Path]::GetTempPath()),[StringComparison]::OrdinalIgnoreCase)){throw 'unsafe cleanup'}
    Remove-Item -LiteralPath $resolved -Recurse -Force
}
