import {
  buildDomainRegexFilter,
  findMatchingSite,
  findSiteByHostname,
  getWebHostname,
  normalizeDomain,
} from './lib/domains.js';
import {
  createGrant,
  getGrantProjectedExpiry,
  getGrantRemainingMs,
  getGrantUsedMs,
  reconcileGrantsForFocusedSites,
} from './lib/grants.js';
import { evaluateIntention, testOpenRouterConnection } from './lib/openrouter.js';
import { computeUsageStats } from './lib/prompt.js';
import {
  appendHistoryEntry,
  getActiveGrants,
  getGrants,
  getHistory,
  getSettings,
  getSites,
  initializeStorage,
  saveGrants,
  saveSites,
  updateHistoryEntry,
} from './lib/storage.js';

const ALARM_EXPIRE_PREFIX = 'grant-expire:';
const ALARM_BADGE_TICK = 'badge-tick';

// Serialize all grant / DNR mutations so rapid tab/window events never race
let stateChain = Promise.resolve();

function serialize(fn) {
  const next = stateChain.then(fn, fn);
  stateChain = next.catch(() => {});
  return next;
}

function getBlockedPageUrl(targetUrl, reason = 'blocked', siteId = '') {
  const base = chrome.runtime.getURL('src/blocked.html');
  const params = [];
  if (reason && reason !== 'blocked') {
    params.push(`reason=${encodeURIComponent(reason)}`);
  }
  if (siteId) {
    params.push(`siteId=${encodeURIComponent(siteId)}`);
  }
  if (targetUrl) {
    params.push(`target=${encodeURIComponent(targetUrl)}`);
  }
  return params.length ? `${base}?${params.join('&')}` : base;
}

/**
 * Determine which blocked site (if any) is currently in the active tab of a focused Chrome window.
 */
async function getFocusedSiteIds(sites) {
  const focusedSiteIds = new Set();
  try {
    const windows = await chrome.windows.getAll({ populate: true, windowTypes: ['normal'] });
    for (const win of windows) {
      if (!win.focused) continue;
      const activeTab = (win.tabs || []).find((t) => t.active);
      if (activeTab?.url) {
        const match = findMatchingSite(activeTab.url, sites);
        if (match) {
          focusedSiteIds.add(match.id);
        }
      }
    }
  } catch (err) {
    console.warn('[Intentional Block] Could not inspect focused windows:', err);
  }
  return focusedSiteIds;
}

/**
 * Push latest grant states to open tabs hosting any unlocked sites so their timer pill
 * pauses/resumes immediately without waiting.
 */
async function broadcastGrantsToTabs(sites, grants) {
  if (!grants || Object.keys(grants).length === 0) return;
  try {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (!tab.id || !tab.url) continue;
      const site = findMatchingSite(tab.url, sites);
      if (!site || !grants[site.id]) continue;
      chrome.tabs
        .sendMessage(tab.id, { type: 'GRANT_UPDATE', grant: grants[site.id] })
        .catch(() => {
          // Tab might not have the timer pill injected yet
        });
    }
  } catch {
    // Ignore tab query errors
  }
}

/**
 * Core synchronization:
 * 1. Settles elapsed active time and pauses/resumes grants based on focused browser tab
 * 2. Prunes expired or orphaned grants
 * 3. Updates DNR dynamic rules, alarms, toolbar badge, and open tab timer pills
 * 4. Redirects any open tabs whose grants just expired
 */
