@echo off
chcp 65001 >nul
title 음악 스튜디오
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  [오류] Node.js가 설치되어 있지 않습니다.
  echo  https://nodejs.org 에서 LTS 버전을 설치한 뒤 다시 실행해 주세요.
  echo.
  pause
  exit /b 1
)

if not exist node_modules (
  echo  첫 실행 준비 중입니다... 잠시만 기다려 주세요. ^(1~2분^)
  call npm install --no-audit --no-fund
)

echo  음악 스튜디오를 시작합니다. 잠시 후 브라우저가 열립니다...
node server.js
pause
