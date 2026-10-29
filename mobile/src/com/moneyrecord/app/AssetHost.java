package com.moneyrecord.app;

import android.content.res.AssetManager;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;

/**
 * 极简本地资源服务器：把 assets/www 里的前端产物挂到 http://127.0.0.1:port/
 * 使用 http 而非 file:// 是为了让 ES Module / fetch 正常工作（file:// 下模块脚本会被 CORS 拦截）。
 * 仅监听回环地址，不对局域网暴露。
 */
public class AssetHost implements Runnable {

    private final AssetManager assets;
    private final ServerSocket server;

    /**
     * 构造时同步完成端口绑定：避免 WebView 在 bind 之前发起请求导致 ERR_CONNECTION_REFUSED。
     * 绑定失败（端口被占用等）直接抛出，由调用方记录日志。
     */
    public AssetHost(AssetManager assets, int port) throws IOException {
        this.assets = assets;
        this.server = new ServerSocket();
        this.server.setReuseAddress(true);
        this.server.bind(new java.net.InetSocketAddress(InetAddress.getByName("127.0.0.1"), port), 64);
    }

    @Override
    public void run() {
        while (true) {
            try {
                serve(server.accept());
            } catch (IOException ignored) {
                // 单个连接失败不影响服务
            }
        }
    }

    private void serve(Socket socket) {
        try {
            BufferedReader reader = new BufferedReader(new InputStreamReader(socket.getInputStream()));
            String requestLine = reader.readLine();
            if (requestLine == null) return;
            String path = requestLine.split(" ")[1];
            while (true) { // 丢弃剩余请求头
                String line = reader.readLine();
                if (line == null || line.length() == 0) break;
            }
            path = path.split("\\?")[0];
            if (path.equals("/")) path = "/index.html";
            String clean = path.replace("\\", "");
            while (clean.contains("..")) clean = clean.replace("..", ""); // 防目录穿越

            String name = clean.substring(1);
            byte[] body = readAsset(name);
            // 仅「无扩展名的路径」回退到 index.html（SPA 路由）；
            // 缺失的 js/css 必须 404，否则浏览器会把 HTML 当脚本执行，报 "Unexpected token '<'"
            if (body == null && name.indexOf('.') < 0) body = readAsset("index.html");
            OutputStream out = socket.getOutputStream();
            if (body == null) {
                out.write("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".getBytes());
            } else {
                out.write(("HTTP/1.1 200 OK\r\nContent-Type: " + mime(clean)
                        + "\r\nContent-Length: " + body.length
                        + "\r\nCache-Control: no-cache\r\nConnection: close\r\n\r\n").getBytes("UTF-8"));
                out.write(body);
            }
            out.flush();
        } catch (Exception ignored) {
        } finally {
            try {
                socket.close();
            } catch (IOException ignored) {
            }
        }
    }

    private byte[] readAsset(String name) {
        // aapt2 -A www 把 www 内容放到 assets 根：assets/index.html、assets/assets/*.js
        InputStream in = null;
        try {
            in = assets.open(name);
            java.io.ByteArrayOutputStream buf = new java.io.ByteArrayOutputStream();
            byte[] chunk = new byte[8192];
            int n;
            while ((n = in.read(chunk)) > 0) buf.write(chunk, 0, n);
            return buf.toByteArray();
        } catch (IOException e) {
            return null;
        } finally {
            if (in != null) try { in.close(); } catch (IOException ignored) { }
        }
    }

    private static String mime(String path) {
        String p = path.toLowerCase();
        if (p.endsWith(".html")) return "text/html; charset=utf-8";
        if (p.endsWith(".js") || p.endsWith(".mjs")) return "text/javascript; charset=utf-8";
        if (p.endsWith(".css")) return "text/css; charset=utf-8";
        if (p.endsWith(".json") || p.endsWith(".webmanifest")) return "application/json; charset=utf-8";
        if (p.endsWith(".svg")) return "image/svg+xml";
        if (p.endsWith(".png")) return "image/png";
        if (p.endsWith(".jpg") || p.endsWith(".jpeg")) return "image/jpeg";
        if (p.endsWith(".webp")) return "image/webp";
        if (p.endsWith(".ico")) return "image/x-icon";
        if (p.endsWith(".woff2")) return "font/woff2";
        if (p.endsWith(".woff")) return "font/woff";
        if (p.endsWith(".wasm")) return "application/wasm";
        return "application/octet-stream";
    }
}
