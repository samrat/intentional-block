import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSystemPrompt,
  computeUsageStats,
  parseGatekeeperResponse,
} from '../src/lib/prompt.js';

describe('computeUsageStats', () => {
  it('aggregates today, last 6h, and last 7d stats accurately', () => {
    const now = new Date('2026-11-20T15:00:00').getTime();
    const history = [
      {
        timestamp: now - 30 * 60 * 1000, // 30m ago
        siteId: 'site-twitter',
        decision: 'approve',
        grantedMinutes: 20,
        actualMinutes: 12, // ended early
        category: 'productive',
      },
      {
        timestamp: now - 2 * 60 * 60 * 1000, // 2h ago
        siteId: 'site-instagram',
        decision: 'approve',
        grantedMinutes: 5,
        category: 'leisure',
      },
      {
        timestamp: now - 3 * 60 * 60 * 1000, // 3h ago
        siteId: 'site-twitter',
        decision: 'deny',
        grantedMinutes: 0,
        category: 'habitual',
      },
      {
        timestamp: now - 3 * 24 * 60 * 60 * 1000, // 3d ago
        siteId: 'site-twitter',
        decision: 'approve',
        grantedMinutes: 15,
        category: 'productive',
      },
    ];

    const stats = computeUsageStats(history, 'site-twitter', now);
    assert.equal(stats.todayAll.approvals, 2);
    assert.equal(stats.todayAll.denials, 1);
    assert.equal(stats.todayAll.minutes, 17); // 12 + 5
    assert.equal(stats.todaySite.approvals, 1);
    assert.equal(stats.todaySite.denials, 1);
    assert.equal(stats.todaySite.minutes, 12);
    assert.equal(stats.last7dAll.approvals, 3);
    assert.equal(stats.last7dAll.minutes, 32);
    assert.equal(stats.last7dAll.byCategory.productive, 27);
    assert.equal(stats.last7dAll.byCategory.leisure, 5);
  });
});

describe('buildSystemPrompt', () => {
  it('injects site info, history entries, and custom instructions', () => {
    const now = new Date('2026-11-20T15:00:00').getTime();
    const prompt = buildSystemPrompt({
      site: { id: 'site-twitter', name: 'X / Twitter', domains: ['x.com', 'twitter.com'] },
      targetUrl: 'https://x.com/compose/post',
      settings: {
        strictness: 'balanced',
        maxMinutes: 30,
        customInstructions: 'App launch week — prioritize posting updates.',
      },
      history: [
        {
          timestamp: now - 45 * 60 * 1000,
          siteId: 'site-twitter',
          siteName: 'X / Twitter',
          decision: 'approve',
          grantedMinutes: 5,
          category: 'leisure',
          summary: 'Quick breather scroll',
        },
      ],
      now,
    });

    assert.match(prompt, /X \/ Twitter/);
    assert.match(prompt, /https:\/\/x\.com\/compose\/post/);
    assert.match(prompt, /App launch week/);
    assert.match(prompt, /Quick breather scroll/);
    assert.match(prompt, /APPROVED 5m/);
    assert.match(prompt, /between 1 and 30/);
    assert.match(prompt, /SINGLE-TURN/);
    assert.doesNotMatch(prompt, /"clarify"/);
  });
});

describe('parseGatekeeperResponse', () => {
  it('parses clean JSON approval and clamps minutes to maxMinutes', () => {
    const raw = JSON.stringify({
      decision: 'approve',
      minutes: 120,
      summary: 'Post app screenshots',
      category: 'productive',
      message: 'Go for it!',
    });

    const parsed = parseGatekeeperResponse(raw, 45);
    assert.equal(parsed.decision, 'approve');
    assert.equal(parsed.minutes, 45);
    assert.equal(parsed.summary, 'Post app screenshots');
    assert.equal(parsed.category, 'productive');
    assert.equal(parsed.message, 'Go for it!');
  });

  it('extracts JSON wrapped in markdown code fences', () => {
    const raw =
      'Here is my decision:\n```json\n{"decision":"deny","minutes":10,"summary":"Repeat scrolling","category":"habitual","message":"Take a break first."}\n```';
    const parsed = parseGatekeeperResponse(raw, 45);
    assert.equal(parsed.decision, 'deny');
    assert.equal(parsed.minutes, 0);
    assert.equal(parsed.category, 'habitual');
    assert.equal(parsed.message, 'Take a break first.');
  });

  it('falls back to deny without starting a chat loop when model returns plain text or clarify', () => {
    const plain = parseGatekeeperResponse('Please stay focused for now.', 45);
    assert.equal(plain.decision, 'deny');
    assert.equal(plain.minutes, 0);
    assert.equal(plain.message, 'Please stay focused for now.');

    const clarify = parseGatekeeperResponse(
      JSON.stringify({
        decision: 'clarify',
        minutes: 0,
        summary: 'Vague request',
        category: 'other',
        message: 'Too vague.',
      }),
      45
    );
    assert.equal(clarify.decision, 'deny');
    assert.equal(clarify.minutes, 0);
    assert.equal(clarify.message, 'Too vague.');
  });
});
