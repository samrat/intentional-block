import { formatShortUrl, isSafeHttpUrl, parseBlockedPageParams } from './lib/domains.js';
import { getGrantRemainingMs } from './lib/grants.js';
import { formatRelativeTime } from './lib/prompt.js';

const params = parseBlockedPageParams(window.location.href);

const els = {
  page: document.getElementById('page'),
  statusDot: document.getElementById('statusDot'),
  siteName: document.getElementById('siteName'),
  reasonBadge: document.getElementById('reasonBadge'),
  targetUrlDisplay: document.getElementById('targetUrlDisplay'),
  todayStatsPill: document.getElementById('todayStatsPill'),
  openSettingsBtn: document.getElementById('openSettingsBtn'),
  setupCard: document.getElementById('setupCard'),
  setupOpenSettingsBtn: document.getElementById('setupOpenSettingsBtn'),
  setupCloseTabBtn: document.getElementById('setupCloseTabBtn'),
  intentionStage: document.getElementById('intentionStage'),
  promptLead: document.getElementById('promptLead'),
  intentionForm: document.getElementById('intentionForm'),
  intentionCanvas: document.getElementById('intentionCanvas'),
  intentionEditor: document.getElementById('intentionEditor'),
  intentionPlaceholder: document.getElementById('intentionPlaceholder'),
  intentionMirror: document.getElementById('intentionMirror'),
  intentionInput: document.getElementById('intentionInput'),
  composerHint: document.getElementById('composerHint'),
  closeTabBtn: document.getElementById('closeTabBtn'),
  submitBtn: document.getElementById('submitBtn'),
  submittedBlock: document.getElementById('submittedBlock'),
  submittedEyebrow: document.getElementById('submittedEyebrow'),
  submittedText: document.getElementById('submittedText'),
  thinkingState: document.getElementById('thinkingState'),
  replyPanel: document.getElementById('replyPanel'),
  verdictLabel: document.getElementById('verdictLabel'),
  countdownBox: document.getElementById('countdownBox'),
  countdownValue: document.getElementById('countdownValue'),
  replyMessage: document.getElementById('replyMessage'),
  continueBtn: document.getElementById('continueBtn'),
  lockEarlyBtn: document.getElementById('lockEarlyBtn'),
  replyCloseTabBtn: document.getElementById('replyCloseTabBtn'),
  retryBtn: document.getElementById('retryBtn'),
  recentDetails: document.getElementById('recentDetails'),
  recentList: document.getElementById('recentList'),
};

const state = {
  site: null,
  displayName: 'this site',
  targetUrl: params.target,
  reason: params.reason,
  phase: 'compose', // 'compose' | 'evaluating' | 'approved' | 'denied' | 'error'
  lastIntention: '',
  activeGrant: null,
  countdownTimer: null,
  pulseTimer: null,
  mirrorItems: [], // { char: string, node: Node }[]
  mirrorSentinel: document.createTextNode('\u200b'),
};

els.intentionMirror.appendChild(state.mirrorSentinel);

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

function getDestinationUrl() {
  if (isSafeHttpUrl(state.targetUrl)) return state.targetUrl;
  if (state.site?.domains?.[0]) return `https://${state.site.domains[0]}`;
  return '';
}

function formatCountdown(ms) {
  const totalSec = Math.max(0, Math.ceil(ms / 1000));
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

function renderStats(stats) {
  if (!stats) return;
  const approvals = stats.todayAll?.approvals || 0;
  const minutes = Math.round(stats.todayAll?.minutes || 0);
  els.todayStatsPill.textContent =
    approvals === 0 ? 'Today: 0 unlocks' : `Today: ${approvals} unlock${approvals === 1 ? '' : 's'} · ${minutes}m`;
  els.todayStatsPill.hidden = false;
}

function renderRecentHistory(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    els.recentDetails.hidden = true;
    return;
  }

  els.recentList.innerHTML = '';
  for (const item of entries) {
    const li = document.createElement('li');
    li.className = 'recent-item';

    const left = document.createElement('div');
    left.className = 'recent-item-left';

    const chip = document.createElement('span');
    chip.className = `decision-chip ${item.decision === 'approve' ? 'approve' : 'deny'}`;
    chip.textContent = item.decision === 'approve' ? `${item.grantedMinutes}m` : 'Denied';

    const summary = document.createElement('span');
    summary.className = 'recent-item-summary';
    summary.textContent = item.summary || item.intention || 'Session';

    left.append(chip, summary);

    const meta = document.createElement('span');
    meta.className = 'recent-item-meta';
    meta.textContent = formatRelativeTime(item.timestamp);

    li.append(left, meta);
    els.recentList.appendChild(li);
  }

  els.recentDetails.hidden = false;
}

