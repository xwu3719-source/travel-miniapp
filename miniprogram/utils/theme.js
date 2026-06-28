const THEME_STORAGE_KEY = '_st_theme_config';

const DEFAULT_DIY = {
  primary: '#d946ef',
  deep: '#7c3aed',
  start: '#ff8a00',
  end: '#5b6cff'
};

const BUILTIN_THEMES = {
  blue: {
    id: 'blue',
    name: '浅蓝玻璃',
    desc: '干净、轻盈，适合日常使用',
    primary: '#5b9ff5',
    deep: '#357de8',
    start: '#7db9f8',
    end: '#357de8',
    light: '#ecf5ff',
    soft: '#f5f9ff',
    bg: '#f7f8fc',
    card: '#ffffff',
    text: '#1e1e2e',
    secondary: '#6b7280',
    hint: '#9ca3af',
    navBarBg: '#ffffff',
    navBarFront: '#000000',
    tabBarBg: 'rgba(255,255,255,0.88)',
    iconFilter: 'brightness(0) saturate(100%) invert(59%) sepia(34%) saturate(1111%) hue-rotate(178deg) brightness(101%) contrast(93%)'
  },
  neon: {
    id: 'neon',
    name: '霓虹甜心',
    desc: '高饱和渐变，像夜里的发光贴纸',
    primary: '#d946ef',
    deep: '#7c3aed',
    start: '#ff8a00',
    mid: '#ff2bd6',
    end: '#5b6cff',
    light: '#fff0fb',
    soft: '#fff7fd',
    bg: '#fff7fd',
    card: '#ffffff',
    text: '#22172f',
    secondary: '#7b647f',
    hint: '#aa8eac',
    navBarBg: '#ffffff',
    navBarFront: '#000000',
    tabBarBg: 'rgba(255,255,255,0.88)',
    iconFilter: 'brightness(0) saturate(100%) invert(41%) sepia(91%) saturate(2560%) hue-rotate(282deg) brightness(104%) contrast(93%)'
  },
  sunset: {
    id: 'sunset',
    name: '日落胶片',
    desc: '橘粉暖光，适合旅行回忆感',
    primary: '#fb7185',
    deep: '#f97316',
    start: '#fbbf24',
    mid: '#fb7185',
    end: '#a855f7',
    light: '#fff1f2',
    soft: '#fff8ed',
    bg: '#fff8f2',
    card: '#ffffff',
    text: '#2f1f1f',
    secondary: '#805f5f',
    hint: '#ad8b80',
    navBarBg: '#ffffff',
    navBarFront: '#000000',
    tabBarBg: 'rgba(255,255,255,0.88)',
    iconFilter: 'brightness(0) saturate(100%) invert(61%) sepia(76%) saturate(1167%) hue-rotate(315deg) brightness(101%) contrast(97%)'
  },
  night: {
    id: 'night',
    name: '星河暗夜',
    desc: '深色背景配蓝紫光，晚上看更舒服',
    primary: '#60a5fa',
    deep: '#a78bfa',
    start: '#0f172a',
    mid: '#2563eb',
    end: '#c084fc',
    light: '#1e293b',
    soft: '#111827',
    bg: '#0f172a',
    card: '#172033',
    text: '#f8fafc',
    secondary: '#cbd5e1',
    hint: '#94a3b8',
    navBarBg: '#0f172a',
    navBarFront: '#ffffff',
    tabBarBg: 'rgba(15, 23, 42, 0.86)',
    iconFilter: 'brightness(0) saturate(100%) invert(70%) sepia(55%) saturate(1092%) hue-rotate(185deg) brightness(102%) contrast(96%)'
  }
};