function syncState({
  enforceExpired = true,
  enforceAllBlocked = false,
  skipElapsedDeduction = false,
} = {}) {
  return serialize(async () => {
    const now = Date.now();
    const [sites, rawGrants] = await Promise.all([getSites(), getGrants()]);
    const focusedSiteIds = await getFocusedSiteIds(sites);
    const validSiteIds = new Set(sites.map((s) => s.id));

    const { grants: activeGrants, expiredSiteIds, changed } = reconcileGrantsForFocusedSites(
      rawGrants,
      focusedSiteIds,
      now,
      { validSiteIds, skipElapsedDeduction }
    );

    if (changed) {
      await saveGrants(activeGrants);
    }

    await updateDnrRules(sites, activeGrants);
    await syncAlarms(activeGrants);
    await updateActionBadge(activeGrants, now);
    await broadcastGrantsToTabs(sites, activeGrants);

    if (enforceExpired && expiredSiteIds.length > 0) {
      await enforceBlockedTabs({
        sites,
        activeGrants,
        siteIds: expiredSiteIds,
        reason: 'expired',
      });
    } else if (enforceAllBlocked) {
      await enforceBlockedTabs({
        sites,
        activeGrants,
        reason: 'blocked',
      });
    }

    return { sites, activeGrants, expiredSiteIds };
  });
}

async function updateDnrRules(sites, activeGrants) {
  const blockedPageBase = chrome.runtime.getURL('src/blocked.html');
  const addRules = [];
  let ruleId = 1;

  for (const site of sites) {
    if (!site.enabled) continue;
    if (activeGrants[site.id]) continue; // Temporarily unblocked

    for (const domain of site.domains || []) {
      const clean = normalizeDomain(domain);
      if (!clean) continue;

      addRules.push({
        id: ruleId++,
        priority: 1,
        action: {
          type: 'redirect',
          redirect: {
            regexSubstitution: `${blockedPageBase}?target=\\0`,
          },
        },
        condition: {
          regexFilter: buildDomainRegexFilter(clean),
          isUrlFilterCaseSensitive: false,
          resourceTypes: ['main_frame'],
        },
      });
    }
  }

  const existingRules = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = existingRules.map((r) => r.id);

  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds,
    addRules,
  });
}

async function syncAlarms(activeGrants) {
  const existingAlarms = await chrome.alarms.getAll();
  const runningSiteIds = new Set();

  for (const [siteId, grant] of Object.entries(activeGrants)) {
    const projectedExpiry = getGrantProjectedExpiry(grant);
    if (projectedExpiry !== null) {
      runningSiteIds.add(siteId);
      await chrome.alarms.create(`${ALARM_EXPIRE_PREFIX}${siteId}`, {
        when: Math.max(Date.now() + 500, projectedExpiry),
      });
    }
  }

  // Clear alarms for grants that are paused or no longer active
  for (const alarm of existingAlarms) {
    if (alarm.name.startsWith(ALARM_EXPIRE_PREFIX)) {
      const siteId = alarm.name.slice(ALARM_EXPIRE_PREFIX.length);
      if (!runningSiteIds.has(siteId)) {
        await chrome.alarms.clear(alarm.name);
      }
    }
  }

  // Only tick badge every minute while at least one timer is actively counting down
  if (runningSiteIds.size > 0) {
    const hasTick = existingAlarms.some((a) => a.name === ALARM_BADGE_TICK);
    if (!hasTick) {
      await chrome.alarms.create(ALARM_BADGE_TICK, { periodInMinutes: 1 });
    }
  } else {
    await chrome.alarms.clear(ALARM_BADGE_TICK);
  }
}

async function updateActionBadge(activeGrantsInput = null, now = Date.now()) {
  const activeGrants = activeGrantsInput || (await getActiveGrants(now));
  const grantList = Object.values(activeGrants);

  if (grantList.length === 0) {
    await chrome.action.setBadgeText({ text: '' });
    return;
  }

  const runningGrants = grantList.filter((g) => g.activeSince !== null);
  const displayList = runningGrants.length > 0 ? runningGrants : grantList;
  const soonestMs = Math.min(...displayList.map((g) => getGrantRemainingMs(g, now)));
  const mins = Math.ceil(soonestMs / 60000);
  const text = mins <= 0 ? '' : mins < 1 ? '<1m' : `${mins}m`;

  const isRunning = runningGrants.length > 0;
  const color = !isRunning ? '#475569' : mins <= 1 ? '#d97706' : '#4f46e5';

  await chrome.action.setBadgeBackgroundColor({ color });
  await chrome.action.setBadgeText({ text });
}

