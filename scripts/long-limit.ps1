while ($true) {
    # Create a temporary file for stderr
    $err = New-TemporaryFile

    # Run the command, redirect stderr to temp file
    $out = npx tsx ./long-limit.ts --cancel --spread -64 --gap -.0 --qty .01 --dispersion 1 --sleep 10 2> $err.FullName
    $rc  = $LASTEXITCODE

    # Print stderr
    Get-Content $err.FullName
    Remove-Item $err.FullName

    # Filter and sort stdout
    $out |
        Select-String -NotMatch 'cancelled' |
        Select-String -NotMatch 'Cancelling' |
        Select-String -NotMatch 'returned' |
        Sort-Object

    Write-Host "exit code: $rc"

    if ($rc -eq 2) { break }

    Get-Date
    Start-Sleep -Seconds 3600
}
