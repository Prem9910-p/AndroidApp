package com.prem.statussaver;

import android.app.Activity;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.media.MediaScannerConnection;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.os.storage.StorageManager;
import android.os.storage.StorageVolume;
import android.provider.MediaStore;
import android.provider.OpenableColumns;
import android.provider.Settings;
import androidx.annotation.NonNull;
import androidx.documentfile.provider.DocumentFile;
import androidx.core.content.FileProvider;
import com.facebook.react.bridge.ActivityEventListener;
import com.facebook.react.bridge.Arguments;
import com.facebook.react.bridge.BaseActivityEventListener;
import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;
import com.facebook.react.bridge.WritableArray;
import com.facebook.react.bridge.WritableMap;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

public class StatusSaverModule extends ReactContextBaseJavaModule {

  private static final String PREFS = "status_saver";
  private static final String PREF_CUSTOM_TREE = "custom_status_tree_uri";
  private static final int REQ_PICK_TREE = 7142;

  private Promise mPickFolderPromise;

  private final ActivityEventListener mActivityListener =
      new BaseActivityEventListener() {
        @Override
        public void onActivityResult(
            Activity activity, int requestCode, int resultCode, Intent data) {
          if (requestCode != REQ_PICK_TREE) {
            return;
          }
          Promise p = mPickFolderPromise;
          mPickFolderPromise = null;
          if (p == null) {
            return;
          }
          if (resultCode != Activity.RESULT_OK || data == null || data.getData() == null) {
            p.reject("E_CANCELLED", "Folder selection cancelled");
            return;
          }
          Uri treeUri = data.getData();
          try {
            int takeFlags =
                data.getFlags()
                    & (Intent.FLAG_GRANT_READ_URI_PERMISSION
                        | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
            activity.getContentResolver().takePersistableUriPermission(treeUri, takeFlags);
          } catch (SecurityException ignored) {
            // Some devices still allow reading without persistable permission.
          }
          prefs().edit().putString(PREF_CUSTOM_TREE, treeUri.toString()).apply();
          p.resolve(treeUri.toString());
        }
      };

  public StatusSaverModule(ReactApplicationContext reactContext) {
    super(reactContext);
    reactContext.addActivityEventListener(mActivityListener);
  }

  @Override
  public void invalidate() {
    super.invalidate();
    getReactApplicationContext().removeActivityEventListener(mActivityListener);
  }

  @NonNull
  @Override
  public String getName() {
    return "StatusSaver";
  }

  private SharedPreferences prefs() {
    return getReactApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
  }

  private File savedDir() {
    File dir = new File(getReactApplicationContext().getFilesDir(), "saved_statuses");
    if (!dir.exists()) {
      dir.mkdirs();
    }
    return dir;
  }

  private static File normalized(File f) {
    try {
      return new File(f.getCanonicalPath());
    } catch (Exception e) {
      return f;
    }
  }

  @SuppressWarnings("deprecation")
  private List<File> externalStorageRoots() {
    Set<File> roots = new LinkedHashSet<>();
    File primary = Environment.getExternalStorageDirectory();
    if (primary != null) {
      roots.add(normalized(primary));
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      StorageManager sm =
          (StorageManager) getReactApplicationContext().getSystemService(Context.STORAGE_SERVICE);
      if (sm != null) {
        for (StorageVolume vol : sm.getStorageVolumes()) {
          File dir = vol.getDirectory();
          if (dir != null) {
            roots.add(normalized(dir));
          }
        }
      }
    }
    roots.add(normalized(new File("/storage/emulated/0")));
    return new ArrayList<>(roots);
  }

  private static List<File> statusFoldersUnder(File root) {
    List<File> list = new ArrayList<>();
    list.add(new File(root, "Android/media/com.whatsapp/WhatsApp/Media/.Statuses"));
    list.add(new File(root, "WhatsApp/Media/.Statuses"));
    list.add(new File(root, "Android/media/com.whatsapp.w4b/WhatsApp/Media/.Statuses"));
    list.add(new File(root, "WhatsApp Business/Media/.Statuses"));
    list.add(new File(root, "Android/media/com.gbwhatsapp/GBWhatsApp/Media/.Statuses"));
    list.add(new File(root, "GBWhatsApp/Media/.Statuses"));
    return list;
  }

  private List<File> allStatusDirectories() {
    Set<String> uniq = new LinkedHashSet<>();
    List<File> out = new ArrayList<>();
    for (File base : externalStorageRoots()) {
      for (File folder : statusFoldersUnder(base)) {
        String key;
        try {
          key = folder.getCanonicalPath();
        } catch (Exception e) {
          key = folder.getAbsolutePath();
        }
        if (uniq.add(key)) {
          out.add(folder);
        }
      }
    }
    return out;
  }

  private static boolean isVideoExtension(String ext) {
    return ext.equals("mp4") || ext.equals("mkv") || ext.equals("3gp") || ext.equals("webm");
  }

  private static String fileExtension(File file) {
    String name = file.getName();
    int i = name.lastIndexOf('.');
    return i >= 0 ? name.substring(i + 1) : "";
  }

  private static String extensionFromFileName(String name) {
    int i = name.lastIndexOf('.');
    return i >= 0 ? name.substring(i + 1) : "";
  }

  private static boolean isMediaExtension(String ext) {
    ext = ext.toLowerCase(Locale.US);
    return ext.equals("jpg")
        || ext.equals("jpeg")
        || ext.equals("png")
        || ext.equals("webp")
        || ext.equals("mp4")
        || ext.equals("mkv")
        || ext.equals("3gp")
        || ext.equals("webm");
  }

  private static boolean isMediaFile(File file) {
    if (!file.isFile()) {
      return false;
    }
    return isMediaExtension(fileExtension(file));
  }

  private static String mimeForExtension(String ext) {
    ext = ext.toLowerCase(Locale.US);
    switch (ext) {
      case "jpg":
      case "jpeg":
        return "image/jpeg";
      case "png":
        return "image/png";
      case "webp":
        return "image/webp";
      case "mp4":
        return "video/mp4";
      case "mkv":
        return "video/x-matroska";
      case "3gp":
        return "video/3gpp";
      case "webm":
        return "video/webm";
      default:
        return "application/octet-stream";
    }
  }

  private static String mimeForFile(File file) {
    return mimeForExtension(fileExtension(file));
  }

  private DocumentFile customTreeRoot() {
    String uriStr = prefs().getString(PREF_CUSTOM_TREE, null);
    if (uriStr == null) {
      return null;
    }
    Uri treeUri = Uri.parse(uriStr);
    return DocumentFile.fromTreeUri(getReactApplicationContext(), treeUri);
  }

  private int countCustomTreeMedia() {
    DocumentFile root = customTreeRoot();
    if (root == null || !root.exists()) {
      return 0;
    }
    DocumentFile[] files = root.listFiles();
    if (files == null) {
      return 0;
    }
    int n = 0;
    for (DocumentFile f : files) {
      if (f.isFile() && f.getName() != null && isMediaExtension(extensionFromFileName(f.getName()))) {
        n++;
      }
    }
    return n;
  }

  private void appendCustomTreeFiles(WritableArray items, Set<String> seen) {
    DocumentFile root = customTreeRoot();
    if (root == null || !root.exists()) {
      return;
    }
    DocumentFile[] files = root.listFiles();
    if (files == null) {
      return;
    }
    for (DocumentFile f : files) {
      if (!f.isFile()) {
        continue;
      }
      String name = f.getName();
      if (name == null || !isMediaExtension(extensionFromFileName(name))) {
        continue;
      }
      Uri docUri = f.getUri();
      String key = docUri.toString();
      if (!seen.add(key)) {
        continue;
      }
      items.pushMap(documentToMap(f, docUri, name));
    }
  }

  private WritableMap documentToMap(DocumentFile f, Uri docUri, String name) {
    String ext = extensionFromFileName(name).toLowerCase(Locale.US);
    boolean isVideo = isVideoExtension(ext);
    String mime = mimeForExtension(ext);
    WritableMap map = Arguments.createMap();
    map.putString("path", docUri.toString());
    map.putString("name", name);
    map.putString("mime", mime);
    map.putDouble("size", (double) f.length());
    map.putDouble("modified", (double) f.lastModified());
    map.putBoolean("isVideo", isVideo);
    return map;
  }

  private String displayNameFromContentUri(Uri uri) {
    ReactApplicationContext ctx = getReactApplicationContext();
    try (Cursor c =
        ctx.getContentResolver()
            .query(uri, new String[] {OpenableColumns.DISPLAY_NAME}, null, null, null)) {
      if (c != null && c.moveToFirst()) {
        int idx = c.getColumnIndex(OpenableColumns.DISPLAY_NAME);
        if (idx >= 0) {
          String n = c.getString(idx);
          if (n != null && !n.isEmpty()) {
            return n;
          }
        }
      }
    }
    return "media_" + System.currentTimeMillis();
  }

  /**
   * WhatsApp stores statuses under Android/media/.../.Statuses. On API 30+ other apps cannot list
   * that path without {@link Environment#isExternalStorageManager()} or a user-granted SAF tree.
   */
  @ReactMethod
  public void hasFullStorageAccess(Promise promise) {
    try {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
        promise.resolve(true);
        return;
      }
      promise.resolve(Environment.isExternalStorageManager());
    } catch (Exception e) {
      promise.reject("E_FULL_ACCESS", e.getMessage(), e);
    }
  }

