import { getGrantRemainingMs } from './lib/grants.js';

const els = {
  settingsBtn: document.getElementById('settingsBtn'),
  apiKeyBanner: document.getElementById('apiKeyBanner'),
  setupKeyBtn: document.getElementById('setupKeyBtn'),
  activeGrantsSection: document.getElementById('activeGrantsSection'),
  activeGrantsList: document.getElementById('activeGrantsList'),
  currentSiteSection: document.getElementById('currentSiteSection'),
  currentHostname: document.getElementById('currentHostname'),
  quickBlockBtn: document.getElementById('quickBlockBtn'),
  todayMinutes: document.getElementById('todayMinutes'),
  todayUnlocks: document.getElementById('todayUnlocks'),
  blockedCount: document.getElementById('blockedCount'),
  viewHistoryBtn: document.getElementById('viewHistoryBtn'),
};

let countdownInterval = null;
let currentState = null;

function sendMessage(payload) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(payload, (res) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(res);
    });
  });
}

function formatCountdown(ms) {
  const totalSec = Math.max(0, Math.ceil(ms / 1000));
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

function openOptions(hash = '') {
  const url = chrome.runtime.getURL(`src/options.html${hash}`);
  chrome.tabs.create({ url });
}

function renderActiveGrants(activeGrants) {
  const entries = Object.values(activeGrants || {}).filter((g) => getGrantRemainingMs(g) > 0);
  if (entries.length === 0) {
    els.activeGrantsSection.hidden = true;
    return;
  }

  els.activeGrantsSection.hidden = false;
  els.activeGrantsList.innerHTML = '';

  for (const grant of entries) {
    const isRunning = grant.activeSince !== null && grant.activeSince !== undefined;

    const li = document.createElement('li');
    li.className = `grant-item${isRunning ? '' : ' paused'}`;

    const meta = document.createElement('div');
    meta.className = 'grant-meta';

    const siteRow = document.createElement('div');
    siteRow.className = 'grant-site';

    const nameSpan = document.createElement('span');
    nameSpan.textContent = grant.siteName || 'Site';

    const timerSpan = document.createElement('span');
    timerSpan.className = 'grant-timer';
    timerSpan.dataset.siteId = grant.siteId;
    timerSpan.textContent = formatCountdown(getGrantRemainingMs(grant));

    siteRow.append(nameSpan, timerSpan);

    if (!isRunning) {
      const pausedBadge = document.createElement('span');
      pausedBadge.className = 'paused-badge';
      pausedBadge.textContent = 'Paused';
      siteRow.appendChild(pausedBadge);
    }

    const summary = document.createElement('div');
    summary.className = 'grant-summary';
    summary.textContent = grant.summary || 'Unlocked session';

    meta.append(siteRow, summary);

    const lockBtn = document.createElement('button');
    lockBtn.type = 'button';
    lockBtn.className = 'lock-btn';
    lockBtn.textContent = 'Lock';
    lockBtn.addEventListener('click', async () => {
      lockBtn.disabled = true;
      await sendMessage({ type: 'REVOKE_GRANT', siteId: grant.siteId });
      await loadPopup();
    });

    li.append(meta, lockBtn);
    els.activeGrantsList.appendChild(li);
  }
}

function startTick() {
  if (countdownInterval) clearInterval(countdownInterval);
  countdownInterval = setInterval(() => {
    const activeGrants = currentState?.activeGrants || {};
    const timers = document.querySelectorAll('.grant-timer[data-site-id]');
    let anyExpired = false;
    timers.forEach((el) => {
      const grant = activeGrants[el.dataset.siteId];
      if (!grant) return;
      const rem = getGrantRemainingMs(grant);
      if (rem <= 0) {
        anyExpired = true;
      } else {
        el.textContent = formatCountdown(rem);
      }
    });
    if (anyExpired) {
      loadPopup();
    }
  }, 1000);
}

async function loadPopup() {
  const res = await sendMessage({ type: 'GET_POPUP_STATE' });
  if (!res?.ok) return;
  currentState = res;

  els.apiKeyBanner.hidden = Boolean(res.hasApiKey);
  renderActiveGrants(res.activeGrants);

  const tab = res.currentTab;
  if (tab && tab.hostname && (!tab.matchingSite || !tab.matchingSite.enabled)) {
    els.currentSiteSection.hidden = false;
    els.currentHostname.textContent = tab.hostname;
    els.quickBlockBtn.textContent = tab.matchingSite ? 'Re-enable block' : 'Block site';
  } else {
    els.currentSiteSection.hidden = true;
  }

  els.todayMinutes.textContent = `${Math.round(res.stats?.todayAll?.minutes || 0)}m`;
  els.todayUnlocks.textContent = String(res.stats?.todayAll?.approvals || 0);
  els.blockedCount.textContent = String((res.sites || []).filter((s) => s.enabled).length);

  startTick();
}

els.settingsBtn.addEventListener('click', () => openOptions());
els.setupKeyBtn.addEventListener('click', () => openOptions());
els.viewHistoryBtn.addEventListener('click', () => openOptions('#history'));

els.quickBlockBtn.addEventListener('click', async () => {
  const tab = currentState?.currentTab;
  if (!tab?.hostname) return;
  els.quickBlockBtn.disabled = true;
  await sendMessage({
    type: 'QUICK_ADD_SITE',
    hostname: tab.hostname,
    tabId: tab.id,
    tabUrl: tab.url,
  });
  window.close();
});

loadPopup();
