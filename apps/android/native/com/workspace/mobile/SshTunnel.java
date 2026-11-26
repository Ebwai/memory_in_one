package com.workspace.mobile;

import com.jcraft.jsch.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import android.util.Base64;
import org.json.JSONObject;

final class SshTunnel {
  private Session session;
  synchronized void close(){if(session!=null)session.disconnect();session=null;}
  synchronized String connect(String source) throws Exception {
    JSONObject config=new JSONObject(source);
    String host=config.getString("host"), user=config.getString("user"), expected=config.getString("fingerprint");
    int port=config.optInt("port",22), remotePort=config.optInt("remotePort",43127), localPort=config.optInt("localPort",42081);
    if(host.isEmpty()||user.isEmpty()||port<1||port>65535||remotePort<1||remotePort>65535||localPort<1024||localPort>65535||!expected.startsWith("SHA256:"))throw new IllegalArgumentException("请填写 SSH 地址、用户、端口及已核验的 SHA256 主机指纹。");
    final String[] actual={""};
    JSch ssh=new JSch();
    ssh.setHostKeyRepository(new HostKeyRepository(){
      public int check(String name,byte[] key){try{actual[0]="SHA256:"+Base64.encodeToString(MessageDigest.getInstance("SHA-256").digest(key),Base64.NO_WRAP|Base64.NO_PADDING);return MessageDigest.isEqual(expected.getBytes(StandardCharsets.UTF_8),actual[0].getBytes(StandardCharsets.UTF_8))?OK:CHANGED;}catch(Exception e){return CHANGED;}}
      public void add(HostKey key,UserInfo ui){} public void remove(String host,String type){} public void remove(String host,String type,byte[] key){} public String getKnownHostsRepositoryID(){return "explicit-fingerprint";} public HostKey[] getHostKey(){return new HostKey[0];}public HostKey[] getHostKey(String host,String type){return new HostKey[0];}
    });
    String privateKey=config.optString("privateKey","");
    if(!privateKey.isEmpty())ssh.addIdentity("mobile",privateKey.getBytes(StandardCharsets.UTF_8),null,config.optString("passphrase","").getBytes(StandardCharsets.UTF_8));
    Session next=ssh.getSession(user,host,port);
    if(privateKey.isEmpty())next.setPassword(config.optString("password","").getBytes(StandardCharsets.UTF_8));
    next.setConfig("StrictHostKeyChecking","yes");next.setConfig("PreferredAuthentications",privateKey.isEmpty()?"password,keyboard-interactive":"publickey");next.setServerAliveInterval(15000);
    try{next.connect(10000);close();next.setPortForwardingL("127.0.0.1",localPort,"127.0.0.1",remotePort);session=next;return "http://127.0.0.1:"+localPort+"/";}
    catch(Exception e){next.disconnect();throw new Exception(actual[0].isEmpty()?"SSH 连接或认证失败。":"SSH 未连接。请核验主机指纹或认证信息；收到的指纹："+actual[0]);}
  }
}
