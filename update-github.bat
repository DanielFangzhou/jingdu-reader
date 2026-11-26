@echo off
setlocal
title 更新「静读」到 GitHub
cd /d "%~dp0"

where git >nul 2>&1
if errorlevel 1 goto :nogit
git rev-parse --is-inside-work-tree >nul 2>&1
if errorlevel 1 goto :notrepo
git remote get-url origin >nul 2>&1
if errorlevel 1 goto :noorigin

set "BRANCH="
for /f "delims=" %%b in ('git symbolic-ref --short HEAD 2^>nul') do set "BRANCH=%%b"
if not defined BRANCH set "BRANCH=main"
for /f "delims=" %%u in ('git remote get-url origin') do set "REMOTE=%%u"

echo ============================================================
echo              更新代码到 GitHub        (双击运行)
echo ============================================================
echo   分支: %BRANCH%
echo   远程: %REMOTE%
echo.

rem ---------- 提交署名：第一次运行需要设置一次，之后写进仓库配置 ----------
set "GITMAIL="
for /f "delims=" %%e in ('git config user.email 2^>nul') do set "GITMAIL=%%e"
if defined GITMAIL goto :hasid
echo   这个仓库还没有提交署名（只需设置一次）
set "GHUSER="
set /p GHUSER= 你的 GitHub 用户名（全小写英文）: 
if not defined GHUSER goto :noidentity
git config user.name "%GHUSER%"
git config user.email "%GHUSER%@users.noreply.github.com"
echo.
:hasid

echo [1/4] 收集改动 ...
git add -A
git diff --cached --quiet
if not errorlevel 1 goto :nochange

echo [2/4] 本次改动:
git diff --cached --shortstat
echo.
echo       用一句话说明改了什么（直接回车 = 自动用「更新 日期 时间」）
set "MSG="
set /p MSG= 说明: 

set "MSGFILE=%TEMP%\jingdu-msg-%RANDOM%.txt"
if exist "%MSGFILE%" del "%MSGFILE%" >nul 2>&1
rem 控制台是 GBK、git 要 UTF-8：先转码再提交，否则中文说明会变乱码
powershell -NoProfile -ExecutionPolicy Bypass -Command "$m = $env:MSG; if ([string]::IsNullOrWhiteSpace($m)) { $m = '更新 ' + (Get-Date -Format 'yyyy-MM-dd HH:mm') }; [IO.File]::WriteAllText($env:MSGFILE, $m.Trim(), (New-Object Text.UTF8Encoding $false))" >nul 2>nul
if not exist "%MSGFILE%" goto :msgfallback

echo [3/4] 提交 ...
git commit -q -F "%MSGFILE%"
set "RC=%ERRORLEVEL%"
del "%MSGFILE%" >nul 2>&1
if not "%RC%"=="0" goto :commitfail
goto :push

:msgfallback
echo [3/4] 提交 ...（中文转码失败，改用默认说明）
git commit -q -m "update %DATE% %TIME%"
if errorlevel 1 goto :commitfail
goto :push

rem ---------- 没有新改动：但如果还有提交没推送，也要推上去 ----------
:nochange
echo [2/4] 没有新的改动需要提交。
set "AHEAD=?"
for /f "delims=" %%c in ('git rev-list --count "@{u}..HEAD" 2^>nul') do set "AHEAD=%%c"
if "%AHEAD%"=="0" goto :nothing
echo       检测到有未推送的提交，继续推送到 GitHub ...
echo.
goto :push

:nothing
echo       本地和 GitHub 已经一致，无需操作。
echo.
pause
exit /b 0

:push
echo [4/4] 推送到 GitHub ...
echo       如果需要登录，会弹出浏览器窗口，点 Authorize 即可
echo.
git push origin %BRANCH%
if errorlevel 1 goto :pushfail

echo.
echo ============================================================
echo   已更新到 GitHub，刷新仓库页面即可看到
echo ============================================================
echo.
pause
exit /b 0

:pushfail
echo.
echo ------------------------------------------------------------
echo   推送被拒绝。最常见的原因是远程仓库里有你本地没有的提交
echo   （例如在网页上直接改过文件）。
echo.
choice /c YN /n /m "   是否自动同步远程改动后重试？(Y/N) "
if errorlevel 2 goto :giveup
echo.
echo   正在同步远程...
git pull --rebase origin %BRANCH%
if errorlevel 1 goto :conflict
git push origin %BRANCH%
if errorlevel 1 goto :giveup
echo.
echo   已同步并推送成功。
echo.
pause
exit /b 0

:conflict
echo.
echo   自动同步失败：本地改动和远程改动冲突了，需要手工处理。
echo   在下面的窗口执行这两条，看看是谁改了哪里：
echo          git status
echo          git diff
echo   确认以远程为准（会丢弃本地未推送的改动，谨慎）：
echo          git rebase --abort
echo          git reset --hard origin/%BRANCH%
echo.
pause
exit /b 1

:giveup
echo.
echo ------------------------------------------------------------
echo   推送仍未成功，按顺序排查：
echo   1. 网络 / 代理：浏览器能打开 github.com 吗
echo   2. 登录失效：再执行一次 git push，按提示在浏览器重新授权
echo   3. 权限不对：确认仓库属于你自己的账号
echo ------------------------------------------------------------
echo.
pause
exit /b 1

:commitfail
echo.
echo [错误] 提交失败，请把上面窗口里的报错发我。
echo.
pause
exit /b 1

:noidentity
echo.
echo [错误] 用户名不能为空，请重新运行。
echo.
pause
exit /b 1

:nogit
echo [错误] 找不到 git 命令，请先安装 Git for Windows。
echo        https://git-scm.com/download/win
echo.
pause
exit /b 1

:notrepo
echo [错误] 当前目录不是 Git 仓库。
echo        请把这个脚本放在 reader 文件夹里再运行。
echo.
pause
exit /b 1

:noorigin
echo [错误] 这个仓库还没有关联 GitHub 远程地址。
echo        请先双击同目录下的 push-to-github.bat 完成首次上传。
echo.
pause
exit /b 1
