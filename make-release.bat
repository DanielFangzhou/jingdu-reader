@echo off
chcp 936 >nul
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo ============================================
echo    静读 . 生成 GitHub 发布用压缩包
echo ============================================
echo.

set "SRC=%~dp0..\dist\静读"
if not exist "%SRC%\静读.exe" (
  echo [X] 没找到 dist\静读\静读.exe
  echo     请先运行 build-portable.sh 打包，再执行本脚本。
  goto :fail
)

rem ---- 读取版本号 ----
set "VER="
for /f "delims=" %%l in ('findstr /c:"\"version\":" package.json') do if not defined LINE set "LINE=%%l"
if defined LINE (
  set "TMPV=!LINE:*"version": =!"
  set "TMPV=!TMPV:"=!"
  set "TMPV=!TMPV:,=!"
  set "TMPV=!TMPV: =!"
  set "VER=!TMPV!"
)
if not defined VER set "VER=1.0.0"
echo [1/3] 版本号: %VER%

rem ---- 复制（排除个人数据）----
set "WORK=%~dp0..\dist\_release_tmp"
set "OUTDIR=%WORK%\Jingdu-Reader-%VER%"
if exist "%WORK%" rd /s /q "%WORK%"
mkdir "%OUTDIR%" >nul

echo [2/3] 复制程序文件（跳过 user-data 个人数据）...
robocopy "%SRC%" "%OUTDIR%" /E /XD user-data /NFL /NDL /NJH /NJS /NP >nul
if errorlevel 8 (
  echo [X] 复制失败，检查 dist\静读 是否完整
  goto :fail
)

rem ---- 压缩 ----
set "ZIP=%~dp0..\dist\Jingdu-Reader-%VER%-win-x64.zip"
if exist "%ZIP%" del /f /q "%ZIP%" >nul

echo [3/3] 压缩中，约需半分钟...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ProgressPreference='SilentlyContinue'; Compress-Archive -LiteralPath '%OUTDIR%' -DestinationPath '%ZIP%' -CompressionLevel Optimal -Force" >nul 2>&1

if not exist "%ZIP%" (
  echo [X] 压缩失败
  goto :fail
)

rd /s /q "%WORK%" 2>nul

for %%f in ("%ZIP%") do set "SZ=%%~zf"
set /a MB=%SZ%/1048576
echo.
echo ============================================
echo  完成，压缩包 %MB% MB
echo  路径: %ZIP%
echo ============================================
echo.
echo 下一步（网页操作，约 1 分钟）:
echo   1. 打开 github.com/DanielFangzhou/jingdu-reader/releases
echo   2. 点右边的 Draft a new release
echo   3. Tag 填 v%VER% ，标题写 静读 %VER%
echo   4. 把刚生成的 zip 拖进 Attachments 区域
echo   5. 点 Publish release
echo.
echo 注: 包里已自动剔除 user-data，不会泄露你的书库与阅读记录。
echo.
pause
exit /b 0

:fail
echo.
echo 出错了，窗口先留着，按任意键关闭。
if exist "%WORK%" rd /s /q "%WORK%" 2>nul
pause
exit /b 1
