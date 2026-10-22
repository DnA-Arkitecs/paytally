# Opens a small window with one Copy button per PayTally key, for pasting the
# keys saved by paste-keys.ps1 into a host such as Render. Keys never appear on
# screen or in output; the clipboard is cleared when the window closes.
# Run:  powershell -NoProfile -ExecutionPolicy Bypass -STA -File scripts\copy-keys.ps1
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$names = 'PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET', 'ANTHROPIC_API_KEY'

$form = New-Object System.Windows.Forms.Form
$form.Text = 'PayTally keys: copy, then paste'
$form.TopMost = $true
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$form.MinimizeBox = $false
$form.ClientSize = New-Object System.Drawing.Size(440, 200)

$status = New-Object System.Windows.Forms.Label
$status.Location = New-Object System.Drawing.Point(14, 160)
$status.Size = New-Object System.Drawing.Size(410, 30)
$status.Text = 'Click a key, paste it into the box with the same name, then the next.'

$y = 14
foreach ($n in $names) {
    $button = New-Object System.Windows.Forms.Button
    $button.Text = "Copy $n"
    $button.Tag = $n
    $button.Location = New-Object System.Drawing.Point(14, $y)
    $button.Size = New-Object System.Drawing.Size(410, 36)
    $button.Add_Click({
        param($sender)
        $value = [Environment]::GetEnvironmentVariable($sender.Tag, 'User')
        if ($value) {
            [System.Windows.Forms.Clipboard]::SetText($value.Trim())
            $status.Text = "Copied $($sender.Tag). Paste it into Render (Ctrl+V)."
        } else {
            $status.Text = "$($sender.Tag) is not saved on this PC. Run paste-keys.ps1 first."
        }
    })
    $form.Controls.Add($button)
    $y += 46
}
$form.Controls.Add($status)

[void]$form.ShowDialog()
[System.Windows.Forms.Clipboard]::Clear()
$form.Dispose()
'CLOSED (clipboard cleared)'