  @ReactMethod
  public void openManageAllFilesSettings(Promise promise) {
    Activity activity = getCurrentActivity();
    if (activity == null) {
      promise.reject("E_NO_ACTIVITY", "No activity");
      return;
    }
    String packageName = getReactApplicationContext().getPackageName();
    try {
      Intent intent = new Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION);
      intent.setData(Uri.parse("package:" + packageName));
      activity.startActivity(intent);
      promise.resolve(true);
    } catch (Exception e) {
      try {
        Intent fallback = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
        fallback.setData(Uri.parse("package:" + packageName));
        activity.startActivity(fallback);
        promise.resolve(true);
      } catch (Exception e2) {
        promise.reject("E_SETTINGS", e2.getMessage(), e2);
      }
    }
  }

  @ReactMethod
  public void getCustomStatusFolder(Promise promise) {
    try {
      WritableMap map = Arguments.createMap();
      String uriStr = prefs().getString(PREF_CUSTOM_TREE, null);
      if (uriStr == null) {
        map.putBoolean("set", false);
        map.putNull("uri");
        map.putNull("label");
        promise.resolve(map);
        return;
      }
      DocumentFile root = customTreeRoot();
      String label = uriStr;
      if (root != null && root.exists()) {
        String n = root.getName();
        if (n != null) {
          label = n;
        }
      }
      map.putBoolean("set", true);
      map.putString("uri", uriStr);
      if (label != null) {
        map.putString("label", label);
      } else {
        map.putNull("label");
      }
      promise.resolve(map);
    } catch (Exception e) {
      promise.reject("E_CUSTOM_FOLDER", e.getMessage(), e);
    }
  }

  @ReactMethod
  public void pickCustomStatusFolder(Promise promise) {
    Activity activity = getReactApplicationContext().getCurrentActivity();
    if (activity == null) {
      promise.reject("E_NO_ACTIVITY", "No activity");
      return;
    }
    if (mPickFolderPromise != null) {
      mPickFolderPromise.reject("E_REPLACED", "Another picker was opened");
      mPickFolderPromise = null;
    }
    mPickFolderPromise = promise;
    Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
    intent.addFlags(
        Intent.FLAG_GRANT_READ_URI_PERMISSION
            | Intent.FLAG_GRANT_WRITE_URI_PERMISSION
            | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      intent.addFlags(Intent.FLAG_GRANT_PREFIX_URI_PERMISSION);
    }
    try {
      activity.startActivityForResult(intent, REQ_PICK_TREE);
    } catch (Exception e) {
      mPickFolderPromise = null;
      promise.reject("E_PICKER", e.getMessage(), e);
    }
  }

  @ReactMethod
  public void clearCustomStatusFolder(Promise promise) {
    try {
      String uriStr = prefs().getString(PREF_CUSTOM_TREE, null);
      if (uriStr != null) {
        try {
          getReactApplicationContext()
              .getContentResolver()
              .releasePersistableUriPermission(
                  Uri.parse(uriStr),
                  Intent.FLAG_GRANT_READ_URI_PERMISSION
                      | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
        } catch (SecurityException ignored) {
        }
      }
      prefs().edit().remove(PREF_CUSTOM_TREE).apply();
      promise.resolve(true);
    } catch (Exception e) {
      promise.reject("E_CLEAR", e.getMessage(), e);
    }
  }

  @ReactMethod
  public void getStatusFiles(Promise promise) {
    try {
      Set<String> seen = new HashSet<>();
      WritableArray items = Arguments.createArray();
      for (File dir : allStatusDirectories()) {
        if (!dir.exists() || !dir.isDirectory()) {
          continue;
        }
        File[] files = dir.listFiles();
        if (files == null) {
          continue;
        }
        for (File file : files) {
          if (!isMediaFile(file)) {
            continue;
          }
          String key;
          try {
            key = file.getCanonicalPath();
          } catch (Exception e) {
            key = file.getAbsolutePath();
          }
          if (!seen.add(key)) {
            continue;
          }
          items.pushMap(fileToMap(file));
        }
      }
      appendCustomTreeFiles(items, seen);
      promise.resolve(items);
    } catch (Exception e) {
      promise.reject("E_STATUS_LIST", e.getMessage(), e);
    }
  }

  @ReactMethod
  public void getFolderScanReport(Promise promise) {
    try {
      WritableArray arr = Arguments.createArray();
      for (File dir : allStatusDirectories()) {
        WritableMap row = Arguments.createMap();
        row.putString("path", dir.getAbsolutePath());
        row.putBoolean("exists", dir.exists() && dir.isDirectory());
        int count = 0;
        if (dir.isDirectory()) {
          File[] listed = dir.listFiles();
          if (listed != null) {
            for (File f : listed) {
              if (isMediaFile(f)) {
                count++;
              }
            }
          }
        }
        row.putInt("mediaCount", count);
        arr.pushMap(row);
      }
      WritableMap customRow = Arguments.createMap();
      customRow.putString("path", "Custom folder (you picked)");
      DocumentFile cr = customTreeRoot();
      boolean customOk = cr != null && cr.exists();
      customRow.putBoolean("exists", customOk);
      customRow.putInt("mediaCount", customOk ? countCustomTreeMedia() : 0);
      arr.pushMap(customRow);
      promise.resolve(arr);
    } catch (Exception e) {
      promise.reject("E_SCAN_REPORT", e.getMessage(), e);
    }
  }

  private WritableMap fileToMap(File file) {
    String ext = fileExtension(file).toLowerCase(Locale.US);
    boolean isVideo = isVideoExtension(ext);
    WritableMap map = Arguments.createMap();
    map.putString("path", file.getAbsolutePath());
    map.putString("name", file.getName());
    map.putString("mime", mimeForFile(file));
    map.putDouble("size", (double) file.length());
    map.putDouble("modified", (double) file.lastModified());
    map.putBoolean("isVideo", isVideo);
    return map;
  }

  private static void copyStream(InputStream in, OutputStream out) throws IOException {
    byte[] buf = new byte[8192];
    int n;
    while ((n = in.read(buf)) != -1) {
      out.write(buf, 0, n);
    }
  }

  private void saveToGalleryFromContentUri(Uri sourceUri, Promise promise) {
    try {
      ReactApplicationContext ctx = getReactApplicationContext();
      String mime = ctx.getContentResolver().getType(sourceUri);
      if (mime == null) {
        mime = "application/octet-stream";
      }
      String baseName = displayNameFromContentUri(sourceUri);
      String displayName = "Status_" + System.currentTimeMillis() + "_" + baseName;
      ContentValues values = new ContentValues();
      values.put(MediaStore.MediaColumns.DISPLAY_NAME, displayName);
      values.put(MediaStore.MediaColumns.MIME_TYPE, mime);
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        String rel =
            mime.startsWith("video")
                ? Environment.DIRECTORY_MOVIES + "/StatusSaver"
                : Environment.DIRECTORY_PICTURES + "/StatusSaver";
        values.put(MediaStore.MediaColumns.RELATIVE_PATH, rel);
      }
      Uri collection =
          mime.startsWith("video")
              ? MediaStore.Video.Media.EXTERNAL_CONTENT_URI
              : MediaStore.Images.Media.EXTERNAL_CONTENT_URI;
      Uri destUri = ctx.getContentResolver().insert(collection, values);
      if (destUri == null) {
        promise.reject("E_MEDIA_STORE", "Could not create media entry");
        return;
      }
      try (OutputStream out = ctx.getContentResolver().openOutputStream(destUri);
          InputStream input = ctx.getContentResolver().openInputStream(sourceUri)) {
        if (out == null || input == null) {
          promise.reject("E_IO", "Could not open streams");
          return;
        }
        copyStream(input, out);
      }
      WritableMap result = Arguments.createMap();
      result.putString("uri", destUri.toString());
      promise.resolve(result);
    } catch (Exception e) {
      promise.reject("E_SAVE", e.getMessage(), e);
    }
  }

  @ReactMethod
  public void saveToGallery(String sourcePathOrUri, Promise promise) {
    if (sourcePathOrUri == null || sourcePathOrUri.isEmpty()) {
      promise.reject("E_INVALID", "Invalid path");
      return;
    }
    if (sourcePathOrUri.startsWith("content://")) {
      saveToGalleryFromContentUri(Uri.parse(sourcePathOrUri), promise);
      return;
    }
    try {
      File file = new File(sourcePathOrUri);
      if (!file.exists() || !file.isFile()) {
        promise.reject("E_NOT_FOUND", "File not found");
        return;
      }
      String mime = mimeForFile(file);
      ReactApplicationContext ctx = getReactApplicationContext();
      String displayName = "Status_" + System.currentTimeMillis() + "_" + file.getName();
      ContentValues values = new ContentValues();
      values.put(MediaStore.MediaColumns.DISPLAY_NAME, displayName);
      values.put(MediaStore.MediaColumns.MIME_TYPE, mime);
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        String rel =
            mime.startsWith("video")
                ? Environment.DIRECTORY_MOVIES + "/StatusSaver"
                : Environment.DIRECTORY_PICTURES + "/StatusSaver";
        values.put(MediaStore.MediaColumns.RELATIVE_PATH, rel);
      }
      Uri collection =
          mime.startsWith("video")
              ? MediaStore.Video.Media.EXTERNAL_CONTENT_URI
              : MediaStore.Images.Media.EXTERNAL_CONTENT_URI;
      Uri uri = ctx.getContentResolver().insert(collection, values);
      if (uri == null) {
        promise.reject("E_MEDIA_STORE", "Could not create media entry");
        return;
      }
      try (OutputStream out = ctx.getContentResolver().openOutputStream(uri);
          FileInputStream input = new FileInputStream(file)) {
        if (out == null) {
          promise.reject("E_IO", "Could not open output stream");
          return;
        }
        copyStream(input, out);
      }
      WritableMap result = Arguments.createMap();
      result.putString("uri", uri.toString());
      promise.resolve(result);
    } catch (Exception e) {
      promise.reject("E_SAVE", e.getMessage(), e);
    }
  }

  private void copyToAppSavedFromContentUri(Uri sourceUri, Promise promise) {
    try {
      ReactApplicationContext ctx = getReactApplicationContext();
      String baseName = displayNameFromContentUri(sourceUri);
      String destName = System.currentTimeMillis() + "_" + baseName;
      File dest = new File(savedDir(), destName);
      try (InputStream input = ctx.getContentResolver().openInputStream(sourceUri);
          FileOutputStream output = new FileOutputStream(dest)) {
        if (input == null) {
          promise.reject("E_IO", "Could not read source");
          return;
        }
        copyStream(input, output);
      }
      promise.resolve(fileToMap(dest));
    } catch (Exception e) {
      promise.reject("E_COPY", e.getMessage(), e);
    }
  }

  @ReactMethod
  public void copyToAppSaved(String sourcePathOrUri, Promise promise) {
    if (sourcePathOrUri == null || sourcePathOrUri.isEmpty()) {
      promise.reject("E_INVALID", "Invalid path");
      return;
    }
    if (sourcePathOrUri.startsWith("content://")) {
      copyToAppSavedFromContentUri(Uri.parse(sourcePathOrUri), promise);
      return;
    }
    try {
      File src = new File(sourcePathOrUri);
      if (!src.exists() || !src.isFile()) {
        promise.reject("E_NOT_FOUND", "File not found");
        return;
      }
      String destName = System.currentTimeMillis() + "_" + src.getName();
      File dest = new File(savedDir(), destName);
      try (FileInputStream input = new FileInputStream(src);
          FileOutputStream output = new FileOutputStream(dest)) {
        copyStream(input, output);
      }
      promise.resolve(fileToMap(dest));
    } catch (Exception e) {
      promise.reject("E_COPY", e.getMessage(), e);
    }
  }

  @ReactMethod
  public void getSavedFiles(Promise promise) {
    try {
      WritableArray arr = Arguments.createArray();
      File dir = savedDir();
      if (!dir.exists()) {
        promise.resolve(arr);
        return;
      }
      File[] listed = dir.listFiles();
      List<File> files = new ArrayList<>();
      if (listed != null) {
        for (File f : listed) {
          if (isMediaFile(f)) {
            files.add(f);
          }
        }
      }
      files.sort((a, b) -> Long.compare(b.lastModified(), a.lastModified()));
      for (File f : files) {
        arr.pushMap(fileToMap(f));
      }
      promise.resolve(arr);
    } catch (Exception e) {
      promise.reject("E_SAVED_LIST", e.getMessage(), e);
    }
  }

  /**
   * Deletes a status media file from WhatsApp’s cache folder (file path) or from the user-picked
   * custom folder (content URI). Does not delete copies in this app’s Saved area — use {@link
   * #removeSaved} for that.
   */
  @ReactMethod
  public void deleteStatusMedia(String pathOrUri, Promise promise) {
    try {
      if (pathOrUri == null || pathOrUri.isEmpty()) {
        promise.reject("E_INVALID", "Invalid path");
        return;
      }
      ReactApplicationContext ctx = getReactApplicationContext();
      if (pathOrUri.startsWith("content://")) {
        Uri uri = Uri.parse(pathOrUri);
        DocumentFile doc = DocumentFile.fromSingleUri(ctx, uri);
        if (doc == null || !doc.isFile() || !doc.exists()) {
          promise.reject("E_NOT_FOUND", "File not found");
          return;
        }
        if (!doc.delete()) {
          promise.reject("E_DELETE", "Could not delete file");
          return;
        }
        promise.resolve(true);
        return;
      }
      File f = new File(pathOrUri);
      if (!f.exists() || !f.isFile()) {
        promise.reject("E_NOT_FOUND", "File not found");
        return;
      }
      if (!isMediaFile(f)) {
        promise.reject("E_FORBIDDEN", "Not a media file");
        return;
      }
      String canon = f.getCanonicalPath();
      String savedRoot = savedDir().getCanonicalPath();
      if (canon.startsWith(savedRoot)) {
        promise.reject("E_FORBIDDEN", "Use removeSaved for app-saved copies");
        return;
      }
      boolean allowed = false;
      for (File dir : allStatusDirectories()) {
        if (!dir.exists() || !dir.isDirectory()) {
          continue;
        }
        String dirCanon = dir.getCanonicalPath();
        if (canon.startsWith(dirCanon + File.separator)) {
          allowed = true;
          break;
        }
      }
      if (!allowed) {
        promise.reject("E_FORBIDDEN", "Not allowed to delete this path");
        return;
      }
      if (!f.delete()) {
        promise.reject("E_DELETE", "Could not delete file");
        return;
      }
      promise.resolve(true);
    } catch (Exception e) {
      promise.reject("E_DELETE", e.getMessage(), e);
    }
  }

  @ReactMethod
  public void removeSaved(String absolutePath, Promise promise) {
    try {
      File f = new File(absolutePath);
      String savedRoot = savedDir().getAbsolutePath();
      if (f.exists() && f.getAbsolutePath().startsWith(savedRoot)) {
        f.delete();
      }
      promise.resolve(true);
    } catch (Exception e) {
      promise.reject("E_DELETE", e.getMessage(), e);
    }
  }

  @ReactMethod
  public void shareFile(String absolutePathOrUri, Promise promise) {
    try {
      if (absolutePathOrUri == null || absolutePathOrUri.isEmpty()) {
        promise.reject("E_INVALID", "Invalid path");
        return;
      }
      ReactApplicationContext ctx = getReactApplicationContext();
      if (absolutePathOrUri.startsWith("content://")) {
        Uri uri = Uri.parse(absolutePathOrUri);
        String mime = ctx.getContentResolver().getType(uri);
        if (mime == null) {
          mime = "*/*";
        }
        Intent intent = new Intent(Intent.ACTION_SEND);
        intent.setType(mime);
        intent.putExtra(Intent.EXTRA_STREAM, uri);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        Intent chooser = Intent.createChooser(intent, "Share");
        chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        ctx.startActivity(chooser);
        promise.resolve(true);
        return;
      }
      File file = new File(absolutePathOrUri);
      if (!file.exists() || !file.isFile()) {
        promise.reject("E_NOT_FOUND", "File not found");
        return;
      }
      Uri uri =
          FileProvider.getUriForFile(
              ctx, ctx.getPackageName() + ".fileprovider", file);
      String mime = mimeForFile(file);
      Intent intent = new Intent(Intent.ACTION_SEND);
      intent.setType(mime);
      intent.putExtra(Intent.EXTRA_STREAM, uri);
      intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
      Intent chooser = Intent.createChooser(intent, "Share");
      chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
      ctx.startActivity(chooser);
      promise.resolve(true);
    } catch (Exception e) {
      promise.reject("E_SHARE", e.getMessage(), e);
    }
  }

  @ReactMethod
  public void scanMedia(String absolutePathOrUri, Promise promise) {
    try {
      if (absolutePathOrUri == null || absolutePathOrUri.isEmpty()) {
        promise.reject("E_INVALID", "Invalid path");
        return;
      }
      if (absolutePathOrUri.startsWith("content://")) {
        promise.resolve(true);
        return;
      }
      File file = new File(absolutePathOrUri);
      if (!file.exists()) {
        promise.resolve(false);
        return;
      }
      MediaScannerConnection.scanFile(
          getReactApplicationContext(),
          new String[] {file.getAbsolutePath()},
          new String[] {mimeForFile(file)},
          null);
      promise.resolve(true);
    } catch (Exception e) {
      promise.reject("E_SCAN", e.getMessage(), e);
    }
  }
}
