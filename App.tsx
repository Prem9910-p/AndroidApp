/**
 * WhatsApp Status Saver — view and save status media (Android).
 * Not affiliated with WhatsApp Inc.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  AppState,
  type AppStateStatus,
  Dimensions,
  FlatList,
  Image,
  Linking,
  Modal,
  NativeModules,
  PermissionsAndroid,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StatusBar,
  StyleSheet,
  Switch,
  Text,
  useColorScheme,
  View,
} from 'react-native';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import Video from 'react-native-video';
import mobileAds, {
  AdEventType,
  AppOpenAd,
  BannerAd,
  BannerAdSize,
  InterstitialAd,
  RewardedAd,
  RewardedAdEventType,
} from 'react-native-google-mobile-ads';
import {
  APP_OPEN_AD_UNIT_ID,
  BANNER_AD_UNIT_ID,
  INTERSTITIAL_AD_UNIT_ID,
  REWARDED_AD_UNIT_ID,
} from './adsConfig';

const AUTO_SAVE_KEY = '@status_saver_auto';
/** Tracks statuses already saved (gallery + app Saved) — used for auto and manual saves. */
const SAVED_REGISTRY_KEY = '@status_saver_seen';

function statusSaveKey(f: Pick<StatusFile, 'path' | 'modified'>): string {
  return `${f.path}|${f.modified}`;
}

async function loadSaveRegistry(): Promise<Set<string>> {
  try {
    const raw = await AsyncStorage.getItem(SAVED_REGISTRY_KEY);
    return new Set(raw ? JSON.parse(raw) : []);
  } catch {
    return new Set();
  }
}

async function persistSaveRegistry(registry: Set<string>): Promise<void> {
  try {
    await AsyncStorage.setItem(SAVED_REGISTRY_KEY, JSON.stringify([...registry]));
  } catch {
    /* ignore */
  }
}

type SaveStatusResult = 'saved' | 'duplicate' | 'failed';

async function saveStatusIfNew(
  native: StatusSaverNative,
  f: StatusFile,
  registry: Set<string>,
  options?: { scanMedia?: boolean },
): Promise<SaveStatusResult> {
  const key = statusSaveKey(f);
  if (registry.has(key)) {
    return 'duplicate';
  }
  try {
    await native.saveToGallery(f.path);
    await native.copyToAppSaved(f.path);
    if (options?.scanMedia) {
      await native.scanMedia(f.path);
    }
    registry.add(key);
    return 'saved';
  } catch {
    return 'failed';
  }
}

/** AsyncStorage is the source of truth — avoids stale React state saving to gallery. */
async function readAutoSaveEnabled(): Promise<boolean> {
  try {
    const v = await AsyncStorage.getItem(AUTO_SAVE_KEY);
    return v === '1';
  } catch {
    return false;
  }
}
const INTERSTITIAL_EVERY_N_SAVES = 2;
const APP_OPEN_RESUME_MIN_MS = 4 * 60 * 1000;

const SCREEN_W = Dimensions.get('window').width;
const GRID_GAP = 8;
const CELL_SIZE = (SCREEN_W - GRID_GAP * 4) / 3;

type FolderSlot = 'whatsapp' | 'business';

type TabId = 'images' | 'videos' | 'saved';

export type StatusFile = {
  path: string;
  name: string;
  mime: string;
  size: number;
  modified: number;
  isVideo: boolean;
};

type FolderScanRow = { path: string; exists: boolean; mediaCount: number };

type CustomFolderInfo = { set: boolean; uri: string | null; label: string | null };

type CustomFoldersState = { whatsapp: CustomFolderInfo; business: CustomFolderInfo };

const EMPTY_CUSTOM_FOLDER: CustomFolderInfo = { set: false, uri: null, label: null };

type StatusSaverNative = {
  getStatusFiles: () => Promise<StatusFile[]>;
  getFolderScanReport?: () => Promise<FolderScanRow[]>;
  getCustomStatusFolder?: () => Promise<CustomFolderInfo>;
  getCustomStatusFolders?: () => Promise<CustomFoldersState>;
  pickWhatsAppStatusFolder?: () => Promise<string>;
  pickBusinessStatusFolder?: () => Promise<string>;
  pickCustomStatusFolder?: (slot: FolderSlot) => Promise<string>;
  clearWhatsAppStatusFolder?: () => Promise<boolean>;
  clearBusinessStatusFolder?: () => Promise<boolean>;
  clearCustomStatusFolder?: (slot: FolderSlot) => Promise<boolean>;
  hasFullStorageAccess?: () => Promise<boolean>;
  openManageAllFilesSettings?: () => Promise<void>;
  saveToGallery: (path: string) => Promise<{ uri: string }>;
  copyToAppSaved: (path: string) => Promise<StatusFile>;
  getSavedFiles: () => Promise<StatusFile[]>;
  removeSaved: (path: string) => Promise<boolean>;
  /** Delete status file from WhatsApp/.Statuses or custom folder (not app Saved). */
  deleteStatusMedia: (path: string) => Promise<boolean>;
  shareFile: (path: string) => Promise<boolean>;
  scanMedia: (path: string) => Promise<boolean>;
};

/** Local file path or content:// document URI for previews. */
function androidFileUrl(pathOrUri: string): string {
  if (pathOrUri.startsWith('content://')) {
    return pathOrUri;
  }
  const slash = pathOrUri.replace(/\\/g, '/');
  return 'file://' + encodeURI(slash);
}

