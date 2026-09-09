@echo off
chcp 65001 >nul
cd /d "%~dp0"
python -c "import openpyxl" >nul 2>nul
if errorlevel 1 (
  echo 正在安装 Excel 解析依赖...
  python -m pip install -r requirements.txt
)
python app.py serve
pause
