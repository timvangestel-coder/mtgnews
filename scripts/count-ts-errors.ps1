$output = npx tsc --noEmit 2>&1
$count = ($output | Select-String 'error TS').Count
Write-Host "Total errors: $count"
$output | Select-String 'error TS'