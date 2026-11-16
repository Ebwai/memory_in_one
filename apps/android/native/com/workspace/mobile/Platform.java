package com.workspace.mobile;

import android.content.Context;
import android.database.Cursor;
import io.requery.android.database.sqlite.SQLiteDatabase;
import io.requery.android.database.sqlite.SQLiteStatement;
import android.webkit.JavascriptInterface;
import org.json.*;
import java.util.*;
import java.net.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;

/** Only installed on the packaged, navigation-locked application origin. */
public final class Platform {
  private final Context context;
  @JavascriptInterface public void background(){((android.app.Activity)context).runOnUiThread(()->((android.app.Activity)context).moveTaskToBack(true));}
  @JavascriptInterface public boolean debug() { return (context.getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0; }
  @JavascriptInterface public synchronized String syncDeviceId() {
    android.content.SharedPreferences preferences = context.getSharedPreferences("sync-device", Context.MODE_PRIVATE);
    String id = preferences.getString("id", "");
    if (!id.isEmpty()) return id;
    id = UUID.randomUUID().toString();
    return preferences.edit().putString("id", id).commit() ? id : "";
  }
  private final SshTunnel tunnel = new SshTunnel();
  private final java.util.concurrent.ExecutorService io = java.util.concurrent.Executors.newFixedThreadPool(2);
  @JavascriptInterface public void rpc(String id,String action,String source) {
    io.execute(()->{
      try {
        JSONObject args=new JSONObject(source);
        String result=action.equals("update")?Updater.install((android.app.Activity)context,source):action.equals("ssh")?ssh(args.getString("action"),args.optString("config","")):action.equals("request")?request(args.getString("url"),args.getString("method"),args.getString("token"),args.getString("body")):error("未知平台动作。");
        ((MainActivity)context).emitRpc(new JSONObject().put("id",id).put("result",new JSONObject(result)).toString());
      }catch(Exception e){try{((MainActivity)context).emitRpc(new JSONObject().put("id",id).put("result",new JSONObject(error("平台操作未完成。"))).toString());}catch(Exception ignored){}}
    });
  }
  @JavascriptInterface public synchronized String ssh(String action,String config) { try { if(action.equals("disconnect")){tunnel.close();return new JSONObject().put("ok",true).put("value","已断开 SSH。").toString();} if(!action.equals("connect"))throw new IllegalArgumentException(); return new JSONObject().put("ok",true).put("value",tunnel.connect(config)).toString(); } catch(Exception e){return error(e.getMessage());} }
  private final Map<String,SQLiteDatabase> databases = new HashMap<>();
  Platform(Context context) { this.context = context; }
  private SQLiteDatabase database(String name) {
    if (!name.matches("[a-zA-Z0-9_-]{1,128}")) throw new IllegalArgumentException("Invalid database identity");
    SQLiteDatabase db = databases.get(name);
    if (db == null) {
      db = SQLiteDatabase.openOrCreateDatabase(context.getDatabasePath("space-" + name + ".sqlite"), null);
      db.setForeignKeyConstraintsEnabled(true); databases.put(name, db);
    }
    return db;
  }
  @JavascriptInterface public synchronized String sql(String name, String operation, String sql, String arguments) {
    try {
      SQLiteDatabase db = database(name);
      JSONArray args = new JSONArray(arguments);
      Object value;
      if (operation.equals("exec")) {
        for (String statement : sql.split(";")) {
          String s = statement.trim();
          if (s.isEmpty()) continue;
          if (s.equalsIgnoreCase("BEGIN IMMEDIATE") || s.equalsIgnoreCase("BEGIN")) db.beginTransactionNonExclusive();
          else if (s.equalsIgnoreCase("COMMIT")) { db.setTransactionSuccessful(); db.endTransaction(); }
          else if (s.equalsIgnoreCase("ROLLBACK")) { if (db.inTransaction()) db.endTransaction(); }
          else if(s.toUpperCase(java.util.Locale.ROOT).startsWith("PRAGMA")) { try(Cursor pragma=db.rawQuery(s,null)){pragma.moveToFirst();} }
          else db.execSQL(s);
        }
        value = JSONObject.NULL;
      } else if (operation.equals("all")) {
        String[] bindings = new String[args.length()];
        for (int i=0;i<bindings.length;i++) bindings[i] = args.isNull(i) ? null : String.valueOf(args.get(i));
        JSONArray rows = new JSONArray();
        try (Cursor c = db.rawQuery(sql, bindings)) {
          while (c.moveToNext()) {
            JSONObject row = new JSONObject();
            for (int i=0;i<c.getColumnCount();i++) {
              Object item = c.isNull(i) ? JSONObject.NULL : c.getType(i)==Cursor.FIELD_TYPE_INTEGER ? c.getLong(i) : c.getType(i)==Cursor.FIELD_TYPE_FLOAT ? c.getDouble(i) : c.getString(i);
              row.put(c.getColumnName(i), item);
            }
            rows.put(row);
          }
        }
        value = rows;
      } else if (operation.equals("run")) {
        try (SQLiteStatement s = db.compileStatement(sql)) {
          for (int i=0;i<args.length();i++) {
            Object item=args.get(i);
            if (item==JSONObject.NULL) s.bindNull(i+1);
            else if (item instanceof Number) s.bindLong(i+1, ((Number)item).longValue());
            else s.bindString(i+1, String.valueOf(item));
          }
          s.execute();
        }
        try (Cursor c=db.rawQuery("SELECT changes() AS changes, last_insert_rowid() AS lastInsertRowid",null)) {
          c.moveToFirst(); value=new JSONObject().put("changes",c.getLong(0)).put("lastInsertRowid",c.getLong(1));
        }
      } else throw new IllegalArgumentException("Invalid SQL operation");
      return new JSONObject().put("ok",true).put("value",value).toString();
    } catch (Exception e) { return error(e.getMessage()); }
  }
  @JavascriptInterface public String hash(String text) {
    try { byte[] data=MessageDigest.getInstance("SHA-256").digest(text.getBytes(StandardCharsets.UTF_8)); StringBuilder result=new StringBuilder(); for(byte b:data) result.append(String.format("%02x",b&255)); return result.toString(); }
    catch(Exception e) { throw new IllegalStateException(e); }
  }
  @JavascriptInterface public String request(String url, String method, String token, String body) {
    HttpURLConnection connection=null;
    try {
      URI uri=new URI(url);
      boolean loopback=Arrays.asList("localhost","127.0.0.1","[::1]").contains(uri.getHost());
      if ((!"https".equals(uri.getScheme()) && !("http".equals(uri.getScheme())&&loopback)) || uri.getUserInfo()!=null || uri.getFragment()!=null) throw new IllegalArgumentException("需要 HTTPS 或本机回环地址。");
      connection=(HttpURLConnection)uri.toURL().openConnection();
      connection.setInstanceFollowRedirects(false); connection.setConnectTimeout(5000); connection.setReadTimeout(10000);
      connection.setRequestMethod(method); connection.setRequestProperty("User-Agent","Workspace-Android"); if(!token.isEmpty())connection.setRequestProperty("Authorization","Bearer "+token);
      if (!"GET".equals(method)) { connection.setDoOutput(true); connection.setRequestProperty("Content-Type","application/json"); try(OutputStream out=connection.getOutputStream()){out.write(body.getBytes(StandardCharsets.UTF_8));} }
      int status=connection.getResponseCode();
      InputStream stream=status>=400?connection.getErrorStream():connection.getInputStream();
      ByteArrayOutputStream bytes=new ByteArrayOutputStream();
      if(stream!=null)try(InputStream input=stream){byte[] buffer=new byte[8192];int count;while((count=input.read(buffer))!=-1){if(bytes.size()+count>16*1024*1024)throw new IOException("响应过大。");bytes.write(buffer,0,count);}}
      return new JSONObject().put("ok",true).put("status",status).put("body",bytes.toString("UTF-8")).toString();
    } catch(Exception e){return error("连接暂不可用，原操作保留。");} finally{if(connection!=null)connection.disconnect();}
  }
  @JavascriptInterface public synchronized String credential(String action, String name, String value) {
    try {
      if(!name.matches("[a-zA-Z0-9_-]{1,160}")) throw new IllegalArgumentException();
      java.security.KeyStore keys=java.security.KeyStore.getInstance("AndroidKeyStore"); keys.load(null);
      String alias="workspace-owner";
      if(!keys.containsAlias(alias)) {
        javax.crypto.KeyGenerator generator=javax.crypto.KeyGenerator.getInstance("AES","AndroidKeyStore");
        generator.init(new android.security.keystore.KeyGenParameterSpec.Builder(alias,android.security.keystore.KeyProperties.PURPOSE_ENCRYPT|android.security.keystore.KeyProperties.PURPOSE_DECRYPT).setBlockModes("GCM").setEncryptionPaddings("NoPadding").build()); generator.generateKey();
      }
      javax.crypto.SecretKey key=(javax.crypto.SecretKey)keys.getKey(alias,null);
      android.content.SharedPreferences prefs=context.getSharedPreferences("credentials",Context.MODE_PRIVATE);
      javax.crypto.Cipher cipher=javax.crypto.Cipher.getInstance("AES/GCM/NoPadding");
      if(action.equals("save")) {
        cipher.init(javax.crypto.Cipher.ENCRYPT_MODE,key);
        String encrypted=android.util.Base64.encodeToString(cipher.getIV(),2)+":"+android.util.Base64.encodeToString(cipher.doFinal(value.getBytes(StandardCharsets.UTF_8)),2);
        if(!prefs.edit().putString(name,encrypted).commit())throw new IOException();
        return "{\"ok\":true}";
      }
      if(!action.equals("load"))throw new IllegalArgumentException();
      String encrypted=prefs.getString(name,null); if(encrypted==null)throw new IOException();
      String[] parts=encrypted.split(":");
      cipher.init(javax.crypto.Cipher.DECRYPT_MODE,key,new javax.crypto.spec.GCMParameterSpec(128,android.util.Base64.decode(parts[0],2)));
      return new JSONObject().put("ok",true).put("value",new String(cipher.doFinal(android.util.Base64.decode(parts[1],2)),StandardCharsets.UTF_8)).toString();
    } catch(Exception e){return error("系统凭据保护不可用，请重新接入。");}
  }
  private String fileId=null, fileAction=null, fileBody=null;
  @JavascriptInterface public synchronized void file(String id,String action,String body) {
    if(fileId!=null){fileResult(id,false,"已有文件选择正在进行。");return;}
    fileId=id;fileAction=action;fileBody=body;
    ((android.app.Activity)context).runOnUiThread(()->{
      try {
        android.content.Intent intent=new android.content.Intent(action.equals("save")?android.content.Intent.ACTION_CREATE_DOCUMENT:android.content.Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(android.content.Intent.CATEGORY_OPENABLE);
        intent.setType(action.equals("install")?"application/vnd.android.package-archive":"application/json");
        if(action.equals("save"))intent.putExtra(android.content.Intent.EXTRA_TITLE,"workspace-backup.json");
        ((android.app.Activity)context).startActivityForResult(intent,810);
      }catch(Exception e){fileResult(id,false,"无法打开系统文件选择器。");clearFile();}
    });
  }
  synchronized void onActivityResult(int resultCode,android.content.Intent data) {
    if(fileId==null)return;String id=fileId;
    try {
      if(resultCode!=android.app.Activity.RESULT_OK||data==null||data.getData()==null){fileResult(id,false,"已取消。");return;}
      android.net.Uri uri=data.getData();
      if(fileAction.equals("save")){
        try(OutputStream out=context.getContentResolver().openOutputStream(uri,"wt")){out.write(fileBody.getBytes(StandardCharsets.UTF_8));out.flush();}
        fileResult(id,true,"备份文件已交付。");
      }else if(fileAction.equals("install")){
        android.content.Intent installer=new android.content.Intent(android.content.Intent.ACTION_VIEW).setDataAndType(uri,"application/vnd.android.package-archive").addFlags(android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION);
        context.startActivity(installer);fileResult(id,true,"请在系统安装界面核验并完成更新。");
      }else{
        ByteArrayOutputStream bytes=new ByteArrayOutputStream();
        try(InputStream input=context.getContentResolver().openInputStream(uri)){byte[] buffer=new byte[8192];int count;while((count=input.read(buffer))!=-1){if(bytes.size()+count>64*1024*1024)throw new IOException();bytes.write(buffer,0,count);}}
        fileResult(id,true,bytes.toString("UTF-8"));
      }
    }catch(Exception e){fileResult(id,false,"文件操作未完成，请保留原数据并重试。");}finally{clearFile();}
  }
  private void clearFile(){fileId=null;fileAction=null;fileBody=null;}
  private void fileResult(String id,boolean ok,String value){
    try{String payload=new JSONObject().put("id",id).put("ok",ok).put("value",value).toString();((MainActivity)context).emitFile(payload);}catch(Exception e){}
  }
  private String error(String message){try{return new JSONObject().put("ok",false).put("message",message).toString();}catch(Exception e){return "{\"ok\":false}";}}
  synchronized void close(){io.shutdownNow();tunnel.close();for(SQLiteDatabase db:databases.values()) { if(db.inTransaction())db.endTransaction(); db.close(); }databases.clear();}
}