/**
 * Diff previous and next characters so only newly inserted letters animate in,
 * while settled characters remain completely still and aligned with the native caret.
 */
function syncMirror(nextValue, { animate = true } = {}) {
  const nextChars = Array.from(nextValue);
  const prevItems = state.mirrorItems;

  let prefix = 0;
  const minLen = Math.min(prevItems.length, nextChars.length);
  while (prefix < minLen && prevItems[prefix].char === nextChars[prefix]) {
    prefix += 1;
  }

  let prevEnd = prevItems.length - 1;
  let nextEnd = nextChars.length - 1;
  while (prevEnd >= prefix && nextEnd >= prefix && prevItems[prevEnd].char === nextChars[nextEnd]) {
    prevEnd -= 1;
    nextEnd -= 1;
  }

  // Remove replaced/deleted nodes
  const removeCount = prevEnd - prefix + 1;
  if (removeCount > 0) {
    for (let i = prefix; i <= prevEnd; i += 1) {
      prevItems[i].node.remove();
    }
    prevItems.splice(prefix, removeCount);
  }

  // Insert newly added nodes before the anchor
  const anchorNode = prevItems[prefix]?.node || state.mirrorSentinel;
  const insertedCount = nextEnd - prefix + 1;
  const newItems = [];

  for (let i = 0; i < insertedCount; i += 1) {
    const ch = nextChars[prefix + i];
    let node;
    if (/\s/.test(ch)) {
      // Keep whitespace as plain text nodes so native pre-wrap line breaking matches 100%
      node = document.createTextNode(ch);
    } else {
      const span = document.createElement('span');
      span.className = animate ? 'char-glyph is-entering' : 'char-glyph';
      if (animate && insertedCount > 1) {
        span.style.animationDelay = `${Math.min(i * 14, 180)}ms`;
      }
      span.textContent = ch;
      if (animate) {
        span.addEventListener(
          'animationend',
          () => {
            span.classList.remove('is-entering');
            span.style.animationDelay = '';
          },
          { once: true }
        );
      }
      node = span;
    }

    els.intentionMirror.insertBefore(node, anchorNode);
    newItems.push({ char: ch, node });
  }

  if (newItems.length > 0) {
    prevItems.splice(prefix, 0, ...newItems);
  }

  // Update visual typography scale, ambient presence, and controls
  const len = nextChars.length;
  const trimmedLen = nextValue.trim().length;

  els.intentionEditor.classList.toggle('size-lg', len <= 72);
  els.intentionEditor.classList.toggle('size-md', len > 72 && len <= 145);
  els.intentionEditor.classList.toggle('size-sm', len > 145);

  const presence = Math.min(1, trimmedLen / 65);
  els.page.style.setProperty('--presence', presence.toFixed(3));
  els.intentionCanvas.classList.toggle('has-value', len > 0);
  els.page.classList.toggle('is-composing', state.phase === 'compose' && len > 0);
  els.submitBtn.disabled = trimmedLen === 0;

  els.composerHint.textContent =
    trimmedLen > 0
      ? 'Press Enter to submit · Shift+Enter for new line'
      : 'One prompt, one decision · Press Enter when ready';

  if (animate && insertedCount > 0) {
    els.intentionCanvas.classList.add('is-pulsing');
    if (state.pulseTimer) clearTimeout(state.pulseTimer);
    state.pulseTimer = setTimeout(() => {
      els.intentionCanvas.classList.remove('is-pulsing');
    }, 220);
  }
}

