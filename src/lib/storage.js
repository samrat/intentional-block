import {
  DEFAULT_SETTINGS,
  DEFAULT_SITES,
  MAX_HISTORY_ENTRIES,
  STORAGE_KEYS,
} from './constants.js';
import { isGrantActive, normalizeGrant } from './grants.js';

export async function initializeStorage() {
  const data = await chrome.storage.local.get([
    STORAGE_KEYS.SETTINGS,
    STORAGE_KEYS.SITES,
    STORAGE_KEYS.GRANTS,
    STORAGE_KEYS.HISTORY,
  ]);

  const toSet = {};
  if (!data[STORAGE_KEYS.SETTINGS]) {
    toSet[STORAGE_KEYS.SETTINGS] = { ...DEFAULT_SETTINGS };
  } else {
    toSet[STORAGE_KEYS.SETTINGS] = { ...DEFAULT_SETTINGS, ...data[STORAGE_KEYS.SETTINGS] };
  }
  if (!Array.isArray(data[STORAGE_KEYS.SITES])) {
    toSet[STORAGE_KEYS.SITES] = DEFAULT_SITES.map((s) => ({ ...s, domains: [...s.domains] }));
  }
  if (!data[STORAGE_KEYS.GRANTS] || typeof data[STORAGE_KEYS.GRANTS] !== 'object') {
    toSet[STORAGE_KEYS.GRANTS] = {};
  }
  if (!Array.isArray(data[STORAGE_KEYS.HISTORY])) {
    toSet[STORAGE_KEYS.HISTORY] = [];
  }

  if (Object.keys(toSet).length > 0) {
    await chrome.storage.local.set(toSet);
  }
}

export async function getSettings() {
  const data = await chrome.storage.local.get(STORAGE_KEYS.SETTINGS);
  return { ...DEFAULT_SETTINGS, ...(data[STORAGE_KEYS.SETTINGS] || {}) };
}

export async function saveSettings(partial) {
  const current = await getSettings();
  const next = { ...current, ...partial };
  await chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: next });
  return next;
}

export async function getSites() {
  const data = await chrome.storage.local.get(STORAGE_KEYS.SITES);
  if (!Array.isArray(data[STORAGE_KEYS.SITES])) {
    return DEFAULT_SITES.map((s) => ({ ...s, domains: [...s.domains] }));
  }
  return data[STORAGE_KEYS.SITES];
}

export async function saveSites(sites) {
  await chrome.storage.local.set({ [STORAGE_KEYS.SITES]: sites });
  return sites;
}

export async function getGrants() {
  const data = await chrome.storage.local.get(STORAGE_KEYS.GRANTS);
  return data[STORAGE_KEYS.GRANTS] || {};
}

export async function getActiveGrants(now = Date.now()) {
  const grants = await getGrants();
  const active = {};
  for (const [siteId, grant] of Object.entries(grants)) {
    const norm = normalizeGrant(grant, now);
    if (norm && isGrantActive(norm, now)) {
      active[siteId] = norm;
    }
  }
  return active;
}

export async function saveGrants(grants) {
  await chrome.storage.local.set({ [STORAGE_KEYS.GRANTS]: grants });
  return grants;
}

export async function getHistory() {
  const data = await chrome.storage.local.get(STORAGE_KEYS.HISTORY);
  return Array.isArray(data[STORAGE_KEYS.HISTORY]) ? data[STORAGE_KEYS.HISTORY] : [];
}

export async function appendHistoryEntry(entry) {
  const history = await getHistory();
  const next = [entry, ...history].slice(0, MAX_HISTORY_ENTRIES);
  await chrome.storage.local.set({ [STORAGE_KEYS.HISTORY]: next });
  return next;
}

export async function updateHistoryEntry(id, patch) {
  const history = await getHistory();
  const next = history.map((item) => (item.id === id ? { ...item, ...patch } : item));
  await chrome.storage.local.set({ [STORAGE_KEYS.HISTORY]: next });
  return next;
}

export async function clearHistory() {
  await chrome.storage.local.set({ [STORAGE_KEYS.HISTORY]: [] });
}
