@echo off
chcp 65001 >nul
rem SnowLuma × AstrBot 控制台 —— 开发模式启动脚本
rem 说明：某些终端环境会预设 ELECTRON_RUN_AS_NODE=1，导致 Electron 以纯 Node 方式运行，
rem       这里显式清掉它，保证以 GUI 方式启动（不会弹出任何终端控制台窗口）。
set ELECTRON_RUN_AS_NODE=
cd /d "%~dp0"
if not exist "node_modules\electron\dist\electron.exe" (
  echo [1/2] 首次运行，正在安装依赖...
  set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
  call npm install --no-audit --no-fund || goto :fail
)
echo [2/2] 正在启动控制台...
start "" "node_modules\electron\dist\electron.exe" "%~dp0."
exit /b 0

:fail
echo.
echo 依赖安装失败，请检查网络后重试（可先执行：npm install）。
pause
exit /b 1