const getNative = (): StatusSaverNative | null => {
  if (Platform.OS !== 'android') return null;
  const m = NativeModules.StatusSaver as StatusSaverNative | undefined;
  return m ?? null;
};

async function requestAndroidMediaPermission(): Promise<boolean> {
  if (Platform.OS !== 'android') return false;
  const api = Platform.Version as number;
  if (api >= 33) {
    const r = await PermissionsAndroid.requestMultiple([
      PermissionsAndroid.PERMISSIONS.READ_MEDIA_IMAGES,
      PermissionsAndroid.PERMISSIONS.READ_MEDIA_VIDEO,
    ]);
    return (
      r['android.permission.READ_MEDIA_IMAGES'] === PermissionsAndroid.RESULTS.GRANTED &&
      r['android.permission.READ_MEDIA_VIDEO'] === PermissionsAndroid.RESULTS.GRANTED
    );
  }
  const r = await PermissionsAndroid.request(
    PermissionsAndroid.PERMISSIONS.READ_EXTERNAL_STORAGE,
  );
  return r === PermissionsAndroid.RESULTS.GRANTED;
}

function App() {
  const isDark = useColorScheme() === 'dark';
  return (
    <SafeAreaProvider>
      <StatusBar barStyle={isDark ? 'light-content' : 'dark-content'} />
      <AppContent />
    </SafeAreaProvider>
  );
}

