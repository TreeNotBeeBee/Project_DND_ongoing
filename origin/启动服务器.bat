@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title JigeRPG 房间服务器

where node >nul 2>nul
if errorlevel 1 goto :no_node

if not exist "room_server.mjs" goto :no_file

if exist "node_modules\koa\package.json" goto :run

echo [首次运行] 正在安装依赖，请稍候...
call npm install
if errorlevel 1 goto :install_fail

:run
echo.
echo 正在启动 JigeRPG 房间服务器...
echo 本机访问 http://localhost:8080
echo 手机或其他电脑用启动日志里的局域网地址
echo 关闭这个窗口即可停止服务器
echo.
node room_server.mjs %*
if errorlevel 1 (
    echo.
    echo [提示] 服务器已退出。若提示端口被占用，可换端口启动：
    echo        启动服务器.bat 8123
)
echo.
pause
exit /b 0

:no_node
echo [错误] 没有找到 Node.js，请先安装 Node.js 18 或更新版本。
echo 下载地址 https://nodejs.org/
pause
exit /b 1

:no_file
echo [错误] 当前目录找不到 room_server.mjs
echo 请把本脚本放在 JigeRPG 的 src 目录里。
pause
exit /b 1

:install_fail
echo [错误] 依赖安装失败，请检查网络后重试。
pause
exit /b 1