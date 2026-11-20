import { PRESET_SITES } from './lib/constants.js';
import { parseDomainsInput } from './lib/domains.js';
import { computeUsageStats } from './lib/prompt.js';
import {
  clearHistory,
  getHistory,
  getSettings,
  getSites,
  saveSettings,
  saveSites,
} from './lib/storage.js';

const els = {
  tabs: document.querySelectorAll('.tab'),
  panels: {
    settings: document.getElementById('tab-settings'),
    sites: document.getElementById('tab-sites'),
    history: document.getElementById('tab-history'),
  },
  // Settings
  settingsForm: document.getElementById('settingsForm'),
  apiKeyInput: document.getElementById('apiKeyInput'),
  toggleKeyBtn: document.getElementById('toggleKeyBtn'),
  modelInput: document.getElementById('modelInput'),
  disableThinkingInput: document.getElementById('disableThinkingInput'),
  testConnectionBtn: document.getElementById('testConnectionBtn'),
  testStatus: document.getElementById('testStatus'),
  strictnessGroup: document.getElementById('strictnessGroup'),
  maxMinutesInput: document.getElementById('maxMinutesInput'),
  customInstructionsInput: document.getElementById('customInstructionsInput'),
  showTimerPillInput: document.getElementById('showTimerPillInput'),
  saveStatus: document.getElementById('saveStatus'),
  // Sites
  addSiteForm: document.getElementById('addSiteForm'),
  newSiteDomains: document.getElementById('newSiteDomains'),
  newSiteName: document.getElementById('newSiteName'),
  siteError: document.getElementById('siteError'),
  presetChips: document.getElementById('presetChips'),
  sitesCountSubtitle: document.getElementById('sitesCountSubtitle'),
  sitesList: document.getElementById('sitesList'),
  // History
  historyStatsGrid: document.getElementById('historyStatsGrid'),
  historySearch: document.getElementById('historySearch'),
  historyDecisionFilter: document.getElementById('historyDecisionFilter'),
  historyList: document.getElementById('historyList'),
  exportHistoryBtn: document.getElementById('exportHistoryBtn'),
  clearHistoryBtn: document.getElementById('clearHistoryBtn'),
};

let currentStrictness = 'balanced';
let currentSites = [];
let currentHistory = [];

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

// --- Tabs ---

function switchTab(tabName) {
  els.tabs.forEach((btn) => {
    const active = btn.dataset.tab === tabName;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', String(active));
  });
  Object.entries(els.panels).forEach(([name, panel]) => {
    panel.hidden = name !== tabName;
    panel.classList.toggle('active', name === tabName);
  });

  if (tabName === 'history') {
    loadHistory();
  }
}

els.tabs.forEach((btn) => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

// --- Settings ---

function getSelectedModel() {
  return els.modelInput.value.trim();
}

function setStrictnessUI(value) {
  currentStrictness = value || 'balanced';
  els.strictnessGroup.querySelectorAll('.seg-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.value === currentStrictness);
  });
}

async function loadSettings() {
  const settings = await getSettings();
  els.apiKeyInput.value = settings.apiKey || '';
  els.modelInput.value = settings.model || '';
  els.disableThinkingInput.checked = Boolean(settings.disableThinking);
  setStrictnessUI(settings.strictness);
  els.maxMinutesInput.value = settings.maxMinutes || 45;
  els.customInstructionsInput.value = settings.customInstructions || '';
  els.showTimerPillInput.checked = settings.showTimerPill !== false;
}

els.toggleKeyBtn.addEventListener('click', () => {
  const isPassword = els.apiKeyInput.type === 'password';
  els.apiKeyInput.type = isPassword ? 'text' : 'password';
  els.toggleKeyBtn.textContent = isPassword ? 'Hide' : 'Show';
});

els.strictnessGroup.addEventListener('click', (e) => {
  const btn = e.target.closest('.seg-btn');
  if (!btn) return;
  setStrictnessUI(btn.dataset.value);
});

els.testConnectionBtn.addEventListener('click', async () => {
  const apiKey = els.apiKeyInput.value.trim();
  const model = getSelectedModel();

  if (!apiKey) {
    els.testStatus.textContent = 'Enter your OpenRouter API key first.';
    els.testStatus.className = 'status-text err';
    return;
  }
  if (!model) {
    els.testStatus.textContent = 'Enter an OpenRouter model ID first.';
    els.testStatus.className = 'status-text err';
    return;
  }

  els.testConnectionBtn.disabled = true;
  els.testStatus.textContent = 'Testing connection...';
  els.testStatus.className = 'status-text';

  try {
    const res = await sendMessage({
      type: 'TEST_OPENROUTER',
      apiKey,
      model,
      disableThinking: els.disableThinkingInput.checked,
    });

    if (res?.ok) {
      const modeSuffix =
        res.reasoningMode === 'off'
          ? ' · thinking off'
          : res.reasoningMode === 'low'
            ? ' · low thinking'
            : '';
      els.testStatus.textContent = `Connected (${res.modelUsed || model}${modeSuffix})`;
      els.testStatus.className = 'status-text ok';
    } else {
      els.testStatus.textContent = res?.error || 'Connection failed.';
      els.testStatus.className = 'status-text err';
    }
  } catch (err) {
    els.testStatus.textContent = err.message;
    els.testStatus.className = 'status-text err';
  } finally {
    els.testConnectionBtn.disabled = false;
  }
});

