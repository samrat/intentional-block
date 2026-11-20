import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createGrant,
  getGrantProjectedExpiry,
  getGrantRemainingMs,
  getGrantUsedMs,
  reconcileGrantsForFocusedSites,
} from '../src/lib/grants.js';

describe('active-time grants', () => {
  it('starts paused until the user focuses the site', () => {
    const t0 = 1_000_000;
    const grant = createGrant({
      siteId: 'site-x',
      siteName: 'X / Twitter',
      historyId: 'h1',
      minutes: 5,
      summary: 'Post screenshots',
      category: 'productive',
      now: t0,
    });

    assert.equal(grant.activeSince, null);
    assert.equal(getGrantProjectedExpiry(grant), null);
    // 2 minutes later while still away, zero time should be deducted
    assert.equal(getGrantRemainingMs(grant, t0 + 120_000), 300_000);
    assert.equal(getGrantUsedMs(grant, t0 + 120_000), 0);
  });

  it('counts down only while the site is focused and pauses when switching away', () => {
    const t0 = 1_000_000;
    let grants = {
      'site-x': createGrant({
        siteId: 'site-x',
        siteName: 'X / Twitter',
        historyId: 'h1',
        minutes: 5,
        summary: 'Quick scroll',
        category: 'leisure',
        now: t0,
      }),
    };

    // User enters X at t0 + 10s
    let res = reconcileGrantsForFocusedSites(grants, new Set(['site-x']), t0 + 10_000);
    grants = res.grants;
    assert.equal(grants['site-x'].activeSince, t0 + 10_000);
    assert.equal(grants['site-x'].remainingMs, 300_000);
    assert.equal(getGrantProjectedExpiry(grants['site-x']), t0 + 310_000);

    // 90 seconds pass while on X -> 3m30s left
    assert.equal(getGrantRemainingMs(grants['site-x'], t0 + 100_000), 210_000);
    assert.equal(getGrantUsedMs(grants['site-x'], t0 + 100_000), 90_000);

    // User switches to VS Code at t0 + 100s -> pauses cleanly at 210s remaining
    res = reconcileGrantsForFocusedSites(grants, new Set(), t0 + 100_000);
    grants = res.grants;
    assert.equal(grants['site-x'].activeSince, null);
    assert.equal(grants['site-x'].remainingMs, 210_000);
    assert.equal(grants['site-x'].usedMs, 90_000);
    assert.equal(getGrantProjectedExpiry(grants['site-x']), null);

    // 10 minutes pass in VS Code -> still 210s remaining!
    res = reconcileGrantsForFocusedSites(grants, new Set(), t0 + 700_000);
    grants = res.grants;
    assert.equal(grants['site-x'].remainingMs, 210_000);

    // User returns to X at t0 + 700s -> resumes with 210s left
    res = reconcileGrantsForFocusedSites(grants, new Set(['site-x']), t0 + 700_000);
    grants = res.grants;
    assert.equal(grants['site-x'].activeSince, t0 + 700_000);
    assert.equal(getGrantProjectedExpiry(grants['site-x']), t0 + 910_000);

    // 210 seconds later while on X -> expires!
    res = reconcileGrantsForFocusedSites(grants, new Set(['site-x']), t0 + 910_000);
    assert.deepEqual(res.expiredSiteIds, ['site-x']);
    assert.equal(res.grants['site-x'], undefined);
  });

  it('migrates legacy wall-clock expiresAt grants gracefully', () => {
    const now = 5_000_000;
    const legacy = {
      'site-ig': {
        siteId: 'site-ig',
        siteName: 'Instagram',
        minutes: 10,
        expiresAt: now + 180_000,
      },
    };

    const res = reconcileGrantsForFocusedSites(legacy, new Set(), now);
    assert.equal(res.changed, true);
    assert.equal(res.grants['site-ig'].remainingMs, 180_000);
    assert.equal(res.grants['site-ig'].activeSince, null);
  });
});
