/**
 * Pure active-time grant helpers.
 *
 * A grant only counts down while the user is actively viewing a tab on that site
 * in a focused browser window (`activeSince !== null`). When the user switches tabs,
 * switches apps, or closes the tab, elapsed active time is settled into `remainingMs`
 * / `usedMs` and `activeSince` becomes `null` (paused).
 */

export function createGrant({
  siteId,
  siteName,
  historyId,
  minutes,
  summary,
  category,
  now = Date.now(),
}) {
  const totalMs = Math.max(1, Number(minutes) || 1) * 60 * 1000;
  return {
    siteId,
    siteName,
    historyId,
    grantedAt: now,
    minutes,
    totalMs,
    remainingMs: totalMs,
    usedMs: 0,
    activeSince: null, // Starts paused until the user actually enters the site
    summary,
    category,
  };
}

/**
 * Normalize a grant (including migrating legacy wall-clock `expiresAt` grants).
 */
export function normalizeGrant(grant, now = Date.now()) {
  if (!grant || typeof grant !== 'object') return null;

  if (typeof grant.remainingMs === 'number') {
    const totalMs =
      typeof grant.totalMs === 'number'
        ? grant.totalMs
        : Math.max(grant.remainingMs, (Number(grant.minutes) || 1) * 60 * 1000);
    return {
      ...grant,
      totalMs,
      remainingMs: Math.max(0, grant.remainingMs),
      usedMs: typeof grant.usedMs === 'number' ? Math.max(0, grant.usedMs) : 0,
      activeSince: typeof grant.activeSince === 'number' ? grant.activeSince : null,
    };
  }

  // Legacy migration from wall-clock `expiresAt`
  if (typeof grant.expiresAt === 'number') {
    const remainingMs = Math.max(0, grant.expiresAt - now);
    const totalMs = Math.max(remainingMs, (Number(grant.minutes) || 1) * 60 * 1000);
    return {
      ...grant,
      totalMs,
      remainingMs,
      usedMs: Math.max(0, totalMs - remainingMs),
      activeSince: null,
    };
  }

  return null;
}

/**
 * Compute live remaining milliseconds for a grant at time `now`.
 */
export function getGrantRemainingMs(grant, now = Date.now()) {
  const norm = normalizeGrant(grant, now);
  if (!norm) return 0;
  if (norm.activeSince === null) return norm.remainingMs;
  const elapsed = Math.max(0, now - norm.activeSince);
  return Math.max(0, norm.remainingMs - elapsed);
}

/**
 * Compute total active milliseconds spent on a grant up to `now`.
 */
export function getGrantUsedMs(grant, now = Date.now()) {
  const norm = normalizeGrant(grant, now);
  if (!norm) return 0;
  if (norm.activeSince === null) return norm.usedMs;
  const elapsed = Math.min(norm.remainingMs, Math.max(0, now - norm.activeSince));
  return norm.usedMs + elapsed;
}

/**
 * Whether a grant still has remaining time left.
 */
export function isGrantActive(grant, now = Date.now()) {
  return getGrantRemainingMs(grant, now) > 0;
}

/**
 * Return projected wall-clock expiry timestamp if currently running, or null if paused.
 */
export function getGrantProjectedExpiry(grant) {
  if (!grant || typeof grant.activeSince !== 'number' || typeof grant.remainingMs !== 'number') {
    return null;
  }
  return grant.activeSince + Math.max(0, grant.remainingMs);
}

/**
 * Settle elapsed active time across all grants and transition each grant to running
 * or paused depending on whether its site is in `focusedSiteIds`.
 *
 * Returns `{ grants, expiredSiteIds, changed }`.
 */
export function reconcileGrantsForFocusedSites(
  rawGrants,
  focusedSiteIds = new Set(),
  now = Date.now(),
  { validSiteIds = null, skipElapsedDeduction = false } = {}
) {
  const nextGrants = {};
  const expiredSiteIds = [];
  let changed = false;

  for (const [siteId, raw] of Object.entries(rawGrants || {})) {
    if (validSiteIds && !validSiteIds.has(siteId)) {
      changed = true;
      continue;
    }

    const norm = normalizeGrant(raw, now);
    if (!norm) {
      changed = true;
      continue;
    }

    // Detect legacy migration
    if (typeof raw.remainingMs !== 'number') {
      changed = true;
    }

    let remainingMs = norm.remainingMs;
    let usedMs = norm.usedMs;
    const wasRunning = norm.activeSince !== null;

    if (wasRunning && !skipElapsedDeduction) {
      const elapsed = Math.max(0, now - norm.activeSince);
      const deducted = Math.min(remainingMs, elapsed);
      remainingMs -= deducted;
      usedMs += deducted;
      if (deducted > 0) changed = true;
    }

    if (remainingMs <= 0) {
      expiredSiteIds.push(siteId);
      changed = true;
      continue;
    }

    const shouldRun = focusedSiteIds.has(siteId);
    const nextActiveSince = shouldRun ? now : null;

    if (wasRunning !== shouldRun || (shouldRun && norm.activeSince !== nextActiveSince)) {
      changed = true;
    }

    nextGrants[siteId] = {
      ...norm,
      remainingMs,
      usedMs,
      activeSince: nextActiveSince,
    };
  }

  return { grants: nextGrants, expiredSiteIds, changed };
}
