(() => {
  const HOST_ID = 'intentional-block-timer-pill-host';
  if (document.getElementById(HOST_ID)) return;

  function formatCountdown(ms) {
    const totalSec = Math.max(0, Math.ceil(ms / 1000));
    const mins = Math.floor(totalSec / 60);
    const secs = totalSec % 60;
    return `${mins}:${String(secs).padStart(2, '0')}`;
  }

  function computeRemainingMs(grant) {
    if (!grant) return 0;
    if (typeof grant.remainingMs === 'number') {
      if (typeof grant.activeSince === 'number' && !document.hidden && document.hasFocus()) {
        return Math.max(0, grant.remainingMs - Math.max(0, Date.now() - grant.activeSince));
      }
      return Math.max(0, grant.remainingMs);
    }
    if (typeof grant.expiresAt === 'number') {
      return Math.max(0, grant.expiresAt - Date.now());
    }
    return 0;
  }

  let currentGrant = null;
  let pillEl = null;
  let timeEl = null;
  let summaryEl = null;
  let intervalId = null;

  function renderTick() {
    if (!currentGrant || !pillEl || !timeEl) return;

    const isRunning =
      typeof currentGrant.activeSince === 'number' && !document.hidden && document.hasFocus();
    const remaining = computeRemainingMs(currentGrant);

    pillEl.classList.toggle('paused', !isRunning);
    pillEl.classList.toggle('warning', isRunning && remaining <= 60 * 1000);
    timeEl.textContent = formatCountdown(remaining);

    if (remaining <= 0) {
      timeEl.textContent = '0:00';
      pillEl.classList.add('warning');
    }
  }

  function refreshFromBackground() {
    chrome.runtime.sendMessage({ type: 'GET_ACTIVE_GRANT_FOR_TAB' }, (response) => {
      if (chrome.runtime.lastError) return;
      if (!response?.ok || !response.grant) {
        document.getElementById(HOST_ID)?.remove();
        if (intervalId) clearInterval(intervalId);
        return;
      }
      currentGrant = response.grant;
      if (summaryEl) {
        summaryEl.textContent = currentGrant.summary || currentGrant.siteName || 'Active session';
      }
      renderTick();
    });
  }

  function mountPill(grant) {
    if (document.getElementById(HOST_ID)) return;
    currentGrant = grant;

    const host = document.createElement('div');
    host.id = HOST_ID;
    host.style.cssText =
      'position:fixed;bottom:16px;right:16px;z-index:2147483647;font-family:-apple-system,BlinkMacSystemFont,"Inter","Segoe UI",sans-serif;';

    const shadow = host.attachShadow({ mode: 'closed' });
    shadow.innerHTML = `
      <style>
        * { box-sizing: border-box; }
        .pill {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 7px 12px;
          border-radius: 999px;
          background: rgba(17, 20, 28, 0.88);
          color: #eef0f6;
          border: 1px solid rgba(255, 255, 255, 0.14);
          box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
          backdrop-filter: blur(12px);
          -webkit-backdrop-filter: blur(12px);
          font-size: 12px;
          line-height: 1;
          user-select: none;
          transition: all 0.2s ease;
        }
        .pill.paused {
          opacity: 0.72;
        }
        .pill.warning {
          background: rgba(120, 53, 15, 0.92);
          border-color: rgba(251, 191, 36, 0.5);
          color: #fef3c7;
        }
        .dot {
          width: 7px;
          height: 7px;
          border-radius: 50%;
          background: #34d399;
          flex-shrink: 0;
        }
        .pill.paused .dot {
          background: #94a3b8;
        }
        .pill.warning .dot {
          background: #fbbf24;
        }
        .time {
          font-variant-numeric: tabular-nums;
          font-weight: 600;
          letter-spacing: 0.02em;
        }
        .paused-tag {
          display: none;
          font-size: 10px;
          text-transform: uppercase;
          letter-spacing: 0.05em;
          color: #94a3b8;
        }
        .pill.paused .paused-tag {
          display: inline;
        }
        .details {
          display: none;
          align-items: center;
          gap: 8px;
          padding-left: 4px;
          border-left: 1px solid rgba(255, 255, 255, 0.16);
        }
        .pill.expanded .details,
        .pill:hover .details {
          display: flex;
        }
        .summary {
          max-width: 180px;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          color: rgba(238, 240, 246, 0.82);
        }
        .lock-btn {
          appearance: none;
          border: 1px solid rgba(255, 255, 255, 0.2);
          background: rgba(255, 255, 255, 0.08);
          color: #fff;
          font-size: 11px;
          font-weight: 500;
          padding: 4px 8px;
          border-radius: 999px;
          cursor: pointer;
          white-space: nowrap;
        }
        .lock-btn:hover {
          background: rgba(248, 113, 113, 0.25);
          border-color: rgba(248, 113, 113, 0.55);
        }
      </style>
      <div class="pill" title="Intentional Block active session (pauses automatically when you leave this tab)">
        <span class="dot"></span>
        <span class="time"></span>
        <span class="paused-tag">Paused</span>
        <div class="details">
          <span class="summary"></span>
          <button class="lock-btn" type="button">Lock now</button>
        </div>
      </div>
    `;

    pillEl = shadow.querySelector('.pill');
    timeEl = shadow.querySelector('.time');
    summaryEl = shadow.querySelector('.summary');
    const lockBtn = shadow.querySelector('.lock-btn');

    summaryEl.textContent = grant.summary || grant.siteName || 'Active session';

    pillEl.addEventListener('click', (e) => {
      if (e.target === lockBtn) return;
      pillEl.classList.toggle('expanded');
    });

    lockBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      lockBtn.disabled = true;
      lockBtn.textContent = 'Locking...';
      chrome.runtime.sendMessage({ type: 'REVOKE_GRANT', siteId: currentGrant.siteId });
    });

    chrome.runtime.onMessage.addListener((message) => {
      if (message?.type === 'GRANT_UPDATE' && message.grant?.siteId === currentGrant?.siteId) {
        currentGrant = message.grant;
        renderTick();
      }
    });

    window.addEventListener('focus', refreshFromBackground);
    window.addEventListener('blur', renderTick);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        refreshFromBackground();
      } else {
        renderTick();
      }
    });

    renderTick();
    intervalId = setInterval(renderTick, 1000);
    document.documentElement.appendChild(host);
  }

  chrome.runtime.sendMessage({ type: 'GET_ACTIVE_GRANT_FOR_TAB' }, (response) => {
    if (chrome.runtime.lastError || !response?.ok || !response.grant) return;
    mountPill(response.grant);
  });
})();
