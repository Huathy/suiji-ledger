# 从 Google platform zip 中提取 android.jar 到 android-sdk/platforms/android-35/
import zipfile, os, shutil, sys

z = zipfile.ZipFile('platform-35.zip')
target = [n for n in z.namelist() if n.endswith('/android.jar')]
if not target:
    print('android.jar not found in zip, sample entries:', z.namelist()[:8])
    sys.exit(1)
out = 'android-sdk/platforms/android-35'
os.makedirs(out, exist_ok=True)
with z.open(target[0]) as src, open(os.path.join(out, 'android.jar'), 'wb') as dst:
    shutil.copyfileobj(src, dst)
print('extracted', target[0], '->', os.path.join(out, 'android.jar'),
      os.path.getsize(os.path.join(out, 'android.jar')), 'bytes')