function clearCountdown() {
  if (state.countdownTimer) {
    clearInterval(state.countdownTimer);
    state.countdownTimer = null;
  }
}

function enterComposePhase({ promptText = null, prefill = '' } = {}) {
  clearCountdown();
  state.activeGrant = null;
  state.phase = 'compose';

  els.statusDot.classList.remove('unlocked', 'denied');
  els.page.classList.remove('is-settled');

  if (promptText) {
    els.promptLead.textContent = promptText;
  }

  els.intentionForm.hidden = false;
  els.submittedBlock.hidden = true;
  els.thinkingState.hidden = true;
  els.replyPanel.hidden = true;
  els.replyPanel.classList.remove('is-approved', 'is-denied', 'is-error');

  els.intentionInput.value = prefill;
  syncMirror(prefill, { animate: false });
  els.intentionInput.focus();
  els.intentionInput.setSelectionRange(prefill.length, prefill.length);
}

function enterEvaluatingPhase(intentionText) {
  state.phase = 'evaluating';
  state.lastIntention = intentionText;

  els.page.classList.remove('is-composing');
  els.page.classList.add('is-settled');
  els.page.style.setProperty('--presence', '0.75');

  els.intentionForm.hidden = true;
  els.submittedEyebrow.textContent = 'Your intention';
  els.submittedText.textContent = intentionText;
  els.submittedBlock.hidden = false;

  els.thinkingState.hidden = false;
  els.replyPanel.hidden = true;
}

function showApprovedReply(grant, messageText, intentionText = '') {
  clearCountdown();
  state.activeGrant = grant;
  state.phase = 'approved';

  els.page.classList.remove('is-composing');
  els.page.classList.add('is-settled');
  els.page.style.setProperty('--presence', '0.65');

  els.statusDot.classList.remove('denied');
  els.statusDot.classList.add('unlocked');

  els.intentionForm.hidden = true;
  els.thinkingState.hidden = true;

  const displayedIntention = intentionText || grant.summary || '';
  if (displayedIntention) {
    els.submittedEyebrow.textContent = 'Your intention';
    els.submittedText.textContent = displayedIntention;
    els.submittedBlock.hidden = false;
  } else {
    els.submittedBlock.hidden = true;
  }

  els.replyPanel.classList.remove('is-denied', 'is-error');
  els.replyPanel.classList.add('is-approved');
  els.verdictLabel.textContent = `Unlocked for ${grant.minutes} minute${grant.minutes === 1 ? '' : 's'}`;
  els.replyMessage.textContent = messageText || 'You are good to go.';

  els.countdownBox.hidden = false;
  els.continueBtn.textContent = `Continue to ${state.displayName} →`;
  els.continueBtn.hidden = false;
  els.lockEarlyBtn.hidden = false;
  els.replyCloseTabBtn.hidden = true;
  els.retryBtn.hidden = true;
  els.replyPanel.hidden = false;

  const countdownLabel = els.countdownBox.querySelector('.countdown-label');
  const updateTimer = () => {
    const currentGrant = state.activeGrant;
    if (!currentGrant) return;
    const remaining = getGrantRemainingMs(currentGrant, Date.now());
    if (remaining <= 0) {
      clearCountdown();
      els.reasonBadge.textContent = 'Session expired';
      els.reasonBadge.hidden = false;
      enterComposePhase({
        promptText: `Your time on ${state.displayName} is up. If something is still unfinished, name it clearly.`,
      });
      return;
    }
    if (countdownLabel) {
      countdownLabel.textContent =
        currentGrant.activeSince === null ? 'Ready · paused' : 'Remaining';
    }
    els.countdownValue.textContent = formatCountdown(remaining);
  };

  updateTimer();
  state.countdownTimer = setInterval(updateTimer, 1000);
  els.continueBtn.focus();
}

