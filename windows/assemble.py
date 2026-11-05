# 组装 Windows 便携包（pack/）
import os
import shutil
import subprocess
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
PACK = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'pack')


def node_exe():
    """
    找 Node 可执行文件（评审修复项：原来两处硬编码 `C:\\env\\nodejs\\node.exe`）。

    硬编码的代价是"换台机器就静默装出一个坏包"：打包机上没有那个路径时
    `shutil.copy2` 抛 FileNotFoundError 还算响；更糟的是 `subprocess.run` 拿到不存在的
    node 却只回非零码，被当成"依赖闭包同步失败"——真实的错因（没装 node）被埋掉。
    优先级：显式 `SUIJI_NODE`（CI/自定义运行时）→ PATH 里的 node → 明确失败。
    """
    cand = os.environ.get('SUIJI_NODE') or shutil.which('node')
    if not cand or not os.path.isfile(cand):
        print('[assemble] 找不到 node 可执行文件：请先装 Node.js，或用 SUIJI_NODE 指定完整路径')
        sys.exit(1)
    return cand


def sync_deps_into_staging():
    """
    组装前必须把 Git 同步闭包（isomorphic-git 及其传递依赖）铺进 staging/node_modules。
    旧链不铺：build-pkg 里已经带 SyncModule，装出来的包一 require 就 MODULE_NOT_FOUND，
    用户在启动器里只看到"服务进程异常退出"（评审修复项 R5：要么装对，要么响亮地拒装）。
    """
    node = node_exe()
    script = os.path.join(ROOT, 'apps', 'server', 'scripts', 'copy-desktop-deps.mjs')
    target = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'staging', 'node_modules')
    r = subprocess.run([node, script, '--to', target])
    if r.returncode != 0:
        print('[assemble] 同步依赖闭包失败，中止组装（不要用缺 isomorphic-git 的 staging 出包）')
        sys.exit(1)

def cp(src, dst):
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    if os.path.isdir(src):
        shutil.copytree(src, dst, dirs_exist_ok=True)
    else:
        shutil.copy2(src, dst)