/**
 * Redirect any open tabs matching the specified site IDs (or all currently blocked sites)
 * back to the Intention Gate.
 */
async function enforceBlockedTabs({
  sites = null,
  activeGrants = null,
  siteIds = null,
  reason = 'expired',
} = {}) {
  const [resolvedSites, resolvedGrants, tabs] = await Promise.all([
    sites ? Promise.resolve(sites) : getSites(),
    activeGrants ? Promise.resolve(activeGrants) : getActiveGrants(),
    chrome.tabs.query({}),
  ]);

  const targetSites = resolvedSites.filter((s) => {
    if (!s.enabled) return false;
    if (resolvedGrants[s.id]) return false;
    if (siteIds && !siteIds.includes(s.id)) return false;
    return true;
  });

  if (targetSites.length === 0) return;

  for (const tab of tabs) {
    if (!tab.id || !tab.url) continue;
    const match = findMatchingSite(tab.url, targetSites);
    if (match) {
      const redirectUrl = getBlockedPageUrl(tab.url, reason, match.id);
      try {
        await chrome.tabs.update(tab.id, { url: redirectUrl });
      } catch {
        // Tab may have been closed
      }
    }
  }
}

/**
 * Inject the subtle in-page countdown pill into a tab if its site is currently unblocked.
 */
async function maybeInjectTimerPill(tabId, url) {
  if (!tabId || !url || !getWebHostname(url)) return;
  const [settings, sites, activeGrants] = await Promise.all([
    getSettings(),
    getSites(),
    getActiveGrants(),
  ]);

  if (!settings.showTimerPill) return;
  const site = findMatchingSite(url, sites);
  if (!site || !activeGrants[site.id]) return;

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['src/timer-pill.js'],
    });
  } catch {
    // Ignore restricted pages or tabs mid-navigation
  }
}

/**
 * Fallback guard for navigations / SPA updates in case DNR didn't intercept.
 */
async function checkTabShouldBlock(tabId, url) {
  if (!tabId || !url || !getWebHostname(url)) return;

  const { sites, activeGrants, expiredSiteIds } = await syncState({ enforceExpired: true });
  const site = findMatchingSite(url, sites);
  if (!site) return;

  if (!activeGrants[site.id]) {
    const redirectUrl = getBlockedPageUrl(
      url,
      expiredSiteIds.includes(site.id) ? 'expired' : 'blocked',
      site.id
    );
    try {
      await chrome.tabs.update(tabId, { url: redirectUrl });
    } catch {
      // Ignore closed tabs
    }
  }
}

// --- Lifecycle & Focus Tracking Listeners ---

chrome.runtime.onInstalled.addListener(async () => {
  await initializeStorage();
  await syncState({ skipElapsedDeduction: true });
});

chrome.runtime.onStartup.addListener(async () => {
  await initializeStorage();
  // Don't deduct time while Chrome was closed; re-check current focused tab
  await syncState({ skipElapsedDeduction: true });
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name.startsWith(ALARM_EXPIRE_PREFIX) || alarm.name === ALARM_BADGE_TICK) {
    await syncState({ enforceExpired: true });
  }
});

chrome.tabs.onActivated.addListener(() => {
  syncState({ enforceExpired: true });
});

chrome.tabs.onRemoved.addListener(() => {
  syncState({ enforceExpired: true });
});

chrome.windows.onFocusChanged.addListener(() => {
  syncState({ enforceExpired: true });
});

chrome.windows.onRemoved.addListener(() => {
  syncState({ enforceExpired: true });
});

chrome.webNavigation.onBeforeNavigate.addListener((details) => {
  if (details.frameId !== 0) return;
  checkTabShouldBlock(details.tabId, details.url);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const url = changeInfo.url || tab?.url;
  if (changeInfo.url) {
    checkTabShouldBlock(tabId, changeInfo.url);
  }
  if (changeInfo.status === 'complete' && url) {
    syncState({ enforceExpired: true }).then(() => maybeInjectTimerPill(tabId, url));
  }
});

