# 组装 Electron 桌面应用目录：server 编译树 + web dist + 生产依赖
import os
import shutil

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))
DESK = os.path.dirname(os.path.abspath(__file__))
STAGING = os.path.join(ROOT, 'windows', 'staging')

def cp(src, dst):
    if os.path.isdir(src):
        shutil.copytree(src, dst, dirs_exist_ok=True)
    else:
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copy2(src, dst)

def main():
    # server/ = 编译后的 JS 树（apps/server/src + packages/shared）
    if os.path.exists(os.path.join(DESK, 'server')):
        shutil.rmtree(os.path.join(DESK, 'server'))
    cp(os.path.join(ROOT, 'apps', 'server', 'build-pkg'), os.path.join(DESK, 'server'))
    # web dist 挂到 server/apps/web/dist（main.js ROOT 解析约定）
    cp(os.path.join(ROOT, 'apps', 'web', 'dist'), os.path.join(DESK, 'server', 'apps', 'web', 'dist'))
    # 生产依赖：放在 server/node_modules（Node 沿目录向上解析；electron-builder 不会裁剪 server/** 内的文件）
    # 目录名避开 node_modules（electron-builder 会强制裁剪该名字），改用 deps + NODE_PATH
    if os.path.exists(os.path.join(DESK, 'server', 'node_modules')):
        shutil.rmtree(os.path.join(DESK, 'server', 'node_modules'))
    if os.path.exists(os.path.join(DESK, 'server', 'deps')):
        shutil.rmtree(os.path.join(DESK, 'server', 'deps'))
    cp(os.path.join(STAGING, 'node_modules'), os.path.join(DESK, 'server', 'deps'))
    print('desktop staged:',
          'server js =', sum(len(f) for _, _, f in os.walk(os.path.join(DESK, 'server'))),
          '| node_modules exists =', os.path.exists(os.path.join(DESK, 'node_modules', '@prisma', 'client')))

if __name__ == '__main__':
    main()
