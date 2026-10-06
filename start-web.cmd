@echo off
REM ═══════════════════════════════════════════════════════════════════════
REM  mp_Tools 網頁版 —— 本機啟動器
REM
REM  這個 .cmd 只做一件事：起一個靜態伺服器然後開瀏覽器。
REM  **不需要 npm、不需要 build、不需要安裝任何東西。**
REM
REM  為什麼不能直接雙擊 index.html？
REM    ES module 在 file:// 下會被瀏覽器的同源政策擋掉（CORS），
REM    而且 Web Serial 需要安全來源。http://127.0.0.1 兩者都滿足。
REM ═══════════════════════════════════════════════════════════════════════
setlocal
set PORT=8807
cd /d "%~dp0web"

where python >nul 2>nul
if errorlevel 1 (
  echo.
  echo   找不到 python。請改用任何靜態伺服器，例如：
  echo       npx serve web
  echo       php -S 127.0.0.1:%PORT% -t web
  echo.
  pause
  exit /b 1
)

echo.
echo   mp_Tools 網頁版
echo   開啟 http://127.0.0.1:%PORT%/
echo   按 Ctrl-C 結束
echo.

start "" "http://127.0.0.1:%PORT%/"
python -m http.server %PORT% --bind 127.0.0.1
endlocal
