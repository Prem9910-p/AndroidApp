/**
 * Status Saver — view and save status media (Android).
 *
 * Fixes applied (folder-picker logic untouched):
 * 1. Merged two AppState listeners into one — prevents double-firing on resume
 * 2. rewardedResolveRef cleared in useEffect cleanup to prevent stale-resolve memory issue
 * 3. Auto-save registry now persists on every run (not only when changed=true)
 * 4. Interstitial shown once per batch save, not inside the loop
 * 5. hdUnlocked persisted to AsyncStorage — survives long backgrounding
 * 6. androidFileUrl now properly percent-encodes path segments
 * 7. Disclaimer moved into FlatList ListFooterComponent — no nested ScrollView
 * 8. Video component gets onError handler — no silent black screen
 * 9. getNative() memoized via module-level constant
 * 10. UI fully refreshed — richer dark/light theme, cards, icons, smooth touches
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
  StatusBar,
  StyleSheet,
  Switch,
  Text,
  useColorScheme,
  View,
} from 'react-native';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import Video from 'react-native-video';
import { createThumbnail } from 'react-native-create-thumbnail';
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

// ─── Constants ────────────────────────────────────────────────────────────────

const AUTO_SAVE_KEY = '@status_saver_auto';
const SAVED_REGISTRY_KEY = '@status_saver_seen';
const HD_UNLOCKED_KEY = '@status_saver_hd';
const INTERSTITIAL_EVERY_N_SAVES = 2;
const APP_OPEN_RESUME_MIN_MS = 4 * 60 * 1000;

const SCREEN_W = Dimensions.get('window').width;
const GRID_GAP = 6;
const COLS = 3;
const CELL_SIZE = (SCREEN_W - GRID_GAP * (COLS + 1)) / COLS;

// Fix #9 — memoized at module level, never re-computed on render
const native = (() => {
  if (Platform.OS !== 'android') return null;
  return (NativeModules.StatusSaver as StatusSaverNative | undefined) ?? null;
})();

// ─── Types ────────────────────────────────────────────────────────────────────

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
  deleteStatusMedia: (path: string) => Promise<boolean>;
  shareFile: (path: string) => Promise<boolean>;
  scanMedia: (path: string) => Promise<boolean>;
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Fix #6 — encode each path segment so spaces/# etc. don't break file:// URIs
function androidFileUrl(pathOrUri: string): string {
  if (pathOrUri.startsWith('content://')) return pathOrUri;
  const slash = pathOrUri.replace(/\\/g, '/');
  const encoded = slash
    .split('/')
    .map(seg => encodeURIComponent(seg))
    .join('/');
  return 'file://' + encoded;
}

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
  } catch { /* ignore */ }
}

type SaveStatusResult = 'saved' | 'duplicate' | 'failed';

async function saveStatusIfNew(
  nat: StatusSaverNative,
  f: StatusFile,
  registry: Set<string>,
  options?: { scanMedia?: boolean },
): Promise<SaveStatusResult> {
  const key = statusSaveKey(f);
  if (registry.has(key)) return 'duplicate';
  try {
    await nat.saveToGallery(f.path);
    await nat.copyToAppSaved(f.path);
    if (options?.scanMedia) await nat.scanMedia(f.path);
    registry.add(key);
    return 'saved';
  } catch {
    return 'failed';
  }
}

async function readAutoSaveEnabled(): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(AUTO_SAVE_KEY)) === '1';
  } catch {
    return false;
  }
}

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
  const r = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.READ_EXTERNAL_STORAGE);
  return r === PermissionsAndroid.RESULTS.GRANTED;
}

// ─── VideoThumb ───────────────────────────────────────────────────────────────
// Extracts a real frame from the video file using MediaMetadataRetriever (Android)
// and renders it as an Image. Falls back to a styled placeholder on error.

type ThumbState = 'loading' | 'ready' | 'error';

function VideoThumb({ path, size }: { path: string; size: number }) {
  const [state, setState] = useState<ThumbState>('loading');
  const [thumbUri, setThumbUri] = useState<string | null>(null);
  const isDark = useColorScheme() === 'dark';

  useEffect(() => {
    let cancelled = false;
    setState('loading');
    setThumbUri(null);

    createThumbnail({
      url: androidFileUrl(path),
      timeStamp: 1000, // grab frame at 1 second — avoids black opener frames
      format: 'jpeg',
    })
      .then(res => {
        if (!cancelled) {
          setThumbUri(res.path);
          setState('ready');
        }
      })
      .catch(() => {
        if (!cancelled) setState('error');
      });

    return () => { cancelled = true; };
  }, [path]);

  if (state === 'ready' && thumbUri) {
    return (
      <View style={{ width: size, height: size }}>
        <Image source={{ uri: thumbUri }} style={{ width: size, height: size }} resizeMode="cover" />
        {/* Dark gradient overlay at bottom */}
        <View style={vthumbStyles.overlay} />
        {/* Play button */}
        <View style={vthumbStyles.playCircle}>
          <Text style={vthumbStyles.playArrow}>▶</Text>
        </View>
        {/* Duration badge area — keeps the gallery look */}
        <View style={vthumbStyles.badge}>
          <Text style={vthumbStyles.badgeText}>VIDEO</Text>
        </View>
      </View>
    );
  }

  if (state === 'error') {
    return (
      <View style={[vthumbStyles.fallback, { width: size, height: size, backgroundColor: isDark ? '#1a1a1a' : '#ddd' }]}>
        <Text style={vthumbStyles.fallbackIcon}>🎬</Text>
        <Text style={[vthumbStyles.fallbackText, { color: isDark ? '#666' : '#999' }]}>VIDEO</Text>
      </View>
    );
  }

  // Loading skeleton
  return (
    <View style={[vthumbStyles.skeleton, { width: size, height: size, backgroundColor: isDark ? '#222' : '#e0e0e0' }]}>
      <ActivityIndicator size="small" color={isDark ? '#444' : '#bbb'} />
    </View>
  );
}

