@echo off
rem Double-click to clear the downloaded PDF cache (conversations are kept).
cd /d "%~dp0"
".venv\Scripts\python.exe" -m host.cache --clear
pause
