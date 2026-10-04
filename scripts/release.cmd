@echo off
setlocal
node "%~dp0release.mjs" %*
exit /b %errorlevel%
