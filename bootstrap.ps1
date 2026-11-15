$ErrorActionPreference = 'Stop'
$temporary = Read-Host 'Enter the supplied temporary Administrator password' -AsSecureString
$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($temporary)
$previousEncoding = $OutputEncoding
try {
    $OutputEncoding = New-Object System.Text.UTF8Encoding($false)
    [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) | node (Join-Path $PSScriptRoot 'server.mjs') bootstrap
    if ($LASTEXITCODE -ne 0) { throw 'Administrator setup failed. Check the message above.' }
}
finally {
    $OutputEncoding = $previousEncoding
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
    $temporary.Dispose()
}
