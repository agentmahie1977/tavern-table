@echo off
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is not installed. Install it from the nodejs.org installer you saved, then run this again. & pause & exit /b)
set /p PW=Choose a table password for your friends: 
node server.js --password "%PW%"
pause