def main():
    sync_deps_into_staging()
    if os.path.exists(PACK):
        shutil.rmtree(PACK)
    os.makedirs(PACK)

    cp(os.path.join(os.path.dirname(__file__), 'SuijiLedger.exe'), os.path.join(PACK, 'SuijiLedger.exe'))
    cp(node_exe(), os.path.join(PACK, 'runtime', 'node.exe'))
    cp(os.path.join(ROOT, 'apps', 'server', 'build-pkg'), os.path.join(PACK, 'app', 'build'))
    cp(os.path.join(os.path.dirname(__file__), 'staging', 'node_modules'), os.path.join(PACK, 'app', 'node_modules'))
    cp(os.path.join(ROOT, 'apps', 'web', 'dist'), os.path.join(PACK, 'app', 'build', 'apps', 'web', 'dist'))
    cp(os.path.join(ROOT, 'apps', 'server', 'prisma'), os.path.join(PACK, 'app', 'build', 'apps', 'server', 'prisma'))

    stop_bat = r'''@echo off
chcp 65001 >nul
echo 正在停止 SuijiLedger 服务（端口 3000）...
for /f "tokens=5" %%p in ('netstat -ano ^| findstr :3000 ^| findstr LISTENING') do taskkill /F /PID %%p >nul 2>&1
echo 已停止。
pause
'''
    start_bat = r'''@echo off
cd /d %~dp0
set DATA_DIR=%~dp0data
set PORT=3000
echo SuijiLedger 手动启动模式（关闭窗口=停止服务） http://localhost:3000
runtime\node.exe app\build\apps\server\src\main.js
pause
'''
    uninstall_bat = r'''@echo off
chcp 65001 >nul
echo ================================================
echo  SuijiLedger 卸载
echo  数据目录: %LOCALAPPDATA%\SuijiLedger\data
echo ================================================
taskkill /F /IM SuijiLedger.exe >nul 2>&1
for /f "tokens=5" %%p in ('netstat -ano ^| findstr :3000 ^| findstr LISTENING') do taskkill /F /PID %%p >nul 2>&1

set "DATAKEEP=%LOCALAPPDATA%\SuijiLedger\data"
set "DATABAK=%LOCALAPPDATA%\SuijiLedger-data-备份"

:ask
set "ANS="
set /p ANS=是否连同本地记账数据一起清除？[y/N] 回车=N保留数据 :
if /i "%ANS%"=="y" goto dodata
if "%ANS%"=="" goto keepdata
echo 请输入 y 或 N。
goto ask

:dodata
rem 先搬走再删；搬迁失败（文件占用/跨盘）必须中止——旧脚本把 move 失败吞掉后
rem 照样 rd /s /q，等于静默删数据（评审修复项）。
if exist "%DATAKEEP%" (
  move "%DATAKEEP%" "%DATABAK%" >nul 2>&1
  if errorlevel 1 (
    echo [中止] 数据搬迁失败（文件被占用或跨盘），为防误删已停止卸载。
    echo        请关闭 SuijiLedger 服务后重试，或先手动备份 data 目录。
    pause
    exit /b 1
  )
  echo 数据已移至 %DATABAK%
)
goto cleanup

:keepdata
echo 保留本地数据。

:cleanup
reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\SuijiLedger" /f >nul 2>&1
powershell -NoProfile -Command "$d=[Environment]::GetFolderPath('Desktop'); Remove-Item (Join-Path $d 'SuijiLedger.lnk') -ErrorAction SilentlyContinue; $sm=[Environment]::GetFolderPath('Programs'); Remove-Item (Join-Path $sm 'SuijiLedger') -Recurse -Force -ErrorAction SilentlyContinue"
rem 保留模式下只删程序文件不碰 data：逐项删，空了才删父目录（rd 不带 /s，非空必失败＝数据安全网）
if exist "%DATAKEEP%" (
  rd /s /q "%LOCALAPPDATA%\SuijiLedger\runtime" >nul 2>&1
  rd /s /q "%LOCALAPPDATA%\SuijiLedger\app" >nul 2>&1
  del /q "%LOCALAPPDATA%\SuijiLedger\*.exe" "%LOCALAPPDATA%\SuijiLedger\*.bat" "%LOCALAPPDATA%\SuijiLedger\*.txt" >nul 2>&1
  rd "%LOCALAPPDATA%\SuijiLedger" >nul 2>&1
  echo 卸载完成，数据保留在 %DATAKEEP%
) else (
  rd /s /q "%LOCALAPPDATA%\SuijiLedger"
  echo 卸载完成（数据备份见 %DATABAK%）
)
pause
'''
    readme = '''SuijiLedger · 月度平账（Windows 便携版 v0.3.0）
================================================

使用方法
--------
1. 双击 SuijiLedger.exe —— 自动启动服务并打开浏览器（http://localhost:3000）
2. 首次使用：设置访问口令 → 添加账户 → 点「平账」记录第一个月
3. 关闭 SuijiLedger.exe 的黑色窗口即可停止服务（或运行 停止服务.bat）

数据与备份
----------
· 所有数据保存在本目录 data 文件夹内（SQLite 单文件），拷贝 data 即完整备份
· 建议定期在网页「我的 → 导出全量备份 JSON」导出备份
· 卸载不会删除 data 目录

文件说明
--------
· SuijiLedger.exe      启动器（启动服务 + 打开浏览器）
· start-server.bat     手动前台启动（看日志排错用）
· stop-server.bat      停止服务
· runtime/node.exe     Node.js 运行时（Node.js 官方二进制，MIT 协议）
· app/                 服务端程序与网页
· data/                你的全部数据（自动创建）

技术支持：本软件为个人自用软件，仅供学习交流。
'''
    io_stop = open(os.path.join(PACK, '停止服务.bat'), 'w', encoding='utf-8-sig', newline='\r\n')
    io_stop.write(stop_bat); io_stop.close()
    io_start = open(os.path.join(PACK, 'start-server.bat'), 'w', encoding='utf-8-sig', newline='\r\n')
    io_start.write(start_bat); io_start.close()
    io_un = open(os.path.join(PACK, 'uninstall.cmd'), 'w', encoding='utf-8-sig', newline='\r\n')
    io_un.write(uninstall_bat); io_un.close()
    io_rd = open(os.path.join(PACK, '使用说明.txt'), 'w', encoding='utf-8-sig', newline='\r\n')
    io_rd.write(readme); io_rd.close()

    total = sum(len(f) for _, _, f in os.walk(PACK))
    size = sum(os.path.getsize(os.path.join(d, f)) for d, _, fs in os.walk(PACK) for f in fs)
    print('pack files:', total, 'size: %.0f MB' % (size / 1048576))

if __name__ == '__main__':
    main()