function showDeniedReply(messageText) {
  clearCountdown();
  state.activeGrant = null;
  state.phase = 'denied';

  els.page.classList.remove('is-composing');
  els.page.classList.add('is-settled');
  els.page.style.setProperty('--presence', '0.2');

  els.statusDot.classList.remove('unlocked');
  els.statusDot.classList.add('denied');

  els.intentionForm.hidden = true;
  els.thinkingState.hidden = true;

  els.replyPanel.classList.remove('is-approved', 'is-error');
  els.replyPanel.classList.add('is-denied');
  els.verdictLabel.textContent = 'Staying blocked for now';
  els.replyMessage.textContent = messageText || 'Keeping this site blocked for now.';

  els.countdownBox.hidden = true;
  els.continueBtn.hidden = true;
  els.lockEarlyBtn.hidden = true;
  els.retryBtn.hidden = true;
  els.replyCloseTabBtn.hidden = false;
  els.replyPanel.hidden = false;
  els.replyCloseTabBtn.focus();
}

function showErrorReply(errorMessage) {
  clearCountdown();
  state.phase = 'error';

  els.page.classList.remove('is-composing');
  els.page.classList.add('is-settled');

  els.intentionForm.hidden = true;
  els.thinkingState.hidden = true;

  els.replyPanel.classList.remove('is-approved', 'is-denied');
  els.replyPanel.classList.add('is-error');
  els.verdictLabel.textContent = 'Could not reach gatekeeper';
  els.replyMessage.textContent = errorMessage;

  els.countdownBox.hidden = true;
  els.continueBtn.hidden = true;
  els.lockEarlyBtn.hidden = true;
  els.replyCloseTabBtn.hidden = false;
  els.retryBtn.hidden = false;
  els.replyPanel.hidden = false;
  els.retryBtn.focus();
}

async function handleSubmit(e) {
  if (e) e.preventDefault();
  if (state.phase !== 'compose') return;

  const text = els.intentionInput.value.trim();
  if (!text) return;

  enterEvaluatingPhase(text);

  try {
    const response = await sendMessage({
      type: 'EVALUATE_INTENTION',
      siteId: state.site?.id || '',
      targetUrl: getDestinationUrl(),
      intention: text,
    });

    if (!response?.ok) {
      throw new Error(response?.error || 'Could not reach OpenRouter.');
    }

    const { result, grant, stats } = response;
    if (stats) renderStats(stats);

    if (result.decision === 'approve' && grant) {
      showApprovedReply(grant, result.message, text);
    } else {
      showDeniedReply(result.message);
    }
  } catch (err) {
    showErrorReply(err.message || 'Something went wrong talking to OpenRouter.');
  }
}

function closeCurrentTab() {
  window.close();
}

function buildPromptLead(displayName, stats, reason) {
  const todaySiteMins = Math.round(stats?.todaySite?.minutes || 0);
  const todaySiteCount = stats?.todaySite?.approvals || 0;

  if (reason === 'expired') {
    return `Your time on ${displayName} is up. If something is still unfinished, name it clearly.`;
  }
  if (todaySiteCount > 0) {
    return `You've unlocked ${displayName} ${todaySiteCount} time${todaySiteCount === 1 ? '' : 's'} today (${todaySiteMins}m). What is your intention right now?`;
  }
  return `Pause for a breath. What is your intention for opening ${displayName}?`;
}

