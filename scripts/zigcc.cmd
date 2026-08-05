@echo off
rem Windows analogue of scripts/zigcc: maps wasm32-wasip1 to zig's wasm32-wasi target.
rem Zig is located via the ZIG env var (default: `zig` on PATH), like the bash script.
if "%ZIG%"=="" set "ZIG=zig"
set "NEWARGS="
:next
if "%~1"=="" goto run
set "A=%~1"
if "%A%"=="--target=wasm32-wasip1" set "A=--target=wasm32-wasi"
if "%A%"=="--target=wasm32-unknown-unknown" set "A=--target=wasm32-freestanding"
set "NEWARGS=%NEWARGS% "%A%""
shift
goto next
:run
%ZIG% cc %NEWARGS%
exit /b %errorlevel%