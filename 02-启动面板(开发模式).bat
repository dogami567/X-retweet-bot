@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul

cd /d "%~dp0"

echo.
echo 检查 Node.js...
where node >nul 2>nul
if errorlevel 1 (
  echo 未检测到 Node.js，请先双击运行：01-安装环境.bat
  echo 或前往 https://nodejs.org/en/download/ 安装 Node.js LTS
  pause
  exit /b 1
)

if not exist "node_modules\" (
  echo.
  echo 未发现 node_modules，说明依赖未安装。
  echo 请先双击运行：01-安装环境.bat
  pause
  exit /b 1
)

echo.
echo 启动服务（npm run dev）...
echo （将打开一个新的命令行窗口显示日志）
start "X-get2put Dev Server" cmd /k "cd /d \"%~dp0\" && npm run dev"

echo.
echo 等待服务启动并自动打开浏览器...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference='SilentlyContinue';" ^
  "$ports=3000..3010;" ^
  "$found=$null;" ^
  "for($i=0;$i -lt 60 -and -not $found;$i++){" ^
  "  foreach($p in $ports){" ^
  "    try{" ^
  "      $r=Invoke-WebRequest -UseBasicParsing -TimeoutSec 1 -Uri ('http://localhost:{0}/api/logs' -f $p);" ^
  "      if($r.StatusCode -ge 200 -and $r.StatusCode -lt 500){ $found=$p; break }" ^
  "    } catch {}" ^
  "  }" ^
  "  if(-not $found){ Start-Sleep -Seconds 1 }" ^
  "}" ^
  "if(-not $found){ $found=3000 }" ^
  "Start-Process ('http://localhost:{0}' -f $found);"

echo.
echo 已尝试打开面板，如果没打开请手动访问：http://localhost:3000
echo （若 3000 被占用，端口可能是 3001/3002...，看服务日志里“Server listening on ...”）
echo.
pause
