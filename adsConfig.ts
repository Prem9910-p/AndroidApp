import { TestIds } from 'react-native-google-mobile-ads';

type AdUnits = {
  banner: string;
  interstitial: string;
  rewarded: string;
  appOpen: string;
};

// Replace these with your real AdMob ad unit IDs.
const RELEASE_AD_UNITS: AdUnits = {
  banner: 'ca-app-pub-3860862913004469/6451040116',
  interstitial: 'ca-app-pub-3860862913004469/3633305084',
  rewarded: 'ca-app-pub-3860862913004469/5302878891',
  appOpen: 'ca-app-pub-3860862913004469/7569949582',
};

const TEST_AD_UNITS: AdUnits = {
  banner: TestIds.BANNER,
  interstitial: TestIds.INTERSTITIAL,
  rewarded: TestIds.REWARDED,
  appOpen: TestIds.APP_OPEN,
};

/** Placeholder IDs break the ads SDK; use Google test units until real IDs are set. */
// const releaseIdsArePlaceholders = RELEASE_AD_UNITS.banner.includes('xxxxxxxx');

const ACTIVE_AD_UNITS =
  __DEV__ ? TEST_AD_UNITS : RELEASE_AD_UNITS;

export const BANNER_AD_UNIT_ID = ACTIVE_AD_UNITS.banner;
export const INTERSTITIAL_AD_UNIT_ID = ACTIVE_AD_UNITS.interstitial;
export const REWARDED_AD_UNIT_ID = ACTIVE_AD_UNITS.rewarded;
export const APP_OPEN_AD_UNIT_ID = ACTIVE_AD_UNITS.appOpen;