const ACCENT_PRESETS = [
  { id: 'candy', name: '糖果粉紫', primary: '#d946ef', deep: '#7c3aed', start: '#ff8a00', end: '#5b6cff' },
  { id: 'cyber', name: '赛博电蓝', primary: '#06b6d4', deep: '#2563eb', start: '#22d3ee', end: '#8b5cf6' },
  { id: 'peach', name: '蜜桃橘粉', primary: '#fb7185', deep: '#f97316', start: '#fbbf24', end: '#ec4899' },
  { id: 'mint', name: '薄荷青绿', primary: '#10b981', deep: '#0d9488', start: '#34d399', end: '#38bdf8' },
  { id: 'grape', name: '葡萄紫光', primary: '#8b5cf6', deep: '#6d28d9', start: '#a78bfa', end: '#ec4899' }
];

function normalizeHex(value, fallback = '#d946ef') {
  const raw = String(value || '').trim();
  const match = raw.match(/^#?([0-9a-fA-F]{6})$/);
  return match ? `#${match[1].toLowerCase()}` : fallback;
}

function hexToRgb(hex) {
  const value = normalizeHex(hex).slice(1);
  return {
    r: parseInt(value.slice(0, 2), 16),
    g: parseInt(value.slice(2, 4), 16),
    b: parseInt(value.slice(4, 6), 16)
  };
}

function rgba(hex, alpha) {
  const rgb = hexToRgb(hex);
  return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})`;
}

function loadThemeConfig() {
  const stored = wx.getStorageSync(THEME_STORAGE_KEY) || {};
  const id = (BUILTIN_THEMES[stored.id] || stored.id === 'diy') ? stored.id : 'blue';
  return {
    id,
    diy: {
      ...DEFAULT_DIY,
      ...(stored.diy || {}),
      primary: normalizeHex(stored.diy && stored.diy.primary, DEFAULT_DIY.primary),
      deep: normalizeHex(stored.diy && stored.diy.deep, DEFAULT_DIY.deep),
      start: normalizeHex(stored.diy && stored.diy.start, DEFAULT_DIY.start),
      end: normalizeHex(stored.diy && stored.diy.end, DEFAULT_DIY.end)
    }
  };
}

function saveThemeConfig(config = {}) {
  const safeId = (BUILTIN_THEMES[config.id] || config.id === 'diy') ? config.id : 'blue';
  const next = {
    id: safeId,
    diy: { ...DEFAULT_DIY, ...(config.diy || {}) }
  };
  wx.setStorageSync(THEME_STORAGE_KEY, next);
  syncAppTheme(next);
  return next;
}

function getTheme(config = loadThemeConfig()) {
  if (config.id === 'diy') {
    const diy = { ...DEFAULT_DIY, ...(config.diy || {}) };
    const primary = normalizeHex(diy.primary);
    const deep = normalizeHex(diy.deep);
    return {
      id: 'diy',
      name: '我的 DIY',
      desc: '自己调出来的专属配色',
      primary,
      deep,
      start: normalizeHex(diy.start),
      end: normalizeHex(diy.end),
      light: rgba(primary, 0.12),
      soft: rgba(primary, 0.08),
      bg: '#fbf8ff',
      card: '#ffffff',
      text: '#22172f',
      secondary: '#75677c',
      hint: '#a494ad',
      navBarBg: '#ffffff',
      navBarFront: '#000000',
      tabBarBg: 'rgba(255,255,255,0.88)',
      iconFilter: BUILTIN_THEMES.neon.iconFilter
    };
  }
  return BUILTIN_THEMES[config.id] || BUILTIN_THEMES.blue;
}

function buildThemeStyle(config = loadThemeConfig()) {
  const theme = getTheme(config);
  const gradient = theme.mid
    ? `linear-gradient(135deg, ${theme.start} 0%, ${theme.mid} 48%, ${theme.end} 100%)`
    : `linear-gradient(135deg, ${theme.start} 0%, ${theme.primary} 52%, ${theme.end} 100%)`;
  const softGradient = `linear-gradient(135deg, ${rgba(theme.primary, 0.10)} 0%, ${rgba(theme.deep, 0.08)} 100%)`;
  return [
    `--trip-blue:${theme.primary}`,
    `--trip-blue-deep:${theme.deep}`,
    `--trip-blue-light:${theme.light}`,
    `--trip-blue-soft:${theme.soft}`,
    `--gradient-trip:${gradient}`,
    `--gradient-trip-soft:${softGradient}`,
    `--gradient-purple:${gradient}`,
    `--purple:${theme.primary}`,
    `--purple-light:${theme.light}`,
    `--blue:${theme.primary}`,
    `--blue-light:${theme.light}`,
    `--bg:${theme.bg}`,
    `--card-bg:${theme.card}`,
    `--text-primary:${theme.text}`,
    `--text-secondary:${theme.secondary}`,
    `--text-hint:${theme.hint}`,
    `--theme-primary:${theme.primary}`,
    `--theme-deep:${theme.deep}`,
    `--theme-icon-filter:${theme.iconFilter}`,
    `--theme-shadow:${rgba(theme.primary, 0.24)}`,
    `--theme-nav-bar-bg:${theme.navBarBg}`,
    `--theme-tab-bar-bg:${theme.tabBarBg}`
  ].join(';');
}

function setNavBarColor(theme) {
  try {
    wx.setNavigationBarColor({
      frontColor: theme.navBarFront || '#000000',
      backgroundColor: theme.navBarBg || '#ffffff',
      animation: { duration: 300, timingFunc: 'easeInOut' }
    });
    wx.setBackgroundColor({
      backgroundColor: theme.bg || '#f7f8fc',
      backgroundColorTop: theme.navBarBg || '#ffffff',
      backgroundColorBottom: theme.bg || '#f7f8fc'
    });
  } catch (_) { /* 非关键 */ }
}

function getThemeState() {
  const config = loadThemeConfig();
  const theme = getTheme(config);
  return {
    themeConfig: config,
    themeId: config.id,
    themeClass: `theme-${config.id || 'blue'}`,
    themeStyle: buildThemeStyle(config),
    themePrimary: theme.primary,
    themeName: theme.name
  };
}

function applyToPage(page) {
  if (!page || !page.setData) return;
  const state = getThemeState();
  page.setData(state);
  // 同步导航栏颜色
  const theme = getTheme(state.themeConfig);
  setNavBarColor(theme);
}

function syncAppTheme(config = loadThemeConfig()) {
  const theme = getTheme(config);
  try {
    const app = getApp();
    if (!app.globalData) app.globalData = {};
    app.globalData.themeConfig = config;
    app.globalData.themeStyle = buildThemeStyle(config);
    app.globalData.themeClass = `theme-${config.id || 'blue'}`;
    // 通知所有已存在的页面和 tab bar
    if (app.broadcastThemeChange) app.broadcastThemeChange();
  } catch (_) {}
  // 更新导航栏
  setNavBarColor(theme);
  // 异步同步到云端
  saveThemeToCloud(config).catch(() => {});
}

// ---- 云端同步 ----
async function saveThemeToCloud(config) {
  try {
    const cloud = require('./cloud');
    await cloud.updateThemeConfig(config);
  } catch (_) { /* 非关键，本地已保存 */ }
}

async function loadThemeFromCloud() {
  try {
    const cloud = require('./cloud');
    const result = await cloud.getThemeConfig();
    if (result && result.themeConfig) {
      const remote = result.themeConfig;
      const local = loadThemeConfig();
      // 云端优先：如果远程有数据且与本地不同，使用云端
      if (remote.id && (remote.id !== local.id ||
        (remote.id === 'diy' && JSON.stringify(remote.diy) !== JSON.stringify(local.diy)))) {
        const merged = { ...local, ...remote, diy: { ...DEFAULT_DIY, ...(remote.diy || {}) } };
        wx.setStorageSync(THEME_STORAGE_KEY, merged);
        return merged;
      }
    }
  } catch (_) { /* 非关键 */ }
  return null;
}

module.exports = {
  BUILTIN_THEMES,
  ACCENT_PRESETS,
  DEFAULT_DIY,
  loadThemeConfig,
  saveThemeConfig,
  getTheme,
  getThemeState,
  buildThemeStyle,
  applyToPage,
  syncAppTheme,
  setNavBarColor,
  saveThemeToCloud,
  loadThemeFromCloud,
  normalizeHex
};
