package com.workspace.mobile;
import android.content.*;
import android.database.Cursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import java.io.*;

/** A single verified APK; no directory or arbitrary file exposure. */
public final class UpdateProvider extends ContentProvider {
  public boolean onCreate(){return true;}
  public String getType(Uri uri){return "application/vnd.android.package-archive";}
  public ParcelFileDescriptor openFile(Uri uri,String mode)throws FileNotFoundException{
    if(!"/apk".equals(uri.getPath())||!"r".equals(mode))throw new FileNotFoundException();
    return ParcelFileDescriptor.open(new File(getContext().getCacheDir(),"workspace-update.apk"),ParcelFileDescriptor.MODE_READ_ONLY);
  }
  public Cursor query(Uri uri,String[] projection,String selection,String[] args,String sort){return null;}
  public Uri insert(Uri uri,ContentValues values){throw new UnsupportedOperationException();}
  public int update(Uri uri,ContentValues values,String selection,String[] args){throw new UnsupportedOperationException();}
  public int delete(Uri uri,String selection,String[] args){throw new UnsupportedOperationException();}
}
