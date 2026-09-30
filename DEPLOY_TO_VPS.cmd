@echo off
setlocal
cd /d "%~dp0"
echo ==== Lavanya OMS - build and upload to VPS ====
node scripts\check-env.mjs
if errorlevel 1 goto bad
findstr /c:"VITE_ENVIRONMENT=production" .env >nul
if errorlevel 1 (
  echo .env is not LIVE. Run SETUP_ENV.cmd and choose L first.
  goto bad
)
call npm run build
if errorlevel 1 goto bad
set /p VPSIP=VPS IP address: 
echo Uploading... (type the VPS root password each time it is asked - 3 times)
ssh root@%VPSIP% "rm -rf /var/www/lavanya-oms.new && mkdir -p /var/www"
scp -r dist root@%VPSIP%:/var/www/lavanya-oms.new
if errorlevel 1 goto bad
ssh root@%VPSIP% "rm -rf /var/www/lavanya-oms.old; if [ -d /var/www/lavanya-oms ]; then mv /var/www/lavanya-oms /var/www/lavanya-oms.old; fi; mv /var/www/lavanya-oms.new /var/www/lavanya-oms && echo DEPLOYED"
echo.
echo Done. Open https://lavanyaoms.co.in and press Ctrl+F5.
pause
exit /b 0
:bad
echo Stopped. Nothing was changed on the server.
pause
exit /b 1
