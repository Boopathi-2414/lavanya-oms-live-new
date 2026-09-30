@echo off
setlocal
cd /d "%~dp0"
echo.
echo ==== Lavanya OMS - .env setup ====
echo NEVER paste a secret / service_role key or database password here.
echo.
echo  L = LIVE business database (pgctafxsbcvrbqbqkzer)
echo  T = TEST database (jfynrmusohnbsmlhainm)
set /p WHICH=Type L or T and press Enter: 
if /i "%WHICH%"=="L" goto live
if /i "%WHICH%"=="T" goto test
echo Please type L or T.
goto end_bad
:live
set "SURL=https://pgctafxsbcvrbqbqkzer.supabase.co"
set "SKEY=sb_publishable_0ffbGTX9Ihr-EDDiUNcU1w_Bi_jErQJ"
set "SMODE=production"
set "SUID=eb0e75f2-f376-4b66-9d90-c5db292158b3"
goto write
:test
echo Supabase - TEST project - Project Settings - API
set /p SURL=Paste TEST Project URL and press Enter: 
set /p SKEY=Paste TEST publishable key and press Enter: 
set "SMODE=test"
:uid
if "%SURL:~-1%"=="/" set "SURL=%SURL:~0,-1%"
echo.
echo Supabase - Authentication - Users - click your login email - copy "User UID".
echo (Not sure? Just press Enter, then run PREFLIGHT.cmd - it shows the correct UID.)
set "SUID="
set /p SUID=Paste User UID and press Enter: 
if "%SUID%"=="" set "SUID=00000000-0000-0000-0000-000000000000"
:write
> .env echo VITE_SUPABASE_URL=%SURL%
>> .env echo VITE_SUPABASE_ANON_KEY=%SKEY%
>> .env echo VITE_AUTHORIZED_UID=%SUID%
>> .env echo VITE_ENVIRONMENT=%SMODE%
echo.
node scripts\check-env.mjs
if errorlevel 1 goto end_bad
if "%SUID%"=="00000000-0000-0000-0000-000000000000" echo UID not set yet: run PREFLIGHT.cmd, copy the UID it shows, then run SETUP_ENV.cmd again.
echo.
echo Next: PREFLIGHT.cmd (database check), then START_WINDOWS.cmd
pause
exit /b 0
:end_bad
echo.
echo Run SETUP_ENV.cmd again and paste the values carefully.
pause
exit /b 1