function AppContent() {
  const insets = useSafeAreaInsets();
  const isDark = useColorScheme() === 'dark';
  const theme = useMemo(() => (isDark ? darkTheme : lightTheme), [isDark]);

  const native = getNative();
  const [tab, setTab] = useState<TabId>('images');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [permissionOk, setPermissionOk] = useState(false);
  const [items, setItems] = useState<StatusFile[]>([]);
  const [savedItems, setSavedItems] = useState<StatusFile[]>([]);
  const [autoSave, setAutoSave] = useState(false);
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [selectionMode, setSelectionMode] = useState(false);
  const [preview, setPreview] = useState<StatusFile | null>(null);
  const [folderHint, setFolderHint] = useState<string | null>(null);
  const [customFolders, setCustomFolders] = useState<CustomFoldersState>({
    whatsapp: EMPTY_CUSTOM_FOLDER,
    business: EMPTY_CUSTOM_FOLDER,
  });
  const [interstitialLoaded, setInterstitialLoaded] = useState(false);
  const [appOpenLoaded, setAppOpenLoaded] = useState(false);
  const [rewardedLoaded, setRewardedLoaded] = useState(false);
  const [hdUnlocked, setHdUnlocked] = useState(false);
  const interstitialRef = useRef(InterstitialAd.createForAdRequest(INTERSTITIAL_AD_UNIT_ID));
  const appOpenRef = useRef(AppOpenAd.createForAdRequest(APP_OPEN_AD_UNIT_ID));
  const rewardedRef = useRef(RewardedAd.createForAdRequest(REWARDED_AD_UNIT_ID));
  const appOpenShownRef = useRef(false);
  const appOpenStateRef = useRef<AppStateStatus>(AppState.currentState);
  const lastBackgroundAtRef = useRef<number | null>(null);
  const lastAppOpenShownAtRef = useRef(0);
  const successfulSaveCountRef = useRef(0);
  const rewardedEarnedRef = useRef(false);
  const rewardedResolveRef = useRef<((value: boolean) => void) | null>(null);

  const loadPrefs = useCallback(async (): Promise<boolean> => {
    try {
      const v = await AsyncStorage.getItem(AUTO_SAVE_KEY);
      const on = v === '1';
      setAutoSave(on);
      return on;
    } catch {
      return false;
    }
  }, []);

  const loadStatuses = useCallback(async () => {
    if (!native) return;
    const list = await native.getStatusFiles();
    list.sort((a, b) => b.modified - a.modified);
    setItems(list);
    return list;
  }, [native]);

  const loadSaved = useCallback(async () => {
    if (!native) return;
    const list = await native.getSavedFiles();
    setSavedItems(list);
  }, [native]);

  const refreshCustomFolders = useCallback(async () => {
    if (!native?.getCustomStatusFolders) {
      if (native?.getCustomStatusFolder) {
        try {
          const r = await native.getCustomStatusFolder();
          setCustomFolders({ whatsapp: r, business: EMPTY_CUSTOM_FOLDER });
        } catch {
          setCustomFolders({ whatsapp: EMPTY_CUSTOM_FOLDER, business: EMPTY_CUSTOM_FOLDER });
        }
      }
      return;
    }
    try {
      const r = await native.getCustomStatusFolders();
      setCustomFolders({
        whatsapp: r.whatsapp ?? EMPTY_CUSTOM_FOLDER,
        business: r.business ?? EMPTY_CUSTOM_FOLDER,
      });
    } catch {
      setCustomFolders({ whatsapp: EMPTY_CUSTOM_FOLDER, business: EMPTY_CUSTOM_FOLDER });
    }
  }, [native]);

  const runAutoSave = useCallback(
    async (list: StatusFile[], forceRun = false) => {
      if (!native || !list.length) return;
      const enabled = forceRun || (await readAutoSaveEnabled());
      if (!enabled) return;
      const registry = await loadSaveRegistry();
      let changed = false;
      for (const f of list) {
        const result = await saveStatusIfNew(native, f, registry);
        if (result === 'saved') {
          changed = true;
        }
      }
      if (changed) {
        await persistSaveRegistry(registry);
        await loadSaved();
      }
    },
    [native, loadSaved],
  );

  const persistAutoSave = useCallback(
    async (v: boolean) => {
      await AsyncStorage.setItem(AUTO_SAVE_KEY, v ? '1' : '0');
      setAutoSave(v);
      if (v && native && permissionOk) {
        const list = await loadStatuses();
        await loadSaved();
        if (list) {
          await runAutoSave(list, true);
        }
      }
    },
    [native, permissionOk, loadStatuses, loadSaved, runAutoSave],
  );

  const bootstrap = useCallback(async () => {
    if (!native) {
      setLoading(false);
      return;
    }
    try {
      const ok = await requestAndroidMediaPermission();
      setPermissionOk(ok);
      if (!ok) {
        return;
      }
      await loadPrefs();
      const list = await loadStatuses();
      await loadSaved();
      if (list) await runAutoSave(list);
      await refreshCustomFolders();
    } catch {
      /* Native module errors should not leave the UI stuck on Loading */
    } finally {
      setLoading(false);
    }
  }, [native, loadPrefs, loadStatuses, loadSaved, runAutoSave, refreshCustomFolders]);

  useEffect(() => {
    bootstrap();
  }, [bootstrap]);

  useEffect(() => {
    mobileAds().initialize().catch(() => {
      /* ignore ads init failure */
    });
  }, []);

  useEffect(() => {
    const ad = appOpenRef.current;
    const onLoaded = ad.addAdEventListener(AdEventType.LOADED, () => setAppOpenLoaded(true));
    const onClosed = ad.addAdEventListener(AdEventType.CLOSED, () => {
      setAppOpenLoaded(false);
      ad.load();
    });
    const onError = ad.addAdEventListener(AdEventType.ERROR, () => {
      setAppOpenLoaded(false);
    });
    ad.load();
    return () => {
      onLoaded();
      onClosed();
      onError();
    };
  }, []);

  const showAppOpenIfReady = useCallback((): boolean => {
    if (loading || !appOpenLoaded) {
      return false;
    }
    const now = Date.now();
    if (now - lastAppOpenShownAtRef.current < 30_000) {
      return false;
    }
    try {
      appOpenRef.current.show();
      lastAppOpenShownAtRef.current = now;
      return true;
    } catch {
      return false;
    }
  }, [loading, appOpenLoaded]);

  useEffect(() => {
    if (appOpenShownRef.current) {
      return;
    }
    const shown = showAppOpenIfReady();
    if (shown) {
      appOpenShownRef.current = true;
    }
  }, [showAppOpenIfReady]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (next: AppStateStatus) => {
      const prev = appOpenStateRef.current;
      appOpenStateRef.current = next;
      if (next.match(/inactive|background/)) {
        lastBackgroundAtRef.current = Date.now();
        return;
      }
      if (!prev.match(/inactive|background/) || next !== 'active') {
        return;
      }
      const backgroundedAt = lastBackgroundAtRef.current;
      if (!backgroundedAt) {
        return;
      }
      if (Date.now() - backgroundedAt < APP_OPEN_RESUME_MIN_MS) {
        return;
      }
      showAppOpenIfReady();
    });
    return () => sub.remove();
  }, [showAppOpenIfReady]);

  useEffect(() => {
    const ad = interstitialRef.current;
    const onLoaded = ad.addAdEventListener(AdEventType.LOADED, () => setInterstitialLoaded(true));
    const onClosed = ad.addAdEventListener(AdEventType.CLOSED, () => {
      setInterstitialLoaded(false);
      ad.load();
    });
    const onError = ad.addAdEventListener(AdEventType.ERROR, () => {
      setInterstitialLoaded(false);
    });
    ad.load();
    return () => {
      onLoaded();
      onClosed();
      onError();
    };
  }, []);

  useEffect(() => {
    const ad = rewardedRef.current;
    const onLoaded = ad.addAdEventListener(RewardedAdEventType.LOADED, () => setRewardedLoaded(true));
    const onEarned = ad.addAdEventListener(RewardedAdEventType.EARNED_REWARD, () => {
      rewardedEarnedRef.current = true;
      setHdUnlocked(true);
    });
    const onClosed = ad.addAdEventListener(AdEventType.CLOSED, () => {
      setRewardedLoaded(false);
      const earned = rewardedEarnedRef.current;
      rewardedEarnedRef.current = false;
      if (rewardedResolveRef.current) {
        rewardedResolveRef.current(earned);
        rewardedResolveRef.current = null;
      }
      ad.load();
    });
    const onError = ad.addAdEventListener(AdEventType.ERROR, () => {
      setRewardedLoaded(false);
      if (rewardedResolveRef.current) {
        rewardedResolveRef.current(false);
        rewardedResolveRef.current = null;
      }
      ad.load();
    });
    ad.load();
    return () => {
      onLoaded();
      onEarned();
      onClosed();
      onError();
    };
  }, []);

  const maybeShowInterstitial = useCallback(() => {
    successfulSaveCountRef.current += 1;
    if (successfulSaveCountRef.current < INTERSTITIAL_EVERY_N_SAVES) {
      return;
    }
    successfulSaveCountRef.current = 0;
    if (interstitialLoaded) {
      interstitialRef.current.show();
    }
  }, [interstitialLoaded]);

  const ensureHdUnlocked = useCallback(async (): Promise<boolean> => {
    if (hdUnlocked) {
      return true;
    }
    if (!rewardedLoaded) {
      rewardedRef.current.load();
      Alert.alert('HD locked', 'Rewarded ad is not ready yet. Please try again in a few seconds.');
      return false;
    }
    rewardedEarnedRef.current = false;
    return new Promise<boolean>(resolve => {
      rewardedResolveRef.current = resolve;
      rewardedRef.current.show();
    });
  }, [hdUnlocked, rewardedLoaded]);

  const appStateRef = useRef<AppStateStatus>(AppState.currentState);
  useEffect(() => {
    if (!native || !permissionOk) {
      return;
    }
    const sub = AppState.addEventListener('change', (next: AppStateStatus) => {
      const prev = appStateRef.current;
      appStateRef.current = next;
      if (!prev.match(/inactive|background/) || next !== 'active') {
        return;
      }
      const handleAppActive = async () => {
        const list = await loadStatuses();
        await loadSaved();
        if (list) await runAutoSave(list);
      };
      handleAppActive().catch(() => {
        /* ignore resume refresh errors */
      });
    });
    return () => sub.remove();
  }, [native, permissionOk, loadStatuses, loadSaved, runAutoSave]);

  useEffect(() => {
    if (!native || !permissionOk || items.length > 0) {
      if (items.length > 0) {
        setFolderHint(null);
      }
      return;
    }
    const report = native.getFolderScanReport;
    if (!report) {
      return;
    }
    let cancelled = false;
    report()
      .then(rows => {
        if (cancelled) {
          return;
        }
        const existing = rows.filter(r => r.exists).length;
        const withMedia = rows.filter(r => r.exists && r.mediaCount > 0).length;
        setFolderHint(
          `Checked ${rows.length} status folders (${existing} found on device, ${withMedia} with files). Open Statuses in your chat app, then pull down to refresh.`,
        );
      })
      .catch(() => {
        if (!cancelled) {
          setFolderHint(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [native, permissionOk, items.length]);

  const onRefresh = useCallback(async () => {
    if (!native || !permissionOk) return;
    setRefreshing(true);
    try {
      const list = await loadStatuses();
      await loadSaved();
      if (list) await runAutoSave(list);
      await refreshCustomFolders();
    } finally {
      setRefreshing(false);
    }
  }, [native, permissionOk, loadStatuses, loadSaved, runAutoSave, refreshCustomFolders]);

  const pickCustomFolder = useCallback(
    async (slot: FolderSlot) => {
      if (!native) {
        return;
      }
      try {
        if (slot === 'business' && native.pickBusinessStatusFolder) {
          await native.pickBusinessStatusFolder();
        } else if (slot === 'whatsapp' && native.pickWhatsAppStatusFolder) {
          await native.pickWhatsAppStatusFolder();
        } else if (native.pickCustomStatusFolder) {
          await native.pickCustomStatusFolder(slot);
        } else {
          return;
        }
        const list = await loadStatuses();
        await loadSaved();
        if (list) await runAutoSave(list);
        await refreshCustomFolders();
      } catch (e: unknown) {
        const msg =
          e instanceof Error
            ? e.message
            : e && typeof e === 'object' && 'message' in e
              ? String((e as { message: unknown }).message)
              : String(e);
        if (/E_CANCELLED|cancelled/i.test(msg)) {
          return;
        }
        Alert.alert(/E_WRONG_FOLDER/i.test(msg) ? 'Wrong folder' : 'Folder', msg);
      }
    },
    [native, loadStatuses, loadSaved, runAutoSave, refreshCustomFolders],
  );

  const clearCustomFolder = useCallback(
    async (slot: FolderSlot) => {
      if (!native) {
        return;
      }
      try {
        if (slot === 'business' && native.clearBusinessStatusFolder) {
          await native.clearBusinessStatusFolder();
        } else if (slot === 'whatsapp' && native.clearWhatsAppStatusFolder) {
          await native.clearWhatsAppStatusFolder();
        } else if (native.clearCustomStatusFolder) {
          await native.clearCustomStatusFolder(slot);
        } else {
          return;
        }
        await loadStatuses();
        await refreshCustomFolders();
      } catch (e) {
        Alert.alert('Error', String(e));
      }
    },
    [native, loadStatuses, refreshCustomFolders],
  );

  const filtered = useMemo(() => {
    if (tab === 'saved') return savedItems;
    if (tab === 'images') return items.filter(i => !i.isVideo);
    return items.filter(i => i.isVideo);
  }, [tab, items, savedItems]);

  const toggleSelect = useCallback((path: string) => {
    setSelection(prev => {
      const n = new Set(prev);
      if (n.has(path)) n.delete(path);
      else n.add(path);
      return n;
    });
  }, []);

  const clearSelection = useCallback(() => {
    setSelection(new Set());
    setSelectionMode(false);
  }, []);

  const allVisibleSelected =
    filtered.length > 0 && filtered.every(f => selection.has(f.path));

  const toggleSelectAllVisible = useCallback(() => {
    if (filtered.length === 0) {
      return;
    }
    setSelectionMode(true);
    setSelection(prev => {
      const allSelected = filtered.every(f => prev.has(f.path));
      if (allSelected) {
        return new Set();
      }
      return new Set(filtered.map(f => f.path));
    });
  }, [filtered]);

  const downloadOne = useCallback(
    async (f: StatusFile, hdMode = false) => {
      if (!native) return;
      try {
        const registry = await loadSaveRegistry();
        const result = await saveStatusIfNew(native, f, registry, { scanMedia: true });
        if (result === 'duplicate') {
          Alert.alert('Already saved', 'This status is already in your gallery.');
          return;
        }
        if (result === 'failed') {
          Alert.alert('Error', 'Could not save this status.');
          return;
        }
        await persistSaveRegistry(registry);
        await loadSaved();
        maybeShowInterstitial();
        Alert.alert(
          'Saved',
          hdMode ? 'HD download saved to gallery.' : 'Saved to gallery (Pictures or Movies / StatusSaver).',
        );
      } catch (e) {
        Alert.alert('Error', String(e));
      }
    },
    [native, loadSaved, maybeShowInterstitial],
  );

  const downloadHdWithReward = useCallback(
    async (f: StatusFile) => {
      const unlocked = await ensureHdUnlocked();
      if (!unlocked) {
        return;
      }
      await downloadOne(f, true);
    },
    [downloadOne, ensureHdUnlocked],
  );

  const downloadSelected = useCallback(async () => {
    if (!native || selection.size === 0) return;
    try {
      const registry = await loadSaveRegistry();
      let saved = 0;
      let skipped = 0;
      let failed = 0;
      for (const path of selection) {
        const f = items.find(i => i.path === path) ?? savedItems.find(i => i.path === path);
        if (!f) continue;
        const result = await saveStatusIfNew(native, f, registry, { scanMedia: true });
        if (result === 'saved') {
          saved += 1;
          maybeShowInterstitial();
        } else if (result === 'duplicate') {
          skipped += 1;
        } else {
          failed += 1;
        }
      }
      if (saved > 0) {
        await persistSaveRegistry(registry);
      }
      await loadSaved();
      clearSelection();
      if (saved === 0 && skipped > 0 && failed === 0) {
        Alert.alert('Already saved', 'All selected items were saved before.');
      } else if (failed > 0 && saved === 0) {
        Alert.alert('Error', 'Could not save the selected items.');
      } else {
        const parts: string[] = [];
        if (saved > 0) parts.push(`${saved} saved`);
        if (skipped > 0) parts.push(`${skipped} already saved`);
        if (failed > 0) parts.push(`${failed} failed`);
        Alert.alert('Done', parts.join(', ') + '.');
      }
    } catch (e) {
      Alert.alert('Error', String(e));
    }
  }, [native, selection, items, savedItems, loadSaved, clearSelection, maybeShowInterstitial]);

  const removeSelectedSaved = useCallback(async () => {
    if (!native || selection.size === 0 || tab !== 'saved') return;
    const n = selection.size;
    Alert.alert('Remove from Saved', `Remove ${n} item(s) from Saved in this app?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: async () => {
          try {
            for (const path of selection) {
              await native.removeSaved(path);
            }
            await loadSaved();
            clearSelection();
          } catch (e) {
            Alert.alert('Error', String(e));
          }
        },
      },
    ]);
  }, [native, selection, tab, loadSaved, clearSelection]);

  const deleteSelectedStatuses = useCallback(async () => {
    if (!native || selection.size === 0 || tab === 'saved') return;
    const n = selection.size;
    Alert.alert(
      'Delete status files',
      `Permanently delete ${n} file(s) from the status folder on this device? This cannot be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            try {
              for (const path of selection) {
                await native.deleteStatusMedia(path);
              }
              clearSelection();
              await loadStatuses();
            } catch (e) {
              Alert.alert('Error', String(e));
            }
          },
        },
      ],
    );
  }, [native, selection, tab, loadStatuses, clearSelection]);

  const shareOne = useCallback(
    async (f: StatusFile) => {
      if (!native) return;
      try {
        await native.shareFile(f.path);
      } catch (e) {
        Alert.alert('Error', String(e));
      }
    },
    [native],
  );

  const removeSavedOne = useCallback(
    async (f: StatusFile) => {
      if (!native) return;
      Alert.alert('Remove', 'Remove from Saved in this app?', [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: async () => {
            await native.removeSaved(f.path);
            await loadSaved();
            setPreview(null);
          },
        },
      ]);
    },
    [native, loadSaved],
  );

  if (Platform.OS !== 'android' || !native) {
    return (
      <View style={[styles.center, { backgroundColor: theme.bg, paddingTop: insets.top }]}>
        <Text style={[styles.title, { color: theme.text }]}> Status Saver - Video</Text>
        <Text style={[styles.hint, { color: theme.muted }]}>
          This app reads status media from your device on Android only.
        </Text>
      </View>
    );
  }

  if (loading) {
    return (
      <View style={[styles.center, { backgroundColor: theme.bg, paddingTop: insets.top }]}>
        <ActivityIndicator size="large" color={theme.accent} />
        <Text style={[styles.hint, styles.marginTop12, { color: theme.muted }]}>Loading…</Text>
      </View>
    );
  }

  if (!permissionOk) {
    return (
      <View style={[styles.center, styles.centerWide, { backgroundColor: theme.bg, paddingTop: insets.top }]}>
        <Text style={[styles.title, { color: theme.text }]}>Permission needed</Text>
        <Text style={[styles.hint, styles.permissionHint, { color: theme.muted }]}>
          Allow Photos and Videos access so the app can list status media stored on your device. On Android 14+, choose
          &quot;Allow all&quot; if asked, not only selected photos—status files live outside your camera roll.
        </Text>
        <Pressable
          style={[styles.primaryBtn, styles.primaryBtnTop, { backgroundColor: theme.accent }]}
          onPress={() => bootstrap()}>
          <Text style={styles.primaryBtnText}>Grant permission</Text>
        </Pressable>
        <Pressable
          style={[styles.smallBtnOutline, styles.permissionSettingsBtn, { borderColor: theme.muted }]}
          onPress={() => {
            Linking.openSettings().catch(() => {
              /* ignore */
            });
          }}>
          <Text style={[styles.smallBtnText, { color: theme.text }]}>Open app settings</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={[styles.root, { backgroundColor: theme.bg, paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Text style={[styles.title, { color: theme.text }]}> Status Saver - Video</Text>
        <View style={styles.autoRow}>
          <Text style={[styles.autoLabel, { color: theme.muted }]}>Auto-save new</Text>
          <Switch value={autoSave} onValueChange={persistAutoSave} trackColor={{ false: '#444', true: theme.accent }} />
        </View>
      </View>

      <View style={[styles.tabs, { backgroundColor: theme.surface }]}>
        {(['images', 'videos', 'saved'] as const).map(id => (
          <Pressable
            key={id}
            style={[styles.tab, tab === id && styles.tabActive, tab === id && { borderBottomColor: theme.accent }]}
            onPress={() => {
              setTab(id);
              clearSelection();
            }}>
            <Text style={[styles.tabText, { color: tab === id ? theme.text : theme.muted }]}>
              {id === 'images' ? 'Images' : id === 'videos' ? 'Videos' : 'Saved'}
            </Text>
          </Pressable>
        ))}
      </View>

      {native.pickWhatsAppStatusFolder || native.pickCustomStatusFolder ? (
        <View style={[styles.folderBar, { backgroundColor: theme.surface }]}>
          <View style={styles.folderBarTextCol}>
            <Text style={[styles.folderBarTitle, { color: theme.text }]}>Not seeing files?</Text>
            <Text style={[styles.folderBarHint, { color: theme.muted }]}>
              Pick one or both .Statuses folders. If both are chosen, statuses from WhatsApp and
              WhatsApp Business are merged in the list.
            </Text>
            {customFolders.whatsapp.set || customFolders.business.set ? (
              <Text style={[styles.folderBarActive, { color: theme.text }]}>
                {[
                  customFolders.whatsapp.set ? 'WA folder selected' : null,
                  customFolders.business.set ? 'BWA folder selected' : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </Text>
            ) : null}
          </View>

          <View style={styles.folderBarBtns}>
            <Pressable
              style={[styles.folderPickBtn, { backgroundColor: theme.accent }]}
              onPress={() => {
                pickCustomFolder('whatsapp').catch(() => {
                  /* handled in callback */
                });
              }}>
              <Text style={styles.smallBtnText}>Choose folder WA</Text>
            </Pressable>
            {customFolders.whatsapp.set ? (
              <Pressable
                style={styles.smallBtnOutline}
                onPress={() => {
                  clearCustomFolder('whatsapp').catch(() => {
                    /* handled in callback */
                  });
                }}>
                <Text style={[styles.smallBtnText, { color: theme.text }]}>Clear WA</Text>
              </Pressable>
            ) : null}
            <Pressable
              style={[styles.folderPickBtn, styles.folderPickBtnBusiness]}
              onPress={() => {
                pickCustomFolder('business').catch(() => {
                  /* handled in callback */
                });
              }}>
              <Text style={styles.smallBtnText}>Choose folder BWA</Text>
            </Pressable>
            {customFolders.business.set ? (
              <Pressable
                style={styles.smallBtnOutline}
                onPress={() => {
                  clearCustomFolder('business').catch(() => {
                    /* handled in callback */
                  });
                }}>
                <Text style={[styles.smallBtnText, { color: theme.text }]}>Clear BWA</Text>
              </Pressable>
            ) : null}
          </View>
        </View>
      ) : null}

      {selectionMode && (
        <View style={[styles.bar, { backgroundColor: theme.surface }]}>
          <Text style={[styles.barCount, { color: theme.text }]}>{selection.size} selected</Text>
          <View style={styles.barActions}>
            {filtered.length > 0 ? (
              <Pressable
                onPress={toggleSelectAllVisible}
                style={[styles.barBtn, styles.smallBtnOutline, styles.selectAllBtn]}>
                <Text style={[styles.barBtnText, { color: theme.text }]}>
                  {allVisibleSelected ? 'Deselect all' : 'Select all'}
                </Text>
              </Pressable>
            ) : null}
            {tab !== 'saved' && selection.size > 0 ? (
              <Pressable
                onPress={downloadSelected}
                style={[styles.barBtn, styles.smallBtn, { backgroundColor: theme.accent }]}>
                <Text style={styles.barBtnText}>Save</Text>
              </Pressable>
            ) : null}
            {selection.size > 0 ? (
              tab === 'saved' ? (
                <Pressable onPress={removeSelectedSaved} style={[styles.barBtn, styles.smallBtn, styles.smallBtnDanger]}>
                  <Text style={styles.barBtnText}>Remove</Text>
                </Pressable>
              ) : (
                <Pressable onPress={deleteSelectedStatuses} style={[styles.barBtn, styles.smallBtn, styles.smallBtnDanger]}>
                  <Text style={styles.barBtnText}>Delete</Text>
                </Pressable>
              )
            ) : null}
            <Pressable onPress={clearSelection} style={[styles.barBtn, styles.smallBtnOutline]}>
              <Text style={[styles.barBtnText, { color: theme.text }]}>Cancel</Text>
            </Pressable>
          </View>
        </View>
      )}

      <FlatList
        data={filtered}
        keyExtractor={item => item.path}
        numColumns={3}
        key={tab === 'saved' ? 'saved' : 'grid'}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.accent} />}
        contentContainerStyle={[
          filtered.length === 0 ? styles.emptyList : styles.grid,
          styles.gridPadBottom,
        ]}
        columnWrapperStyle={styles.gridRow}
        ListEmptyComponent={
          <View style={styles.emptyWrap}>
            {tab === 'saved' ? (
              <Text style={[styles.empty, { color: theme.muted }]}>
                Nothing saved yet. Open Images or Videos and tap Save.
              </Text>
            ) : (
              <Text style={[styles.empty, { color: theme.muted }]}>
                No statuses found. Pull down to refresh, or use Choose folder WA / BWA above.
              </Text>
            )}
            {tab !== 'saved' && folderHint ? (
              <Text style={[styles.emptyHint, { color: theme.muted }]}>{folderHint}</Text>
            ) : null}
          </View>
        }
        renderItem={({ item }) => (
          <Pressable
            style={styles.cell}
            onPress={() => {
              if (selectionMode) toggleSelect(item.path);
              else setPreview(item);
            }}
            onLongPress={() => {
              setSelectionMode(true);
              toggleSelect(item.path);
            }}>
            <View style={[styles.thumbWrap, { backgroundColor: theme.surface }]}>
              {item.isVideo ? (
                <View style={[styles.thumb, styles.videoPlaceholder]}>
                  <Text style={[styles.videoLabel, { color: theme.muted }]}>VIDEO</Text>
                  <View style={styles.playBadge}>
                    <Text style={styles.playText}>▶</Text>
                  </View>
                </View>
              ) : (
                <Image source={{ uri: androidFileUrl(item.path) }} style={styles.thumb} resizeMode="cover" />
              )}
              {selectionMode && (
                <View style={[styles.check, selection.has(item.path) && styles.checkOn]}>
                  {selection.has(item.path) && <Text style={styles.checkMark}>✓</Text>}
                </View>
              )}
            </View>
          </Pressable>
        )}
      />

      <ScrollView style={styles.disclaimer} contentContainerStyle={{ paddingBottom: insets.bottom + 96 }}>
        <Text style={[styles.disclaimerText, { color: theme.muted }]}>
          This app is not affiliated with WhatsApp Inc. Status media is stored temporarily on your device by the chat
          app; we only help you copy it to your gallery. Use content you have rights to share.
        </Text>
      </ScrollView>

      <View style={[styles.adBannerWrap, { backgroundColor: theme.bg, paddingBottom: Math.max(insets.bottom, 6) }]}>
        <BannerAd
          unitId={BANNER_AD_UNIT_ID}
          size={BannerAdSize.ANCHORED_ADAPTIVE_BANNER}
          requestOptions={{ requestNonPersonalizedAdsOnly: true }}
        />
      </View>

      <Modal visible={preview !== null} transparent animationType="fade" onRequestClose={() => setPreview(null)}>
        <View style={styles.modalBackdrop}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setPreview(null)} />
          {preview && (
            <View style={[styles.modalCard, { backgroundColor: theme.surface }]}>
              {preview.isVideo ? (
                <Video
                  source={{ uri: androidFileUrl(preview.path) }}
                  style={styles.modalMedia}
                  resizeMode="contain"
                  controls
                />
              ) : (
                <Image source={{ uri: androidFileUrl(preview.path) }} style={styles.modalMedia} resizeMode="contain" />
              )}
              <View style={styles.modalActions}>
                {tab !== 'saved' && (
                  <Pressable style={[styles.modalBtn, { backgroundColor: theme.accent }]} onPress={() => downloadOne(preview)}>
                    <Text style={styles.modalBtnText}>Save to gallery</Text>
                  </Pressable>
                )}
                {tab !== 'saved' && (
                  <Pressable
                    style={[styles.modalBtn, styles.modalBtnHd]}
                    onPress={() => {
                      downloadHdWithReward(preview).catch(() => {
                        /* handled in callback */
                      });
                    }}>
                    <Text style={styles.modalBtnText}>
                      {hdUnlocked ? 'Save HD (Unlocked)' : 'Unlock HD (Watch Ad)'}
                    </Text>
                  </Pressable>
                )}
                <Pressable style={[styles.modalBtn, { backgroundColor: theme.muted }]} onPress={() => shareOne(preview)}>
                  <Text style={styles.modalBtnText}>Share</Text>
                </Pressable>
                {tab === 'saved' && (
                  <Pressable style={[styles.modalBtn, styles.modalBtnDanger]} onPress={() => removeSavedOne(preview)}>
                    <Text style={styles.modalBtnText}>Remove from Saved</Text>
                  </Pressable>
                )}
                <Pressable style={styles.modalBtnOutline} onPress={() => setPreview(null)}>
                  <Text style={[styles.modalBtnText, { color: theme.text }]}>Close</Text>
                </Pressable>
              </View>
            </View>
          )}
        </View>
      </Modal>
    </View>
  );
}

const darkTheme = {
  bg: '#121212',
  surface: '#1e1e1e',
  text: '#f5f5f5',
  muted: '#9e9e9e',
  accent: '#4caf50',
};

const lightTheme = {
  bg: '#f2f4f7',
  surface: '#ffffff',
  text: '#1a1a1a',
  muted: '#666666',
  accent: '#2e7d32',
};

const styles = StyleSheet.create({
  root: { flex: 1 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24 },
  header: { paddingHorizontal: 16, paddingBottom: 8 },
  title: { fontSize: 22, fontWeight: '700' },
  hint: { fontSize: 15, lineHeight: 22 },
  marginTop12: { marginTop: 12 },
  marginTop10: { marginTop: 10 },
  centerWide: { paddingHorizontal: 24 },
  permissionHint: { textAlign: 'center', marginTop: 8 },
  primaryBtnTop: { marginTop: 20 },
  permissionSettingsBtn: { marginTop: 14, alignSelf: 'center', paddingHorizontal: 20, paddingVertical: 12 },
  autoRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 8 },
  autoLabel: { fontSize: 14 },
  tabs: { flexDirection: 'row', marginHorizontal: 12, borderRadius: 10, overflow: 'hidden', marginBottom: 8 },
  tab: { flex: 1, paddingVertical: 12, alignItems: 'center' },
  tabActive: { borderBottomWidth: 2 },
  tabText: { fontSize: 15, fontWeight: '600' },
  folderBar: {
    flexDirection: 'column',
    marginHorizontal: 12,
    marginBottom: 8,
    padding: 12,
    borderRadius: 10,
    gap: 10,
  },
  folderBarTextCol: { flex: 1 },
  folderBarTitle: { fontSize: 14, fontWeight: '700', marginBottom: 4 },
  folderBarHint: { fontSize: 12, lineHeight: 17 },
  folderBarActive: { fontSize: 12, lineHeight: 17, marginTop: 8, fontWeight: '600' },
  folderBarBtns: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginTop: 10 },
  folderPickBtn: { paddingHorizontal: 14, paddingVertical: 10, borderRadius: 8 },
  folderPickBtnBusiness: { backgroundColor: '#1565c0' },
  bar: {
    flexDirection: 'column',
    alignItems: 'stretch',
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginHorizontal: 12,
    borderRadius: 8,
    marginBottom: 8,
    gap: 10,
  },
  barCount: { fontSize: 15, fontWeight: '700' },
  barActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    alignItems: 'center',
  },
  barBtn: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    minWidth: 72,
    alignItems: 'center',
  },
  barBtnText: { color: '#fff', fontWeight: '600', fontSize: 13 },
  selectAllBtn: { borderColor: '#888' },
  smallBtn: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8 },
  smallBtnDanger: { backgroundColor: '#c62828' },
  smallBtnOutline: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8, borderWidth: 1, borderColor: '#888' },
  smallBtnText: { color: '#fff', fontWeight: '600', fontSize: 14 },
  grid: { paddingHorizontal: GRID_GAP, paddingBottom: 8 },
  gridPadBottom: { paddingBottom: 88 },
  cell: { width: CELL_SIZE, margin: GRID_GAP / 2 },
  thumbWrap: { width: CELL_SIZE, height: CELL_SIZE, borderRadius: 8, overflow: 'hidden' },
  gridRow: { gap: GRID_GAP / 2 },
  thumb: { width: '100%', height: '100%' },
  playBadge: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.25)',
  },
  playText: { color: '#fff', fontSize: 28 },
  check: {
    position: 'absolute',
    top: 6,
    right: 6,
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: 2,
    borderColor: '#fff',
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  checkOn: { backgroundColor: '#4caf50', borderColor: '#4caf50' },
  checkMark: { color: '#fff', fontWeight: '800' },
  emptyList: { flexGrow: 1, justifyContent: 'center', padding: 24 },
  emptyWrap: { paddingHorizontal: 8 },
  empty: { textAlign: 'center', fontSize: 15, lineHeight: 22 },
  emptyHint: { textAlign: 'center', fontSize: 12, lineHeight: 18, marginTop: 12 },
  videoPlaceholder: {
    backgroundColor: '#1a1a1a',
    justifyContent: 'center',
    alignItems: 'center',
  },
  videoLabel: { fontSize: 11, fontWeight: '700', letterSpacing: 1, marginBottom: 4 },
  disclaimer: { maxHeight: 100 },
  disclaimerText: { fontSize: 11, lineHeight: 16, paddingHorizontal: 16, textAlign: 'center' },
  adBannerWrap: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#808080',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 56,
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.85)',
    justifyContent: 'center',
    padding: 16,
  },
  modalCard: { borderRadius: 12, overflow: 'hidden', padding: 8 },
  modalMedia: { width: '100%', height: 320, backgroundColor: '#000' },
  modalActions: { paddingTop: 12, gap: 8 },
  modalBtn: { paddingVertical: 12, borderRadius: 8, alignItems: 'center' },
  modalBtnHd: { backgroundColor: '#7b1fa2' },
  modalBtnDanger: { backgroundColor: '#c62828' },
  modalBtnOutline: { paddingVertical: 12, borderRadius: 8, alignItems: 'center', borderWidth: 1, borderColor: '#888' },
  modalBtnText: { color: '#fff', fontWeight: '600', fontSize: 16 },
  primaryBtn: { paddingHorizontal: 24, paddingVertical: 14, borderRadius: 10 },
  primaryBtnText: { color: '#fff', fontWeight: '700', fontSize: 16 },
});

export default App;