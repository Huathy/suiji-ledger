# Suiji Ledger 安卓 APK 手工构建脚本（零 Gradle）
# 依赖：JDK(keytool/javac/jar)、build-tools r35(aapt2/d8/zipalign/apksigner)、android.jar
# 用法：python build-apk.py   （先确保 apps/web/dist-mobile 已构建）
import os
import shutil
import subprocess
import sys
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, ".."))
WEB = os.path.join(ROOT, "apps", "web")

BT = r"D:\works\temp\kilo\android-tools\build-tools_r35\android-15"
ANDROID_JAR = os.path.join(HERE, "android-sdk", "platforms", "android-35", "android.jar")

# 签名 keystore：文件名与 alias 沿用旧版，确保与已安装的 APK 同签名、可覆盖升级。
# 口令不入库：优先读环境变量 SJ_KEYSTORE_PASS，其次读同目录 keystore-pass.txt（已 gitignore）。
KEYSTORE = os.path.join(HERE, "moneyrecord.jks")
KS_ALIAS = "moneyrecord"


def keystore_pass():
    env = os.environ.get("SJ_KEYSTORE_PASS")
    if env:
        return env.strip()
    pass_file = os.path.join(HERE, "keystore-pass.txt")
    if os.path.exists(pass_file):
        with open(pass_file, "r", encoding="utf-8") as f:
            return f.read().strip()
    sys.exit(
        "缺少 keystore 口令：请设置环境变量 SJ_KEYSTORE_PASS，"
        "或写入 %s（该文件已 gitignore）" % pass_file
    )

AAPT2 = os.path.join(BT, "aapt2.exe")
D8 = os.path.join(BT, "d8.bat")
ZIPALIGN = os.path.join(BT, "zipalign.exe")
APKSIGNER = os.path.join(BT, "apksigner.bat")

VERSION_NAME = "0.2.7"
VERSION_CODE = "9"
OUT_APK = os.path.join(ROOT, "dist", f"SuijiLedger-v{VERSION_NAME}.apk")

BUILD = os.path.join(HERE, "build")


def run(cmd, **kw):
    print("+", " ".join(os.path.basename(c) if i == 0 else c for i, c in enumerate(map(str, cmd))))
    r = subprocess.run(cmd, **kw)
    if r.returncode != 0:
        sys.exit(f"步骤失败：{cmd[0]}")


def main():
    os.makedirs(BUILD, exist_ok=True)
    os.makedirs(os.path.join(ROOT, "dist"), exist_ok=True)

    # 0. 前端产物 → assets/www
    www = os.path.join(BUILD, "www")
    if os.path.exists(www):
        shutil.rmtree(www)
    src = os.path.join(WEB, "dist-mobile")
    if not os.path.isdir(src):
        sys.exit("缺少 apps/web/dist-mobile，请先执行移动端前端构建")
    shutil.copytree(src, www)
    print(f"www 资源：{sum(len(f) for _, _, f in os.walk(www))} 个文件")

    # 1. aapt2 编译资源
    run([AAPT2, "compile", "--dir", os.path.join(HERE, "res"), "-o", os.path.join(BUILD, "res.zip")])

    # 2. aapt2 link（生成 base.apk + R.java，附带 assets）
    run([AAPT2, "link",
         "-o", os.path.join(BUILD, "base.apk"),
         "-I", ANDROID_JAR,
         "--manifest", os.path.join(HERE, "AndroidManifest.xml"),
         "-A", www,
         "--java", os.path.join(BUILD, "gen"),
         "--min-sdk-version", "24",
         "--target-sdk-version", "35",
         "--version-code", VERSION_CODE,
         "--version-name", VERSION_NAME,
         os.path.join(BUILD, "res.zip")])

    # 3. javac（JDK21 编 source 8 级别，对 android.jar 交叉编译）
    classes = os.path.join(BUILD, "classes")
    if os.path.exists(classes):
        shutil.rmtree(classes)
    os.makedirs(classes)
    java_files = []
    for base in [os.path.join(BUILD, "gen"), os.path.join(HERE, "src")]:
        for dirpath, _, files in os.walk(base):
            java_files += [os.path.join(dirpath, f) for f in files if f.endswith(".java")]
    run(["javac", "-source", "1.8", "-target", "1.8", "-nowarn", "-Xlint:none",
         "-bootclasspath", ANDROID_JAR, "-classpath", ANDROID_JAR,
         "-encoding", "UTF-8", "-d", classes] + java_files,
        shell=False)

    # 4. d8 转 dex
    jar_file = os.path.join(BUILD, "app-classes.jar")
    if os.path.exists(jar_file):
        os.remove(jar_file)
    run(["jar", "cf", jar_file, "-C", classes, "."])
    dex_out = os.path.join(BUILD, "dex")
    if os.path.exists(dex_out):
        shutil.rmtree(dex_out)
    os.makedirs(dex_out)
    run([D8, "--release", "--lib", ANDROID_JAR, "--min-api", "24",
         "--output", dex_out, jar_file])
    dex_file = os.path.join(dex_out, "classes.dex")
    assert os.path.exists(dex_file), "d8 未生成 classes.dex"

    # 5. 重打包：复制 base.apk 全部条目（resources.arsc 保持 STORED），追加 classes.dex
    unsigned = os.path.join(BUILD, "unsigned.apk")
    with zipfile.ZipFile(os.path.join(BUILD, "base.apk")) as src_zip, \
         zipfile.ZipFile(unsigned, "w") as out_zip:
        for info in src_zip.infolist():
            data = src_zip.read(info.filename)
            comp = zipfile.ZIP_STORED if info.filename == "resources.arsc" else zipfile.ZIP_DEFLATED
            out_zip.writestr(zipfile.ZipInfo(info.filename), data, compress_type=comp)
        out_zip.write(dex_file, "classes.dex", compress_type=zipfile.ZIP_DEFLATED)
    print("重打包完成（dex + assets 已合入）")

    # 6. zipalign（4 字节对齐，resources.arsc 对齐必须）
    aligned = os.path.join(BUILD, "aligned.apk")
    run([ZIPALIGN, "-f", "4", unsigned, aligned])
    run([ZIPALIGN, "-c", "4", aligned])

    # 7. 签名（keystore 不存在则生成；alias 与旧版一致，保证可覆盖升级）
    ks_pass = keystore_pass()
    if not os.path.exists(KEYSTORE):
        print("生成签名 keystore（首次）")
        run(["keytool", "-genkeypair", "-keystore", KEYSTORE, "-alias", KS_ALIAS,
             "-keyalg", "RSA", "-keysize", "2048", "-validity", "10950",
             "-storepass", ks_pass, "-keypass", ks_pass,
             "-dname", "CN=SuijiLedger"])
    run([APKSIGNER, "sign",
         "--ks", KEYSTORE, "--ks-pass", f"pass:{ks_pass}", "--key-pass", f"pass:{ks_pass}",
         "--ks-key-alias", KS_ALIAS,
         "--out", OUT_APK, aligned])

    # 8. 校验
    run([APKSIGNER, "verify", "--print-certs", OUT_APK])
    print()
    print("APK 构建完成 →", OUT_APK, f"({os.path.getsize(OUT_APK) / 1024 / 1024:.1f} MB)")


if __name__ == "__main__":
    main()
