package com.moneyrecord.app;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ContentValues;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.MediaStore;
import android.util.Log;
import android.webkit.ConsoleMessage;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;

/**
 * SuijiLedger 离线安卓壳：本地资源服务器 + 全屏 WebView + 文件桥。
 * 前端以离线模式打包（VITE_OFFLINE=1），数据全部存 WebView 本地存储，无需任何服务端。
 * 文件能力：
 *  - 导入（钱迹文件/备份恢复）：<input type=file> 由 onShowFileChooser 转发系统选择器
 *  - 导出（备份/CSV）：JS 调 AndroidBridge.saveFile(name, content) → 下载/SuijiLedger
 */
public class MainActivity extends Activity {

    private static final int PORT = 18080;
    private static final String HOME_URL = "http://127.0.0.1:" + PORT + "/";
    private static final int REQ_FILE_CHOOSER = 1001;
    private static final int REQ_PICK_FILE = 1002;
    /** 打开 WebView 远程调试（chrome://inspect / CDP）并把前端 console 转发到 logcat，便于排查 */
    private static final boolean DEBUG_WEB = true;
    private static final String TAG = "SuijiLedger";
    private WebView web;
    private ValueCallback<Uri[]> fileCallback;
    private String pickCallback;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // 先同步绑定端口再启动 accept 线程：避免首屏请求早于监听就绪（ERR_CONNECTION_REFUSED）
        try {
            new Thread(new AssetHost(getAssets(), PORT), "asset-host").start();
        } catch (IOException e) {
            Log.e(TAG, "asset host bind failed: " + e);
        }

        web = new WebView(this);
        setContentView(web);
        if (DEBUG_WEB) WebView.setWebContentsDebuggingEnabled(true);

        WebSettings st = web.getSettings();
        st.setJavaScriptEnabled(true);
        st.setDomStorageEnabled(true);
        st.setDatabaseEnabled(true);
        st.setAllowFileAccess(false);
        st.setMediaPlaybackRequiresUserGesture(false);
        if (Build.VERSION.SDK_INT >= 21) {
            st.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        }
        web.addJavascriptInterface(new Bridge(), "AndroidBridge");
        web.setWebViewClient(new WebViewClient() {
            private int retry = 0;

            @Override
            public void onPageFinished(WebView view, String url) {
                retry = 0;
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                // 本地服务偶发未就绪/端口占用：主文档失败时短暂重试，避免直接弹 Chromium 报错页
                if (request.isForMainFrame() && retry < 8) {
                    long delay = 200L + retry * 150L;
                    retry++;
                    view.postDelayed(new Runnable() {
                        @Override
                        public void run() {
                            view.loadUrl(HOME_URL);
                        }
                    }, delay);
                }
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onConsoleMessage(ConsoleMessage msg) {
                if (DEBUG_WEB) {
                    Log.i(TAG, "JS[" + msg.messageLevel() + "] " + msg.message()
                            + " @" + msg.sourceId() + ":" + msg.lineNumber());
                }
                return true;
            }

            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                             FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                intent.setType("*/*");
                startActivityForResult(Intent.createChooser(intent, "选择文件"), REQ_FILE_CHOOSER);
                return true;
            }
        });
        if (savedInstanceState == null) {
            web.loadUrl(HOME_URL);
        } else {
            web.restoreState(savedInstanceState);
        }
    }

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        if (web != null) web.saveState(outState);
    }

    @Override
    protected void onDestroy() {
        if (web != null) web.destroy();
        super.onDestroy();
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQ_FILE_CHOOSER) {
            if (fileCallback != null) {
                fileCallback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data));
                fileCallback = null;
            }
            return;
        }
        if (requestCode == REQ_PICK_FILE && pickCallback != null) {
            String content = null;
            if (resultCode == RESULT_OK && data != null && data.getData() != null) {
                try {
                    InputStream in = getContentResolver().openInputStream(data.getData());
                    java.io.ByteArrayOutputStream buf = new java.io.ByteArrayOutputStream();
                    byte[] chunk = new byte[8192];
                    int n;
                    while ((n = in.read(chunk)) > 0) buf.write(chunk, 0, n);
                    in.close();
                    content = buf.toString("UTF-8");
                } catch (Exception ignored) {
                }
            }
            final String literal = content == null ? "null" : org.json.JSONObject.quote(content);
            // 注意括号：先取回调再调用；原写法 (window.cb||function(){}(x)) 因优先级问题永远不会调用回调
            final String payload = "((window." + pickCallback + "||function(){})(" + literal + "), null)";
            pickCallback = null;
            web.post(new Runnable() {
                @Override
                public void run() {
                    web.evaluateJavascript(payload, null);
                }
            });
        }
    }

    private class Bridge {

        /** 保存文本文件；Android 10+ 写入公共下载目录，旧版本写入应用外部目录 */
        @JavascriptInterface
        public String saveFile(String name, String content) {
            try {
                if (Build.VERSION.SDK_INT >= 29) {
                    ContentValues cv = new ContentValues();
                    cv.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
                    cv.put(MediaStore.MediaColumns.MIME_TYPE,
                            name.endsWith(".csv") ? "text/csv" : "application/json");
                    cv.put(MediaStore.MediaColumns.RELATIVE_PATH, "Download/SuijiLedger");
                    Uri uri = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, cv);
                    if (uri == null) return "保存失败";
                    OutputStream os = getContentResolver().openOutputStream(uri);
                    os.write(content.getBytes("UTF-8"));
                    os.close();
                    return "已保存到 下载/SuijiLedger/" + name;
                }
                File dir = new File(getExternalFilesDir(null), "export");
                dir.mkdirs();
                File f = new File(dir, name);
                FileOutputStream fo = new FileOutputStream(f);
                fo.write(content.getBytes("UTF-8"));
                fo.close();
                return "已保存到 " + f.getAbsolutePath();
            } catch (Exception e) {
                return "保存失败: " + e.getMessage();
            }
        }

        /** 保存二进制文件（base64）：xlsx 导出 / 月报分享图 */
        @JavascriptInterface
        public String saveBase64(String name, String base64) {
            try {
                byte[] data = android.util.Base64.decode(base64, android.util.Base64.DEFAULT);
                String mime = name.endsWith(".png") ? "image/png"
                        : name.endsWith(".xlsx") ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                        : name.endsWith(".csv") ? "text/csv" : "application/octet-stream";
                if (Build.VERSION.SDK_INT >= 29) {
                    ContentValues cv = new ContentValues();
                    cv.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
                    cv.put(MediaStore.MediaColumns.MIME_TYPE, mime);
                    cv.put(MediaStore.MediaColumns.RELATIVE_PATH, "Download/SuijiLedger");
                    Uri uri = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, cv);
                    if (uri == null) return "保存失败";
                    OutputStream os = getContentResolver().openOutputStream(uri);
                    os.write(data);
                    os.close();
                    return "已保存到 下载/SuijiLedger/" + name;
                }
                File dir = new File(getExternalFilesDir(null), "export");
                dir.mkdirs();
                File f = new File(dir, name);
                FileOutputStream fo = new FileOutputStream(f);
                fo.write(data);
                fo.close();
                return "已保存到 " + f.getAbsolutePath();
            } catch (Exception e) {
                return "保存失败: " + e.getMessage();
            }
        }

        /** 兼容入口：文本文件选择（新代码请用 <input type=file>） */
        @JavascriptInterface
        public void pickFile(String callback) {
            pickCallback = callback;
            Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
            intent.addCategory(Intent.CATEGORY_OPENABLE);
            intent.setType("*/*");
            startActivityForResult(intent, REQ_PICK_FILE);
        }
    }
}
