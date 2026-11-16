package com.workspace.mobile;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.*;
import android.net.Uri;
import java.io.*;
import java.net.*;
import java.security.MessageDigest;
import java.util.*;
import org.json.JSONObject;

final class Updater {
  static String install(Activity activity,String source)throws Exception{
    JSONObject offer=new JSONObject(source);
    String url=offer.getString("url"),expected=offer.getString("sha256");long size=offer.getLong("size");
    if(!url.startsWith("https://github.com/Ebwai/memory_in_one/releases/download/")||!url.endsWith(".apk")||!expected.matches("[a-f0-9]{64}")||size<1||size>512L*1024*1024)throw new IOException("更新来源或校验信息无效。");
    File temporary=new File(activity.getCacheDir(),"workspace-update.partial"),target=new File(activity.getCacheDir(),"workspace-update.apk");
    HttpURLConnection connection=null;
    try{
      for(int redirect=0;redirect<5;redirect++){
        URI uri=new URI(url);
        if(!"https".equals(uri.getScheme())||uri.getUserInfo()!=null||!Arrays.asList("github.com","release-assets.githubusercontent.com","objects.githubusercontent.com").contains(uri.getHost()))throw new IOException("更新重定向来源无效。");
        connection=(HttpURLConnection)uri.toURL().openConnection();connection.setConnectTimeout(10000);connection.setReadTimeout(20000);connection.setInstanceFollowRedirects(false);connection.setRequestProperty("User-Agent","Workspace-Android");
        int status=connection.getResponseCode();
        if(status>=300&&status<400){url=uri.resolve(connection.getHeaderField("Location")).toString();connection.disconnect();connection=null;continue;}
        if(status!=200)throw new IOException("更新下载未完成。");break;
      }
      if(connection==null||connection.getResponseCode()!=200)throw new IOException("更新重定向过多。");
      MessageDigest hash=MessageDigest.getInstance("SHA-256");long length=0;
      try(InputStream input=connection.getInputStream();FileOutputStream output=new FileOutputStream(temporary)){
        byte[] buffer=new byte[65536];int count;while((count=input.read(buffer))!=-1){length+=count;if(length>size)throw new IOException("更新大小不符。");hash.update(buffer,0,count);output.write(buffer,0,count);}output.getFD().sync();
      }
      StringBuilder actual=new StringBuilder();for(byte b:hash.digest())actual.append(String.format("%02x",b&255));
      if(length!=size||!expected.equals(actual.toString()))throw new IOException("更新完整性校验失败。");
      PackageManager pm=activity.getPackageManager();PackageInfo incoming=pm.getPackageArchiveInfo(temporary.getAbsolutePath(),PackageManager.GET_SIGNATURES),current=pm.getPackageInfo(activity.getPackageName(),PackageManager.GET_SIGNATURES);
      if(incoming==null||!activity.getPackageName().equals(incoming.packageName)||incoming.versionCode<=current.versionCode||!Arrays.equals(incoming.signatures,current.signatures))throw new IOException("更新包身份、版本或签名不兼容。");
      if(target.exists()&&!target.delete())throw new IOException("旧更新文件无法替换。");if(!temporary.renameTo(target))throw new IOException("更新文件无法交付。");
      activity.runOnUiThread(()->{
        Intent intent=new Intent(Intent.ACTION_VIEW).setDataAndType(Uri.parse("content://com.workspace.mobile.update/apk"),"application/vnd.android.package-archive").addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        activity.startActivity(intent);
      });
      return new JSONObject().put("ok",true).put("value","完整性与应用签名已核验，请在 Android 系统界面确认安装。").toString();
    }finally{if(connection!=null)connection.disconnect();temporary.delete();}
  }
}
