VERSION = '0.3.0'

# SuijiLedger Windows 安装器：解压到 %LOCALAPPDATA%\SuijiLedger + 快捷方式 + 卸载入口
import os
import subprocess
import sys
import shutil
import zipfile
import subprocess

def res():
    return sys._MEIPASS if getattr(sys, 'frozen', False) else os.path.dirname(os.path.abspath(__file__))

def main():
    zip_path = os.path.join(res(), 'SuijiLedger-portable.zip')
    target = os.environ.get('SJ_TARGET') or os.path.join(os.environ.get('LOCALAPPDATA', os.path.expanduser('~')), 'SuijiLedger')
    test = os.environ.get('SJ_TEST') == '1'

    print('=' * 46)
    print('  SuijiLedger 月度平账 · 安装程序 v%s' % VERSION)
    print('  安装位置: %s' % target)
    print('=' * 46)

    subprocess.run(['taskkill', '/F', '/IM', 'SuijiLedger.exe'], capture_output=True)
    subprocess.run(
        'powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 3000 -State Listen '
        '-ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }"',
        capture_output=True, shell=True)

    os.makedirs(target, exist_ok=True)
    print('正在释放文件（%d 文件，请稍候）…' % len(zipfile.ZipFile(zip_path).namelist()))
    with zipfile.ZipFile(zip_path) as z:
        for m in z.infolist():
            parts = m.filename.split('/', 1)
            if len(parts) == 2:
                m.filename = parts[1]  # 剥离顶层 SuijiLedger/ 目录
                z.extract(m, target)
    print('文件释放完成')

    if test:
        print('[测试模式] 跳过快捷方式与注册表，仅验证解压')
        print('extracted ok:', os.path.exists(os.path.join(target, 'SuijiLedger.exe')))
        return

    ps = (
        '$ws = New-Object -ComObject WScript.Shell;'
        '$d = [Environment]::GetFolderPath(\'Desktop\');'
        '$s1 = $ws.CreateShortcut((Join-Path $d \'SuijiLedger.lnk\'));'
        '$s1.TargetPath = \'{exe}\'; $s1.WorkingDirectory = \'{target}\'; $s1.Save();'
        '$sm = [Environment]::GetFolderPath(\'Programs\');'
        '$md = Join-Path $sm \'SuijiLedger\'; New-Item -ItemType Directory -Force -Path $md | Out-Null;'
        '$s2 = $ws.CreateShortcut((Join-Path $md \'SuijiLedger.lnk\'));'
        '$s2.TargetPath = \'{exe}\'; $s2.WorkingDirectory = \'{target}\'; $s2.Save();'
        '$s3 = $ws.CreateShortcut((Join-Path $md \'卸载SuijiLedger.lnk\'));'
        '$s3.TargetPath = \'{uninst}\'; $s3.Save();'
    ).format(exe=os.path.join(target, 'SuijiLedger.exe'), target=target,
             uninst=os.path.join(target, 'uninstall.cmd'))
    subprocess.run(['powershell', '-NoProfile', '-Command', ps], capture_output=True)

    import winreg
    key = winreg.CreateKey(winreg.HKEY_CURRENT_USER,
                           r'Software\Microsoft\Windows\CurrentVersion\Uninstall\SuijiLedger')
    def setv(name, value):
        winreg.SetValueEx(key, name, 0, winreg.REG_SZ, value)
    setv('DisplayName', 'SuijiLedger 月度平账')
    setv('DisplayVersion', VERSION)
    setv('Publisher', 'SuijiLedger')
    setv('InstallLocation', target)
    setv('DisplayIcon', os.path.join(target, 'SuijiLedger.exe'))
    setv('UninstallString', 'cmd.exe /c ""' + os.path.join(target, 'uninstall.cmd') + '""')
    setv('NoModify', '1')
    setv('NoRepair', '1')
    winreg.CloseKey(key)

    print('安装完成！桌面与开始菜单已创建快捷方式。')
    print('卸载：开始菜单 → SuijiLedger → 卸载SuijiLedger（数据目录保留）')
    subprocess.Popen([os.path.join(target, 'SuijiLedger.exe')], cwd=target)

if __name__ == '__main__':
    main()
