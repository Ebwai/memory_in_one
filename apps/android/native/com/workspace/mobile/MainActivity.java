package com.workspace.mobile;

import android.app.Activity;
import android.os.Bundle;
import android.webkit.*;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.content.ContentValues;
import java.io.*;
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;

public final class MainActivity extends Activity {
  private WebView web;
  private Platform platform;
  private SQLiteDatabase db;
  private static final String ORIGIN = "https://workspace.android.local/";

  @Override public void onCreate(Bundle state) {
    super.onCreate(state);
    db = openOrCreateDatabase("mobile.sqlite", MODE_PRIVATE, null);
    db.execSQL("CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, body TEXT NOT NULL)");
    db.execSQL("INSERT OR IGNORE INTO state VALUES (1,0,'{\"format\":1,\"spaces\":[],\"current\":null}')");
    web = new WebView(this);
    WebView.setWebContentsDebuggingEnabled((getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0);
    web.setBackgroundColor(0xfff5f3ed);
    web.getSettings().setJavaScriptEnabled(true);
    web.getSettings().setDomStorageEnabled(false);
    web.getSettings().setAllowFileAccess(false);
    web.getSettings().setAllowContentAccess(false);
    web.getSettings().setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
    web.addJavascriptInterface(new Storage(), "WorkspaceNative");
    platform = new Platform(this);
    web.addJavascriptInterface(platform, "AndroidPlatform");
    web.setWebViewClient(new WebViewClient() {
      @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) { return true; }
      @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
        String url = req.getUrl().toString();
        if (!url.startsWith(ORIGIN)) return blocked();
        String file = url.substring(ORIGIN.length());
        if (file.isEmpty()) file = "index.html";
        if (!file.matches("[a-zA-Z0-9._-]+")) return blocked();
        try {
          String mime = file.endsWith(".js") ? "application/javascript" : file.endsWith(".css") ? "text/css" : "text/html";
          WebResourceResponse res = new WebResourceResponse(mime, "UTF-8", getAssets().open(file));
          java.util.Map<String,String> headers = new java.util.HashMap<>();
          headers.put("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'");
          headers.put("X-Content-Type-Options", "nosniff");
          res.setResponseHeaders(headers);
          return res;
        } catch (IOException e) { return blocked(); }
      }
    });
    setContentView(web);
    // Keep content clear of status/navigation bars with Android 15 edge-to-edge.
    web.setOnApplyWindowInsetsListener((v, insets) -> {
      v.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(), insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
      return insets;
    });
    web.loadUrl(ORIGIN);
  }
  private WebResourceResponse blocked() {
    return new WebResourceResponse("text/plain", "UTF-8", new ByteArrayInputStream(new byte[0]));
  }
  public final class Storage {
    @JavascriptInterface public synchronized String load() {
      try (Cursor c = db.rawQuery("SELECT revision,body FROM state WHERE id=1", null)) {
        if (!c.moveToFirst()) throw new IllegalStateException();
        return new JSONObject().put("ok", true).put("revision", c.getLong(0)).put("state", new JSONObject(c.getString(1))).toString();
      } catch (Exception e) { return error("无法读取本机内容，请保留应用数据并重试。"); }
    }
    @JavascriptInterface public synchronized String commit(int revision, String body) {
      if (body == null || body.length() > 16 * 1024 * 1024) return error("本机材料过大，尚未保存。");
      db.beginTransaction();
      try {
        JSONObject data = new JSONObject(body);
        if (data.getInt("format") != 1 || !(data.get("spaces") instanceof org.json.JSONArray)) return error("数据版本无效，尚未保存。");
        ContentValues values = new ContentValues();
        values.put("revision", revision + 1); values.put("body", body);
        if (db.update("state", values, "id=1 AND revision=?", new String[]{String.valueOf(revision)}) != 1) return error("本机进度已变化，请重开应用核对；本次输入尚未保存。");
        db.setTransactionSuccessful();
      } catch (Exception e) { return error("本机保存失败，请保留输入后重试。"); }
      finally { db.endTransaction(); }
      return "{\"ok\":true,\"revision\":" + (revision + 1) + "}";
    }
    private String error(String message) {
      try { return new JSONObject().put("ok", false).put("message", message).toString(); }
      catch (Exception e) { return "{\"ok\":false}"; }
    }
  }
  void emitRpc(String payload) { runOnUiThread(()->web.evaluateJavascript("window.dispatchEvent(new CustomEvent('android:rpc',{detail:"+payload+"}))",null)); }
  void emitFile(String payload) { runOnUiThread(()->web.evaluateJavascript("window.dispatchEvent(new CustomEvent('android:file',{detail:"+payload+"}))",null)); }
  @Override protected void onActivityResult(int requestCode,int resultCode,android.content.Intent data) { super.onActivityResult(requestCode,resultCode,data); if(requestCode==810)platform.onActivityResult(resultCode,data); }
  @Override public void onBackPressed() {
    web.evaluateJavascript("window.dispatchEvent(new Event('android:back'))", null);
  }
  @Override protected void onDestroy() {
    web.removeJavascriptInterface("WorkspaceNative"); web.removeJavascriptInterface("AndroidPlatform"); web.destroy(); platform.close(); db.close(); super.onDestroy();
  }
}
