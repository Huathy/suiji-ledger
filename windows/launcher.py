# SuijiLedger Windows 启动器：启动内置服务（node 隐藏窗口）→ 等待就绪 → 自动打开浏览器
# 关闭本窗口即可停止服务；或运行 停止服务.bat
import os
import sys
import time
import subprocess
import webbrowser
import urllib.request

def base_dir():
    if getattr(sys, 'frozen', False):
        return os.path.dirname(os.path.abspath(sys.executable))
    return os.path.dirname(os.path.abspath(__file__))

def main():
    base = base_dir()
    node = os.path.join(base, 'runtime', 'node.exe')
    mainjs = os.path.join(base, 'app', 'build', 'apps', 'server', 'src', 'main.js')
    port = sys.argv[1] if len(sys.argv) > 1 else '3000'

    if not os.path.exists(node) or not os.path.exists(mainjs):
        print('安装目录不完整：缺少 runtime/node.exe 或 app/build 服务端文件')
        input('按回车退出…')
        return

    data_dir = os.path.join(base, 'data')
    os.makedirs(data_dir, exist_ok=True)

    env = os.environ.copy()
    env['DATA_DIR'] = data_dir
    env['PORT'] = port

    flags = subprocess.CREATE_NO_WINDOW
    proc = subprocess.Popen([node, mainjs], cwd=base, env=env, creationflags=flags)

    url = 'http://localhost:%s/' % port
    print('=' * 46)
    print('  SuijiLedger 服务启动中… http://localhost:%s' % port)
    print('  数据目录: %s' % data_dir)
    print('  关闭本窗口即可停止服务')
    print('=' * 46)

    ready = False
    for _ in range(60):
        if proc.poll() is not None:
            print('服务进程异常退出，请检查 data 目录与端口占用')
            input('按回车退出…')
            return
        try:
            urllib.request.urlopen('http://localhost:%s/api/auth/bootstrap' % port, timeout=1)
            ready = True
            break
        except Exception:
            time.sleep(0.5)
    if ready:
        print('服务已就绪，正在打开浏览器…')
        webbrowser.open(url)
    else:
        print('服务启动较慢，请稍后手动访问 %s' % url)

    print('(保持本窗口开启；关闭窗口 = 停止服务)')
    try:
        proc.wait()
    except KeyboardInterrupt:
        proc.terminate()

if __name__ == '__main__':
    main()
