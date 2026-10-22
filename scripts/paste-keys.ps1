# Opens a masked paste box for PayTally's keys and saves each one as a Windows
# User environment variable. Keys never appear on screen or in output; only
# their length is printed. Leave a box empty to keep that key as it is.
# Run:  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\paste-keys.ps1
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$names = 'ANTHROPIC_API_KEY', 'PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET'

$form = New-Object System.Windows.Forms.Form
$form.Text = 'PayTally keys'
$form.TopMost = $true
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$form.MinimizeBox = $false
$form.ClientSize = New-Object System.Drawing.Size(440, 230)

$boxes = @{}
$y = 14
foreach ($n in $names) {
    $label = New-Object System.Windows.Forms.Label
    $label.Text = $n
    $label.Location = New-Object System.Drawing.Point(14, $y)
    $label.Size = New-Object System.Drawing.Size(410, 18)
    $form.Controls.Add($label)

    $box = New-Object System.Windows.Forms.TextBox
    $box.UseSystemPasswordChar = $true
    $box.Location = New-Object System.Drawing.Point(14, ($y + 20))
    $box.Size = New-Object System.Drawing.Size(410, 24)
    $form.Controls.Add($box)
    $boxes[$n] = $box
    $y += 54
}

$save = New-Object System.Windows.Forms.Button
$save.Text = 'Save'
$save.DialogResult = [System.Windows.Forms.DialogResult]::OK
$save.Location = New-Object System.Drawing.Point(254, ($y + 6))
$form.Controls.Add($save)

$cancel = New-Object System.Windows.Forms.Button
$cancel.Text = 'Cancel'
$cancel.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
$cancel.Location = New-Object System.Drawing.Point(344, ($y + 6))
$form.Controls.Add($cancel)

$form.AcceptButton = $save
$form.CancelButton = $cancel

if ($form.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
    foreach ($n in $names) {
        $value = $boxes[$n].Text.Trim()
        if ($value) {
            [Environment]::SetEnvironmentVariable($n, $value, 'User')
            "SAVED $n length=$($value.Length)"
        } else {
            "KEPT $n (box left empty)"
        }
    }
} else {
    'CANCELLED'
}
$form.Dispose()