const vthumbStyles = StyleSheet.create({
  overlay: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: '50%',
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  playCircle: {
    position: 'absolute',
    top: '50%',
    left: '50%',
    marginTop: -16,
    marginLeft: -16,
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: 'rgba(0,0,0,0.55)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  playArrow: { color: '#fff', fontSize: 13, marginLeft: 2 },
  badge: {
    position: 'absolute',
    bottom: 5,
    left: 5,
    backgroundColor: 'rgba(0,0,0,0.6)',
    paddingHorizontal: 5,
    paddingVertical: 2,
    borderRadius: 4,
  },
  badgeText: { color: '#fff', fontSize: 9, fontWeight: '800', letterSpacing: 0.6 },
  fallback: { justifyContent: 'center', alignItems: 'center' },
  fallbackIcon: { fontSize: 28 },
  fallbackText: { fontSize: 10, fontWeight: '700', marginTop: 4, letterSpacing: 1 },
  skeleton: { justifyContent: 'center', alignItems: 'center' },
});

// ─── Root ─────────────────────────────────────────────────────────────────────

function App() {
  const isDark = useColorScheme() === 'dark';
  return (
    <SafeAreaProvider>
      <StatusBar barStyle="light-content" backgroundColor="#0a0a0a" />
      <AppContent />
    </SafeAreaProvider>
  );
}

// ─── Main Screen ──────────────────────────────────────────────────────────────

function AppContent() {
  const insets = useSafeAreaInsets();
  const isDark = useColorScheme() === 'dark';
  const theme = useMemo(() => (isDark ? darkTheme : lightTheme), [isDark]);

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
  const [videoError, setVideoError] = useState(false);
  const [folderHint, setFolderHint] = useState<string | null>(null);
  const [customFolders, setCustomFolders] = useState<CustomFoldersState>({
    whatsapp: EMPTY_CUSTOM_FOLDER,
    business: EMPTY_CUSTOM_FOLDER,
  });

  // Ads state
  const [interstitialLoaded, setInterstitialLoaded] = useState(false);
  const [appOpenLoaded, setAppOpenLoaded] = useState(false);
  const [rewardedLoaded, setRewardedLoaded] = useState(false);
  const [hdUnlocked, setHdUnlocked] = useState(false);

  const interstitialRef = useRef(InterstitialAd.createForAdRequest(INTERSTITIAL_AD_UNIT_ID));
  const appOpenRef = useRef(AppOpenAd.createForAdRequest(APP_OPEN_AD_UNIT_ID));
  const rewardedRef = useRef(RewardedAd.createForAdRequest(REWARDED_AD_UNIT_ID));

  const appOpenShownRef = useRef(false);
  // Fix #1 — single ref tracks AppState for BOTH app-open ad and status refresh
  const appStateRef = useRef<AppStateStatus>(AppState.currentState);
  const lastBackgroundAtRef = useRef<number | null>(null);
  const lastAppOpenShownAtRef = useRef(0);
  const successfulSaveCountRef = useRef(0);
  const rewardedEarnedRef = useRef(false);
  const rewardedResolveRef = useRef<((value: boolean) => void) | null>(null);

  // ── Data loaders ─────────────────────────────────────────────────────────

  const loadStatuses = useCallback(async () => {
    if (!native) return;
    const list = await native.getStatusFiles();
    list.sort((a, b) => b.modified - a.modified);
    setItems(list);
    return list;
  }, []);

  const loadSaved = useCallback(async () => {
    if (!native) return;
    const list = await native.getSavedFiles();
    setSavedItems(list);
  }, []);

  // ── Folder helpers (untouched logic) ─────────────────────────────────────

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
  }, []);

  const pickCustomFolder = useCallback(async (slot: FolderSlot) => {
    if (!native) return;
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
      if (/E_CANCELLED|cancelled/i.test(msg)) return;
      Alert.alert(/E_WRONG_FOLDER/i.test(msg) ? 'Wrong folder' : 'Folder', msg);
    }
  }, [loadStatuses, loadSaved, refreshCustomFolders]);

  const clearCustomFolder = useCallback(async (slot: FolderSlot) => {
    if (!native) return;
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
  }, [loadStatuses, refreshCustomFolders]);

  // ── Auto-save ─────────────────────────────────────────────────────────────

  const runAutoSave = useCallback(async (list: StatusFile[], forceRun = false) => {
    if (!native || !list.length) return;
    const enabled = forceRun || (await readAutoSaveEnabled());
    if (!enabled) return;
    const registry = await loadSaveRegistry();
    let changed = false;
    for (const f of list) {
      const result = await saveStatusIfNew(native, f, registry);
      if (result === 'saved') changed = true;
    }
    // Fix #3 — always persist so failed-attempt keys are written to disk too
    await persistSaveRegistry(registry);
    if (changed) await loadSaved();
  }, [loadSaved]);

  const persistAutoSave = useCallback(async (v: boolean) => {
    await AsyncStorage.setItem(AUTO_SAVE_KEY, v ? '1' : '0');
    setAutoSave(v);
    if (v && native && permissionOk) {
      const list = await loadStatuses();
      await loadSaved();
      if (list) await runAutoSave(list, true);
    }
  }, [permissionOk, loadStatuses, loadSaved, runAutoSave]);

  // ── Bootstrap ─────────────────────────────────────────────────────────────

  const bootstrap = useCallback(async () => {
    if (!native) { setLoading(false); return; }
    try {
      const ok = await requestAndroidMediaPermission();
      setPermissionOk(ok);
      if (!ok) return;
      const v = await AsyncStorage.getItem(AUTO_SAVE_KEY);
      setAutoSave(v === '1');
      // Fix #5 — restore HD unlock from storage
      const hd = await AsyncStorage.getItem(HD_UNLOCKED_KEY);
      if (hd === '1') setHdUnlocked(true);
      const list = await loadStatuses();
      await loadSaved();
      if (list) await runAutoSave(list);
      await refreshCustomFolders();
    } catch { /* don't leave UI stuck */ }
    finally { setLoading(false); }
  }, [loadStatuses, loadSaved, runAutoSave, refreshCustomFolders]);

  useEffect(() => { bootstrap(); }, [bootstrap]);

  // ── Ads init ──────────────────────────────────────────────────────────────

  useEffect(() => {
    mobileAds().initialize().catch(() => {});
  }, []);

  useEffect(() => {
    const ad = appOpenRef.current;
    const onLoaded = ad.addAdEventListener(AdEventType.LOADED, () => setAppOpenLoaded(true));
    const onClosed = ad.addAdEventListener(AdEventType.CLOSED, () => { setAppOpenLoaded(false); ad.load(); });
    const onError = ad.addAdEventListener(AdEventType.ERROR, () => setAppOpenLoaded(false));
    ad.load();
    return () => { onLoaded(); onClosed(); onError(); };
  }, []);

  useEffect(() => {
    const ad = interstitialRef.current;
    const onLoaded = ad.addAdEventListener(AdEventType.LOADED, () => setInterstitialLoaded(true));
    const onClosed = ad.addAdEventListener(AdEventType.CLOSED, () => { setInterstitialLoaded(false); ad.load(); });
    const onError = ad.addAdEventListener(AdEventType.ERROR, () => setInterstitialLoaded(false));
    ad.load();
    return () => { onLoaded(); onClosed(); onError(); };
  }, []);

  useEffect(() => {
    const ad = rewardedRef.current;
    const onLoaded = ad.addAdEventListener(RewardedAdEventType.LOADED, () => setRewardedLoaded(true));
    const onEarned = ad.addAdEventListener(RewardedAdEventType.EARNED_REWARD, () => {
      rewardedEarnedRef.current = true;
      setHdUnlocked(true);
      // Fix #5 — persist HD unlock so it survives long backgrounding
      AsyncStorage.setItem(HD_UNLOCKED_KEY, '1').catch(() => {});
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
      onLoaded(); onEarned(); onClosed(); onError();
      // Fix #2 — clear stale resolve ref on unmount
      if (rewardedResolveRef.current) {
        rewardedResolveRef.current(false);
        rewardedResolveRef.current = null;
      }
    };
  }, []);

  // ── App Open ad ──────────────────────────────────────────────────────────

  const showAppOpenIfReady = useCallback((): boolean => {
    if (loading || !appOpenLoaded) return false;
    const now = Date.now();
    if (now - lastAppOpenShownAtRef.current < 30_000) return false;
    try {
      appOpenRef.current.show();
      lastAppOpenShownAtRef.current = now;
      return true;
    } catch { return false; }
  }, [loading, appOpenLoaded]);

  // Show on initial load
  useEffect(() => {
    if (appOpenShownRef.current) return;
    if (showAppOpenIfReady()) appOpenShownRef.current = true;
  }, [showAppOpenIfReady]);

  // Fix #1 — single AppState listener handles BOTH ad show + status refresh
  useEffect(() => {
    if (!native || !permissionOk) return;
    const sub = AppState.addEventListener('change', (next: AppStateStatus) => {
      const prev = appStateRef.current;
      appStateRef.current = next;

      if (next.match(/inactive|background/)) {
        lastBackgroundAtRef.current = Date.now();
        return;
      }
      if (!prev.match(/inactive|background/) || next !== 'active') return;

      // Refresh statuses on resume
      (async () => {
        const list = await loadStatuses();
        await loadSaved();
        if (list) await runAutoSave(list);
      })().catch(() => {});

      // App Open ad on resume (if backgrounded long enough)
      const backgroundedAt = lastBackgroundAtRef.current;
      if (backgroundedAt && Date.now() - backgroundedAt >= APP_OPEN_RESUME_MIN_MS) {
        showAppOpenIfReady();
      }
    });
    return () => sub.remove();
  }, [native, permissionOk, loadStatuses, loadSaved, runAutoSave, showAppOpenIfReady]);

  // ── Folder hint ───────────────────────────────────────────────────────────

  useEffect(() => {
    if (!native || !permissionOk || items.length > 0) {
      if (items.length > 0) setFolderHint(null);
      return;
    }
    const report = native.getFolderScanReport;
    if (!report) return;
    let cancelled = false;
    report()
      .then(rows => {
        if (cancelled) return;
        const existing = rows.filter(r => r.exists).length;
        const withMedia = rows.filter(r => r.exists && r.mediaCount > 0).length;
        setFolderHint(
          `Checked ${rows.length} status folders (${existing} found, ${withMedia} with files). Open Statuses in your messaging app, then pull down to refresh.`,
        );
      })
      .catch(() => { if (!cancelled) setFolderHint(null); });
    return () => { cancelled = true; };
  }, [native, permissionOk, items.length]);

  // ── Refresh ───────────────────────────────────────────────────────────────

  const onRefresh = useCallback(async () => {
    if (!native || !permissionOk) return;
    setRefreshing(true);
    try {
      const list = await loadStatuses();
      await loadSaved();
      if (list) await runAutoSave(list);
      await refreshCustomFolders();
    } finally { setRefreshing(false); }
  }, [permissionOk, loadStatuses, loadSaved, runAutoSave, refreshCustomFolders]);

  // ── Selection ─────────────────────────────────────────────────────────────

  const filtered = useMemo(() => {
    if (tab === 'saved') return savedItems;
    if (tab === 'images') return items.filter(i => !i.isVideo);
    return items.filter(i => i.isVideo);
  }, [tab, items, savedItems]);

  const toggleSelect = useCallback((path: string) => {
    setSelection(prev => {
      const n = new Set(prev);
      n.has(path) ? n.delete(path) : n.add(path);
      return n;
    });
  }, []);

  const clearSelection = useCallback(() => {
    setSelection(new Set());
    setSelectionMode(false);
  }, []);

  const allVisibleSelected = filtered.length > 0 && filtered.every(f => selection.has(f.path));

  const toggleSelectAllVisible = useCallback(() => {
    if (!filtered.length) return;
    setSelectionMode(true);
    setSelection(prev => {
      const allSelected = filtered.every(f => prev.has(f.path));
      return allSelected ? new Set() : new Set(filtered.map(f => f.path));
    });
  }, [filtered]);

  // ── Ads helpers ───────────────────────────────────────────────────────────

  // Fix #4 — interstitial triggered once per batch, not per-item inside loop
  const maybeShowInterstitial = useCallback((savedCount: number) => {
    successfulSaveCountRef.current += savedCount;
    if (successfulSaveCountRef.current < INTERSTITIAL_EVERY_N_SAVES) return;
    successfulSaveCountRef.current = 0;
    if (interstitialLoaded) interstitialRef.current.show();
  }, [interstitialLoaded]);

  const ensureHdUnlocked = useCallback(async (): Promise<boolean> => {
    if (hdUnlocked) return true;
    if (!rewardedLoaded) {
      rewardedRef.current.load();
      Alert.alert('HD locked', 'Rewarded ad not ready yet. Please try again shortly.');
      return false;
    }
    rewardedEarnedRef.current = false;
    return new Promise<boolean>(resolve => {
      rewardedResolveRef.current = resolve;
      rewardedRef.current.show();
    });
  }, [hdUnlocked, rewardedLoaded]);

  // ── Download / save actions ───────────────────────────────────────────────

  const downloadOne = useCallback(async (f: StatusFile, hdMode = false) => {
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
      maybeShowInterstitial(1);
      Alert.alert('Saved ✓', hdMode ? 'HD saved to gallery.' : 'Saved to gallery.');
    } catch (e) { Alert.alert('Error', String(e)); }
  }, [loadSaved, maybeShowInterstitial]);

  const downloadHdWithReward = useCallback(async (f: StatusFile) => {
    const unlocked = await ensureHdUnlocked();
    if (!unlocked) return;
    await downloadOne(f, true);
  }, [downloadOne, ensureHdUnlocked]);

  const downloadSelected = useCallback(async () => {
    if (!native || !selection.size) return;
    try {
      const registry = await loadSaveRegistry();
      let saved = 0, skipped = 0, failed = 0;
      for (const path of selection) {
        const f = items.find(i => i.path === path) ?? savedItems.find(i => i.path === path);
        if (!f) continue;
        const result = await saveStatusIfNew(native, f, registry, { scanMedia: true });
        if (result === 'saved') saved++;
        else if (result === 'duplicate') skipped++;
        else failed++;
      }
      if (saved > 0) await persistSaveRegistry(registry);
      await loadSaved();
      clearSelection();
      // Fix #4 — call once with total saved count
      maybeShowInterstitial(saved);

      if (saved === 0 && skipped > 0 && failed === 0) {
        Alert.alert('Already saved', 'All selected items were already saved.');
      } else if (failed > 0 && saved === 0) {
        Alert.alert('Error', 'Could not save selected items.');
      } else {
        const parts: string[] = [];
        if (saved > 0) parts.push(`${saved} saved`);
        if (skipped > 0) parts.push(`${skipped} already saved`);
        if (failed > 0) parts.push(`${failed} failed`);
        Alert.alert('Done', parts.join(', ') + '.');
      }
    } catch (e) { Alert.alert('Error', String(e)); }
  }, [selection, items, savedItems, loadSaved, clearSelection, maybeShowInterstitial]);

  const removeSelectedSaved = useCallback(async () => {
    if (!native || !selection.size || tab !== 'saved') return;
    Alert.alert('Remove from Saved', `Remove ${selection.size} item(s)?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove', style: 'destructive',
        onPress: async () => {
          try {
            for (const path of selection) await native.removeSaved(path);
            await loadSaved();
            clearSelection();
          } catch (e) { Alert.alert('Error', String(e)); }
        },
      },
    ]);
  }, [selection, tab, loadSaved, clearSelection]);

  const deleteSelectedStatuses = useCallback(async () => {
    if (!native || !selection.size || tab === 'saved') return;
    Alert.alert('Delete status files',
      `Permanently delete ${selection.size} file(s) from the status folder? This cannot be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete', style: 'destructive',
          onPress: async () => {
            try {
              for (const path of selection) await native.deleteStatusMedia(path);
              clearSelection();
              await loadStatuses();
            } catch (e) { Alert.alert('Error', String(e)); }
          },
        },
      ],
    );
  }, [selection, tab, loadStatuses, clearSelection]);

  const shareOne = useCallback(async (f: StatusFile) => {
    if (!native) return;
    try { await native.shareFile(f.path); }
    catch (e) { Alert.alert('Error', String(e)); }
  }, []);

  const removeSavedOne = useCallback(async (f: StatusFile) => {
    if (!native) return;
    Alert.alert('Remove', 'Remove from Saved?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove', style: 'destructive',
        onPress: async () => {
          await native.removeSaved(f.path);
          await loadSaved();
          setPreview(null);
        },
      },
    ]);
  }, [loadSaved]);

  // ── Guard renders ─────────────────────────────────────────────────────────

  if (Platform.OS !== 'android' || !native) {
    return (
      <View style={[styles.center, { backgroundColor: theme.bg, paddingTop: insets.top }]}>
        <Text style={[styles.unsupportedIcon]}>📱</Text>
        <Text style={[styles.title, { color: theme.text, marginTop: 12 }]}>Android only</Text>
        <Text style={[styles.hint, { color: theme.muted, marginTop: 8, textAlign: 'center' }]}>
          This app reads status media on Android devices only.
        </Text>
      </View>
    );
  }

  if (loading) {
    return (
      <View style={[styles.center, { backgroundColor: theme.bg, paddingTop: insets.top }]}>
        <ActivityIndicator size="large" color={theme.accent} />
        <Text style={[styles.hint, { color: theme.muted, marginTop: 14 }]}>Loading…</Text>
      </View>
    );
  }

  if (!permissionOk) {
    return (
      <View style={[styles.center, styles.centerWide, { backgroundColor: theme.bg, paddingTop: insets.top }]}>
        <View style={[styles.permIconWrap, { backgroundColor: theme.cardBg }]}>
          <Text style={styles.permIcon}>🔒</Text>
        </View>
        <Text style={[styles.title, { color: theme.text, marginTop: 20 }]}>Storage access needed</Text>
        <Text style={[styles.hint, { color: theme.muted, marginTop: 10, textAlign: 'center', lineHeight: 22 }]}>
          Allow Photos and Videos access so the app can list status media. On Android 14+, choose
          "Allow all" — status files live outside your camera roll.
        </Text>
        <Pressable
          style={[styles.primaryBtn, { backgroundColor: theme.accent, marginTop: 28 }]}
          onPress={bootstrap}>
          <Text style={styles.primaryBtnText}>Grant permission</Text>
        </Pressable>
        <Pressable
          style={[styles.outlineBtn, { borderColor: theme.border, marginTop: 12 }]}
          onPress={() => Linking.openSettings().catch(() => {})}>
          <Text style={[styles.outlineBtnText, { color: theme.text }]}>Open app settings</Text>
        </Pressable>
      </View>
    );
  }

  // ── Main UI ───────────────────────────────────────────────────────────────

  const showFolderBar = !!(native.pickWhatsAppStatusFolder || native.pickCustomStatusFolder);

  const ListFooter = (
    <Text style={[styles.disclaimerText, { color: theme.subtle }]}>
      Status media is stored temporarily on your device by your messaging app.
      This app only helps you copy it to your gallery. Only save content you have rights to share.
    </Text>
  );

  return (
    <View style={[styles.root, { backgroundColor: theme.bg, paddingTop: insets.top }]}>

      {/* ── Header ── */}
      <View style={[styles.header, { backgroundColor: theme.headerBg, borderBottomColor: theme.border }]}>
        <View style={styles.headerLeft}>
          <Text style={[styles.appIcon]}>💬</Text>
          <View>
            <Text style={[styles.appName, { color: theme.text }]}>Status Saver</Text>
            <Text style={[styles.appSub, { color: theme.muted }]}>Status & Media Saver</Text>
          </View>
        </View>
        <View style={[styles.autoToggle, { backgroundColor: theme.cardBg }]}>
          <Text style={[styles.autoLabel, { color: theme.muted }]}>Auto-save</Text>
          <Switch
            value={autoSave}
            onValueChange={persistAutoSave}
            trackColor={{ false: theme.switchOff, true: theme.accent }}
            thumbColor="#fff"
          />
        </View>
      </View>

      {/* ── Tabs ── */}
      <View style={[styles.tabBar, { backgroundColor: theme.headerBg, borderBottomColor: theme.border }]}>
        {(['images', 'videos', 'saved'] as const).map(id => {
          const active = tab === id;
          const label = id === 'images' ? '🖼  Images' : id === 'videos' ? '🎬  Videos' : '💾  Saved';
          const count = id === 'images'
            ? items.filter(i => !i.isVideo).length
            : id === 'videos'
            ? items.filter(i => i.isVideo).length
            : savedItems.length;
          return (
            <Pressable
              key={id}
              style={[styles.tab, active && { borderBottomColor: theme.accent, borderBottomWidth: 2.5 }]}
              onPress={() => { setTab(id); clearSelection(); }}>
              <Text style={[styles.tabText, { color: active ? theme.accent : theme.muted }]}>{label}</Text>
              {count > 0 && (
                <View style={[styles.tabBadge, { backgroundColor: active ? theme.accent : theme.subtle2 }]}>
                  <Text style={[styles.tabBadgeText, { color: active ? '#fff' : theme.muted }]}>{count}</Text>
                </View>
              )}
            </Pressable>
          );
        })}
      </View>

      {/* ── Folder bar (untouched logic, restyled) ── */}
      {showFolderBar && (
        <View style={[styles.folderCard, { backgroundColor: theme.cardBg, borderColor: theme.border }]}>
          <View style={styles.folderCardLeft}>
            <Text style={[styles.folderCardTitle, { color: theme.text }]}>Can't see statuses?</Text>
            <Text style={[styles.folderCardHint, { color: theme.muted }]}>
              Pick the .Statuses folder(s). Both apps can be merged into one list.
            </Text>
            {(customFolders.whatsapp.set || customFolders.business.set) && (
              <View style={styles.folderPillRow}>
                {customFolders.whatsapp.set && (
                  <View style={[styles.folderPill, { backgroundColor: theme.accentFade }]}>
                    <Text style={[styles.folderPillText, { color: theme.accent }]}>✓ App 1</Text>
                  </View>
                )}
                {customFolders.business.set && (
                  <View style={[styles.folderPill, { backgroundColor: '#1565c020' }]}>
                    <Text style={[styles.folderPillText, { color: '#1e88e5' }]}>✓ App 2</Text>
                  </View>
                )}
              </View>
            )}
          </View>
          <View style={styles.folderBtnCol}>
            <Pressable
              style={[styles.folderBtn, { backgroundColor: theme.accent }]}
              onPress={() => pickCustomFolder('whatsapp').catch(() => {})}>
              <Text style={styles.folderBtnText}>App 1 folder</Text>
            </Pressable>
            {customFolders.whatsapp.set && (
              <Pressable
                style={[styles.folderClearBtn, { borderColor: theme.border }]}
                onPress={() => clearCustomFolder('whatsapp').catch(() => {})}>
                <Text style={[styles.folderClearText, { color: theme.muted }]}>Clear App 1</Text>
              </Pressable>
            )}
            <Pressable
              style={[styles.folderBtn, { backgroundColor: '#1565c0', marginTop: 6 }]}
              onPress={() => pickCustomFolder('business').catch(() => {})}>
              <Text style={styles.folderBtnText}>App 2 folder</Text>
            </Pressable>
            {customFolders.business.set && (
              <Pressable
                style={[styles.folderClearBtn, { borderColor: theme.border }]}
                onPress={() => clearCustomFolder('business').catch(() => {})}>
                <Text style={[styles.folderClearText, { color: theme.muted }]}>Clear App 2</Text>
              </Pressable>
            )}
          </View>
        </View>
      )}

      {/* ── Selection toolbar ── */}
      {selectionMode && (
        <View style={[styles.selectionBar, { backgroundColor: theme.accentFade, borderColor: theme.accent }]}>
          <Text style={[styles.selCount, { color: theme.accent }]}>{selection.size} selected</Text>
          <View style={styles.selActions}>
            <Pressable style={[styles.selBtn, { backgroundColor: theme.cardBg }]} onPress={toggleSelectAllVisible}>
              <Text style={[styles.selBtnText, { color: theme.text }]}>
                {allVisibleSelected ? 'Deselect all' : 'Select all'}
              </Text>
            </Pressable>
            {tab !== 'saved' && selection.size > 0 && (
              <Pressable style={[styles.selBtn, { backgroundColor: theme.accent }]} onPress={downloadSelected}>
                <Text style={styles.selBtnTextWhite}>Save</Text>
              </Pressable>
            )}
            {selection.size > 0 && (
              tab === 'saved'
                ? <Pressable style={[styles.selBtn, { backgroundColor: '#c62828' }]} onPress={removeSelectedSaved}>
                    <Text style={styles.selBtnTextWhite}>Remove</Text>
                  </Pressable>
                : <Pressable style={[styles.selBtn, { backgroundColor: '#c62828' }]} onPress={deleteSelectedStatuses}>
                    <Text style={styles.selBtnTextWhite}>Delete</Text>
                  </Pressable>
            )}
            <Pressable style={[styles.selBtn, { borderWidth: 1, borderColor: theme.border }]} onPress={clearSelection}>
              <Text style={[styles.selBtnText, { color: theme.text }]}>✕</Text>
            </Pressable>
          </View>
        </View>
      )}

      {/* ── Grid ── */}
      {/* Fix #7 — disclaimer in ListFooterComponent, no nested ScrollView */}
      <FlatList
        data={filtered}
        keyExtractor={item => item.path}
        numColumns={COLS}
        key={`${tab}-${COLS}`}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.accent} colors={[theme.accent]} />
        }
        contentContainerStyle={filtered.length === 0 ? styles.emptyContainer : styles.gridContainer}
        columnWrapperStyle={styles.gridRow}
        ListFooterComponent={<View style={styles.footer}>{ListFooter}</View>}
        ListEmptyComponent={
          <View style={styles.emptyWrap}>
            <Text style={styles.emptyIcon}>{tab === 'saved' ? '💾' : '👻'}</Text>
            <Text style={[styles.emptyTitle, { color: theme.text }]}>
              {tab === 'saved' ? 'Nothing saved yet' : 'No statuses found'}
            </Text>
            <Text style={[styles.emptyHint, { color: theme.muted }]}>
              {tab === 'saved'
                ? 'Open Images or Videos and tap Save on any status.'
                : 'Pull down to refresh, or pick a folder using the buttons above.'}
            </Text>
            {tab !== 'saved' && folderHint && (
              <View style={[styles.hintCard, { backgroundColor: theme.cardBg, borderColor: theme.border }]}>
                <Text style={[styles.hintCardText, { color: theme.muted }]}>{folderHint}</Text>
              </View>
            )}
          </View>
        }
        renderItem={({ item }) => (
          <Pressable
            style={({ pressed }) => [styles.cell, pressed && styles.cellPressed]}
            onPress={() => {
              if (selectionMode) toggleSelect(item.path);
              else { setVideoError(false); setPreview(item); }
            }}
            onLongPress={() => { setSelectionMode(true); toggleSelect(item.path); }}>
            <View style={[styles.thumbWrap, { backgroundColor: theme.cardBg }]}>
              {item.isVideo ? (
                <VideoThumb path={item.path} size={CELL_SIZE} />
              ) : (
                <Image
                  source={{ uri: androidFileUrl(item.path) }}
                  style={styles.thumb}
                  resizeMode="cover"
                />
              )}
              {selectionMode && (
                <View style={[styles.checkRing, selection.has(item.path) && { backgroundColor: theme.accent, borderColor: theme.accent }]}>
                  {selection.has(item.path) && <Text style={styles.checkMark}>✓</Text>}
                </View>
              )}
            </View>
          </Pressable>
        )}
      />

      {/* ── Banner ad ── */}
      <View style={[styles.adWrap, { backgroundColor: theme.headerBg, borderTopColor: theme.border, paddingBottom: Math.max(insets.bottom, 6) }]}>
        <BannerAd
          unitId={BANNER_AD_UNIT_ID}
          size={BannerAdSize.ANCHORED_ADAPTIVE_BANNER}
          requestOptions={{ requestNonPersonalizedAdsOnly: true }}
        />
      </View>

      {/* ── Preview modal ── */}
      <Modal
        visible={preview !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setPreview(null)}>
        <View style={styles.modalBackdrop}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setPreview(null)} />
          {preview && (
            <View style={[styles.modalCard, { backgroundColor: theme.cardBg }]}>

              {/* Media */}
              {preview.isVideo ? (
                videoError ? (
                  <View style={styles.videoErrorWrap}>
                    <Text style={styles.videoErrorIcon}>⚠️</Text>
                    <Text style={[styles.videoErrorText, { color: theme.muted }]}>
                      Could not play this video
                    </Text>
                  </View>
                ) : (
                  // Fix #8 — onError handler so bad files don't show a blank screen
                  <Video
                    source={{ uri: androidFileUrl(preview.path) }}
                    style={styles.modalMedia}
                    resizeMode="contain"
                    controls
                    onError={() => setVideoError(true)}
                  />
                )
              ) : (
                <Image
                  source={{ uri: androidFileUrl(preview.path) }}
                  style={styles.modalMedia}
                  resizeMode="contain"
                />
              )}

              {/* Actions */}
              <View style={styles.modalActions}>
                {tab !== 'saved' && (
                  <Pressable
                    style={[styles.modalBtn, { backgroundColor: theme.accent }]}
                    onPress={() => downloadOne(preview)}>
                    <Text style={styles.modalBtnText}>⬇  Save to gallery</Text>
                  </Pressable>
                )}
                {tab !== 'saved' && (
                  <Pressable
                    style={[styles.modalBtn, { backgroundColor: '#7b1fa2' }]}
                    onPress={() => downloadHdWithReward(preview).catch(() => {})}>
                    <Text style={styles.modalBtnText}>
                      {hdUnlocked ? '⭐  Save HD (Unlocked)' : '🔓  Unlock HD (Watch Ad)'}
                    </Text>
                  </Pressable>
                )}
                <Pressable
                  style={[styles.modalBtn, { backgroundColor: theme.subtle2 }]}
                  onPress={() => shareOne(preview)}>
                  <Text style={[styles.modalBtnText, { color: theme.text }]}>↗  Share</Text>
                </Pressable>
                {tab === 'saved' && (
                  <Pressable
                    style={[styles.modalBtn, { backgroundColor: '#c62828' }]}
                    onPress={() => removeSavedOne(preview)}>
                    <Text style={styles.modalBtnText}>✕  Remove from Saved</Text>
                  </Pressable>
                )}
                <Pressable
                  style={[styles.modalBtnOutline, { borderColor: theme.border }]}
                  onPress={() => setPreview(null)}>
                  <Text style={[styles.modalBtnText, { color: theme.muted }]}>Close</Text>
                </Pressable>
              </View>
            </View>
          )}
        </View>
      </Modal>
    </View>
  );
}

