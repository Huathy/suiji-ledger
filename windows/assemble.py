# 组装 Windows 便携包（pack/）
import os
import shutil

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
PACK = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'pack')

def cp(src, dst):
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    if os.path.isdir(src):
        shutil.copytree(src, dst, dirs_exist_ok=True)
    else:
        shutil.copy2(src, dst)

def main():
    if os.path.exists(PACK):
        shutil.rmtree(PACK)
    os.makedirs(PACK)

    cp(os.path.join(os.path.dirname(__file__), 'SuijiLedger.exe'), os.path.join(PACK, 'SuijiLedger.exe'))
    cp(r'C:\env\nodejs\node.exe', os.path.join(PACK, 'runtime', 'node.exe'))
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
echo 正在卸载 SuijiLedger（数据目录将保留）...
taskkill /F /IM SuijiLedger.exe >nul 2>&1
for /f "tokens=5" %%p in ('netstat -ano ^| findstr :3000 ^| findstr LISTENING') do taskkill /F /PID %%p >nul 2>&1
reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\SuijiLedger" /f >nul 2>&1
powershell -NoProfile -Command "$d=[Environment]::GetFolderPath('Desktop'); Remove-Item (Join-Path $d 'SuijiLedger.lnk') -ErrorAction SilentlyContinue; $sm=[Environment]::GetFolderPath('Programs'); Remove-Item (Join-Path $sm 'SuijiLedger') -Recurse -Force -ErrorAction SilentlyContinue"
if exist "%LOCALAPPDATA%\SuijiLedger" move "%LOCALAPPDATA%\SuijiLedger\data" "%LOCALAPPDATA%\SuijiLedger-data-备份" >nul 2>&1
rd /s /q "%LOCALAPPDATA%\SuijiLedger"
echo 卸载完成。若数据目录有备份，见 %LOCALAPPDATA%\SuijiLedger-data-备份
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
