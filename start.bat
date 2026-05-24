@echo off
chcp 65001 >nul
title 刷课助手

where node >nul 2>&1
if %errorlevel% neq 0 (
    echo.
    echo [错误] 未检测到 Node.js
    echo 请先安装: https://nodejs.org (下载 LTS 版本)
    echo.
    pause
    exit /b 1
)

echo [刷课助手] Node.js 已就绪，开始启动...
echo.
node launcher.js

echo.
echo 按任意键退出...
pause >nul