// --- Message Handlers ---

async function handleGetBlockedContext({ targetUrl, siteId }) {
  const { sites, activeGrants } = await syncState({ enforceExpired: true });
  const [settings, history] = await Promise.all([getSettings(), getHistory()]);

  let site = null;
  if (siteId) {
    site = sites.find((s) => s.id === siteId) || null;
  }
  if (!site && targetUrl) {
    site = findMatchingSite(targetUrl, sites);
    if (!site) {
      const host = getWebHostname(targetUrl);
      site = findSiteByHostname(host, sites);
    }
  }

  const activeGrant = site ? activeGrants[site.id] || null : null;
  const stats = computeUsageStats(history, site?.id || null);
  const recentForSite = site
    ? history.filter((h) => h.siteId === site.id).slice(0, 5)
    : history.slice(0, 5);

  return {
    ok: true,
    site,
    activeGrant,
    hasApiKey: Boolean(settings.apiKey && settings.apiKey.trim()),
    model: settings.model,
    strictness: settings.strictness,
    maxMinutes: settings.maxMinutes,
    stats,
    recentHistory: recentForSite,
  };
}

async function handleEvaluateIntention({ siteId, targetUrl, intention, chatMessages }) {
  const [settings, sites, history] = await Promise.all([
    getSettings(),
    getSites(),
    getHistory(),
  ]);

  const site =
    sites.find((s) => s.id === siteId) ||
    (targetUrl ? findMatchingSite(targetUrl, sites) : null);

  if (!site) {
    throw new Error('Could not find this site in your blocked list.');
  }

  const userIntention = (
    typeof intention === 'string'
      ? intention
      : [...(chatMessages || [])].reverse().find((m) => m.role === 'user')?.content || ''
  ).trim();

  if (!userIntention) {
    throw new Error('Please state an intention first.');
  }

  const result = await evaluateIntention({
    site,
    targetUrl,
    settings,
    history,
    intention: userIntention,
  });

  const now = Date.now();
  let grant = null;

  if (result.decision === 'approve' || result.decision === 'deny') {
    const entryId = `hist-${now}-${Math.random().toString(36).slice(2, 8)}`;

    await appendHistoryEntry({
      id: entryId,
      timestamp: now,
      siteId: site.id,
      siteName: site.name,
      domain: site.domains[0] || '',
      targetUrl: targetUrl || '',
      intention: userIntention.slice(0, 400),
      summary: result.summary,
      category: result.category,
      decision: result.decision,
      grantedMinutes: result.decision === 'approve' ? result.minutes : 0,
      aiMessage: result.message,
      modelUsed: result.modelUsed,
    });

    if (result.decision === 'approve') {
      grant = createGrant({
        siteId: site.id,
        siteName: site.name,
        historyId: entryId,
        minutes: result.minutes,
        summary: result.summary,
        category: result.category,
        now,
      });

      await serialize(async () => {
        const grants = await getActiveGrants(now);
        grants[site.id] = grant;
        await saveGrants(grants);
      });

      // Wait for DNR dynamic rules to update BEFORE returning so navigation won't bounce back!
      const synced = await syncState({ enforceExpired: false });
      grant = synced.activeGrants[site.id] || grant;
    }
  }

  const updatedHistory = await getHistory();
  const stats = computeUsageStats(updatedHistory, site.id);

  return {
    ok: true,
    result,
    grant,
    stats,
  };
}

async function handleRevokeGrant({ siteId }) {
  const now = Date.now();

  await serialize(async () => {
    const grants = await getGrants();
    const existing = grants[siteId];

    if (existing) {
      if (existing.historyId) {
        const usedMs = getGrantUsedMs(existing, now);
        const usedMins = usedMs > 0 ? Math.max(1, Math.round(usedMs / 60000)) : 0;
        if (usedMins < existing.minutes) {
          await updateHistoryEntry(existing.historyId, {
            actualMinutes: usedMins,
            endedEarly: true,
          });
        }
      }
      delete grants[siteId];
      await saveGrants(grants);
    }
  });

  const { sites, activeGrants } = await syncState({ enforceExpired: false });
  await enforceBlockedTabs({ sites, activeGrants, siteIds: [siteId], reason: 'locked' });

  return { ok: true };
}

