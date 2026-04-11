package com.prem.statussaver;

import android.app.Application;
import android.util.Log;
import com.facebook.react.PackageList;
import com.facebook.react.ReactApplication;
import com.facebook.react.ReactHost;
import com.facebook.react.ReactNativeApplicationEntryPoint;
import com.facebook.react.ReactPackage;
import com.facebook.react.bridge.ReactContext;
import com.facebook.react.defaults.DefaultReactHost;
import com.facebook.react.runtime.BindingsInstaller;
import com.facebook.react.runtime.cxxreactpackage.CxxReactPackage;
import java.util.Collections;
import java.util.List;
import kotlin.Unit;
import kotlin.jvm.functions.Function1;

public class MainApplication extends Application implements ReactApplication {

  private ReactHost reactHost;

  @Override
  public ReactHost getReactHost() {
    if (reactHost == null) {
      synchronized (this) {
        if (reactHost == null) {
          List<ReactPackage> packages = new PackageList(this).getPackages();
          packages.add(new StatusSaverPackage());
          // Kotlin default args are not visible from Java; pass full parameter list.
          List<Function1<ReactContext, CxxReactPackage>> cxxProviders = Collections.emptyList();
          // Re-throwing every exception crashes the process. Only do that in debug; in release log
          // so recoverable RN/ads errors do not show "app keeps stopping".
          Function1<Exception, Unit> exceptionHandler =
              new Function1<Exception, Unit>() {
                @Override
                public Unit invoke(Exception e) {
                  if (BuildConfig.DEBUG) {
                    if (e instanceof RuntimeException) {
                      throw (RuntimeException) e;
                    }
                    throw new RuntimeException(e);
                  }
                  Log.e("ReactNative", "Non-fatal exception in React host", e);
                  return Unit.INSTANCE;
                }
              };
          reactHost =
              DefaultReactHost.getDefaultReactHost(
                  getApplicationContext(),
                  packages,
                  "index",
                  "index.android.bundle",
                  null,
                  null,
                  BuildConfig.DEBUG,
                  cxxProviders,
                  exceptionHandler,
                  (BindingsInstaller) null);
        }
      }
    }
    return reactHost;
  }

  @Override
  public void onCreate() {
    super.onCreate();
    ReactNativeApplicationEntryPoint.loadReactNative(this);
  }
}
