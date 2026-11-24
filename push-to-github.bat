@echo off
setlocal
title 把 静读 上传到 GitHub
cd /d "%~dp0"

where git >nul 2>&1
if errorlevel 1 goto :nogit

git rev-parse --is-inside-work-tree >nul 2>&1
if errorlevel 1 goto :notrepo

echo ============================================================
echo            把「静读」上传到 GitHub        (双击运行)
echo ============================================================
echo.
echo  前提：已经在 GitHub 网页上建好一个「空的」仓库。
echo        建仓库时 Add a README / .gitignore / license 都不要勾。
echo.
echo ------------------------------------------------------------
set "GHUSER="
set /p GHUSER= 1) 输入你的 GitHub 用户名（全小写英文，例如 zhangsan）:
if not defined GHUSER goto :nouser
echo.
echo 2) 打开你的仓库页面，点绿色 [Code] 按钮，复制那个 https 地址，
echo    然后在下面窗口里「右键」粘贴（不要按 Ctrl+V，也不要按 Shift+Insert）
set "REPOURL="
set /p REPOURL= 仓库地址（形如 https://github.com/xxx/jingdu-reader.git）:
if not defined REPOURL goto :nourl

set "REPOURL=%REPOURL: =%"
set "GHUSER=%GHUSER: =%"

echo.
echo [1/4] 把提交署名改成你的账号 ...
git config user.name "%GHUSER%"
git config user.email "%GHUSER%@users.noreply.github.com"
git commit --amend --reset-author --no-edit >nul 2>nul
if errorlevel 1 echo        已是最新署名，跳过

echo [2/4] 关联远程仓库 ...
git remote remove origin >nul 2>&1
git remote add origin "%REPOURL%"
if errorlevel 1 goto :badurl
echo        已关联: %REPOURL%

echo [3/4] 开始上传 ...
echo        如果弹出浏览器窗口，请登录 GitHub 并点 Authorize / 授权
echo.
git push -u origin main
if errorlevel 1 goto :pushfail

echo.
echo ============================================================
echo   上传成功！
echo   浏览器打开 https://github.com/%GHUSER% 就能看到仓库了
echo ============================================================
echo.
pause
exit /b 0

:nogit
echo [错误] 这台机器找不到 git 命令。
echo        请先安装 Git for Windows: https://git-scm.com/download/win
echo.
pause
exit /b 1

:notrepo
echo [错误] 当前目录不是 Git 仓库。
echo        请把这个脚本放在 reader 文件夹里再运行。
echo.
pause
exit /b 1

:nouser
echo.
echo [错误] 用户名不能为空，请重新运行。
pause
exit /b 1

:nourl
echo.
echo [错误] 仓库地址不能为空，请重新运行。
pause
exit /b 1

:badurl
echo.
echo [错误] 仓库地址格式不对，或网络不通。
echo        正确格式: https://github.com/你的用户名/jingdu-reader.git
echo.
pause
exit /b 1

:pushfail
echo.
echo ------------------------------------------------------------
echo   上传失败，按下面顺序排除：
echo.
echo   1. 仓库地址写错了？打开仓库页面重新复制一次。
echo   2. 网页建仓库时勾了 README / .gitignore？
echo      在下面的窗口里执行这一行，然后重新运行本脚本：
echo          git pull --rebase origin main
echo   3. 没弹出浏览器登录？看上面窗口里是否提示输入 Username，
echo      输入用户名后，密码处要粘贴 Personal Access Token，不是登录密码。
echo      去这里生成（勾 repo 权限）：https://github.com/settings/tokens
echo ------------------------------------------------------------
echo.
pause
exit /b 1