async function handleGetActiveGrantForTab(sender) {
  const url = sender?.tab?.url;
  if (!url) return { ok: true, grant: null };

  const { sites, activeGrants } = await syncState({ enforceExpired: true });
  const settings = await getSettings();

  if (!settings.showTimerPill) return { ok: true, grant: null };
  const site = findMatchingSite(url, sites);
  if (!site) return { ok: true, grant: null };

  const grant = activeGrants[site.id] || null;
  return { ok: true, grant, site };
}

async function handleGetPopupState() {
  const { sites, activeGrants } = await syncState({ enforceExpired: true });
  const [settings, history, activeTabs] = await Promise.all([
    getSettings(),
    getHistory(),
    chrome.tabs.query({ active: true, currentWindow: true }),
  ]);

  const currentTab = activeTabs[0] || null;
  const currentHostname = currentTab?.url ? getWebHostname(currentTab.url) : null;
  const normalizedHost = currentHostname ? normalizeDomain(currentHostname) : null;
  const matchingSite = currentHostname ? findSiteByHostname(currentHostname, sites) : null;
  const stats = computeUsageStats(history);

  return {
    ok: true,
    hasApiKey: Boolean(settings.apiKey && settings.apiKey.trim()),
    model: settings.model,
    sites,
    activeGrants,
    stats,
    currentTab: currentTab
      ? {
          id: currentTab.id,
          url: currentTab.url,
          hostname: normalizedHost,
          matchingSite,
        }
      : null,
  };
}

async function handleQuickAddSite({ hostname, tabId, tabUrl }) {
  const clean = normalizeDomain(hostname);
  if (!clean) {
    throw new Error('Cannot block this page.');
  }

  const sites = await getSites();
  const existing = findSiteByHostname(clean, sites);

  let targetSite = existing;
  if (existing) {
    existing.enabled = true;
    await saveSites(sites);
  } else {
    targetSite = {
      id: `site-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      name: clean,
      domains: [clean],
      enabled: true,
    };
    sites.push(targetSite);
    await saveSites(sites);
  }

  await syncState({ enforceExpired: false });

  if (tabId && tabUrl) {
    try {
      await chrome.tabs.update(tabId, {
        url: getBlockedPageUrl(tabUrl, 'blocked', targetSite.id),
      });
    } catch {
      // Ignore
    }
  }

  return { ok: true, site: targetSite };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const run = async () => {
    switch (message?.type) {
      case 'GET_BLOCKED_CONTEXT':
        return handleGetBlockedContext(message);
      case 'EVALUATE_INTENTION':
        return handleEvaluateIntention(message);
      case 'REVOKE_GRANT':
        return handleRevokeGrant(message);
      case 'GET_ACTIVE_GRANT_FOR_TAB':
        return handleGetActiveGrantForTab(sender);
      case 'SYNC_RULES':
        await syncState({
          enforceExpired: true,
          enforceAllBlocked: Boolean(message.enforceOpenTabs),
        });
        return { ok: true };
      case 'TEST_OPENROUTER':
        return testOpenRouterConnection({
          apiKey: message.apiKey,
          model: message.model,
          disableThinking: Boolean(message.disableThinking),
        });
      case 'GET_POPUP_STATE':
        return handleGetPopupState();
      case 'QUICK_ADD_SITE':
        return handleQuickAddSite(message);
      default:
        return { ok: false, error: `Unknown message type: ${message?.type}` };
    }
  };

  run()
    .then((res) => sendResponse(res))
    .catch((err) => {
      console.error('[Intentional Block] Message handler error:', err);
      sendResponse({ ok: false, error: err?.message || 'Unexpected error.' });
    });

  return true; // Keep message channel open for async response
});
