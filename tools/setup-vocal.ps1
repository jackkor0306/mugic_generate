# AI 가창 도구 설치 스크립트 (최초 1회)
# OpenUtau + 한국어 지원 DiffSinger 보이스뱅크(Nishiren) + .NET 런타임 + 헤드리스 렌더러 빌드
# 실행: PowerShell에서  .\setup-vocal.ps1
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$tools = Split-Path $MyInvocation.MyCommand.Definition -Parent
$ou = Join-Path $tools 'OpenUtau'
$dl = Join-Path $tools 'downloads'
New-Item -ItemType Directory -Force $dl | Out-Null
Add-Type -AssemblyName System.IO.Compression.FileSystem

if (-not (Test-Path (Join-Path $ou 'OpenUtau.exe'))) {
  Write-Host '1/4 OpenUtau 다운로드 중... (약 130MB)'
  $zip = Join-Path $dl 'OpenUtau-win-x64.zip'
  if (-not (Test-Path $zip)) { Invoke-WebRequest 'https://github.com/openutau/OpenUtau/releases/download/0.1.565/OpenUtau-win-x64.zip' -OutFile $zip }
  [IO.Compression.ZipFile]::ExtractToDirectory($zip, $ou)
}

if (-not (Test-Path (Join-Path $ou 'Singers\Nishiren Diffsinger v2.0\dsconfig.yaml'))) {
  Write-Host '2/4 한국어 AI 가수(Nishiren) 다운로드 중... (약 900MB, 오래 걸립니다)'
  $zip = Join-Path $dl 'Nishiren.zip'
  if (-not (Test-Path $zip)) { Invoke-WebRequest 'https://github.com/Gardanana/Nishiren-AI-Diffsinger/releases/download/v2.0/Nishiren.Diffsinger.v2.0.zip' -OutFile $zip }
  New-Item -ItemType Directory -Force (Join-Path $ou 'Singers') | Out-Null
  [IO.Compression.ZipFile]::ExtractToDirectory($zip, (Join-Path $ou 'Singers'))
}

if (-not (Test-Path (Join-Path $ou 'shared\Microsoft.NETCore.App'))) {
  Write-Host '3/4 .NET 8 런타임 설치 중...'
  $inst = Join-Path $dl 'dotnet-install.ps1'
  Invoke-WebRequest 'https://dot.net/v1/dotnet-install.ps1' -OutFile $inst
  & $inst -Runtime dotnet -Channel 8.0 -InstallDir $ou
}

if (-not (Test-Path (Join-Path $ou 'OuRender.exe'))) {
  Write-Host '4/4 헤드리스 렌더러 빌드 중...'
  $sdk = Join-Path $env:LOCALAPPDATA 'Microsoft\dotnet\dotnet.exe'
  if (-not (Test-Path $sdk)) {
    $inst = Join-Path $dl 'dotnet-install.ps1'
    if (-not (Test-Path $inst)) { Invoke-WebRequest 'https://dot.net/v1/dotnet-install.ps1' -OutFile $inst }
    & $inst -Channel 8.0 -InstallDir (Join-Path $env:LOCALAPPDATA 'Microsoft\dotnet')
  }
  Push-Location (Join-Path $tools 'OuRender')
  & $sdk build -c Release -o $ou
  Pop-Location
}

Write-Host '완료! 음악 스튜디오에서 「AI 가창 렌더링」을 사용할 수 있습니다.'
