@echo off
rem Windows analogue of zig ar for the wasm32-wasip1 build (cc-rs archiver).
rem Zig is located via the ZIG env var (default: `zig` on PATH), like scripts/zigcc.
if "%ZIG%"=="" set "ZIG=zig"
%ZIG% ar %*
exit /b %errorlevel%