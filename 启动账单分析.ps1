$ErrorActionPreference = 'Stop'
$ProjectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $ProjectDir

python -c "import openpyxl" 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Host '正在安装 Excel 解析依赖...'
    python -m pip install -r requirements.txt
}

python app.py serve
