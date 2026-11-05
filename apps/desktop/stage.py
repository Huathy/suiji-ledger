# 组装 Electron 桌面应用目录：server 编译树 + web dist + 生产依赖
import os
import shutil
import sys
import time

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))
DESK = os.path.dirname(os.path.abspath(__file__))
STAGING = os.path.join(ROOT, 'windows', 'staging')
BUILD_PKG = os.path.join(ROOT, 'apps', 'server', 'build-pkg')


def _fail_stale():
    """build-pkg 比源码旧就拒绝 stage：拷出去的包带着旧服务端，
    用户看到的是"新功能没生效/闪退"，实际只是忘记重编 tsc。"""
    main_js = os.path.join(BUILD_PKG, 'apps', 'server', 'src', 'main.js')
    if not os.path.exists(main_js):
        print('[stage] 缺少编译产物 main.js：先跑 npx tsc -p apps/server/tsconfig.build.json')
        sys.exit(1)
    build_mtime = os.path.getmtime(main_js)
    newest = (None, 0.0)
    for root in (os.path.join(ROOT, 'apps', 'server', 'src'),
                 os.path.join(ROOT, 'packages', 'shared', 'src')):
        for dp, _, fns in os.walk(root):
            for fn in fns:
                if not fn.endswith('.ts'):
                    continue
                p = os.path.join(dp, fn)
                try:
                    m = os.path.getmtime(p)
                except OSError:
                    continue
                if m > newest[1]:
                    newest = (p, m)
    if newest[0] and newest[1] > build_mtime + 1:
        print('[stage] 构建已过期：源码 %s（%s）新于 main.js（%s）' % (
            os.path.relpath(newest[0], ROOT),
            time.strftime('%m-%d %H:%M', time.localtime(newest[1])),
            time.strftime('%m-%d %H:%M', time.localtime(build_mtime))))
        print('[stage] 先跑 npx tsc -p apps/server/tsconfig.build.json 再 stage')
        sys.exit(1)

def cp(src, dst):
    if os.path.isdir(src):
        shutil.copytree(src, dst, dirs_exist_ok=True)
    else:
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copy2(src, dst)

def main():
    _fail_stale()
    # server/ = 编译后的 JS 树（apps/server/src + packages/shared）
    if os.path.exists(os.path.join(DESK, 'server')):
        shutil.rmtree(os.path.join(DESK, 'server'))
    cp(os.path.join(ROOT, 'apps', 'server', 'build-pkg'), os.path.join(DESK, 'server'))
    # web dist 挂到 server/apps/web/dist（main.js ROOT 解析约定）
    cp(os.path.join(ROOT, 'apps', 'web', 'dist'), os.path.join(DESK, 'server', 'apps', 'web', 'dist'))
    # 生产依赖：放在 server/deps（Node 沿目录向上解析；electron-builder 不会裁剪 server/** 内的文件）
    # 目录名避开 node_modules（electron-builder 会强制裁剪该名字），改用 deps + NODE_PATH
    # 注意：不要 rmtree 再重铺——Git 闭包（isomorphic-git）由 copy-desktop-deps.mjs 事后补进 deps，
    # 整目录删了重铺会把已补好的 git 包丢掉，装出来的包 require 即 MODULE_NOT_FOUND → 自检弹框 → 用户视角"闪退"
    # （2026-11-05 每次打包闪退的根因：先 deps:desktop 后 stage.py，顺序反了）。
    # 正确顺序：stage.py（铺底）→ npm run deps:desktop（补 git+prisma）→ electron-builder
    if os.path.exists(os.path.join(DESK, 'server', 'node_modules')):
        shutil.rmtree(os.path.join(DESK, 'server', 'node_modules'))
    cp(os.path.join(STAGING, 'node_modules'), os.path.join(DESK, 'server', 'deps'))
    print('desktop staged:',
          'server js =', sum(len(f) for _, _, f in os.walk(os.path.join(DESK, 'server'))),
          '| node_modules exists =', os.path.exists(os.path.join(DESK, 'node_modules', '@prisma', 'client')))

if __name__ == '__main__':
    main()