els.settingsForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const model = getSelectedModel();
  if (!model) {
    els.saveStatus.textContent = 'Please enter a valid OpenRouter model ID.';
    els.saveStatus.className = 'status-text err';
    return;
  }

  const maxMinutes = Math.max(5, Math.min(180, Number(els.maxMinutesInput.value) || 45));

  await saveSettings({
    apiKey: els.apiKeyInput.value.trim(),
    model,
    disableThinking: els.disableThinkingInput.checked,
    strictness: currentStrictness,
    maxMinutes,
    customInstructions: els.customInstructionsInput.value.trim(),
    showTimerPill: els.showTimerPillInput.checked,
  });

  els.saveStatus.textContent = 'Settings saved.';
  els.saveStatus.className = 'status-text ok';
  setTimeout(() => {
    if (els.saveStatus.textContent === 'Settings saved.') {
      els.saveStatus.textContent = '';
    }
  }, 3000);
});

// --- Blocked Sites ---

function hasAnyDomain(domains) {
  const existing = new Set(currentSites.flatMap((s) => s.domains || []));
  return domains.some((d) => existing.has(d));
}

function renderPresets() {
  els.presetChips.innerHTML = '';
  for (const preset of PRESET_SITES) {
    const alreadyAdded = hasAnyDomain(preset.domains);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `preset-chip${alreadyAdded ? ' added' : ''}`;
    btn.textContent = alreadyAdded ? `✓ ${preset.name}` : `+ ${preset.name}`;
    btn.disabled = alreadyAdded;

    btn.addEventListener('click', async () => {
      currentSites.push({
        id: `site-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        name: preset.name,
        domains: [...preset.domains],
        enabled: true,
      });
      await saveSites(currentSites);
      await sendMessage({ type: 'SYNC_RULES', enforceOpenTabs: true });
      renderSites();
    });

    els.presetChips.appendChild(btn);
  }
}

function renderSites() {
  renderPresets();

  const enabledCount = currentSites.filter((s) => s.enabled).length;
  els.sitesCountSubtitle.textContent = `${enabledCount} active · ${currentSites.length} total`;
  els.sitesList.innerHTML = '';

  if (currentSites.length === 0) {
    els.sitesList.innerHTML = '<li class="empty-state">No sites blocked yet. Add a domain above or pick a quick preset.</li>';
    return;
  }

  for (const site of currentSites) {
    const li = document.createElement('li');
    li.className = `site-row${site.enabled ? '' : ' disabled'}`;

    const info = document.createElement('div');
    info.className = 'site-info';

    const name = document.createElement('div');
    name.className = 'site-name';
    name.textContent = site.name;

    const domains = document.createElement('div');
    domains.className = 'site-domains';
    domains.textContent = (site.domains || []).join(', ');

    info.append(name, domains);

    const controls = document.createElement('div');
    controls.className = 'site-controls';

    const toggleLabel = document.createElement('label');
    toggleLabel.className = 'toggle-switch';
    toggleLabel.title = site.enabled ? 'Disable blocking' : 'Enable blocking';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = Boolean(site.enabled);
    checkbox.addEventListener('change', async () => {
      site.enabled = checkbox.checked;
      await saveSites(currentSites);
      await sendMessage({ type: 'SYNC_RULES', enforceOpenTabs: site.enabled });
      renderSites();
    });

    const slider = document.createElement('span');
    slider.className = 'toggle-slider';
    toggleLabel.append(checkbox, slider);

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'icon-btn';
    removeBtn.textContent = 'Remove';
    removeBtn.addEventListener('click', async () => {
      currentSites = currentSites.filter((s) => s.id !== site.id);
      await saveSites(currentSites);
      await sendMessage({ type: 'SYNC_RULES' });
      renderSites();
    });

    controls.append(toggleLabel, removeBtn);
    li.append(info, controls);
    els.sitesList.appendChild(li);
  }
}

async function loadSites() {
  currentSites = await getSites();
  renderSites();
}

els.addSiteForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  els.siteError.hidden = true;

  const domains = parseDomainsInput(els.newSiteDomains.value);
  if (domains.length === 0) {
    els.siteError.textContent = 'Please enter at least one valid domain (e.g. reddit.com or x.com).';
    els.siteError.hidden = false;
    return;
  }

  const label = els.newSiteName.value.trim() || domains[0];
  currentSites.push({
    id: `site-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    name: label,
    domains,
    enabled: true,
  });

  els.newSiteDomains.value = '';
  els.newSiteName.value = '';

  await saveSites(currentSites);
  await sendMessage({ type: 'SYNC_RULES', enforceOpenTabs: true });
  renderSites();
});

// --- History ---

function renderHistoryStats() {
  const stats = computeUsageStats(currentHistory);
  const total7dDecisions = stats.last7dAll.approvals + stats.last7dAll.denials;
  const approvalRate =
    total7dDecisions > 0
      ? `${Math.round((stats.last7dAll.approvals / total7dDecisions) * 100)}%`
      : '—';

  const topCatEntry = Object.entries(stats.last7dAll.byCategory).sort((a, b) => b[1] - a[1])[0];
  const topCat = topCatEntry ? `${topCatEntry[0]} (${Math.round(topCatEntry[1])}m)` : '—';

  const cards = [
    {
      label: 'Today',
      value: `${Math.round(stats.todayAll.minutes)}m`,
      sub: `${stats.todayAll.approvals} approved · ${stats.todayAll.denials} denied`,
    },
    {
      label: 'Last 7 Days',
      value: `${Math.round(stats.last7dAll.minutes)}m`,
      sub: `${stats.last7dAll.approvals} unlocks`,
    },
    {
      label: '7d Approval Rate',
      value: approvalRate,
      sub: `${total7dDecisions} total requests`,
    },
    {
      label: 'Top Category (7d)',
      value: topCatEntry ? topCatEntry[0] : '—',
      sub: topCatEntry ? `${Math.round(topCatEntry[1])} min used` : 'No sessions yet',
    },
  ];

  els.historyStatsGrid.innerHTML = '';
  for (const c of cards) {
    const div = document.createElement('div');
    div.className = 'stat-card';
    div.innerHTML = `
      <div class="stat-label"></div>
      <div class="stat-value"></div>
      <div class="stat-sub"></div>
    `;
    div.querySelector('.stat-label').textContent = c.label;
    div.querySelector('.stat-value').textContent = c.value;
    div.querySelector('.stat-sub').textContent = c.sub;
    els.historyStatsGrid.appendChild(div);
  }
}

function renderHistoryList() {
  const query = els.historySearch.value.trim().toLowerCase();
  const filter = els.historyDecisionFilter.value;

  const filtered = currentHistory.filter((item) => {
    if (filter !== 'all' && item.decision !== filter) return false;
    if (query) {
      const haystack = `${item.siteName || ''} ${item.domain || ''} ${item.intention || ''} ${item.summary || ''} ${item.category || ''}`.toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    return true;
  });

  els.historyList.innerHTML = '';
  if (filtered.length === 0) {
    els.historyList.innerHTML =
      '<div class="empty-state">No intention history matching your filter yet.</div>';
    return;
  }

  for (const item of filtered) {
    const card = document.createElement('div');
    card.className = 'history-item';

    const top = document.createElement('div');
    top.className = 'history-top';

    const badges = document.createElement('div');
    badges.className = 'history-badges';

    const siteSpan = document.createElement('span');
    siteSpan.className = 'history-site';
    siteSpan.textContent = item.siteName || item.domain || 'Site';

    const decPill = document.createElement('span');
    decPill.className = `pill ${item.decision === 'approve' ? 'approve' : 'deny'}`;
    if (item.decision === 'approve') {
      const earlyNote =
        typeof item.actualMinutes === 'number' && item.actualMinutes < item.grantedMinutes
          ? ` (used ${item.actualMinutes}m)`
          : '';
      decPill.textContent = `Approved · ${item.grantedMinutes}m${earlyNote}`;
    } else {
      decPill.textContent = 'Denied';
    }

    const catPill = document.createElement('span');
    catPill.className = 'pill category';
    catPill.textContent = item.category || 'other';

    badges.append(siteSpan, decPill, catPill);

    const timeSpan = document.createElement('span');
    timeSpan.className = 'history-time';
    timeSpan.textContent = new Date(item.timestamp).toLocaleString();

    top.append(badges, timeSpan);

    const intentionDiv = document.createElement('div');
    intentionDiv.className = 'history-intention';
    intentionDiv.textContent = item.intention ? `"${item.intention}"` : item.summary || '';

    const aiDiv = document.createElement('div');
    aiDiv.className = 'history-ai';
    aiDiv.textContent = item.aiMessage || '';

    card.append(top, intentionDiv);
    if (item.aiMessage) card.append(aiDiv);
    els.historyList.appendChild(card);
  }
}

async function loadHistory() {
  currentHistory = await getHistory();
  renderHistoryStats();
  renderHistoryList();
}

els.historySearch.addEventListener('input', renderHistoryList);
els.historyDecisionFilter.addEventListener('change', renderHistoryList);

els.exportHistoryBtn.addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(currentHistory, null, 2)], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `intentional-block-history-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

els.clearHistoryBtn.addEventListener('click', async () => {
  if (!window.confirm('Clear all intention history? The AI gatekeeper will start fresh.')) return;
  await clearHistory();
  await loadHistory();
});

// Support deep link hash like options.html#history or #sites
async function init() {
  await Promise.all([loadSettings(), loadSites(), loadHistory()]);
  const hash = window.location.hash.replace('#', '');
  if (hash && els.panels[hash]) {
    switchTab(hash);
  }
}

init();
