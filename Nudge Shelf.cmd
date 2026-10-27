@echo off
rem Double-click to open Nudge Shelf. It needs Node.js 18 or newer (https://nodejs.org).
title Nudge Shelf
where node >nul 2>nul || (echo Nudge Shelf needs Node.js 18 or newer. Get it from https://nodejs.org and try again. & pause & exit /b 1)
node "%~dp0plugins\nudge\skills\artifacts\scripts\shelf.js" start
if errorlevel 1 pause
