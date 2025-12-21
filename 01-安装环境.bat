@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul

cd /d "%~dp0"

echo.
echo [1/3] 检查 Node.js...
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo 未检测到 Node.js。
  echo 请先安装 Node.js LTS（建议 18/20/22 均可），安装完成后再双击本脚本。
  echo 下载地址：https://nodejs.org/en/download/
  start "" "https://nodejs.org/en/download/"
  echo.
  pause
  exit /b 1
)

echo Node: 
node -v
echo npm:
where npm >nul 2>nul
if errorlevel 1 (
  echo 未检测到 npm，请检查 Node.js 是否安装完整。
  pause
  exit /b 1
)
npm -v

echo.
echo [2/3] 安装依赖（npm install）...
npm install
if errorlevel 1 (
  echo.
  echo 依赖安装失败，请把窗口内容截图发我排查。
  pause
  exit /b 1
)

echo.
echo [3/3] 完成！
echo 你现在可以双击运行：02-启动面板(开发模式).bat
echo.
pause