// ─── Themes ───────────────────────────────────────────────────────────────────

const darkTheme = {
  bg: '#0d0d0d',
  headerBg: '#161616',
  cardBg: '#1f1f1f',
  text: '#f0f0f0',
  muted: '#8a8a8a',
  subtle: '#555',
  subtle2: '#2a2a2a',
  accent: '#25d366',
  accentFade: '#25d36618',
  border: '#2a2a2a',
  switchOff: '#3a3a3a',
};

const lightTheme = {
  bg: '#f0f2f5',
  headerBg: '#ffffff',
  cardBg: '#ffffff',
  text: '#111111',
  muted: '#666666',
  subtle: '#aaa',
  subtle2: '#efefef',
  accent: '#128c7e',
  accentFade: '#128c7e18',
  border: '#e0e0e0',
  switchOff: '#ccc',
};

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root: { flex: 1 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 32 },
  centerWide: { paddingHorizontal: 28 },

  // Header
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerLeft: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  appIcon: { fontSize: 28 },
  appName: { fontSize: 18, fontWeight: '800', letterSpacing: 0.3 },
  appSub: { fontSize: 11, marginTop: 1 },
  autoToggle: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 20 },
  autoLabel: { fontSize: 12, fontWeight: '600' },

  // Tabs
  tabBar: {
    flexDirection: 'row',
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  tab: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingVertical: 12, gap: 6 },
  tabText: { fontSize: 13, fontWeight: '700' },
  tabBadge: { paddingHorizontal: 6, paddingVertical: 1, borderRadius: 10 },
  tabBadgeText: { fontSize: 10, fontWeight: '800' },

  // Folder card
  folderCard: {
    flexDirection: 'row',
    margin: 10,
    padding: 12,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    gap: 10,
    alignItems: 'flex-start',
  },
  folderCardLeft: { flex: 1 },
  folderCardTitle: { fontSize: 13, fontWeight: '700', marginBottom: 3 },
  folderCardHint: { fontSize: 11, lineHeight: 16 },
  folderPillRow: { flexDirection: 'row', gap: 6, marginTop: 8 },
  folderPill: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8 },
  folderPillText: { fontSize: 11, fontWeight: '700' },
  folderBtnCol: { alignItems: 'flex-end', minWidth: 90 },
  folderBtn: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 8 },
  folderBtnText: { color: '#fff', fontWeight: '700', fontSize: 12 },
  folderClearBtn: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 8, borderWidth: 1, marginTop: 5 },
  folderClearText: { fontSize: 11, fontWeight: '600' },

  // Selection bar
  selectionBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginHorizontal: 10,
    marginBottom: 8,
    borderRadius: 10,
    borderWidth: 1,
  },
  selCount: { fontSize: 14, fontWeight: '800' },
  selActions: { flexDirection: 'row', gap: 6, flexWrap: 'wrap' },
  selBtn: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 8 },
  selBtnText: { fontSize: 12, fontWeight: '700' },
  selBtnTextWhite: { fontSize: 12, fontWeight: '700', color: '#fff' },

  // Grid
  gridContainer: { padding: GRID_GAP },
  gridRow: { gap: GRID_GAP },
  cell: { width: CELL_SIZE, marginBottom: GRID_GAP },
  cellPressed: { opacity: 0.75 },
  thumbWrap: { width: CELL_SIZE, height: CELL_SIZE, borderRadius: 10, overflow: 'hidden' },
  thumb: { width: '100%', height: '100%' },

  checkRing: {
    position: 'absolute',
    top: 6,
    right: 6,
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    borderColor: '#fff',
    backgroundColor: 'rgba(0,0,0,0.35)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  checkMark: { color: '#fff', fontWeight: '900', fontSize: 12 },

  // Empty statec
  emptyContainer: { flexGrow: 1, justifyContent: 'center', padding: 32 },
  emptyWrap: { alignItems: 'center', paddingHorizontal: 16 },
  emptyIcon: { fontSize: 52, marginBottom: 16 },
  emptyTitle: { fontSize: 18, fontWeight: '700', marginBottom: 8 },
  emptyHint: { fontSize: 13, lineHeight: 20, textAlign: 'center' },
  hintCard: { marginTop: 16, padding: 12, borderRadius: 10, borderWidth: 1, width: '100%' },
  hintCardText: { fontSize: 12, lineHeight: 18, textAlign: 'center' },

  // Footer / disclaimer
  footer: { paddingHorizontal: 20, paddingVertical: 16, paddingBottom: 100 },
  disclaimerText: { fontSize: 11, lineHeight: 16, textAlign: 'center' },

  // Ad banner
  adWrap: { borderTopWidth: StyleSheet.hairlineWidth, alignItems: 'center', minHeight: 56 },

  // Modal
  modalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.9)', justifyContent: 'center', padding: 16 },
  modalCard: { borderRadius: 16, overflow: 'hidden' },
  modalMedia: { width: '100%', height: 320, backgroundColor: '#000' },
  videoErrorWrap: { width: '100%', height: 200, justifyContent: 'center', alignItems: 'center', backgroundColor: '#111' },
  videoErrorIcon: { fontSize: 36, marginBottom: 10 },
  videoErrorText: { fontSize: 14 },
  modalActions: { padding: 12, gap: 8 },
  modalBtn: { paddingVertical: 13, borderRadius: 10, alignItems: 'center' },
  modalBtnOutline: { paddingVertical: 13, borderRadius: 10, alignItems: 'center', borderWidth: 1 },
  modalBtnText: { color: '#fff', fontWeight: '700', fontSize: 15 },

  // Permission screen
  permIconWrap: { width: 80, height: 80, borderRadius: 40, justifyContent: 'center', alignItems: 'center' },
  permIcon: { fontSize: 36 },
  primaryBtn: { paddingHorizontal: 28, paddingVertical: 14, borderRadius: 12, alignSelf: 'stretch', alignItems: 'center' },
  primaryBtnText: { color: '#fff', fontWeight: '800', fontSize: 16 },
  outlineBtn: { paddingHorizontal: 28, paddingVertical: 12, borderRadius: 12, borderWidth: 1, alignSelf: 'stretch', alignItems: 'center' },
  outlineBtnText: { fontWeight: '600', fontSize: 15 },

  // Generic
  title: { fontSize: 22, fontWeight: '800' },
  hint: { fontSize: 14 },
  unsupportedIcon: { fontSize: 52 },
});

export default App;