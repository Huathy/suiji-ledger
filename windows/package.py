# 生成 Windows 最终产物：便携版 zip + 安装包 exe
#
# ⚠️ 评审修复项（Duplicated Code）：安装器源码曾有第二份全文拷贝内嵌在本文件里，
# 且每次打包会反向覆盖 windows/installer.py——两份必然漂移。现在唯一来源 = windows/installer.py；
# 本脚本只负责读它、注入版本号、交给 PyInstaller。
import os
import subprocess
import sys
import shutil
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
PACK = os.path.join(HERE, 'pack')
OUT = os.path.abspath(os.path.join(HERE, '..', 'dist-windows'))
VERSION = '0.3.0'
INSTALLER_SRC = os.path.join(HERE, 'installer.py')

def make_zip():
    os.makedirs(OUT, exist_ok=True)
    zpath = os.path.join(OUT, f'SuijiLedger-便携版-v{VERSION}.zip')
    if os.path.exists(zpath):
        os.remove(zpath)
    zf = zipfile.ZipFile(zpath, 'w', zipfile.ZIP_DEFLATED, compresslevel=6)
    n = 0
    for root, _, files in os.walk(PACK):
        for f in files:
            full = os.path.join(root, f)
            rel = os.path.relpath(full, PACK)
            zf.write(full, os.path.join('SuijiLedger', rel))
            n += 1
    zf.close()
    print(f'便携版: {zpath} ({os.path.getsize(zpath)/1048576:.0f} MB, {n} 文件)')

def make_installer():
    zip_path = os.path.join(OUT, f'SuijiLedger-便携版-v{VERSION}.zip')
    # PyInstaller --add-data 保留原名：内嵌副本必须用 ASCII 文件名
    embed_dir = os.path.join(HERE, 'build')
    os.makedirs(embed_dir, exist_ok=True)
    embed_zip = os.path.join(embed_dir, 'SuijiLedger-portable.zip')
    shutil.copyfile(zip_path, embed_zip)

    # 单一来源读安装器源码，只把 VERSION 常量钉成本次打包版本（源文件本身不被改写）
    with open(INSTALLER_SRC, 'r', encoding='utf-8') as fh:
        body = fh.read()
    lines = body.splitlines(keepends=True)
    for i, ln in enumerate(lines):
        if ln.startswith('VERSION ='):
            lines[i] = "VERSION = '%s'\n" % VERSION
            break
    else:
        lines.insert(0, "VERSION = '%s'\n" % VERSION)
    src_dir = os.path.join(HERE, 'build')
    isrc = os.path.join(src_dir, 'installer-generated.py')
    with open(isrc, 'w', encoding='utf-8') as fh:
        fh.write(''.join(lines))

    subprocess.run([sys.executable, '-m', 'PyInstaller', '--onefile', '--name', 'SuijiLedger-Setup-v' + VERSION,
                    '--add-data', embed_zip + ';.', isrc,
                    '--distpath', OUT, '--workpath', os.path.join(HERE, 'build'), '--specpath', os.path.join(HERE, 'build')],
                   check=True)
    exe = os.path.join(OUT, f'SuijiLedger-Setup-v{VERSION}.exe')
    print('安装包: %s (%.0f MB)' % (exe, os.path.getsize(exe) / 1048576))

if __name__ == '__main__':
    make_zip()
    make_installer()
