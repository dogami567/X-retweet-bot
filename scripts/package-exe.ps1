$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$exePath = Join-Path $repoRoot "dist-exe\\X-get2put.exe"
$outDir = Join-Path $repoRoot "dist-exe\\X-get2put"
$outZip = Join-Path $repoRoot "X-get2put-exe.zip"

if (-not (Test-Path $exePath)) {
  Write-Host "未找到 exe：$exePath"
  Write-Host "请先运行：npm run build:exe"
  exit 1
}

if (Test-Path $outDir) {
  Remove-Item -Recurse -Force $outDir
}

New-Item -ItemType Directory -Path $outDir | Out-Null

Copy-Item -Force $exePath (Join-Path $outDir "X-get2put.exe")
Copy-Item -Force (Join-Path $repoRoot "README.md") (Join-Path $outDir "README.md")
Copy-Item -Force (Join-Path $repoRoot ".env.empty") (Join-Path $outDir ".env")
Copy-Item -Force (Join-Path $repoRoot ".env.example") (Join-Path $outDir ".env.example")

# 预创建可写目录，避免小白第一次运行误以为没生成文件
New-Item -ItemType Directory -Path (Join-Path $outDir "data") | Out-Null

if (Test-Path $outZip) {
  Remove-Item -Force $outZip
}

Compress-Archive -Path $outDir -DestinationPath $outZip -Force

Write-Host "已生成：$outZip"
