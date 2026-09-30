@echo off
setlocal
cd /d "%~dp0"
echo Close the old npm dev window with Ctrl+C before continuing.
echo Reinstalling dependencies. Your .env and cloud data are preserved.
where node >nul 2>&1
if errorlevel 1 goto missingnode
node -e "if(Number(process.versions.node.split('.')[0])<20){console.error('Install Node.js 22 first.');process.exit(1)}"
if errorlevel 1 goto failed
call npm ci --no-audit --no-fund > INSTALL_LOG.txt 2>&1
if errorlevel 1 goto failed
node scripts/check-install.mjs
if errorlevel 1 goto failed
if not exist .env goto missingenv
node scripts/check-env.mjs
if errorlevel 1 goto badenv
echo Opening http://localhost:5174 ...
call npm run dev -- --force
if errorlevel 1 goto failed
exit /b 0
:missingnode
echo Install Node.js 22 and reopen this file.
pause
exit /b 1
:missingenv
echo No .env file found. Starting setup...
call SETUP_ENV.cmd
exit /b 1
:badenv
echo Fix .env (double-click SETUP_ENV.cmd), then run START_WINDOWS.cmd again.
pause
exit /b 1
:failed
echo Setup failed. Send the final error lines from INSTALL_LOG.txt.
echo Do not send your .env or password.
pause
exit /b 1