async function init() {
  els.openSettingsBtn.addEventListener('click', () => chrome.runtime.openOptionsPage());
  els.setupOpenSettingsBtn.addEventListener('click', () => chrome.runtime.openOptionsPage());
  els.setupCloseTabBtn.addEventListener('click', closeCurrentTab);
  els.closeTabBtn.addEventListener('click', closeCurrentTab);
  els.replyCloseTabBtn.addEventListener('click', closeCurrentTab);

  els.retryBtn.addEventListener('click', () => {
    enterComposePhase({ prefill: state.lastIntention });
  });

  els.continueBtn.addEventListener('click', () => {
    const dest = getDestinationUrl();
    if (dest) {
      window.location.href = dest;
    }
  });

  els.lockEarlyBtn.addEventListener('click', async () => {
    if (!state.site) return;
    els.lockEarlyBtn.disabled = true;
    await sendMessage({ type: 'REVOKE_GRANT', siteId: state.site.id });
    els.lockEarlyBtn.disabled = false;
    els.reasonBadge.textContent = 'Locked';
    els.reasonBadge.hidden = false;
    enterComposePhase({
      promptText: `${state.displayName} is locked again. Set a fresh intention if you need to return.`,
    });
  });

  els.intentionCanvas.addEventListener('click', () => {
    if (state.phase === 'compose') {
      els.intentionInput.focus();
    }
  });

  els.intentionInput.addEventListener('input', () => {
    syncMirror(els.intentionInput.value, { animate: true });
  });

  els.intentionForm.addEventListener('submit', handleSubmit);
  els.intentionInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      handleSubmit();
    }
  });

  // Keyboard shortcuts once a verdict has arrived
  document.addEventListener('keydown', (e) => {
    if (state.phase === 'approved' && e.key === 'Enter' && document.activeElement !== els.lockEarlyBtn) {
      const dest = getDestinationUrl();
      if (dest) {
        e.preventDefault();
        window.location.href = dest;
      }
    } else if (
      state.phase === 'denied' &&
      (e.key === 'Escape' || (e.key === 'Enter' && document.activeElement === els.replyCloseTabBtn))
    ) {
      e.preventDefault();
      closeCurrentTab();
    }
  });

  const ctx = await sendMessage({
    type: 'GET_BLOCKED_CONTEXT',
    targetUrl: params.target,
    siteId: params.siteId,
  });

  if (!ctx?.ok) {
    els.siteName.textContent = 'Site Blocked';
    showErrorReply('Could not load extension state. Try reloading the page.');
    return;
  }

  state.site = ctx.site;
  renderStats(ctx.stats);
  renderRecentHistory(ctx.recentHistory);

  const displayName = ctx.site?.name || (params.target ? formatShortUrl(params.target) : 'Blocked Site');
  state.displayName = displayName;
  els.siteName.textContent = displayName;
  document.title = `Intentional Block — ${displayName}`;

  if (params.target) {
    els.targetUrlDisplay.textContent = formatShortUrl(params.target);
  } else if (ctx.site?.domains?.length) {
    els.targetUrlDisplay.textContent = ctx.site.domains.join(' · ');
  }

  if (params.reason === 'expired') {
    els.reasonBadge.textContent = 'Time is up';
    els.reasonBadge.hidden = false;
  } else if (params.reason === 'locked') {
    els.reasonBadge.textContent = 'Session locked';
    els.reasonBadge.hidden = false;
  }

  if (!ctx.hasApiKey) {
    els.setupCard.hidden = false;
    els.intentionStage.hidden = true;
    const onKeySaved = (changes, area) => {
      if (area === 'local' && changes.settings?.newValue?.apiKey?.trim()) {
        chrome.storage.onChanged.removeListener(onKeySaved);
        window.location.reload();
      }
    };
    chrome.storage.onChanged.addListener(onKeySaved);
    return;
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.grants || state.phase !== 'approved' || !state.site) return;
    const updatedGrant = changes.grants.newValue?.[state.site.id] || null;
    if (!updatedGrant || getGrantRemainingMs(updatedGrant, Date.now()) <= 0) {
      clearCountdown();
      els.reasonBadge.textContent = 'Session expired';
      els.reasonBadge.hidden = false;
      enterComposePhase({
        promptText: `Your time on ${state.displayName} is up. If something is still unfinished, name it clearly.`,
      });
    } else {
      state.activeGrant = updatedGrant;
    }
  });

  if (ctx.activeGrant) {
    showApprovedReply(
      ctx.activeGrant,
      `${displayName} is already unlocked right now. Continue whenever you're ready.`,
      ctx.activeGrant.summary || ''
    );
    return;
  }

  enterComposePhase({
    promptText: buildPromptLead(displayName, ctx.stats, params.reason),
  });
}

init();
