jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

jest.mock('react-native-google-mobile-ads', () => {
  const mockAd = () => ({
    addAdEventListener: () => () => {},
    load: () => {},
    show: () => {},
  });
  return {
    __esModule: true,
    default: () => Promise.resolve(),
    TestIds: {
      BANNER: 'test-banner',
      INTERSTITIAL: 'test-interstitial',
      REWARDED: 'test-rewarded',
      APP_OPEN: 'test-app-open',
    },
    AdEventType: { LOADED: 'loaded', CLOSED: 'closed', ERROR: 'error' },
    BannerAd: 'BannerAd',
    BannerAdSize: { ANCHORED_ADAPTIVE_BANNER: 'adaptive' },
    AppOpenAd: { createForAdRequest: () => mockAd() },
    InterstitialAd: { createForAdRequest: () => mockAd() },
    RewardedAd: { createForAdRequest: () => mockAd() },
    RewardedAdEventType: { LOADED: 'loaded', EARNED_REWARD: 'earned' },
  };
});
