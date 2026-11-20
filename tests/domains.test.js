import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDomainRegexFilter,
  findMatchingSite,
  hostnameMatchesDomain,
  isSafeHttpUrl,
  normalizeDomain,
  parseBlockedPageParams,
  parseDomainsInput,
} from '../src/lib/domains.js';

describe('normalizeDomain', () => {
  it('normalizes URLs, www prefixes, and paths', () => {
    assert.equal(normalizeDomain('https://www.instagram.com/reels/123'), 'instagram.com');
    assert.equal(normalizeDomain('HTTP://X.COM/home?foo=bar'), 'x.com');
    assert.equal(normalizeDomain('*.reddit.com'), 'reddit.com');
    assert.equal(normalizeDomain('  m.youtube.com/watch?v=1  '), 'm.youtube.com');
  });

  it('rejects invalid domains', () => {
    assert.equal(normalizeDomain(''), null);
    assert.equal(normalizeDomain('localhost'), null);
    assert.equal(normalizeDomain('not a domain'), null);
    assert.equal(normalizeDomain('http://bad_host'), null);
  });
});

describe('parseDomainsInput', () => {
  it('parses comma and space separated inputs with deduplication', () => {
    assert.deepEqual(parseDomainsInput('x.com, https://www.twitter.com/home  x.com'), [
      'x.com',
      'twitter.com',
    ]);
  });
});

describe('hostnameMatchesDomain & buildDomainRegexFilter', () => {
  it('matches exact domain and subdomains without matching lookalikes', () => {
    assert.equal(hostnameMatchesDomain('x.com', 'x.com'), true);
    assert.equal(hostnameMatchesDomain('mobile.x.com', 'x.com'), true);
    assert.equal(hostnameMatchesDomain('myx.com', 'x.com'), false);
    assert.equal(hostnameMatchesDomain('x.com.evil.org', 'x.com'), false);

    const re = new RegExp(buildDomainRegexFilter('x.com'), 'i');
    assert.equal(re.test('https://x.com'), true);
    assert.equal(re.test('https://x.com/compose/post?text=hi'), true);
    assert.equal(re.test('http://www.x.com/home'), true);
    assert.equal(re.test('https://X.COM/Home'), true);
    assert.equal(re.test('https://myx.com/home'), false);
    assert.equal(re.test('https://x.com.evil.org/'), false);
  });
});

describe('findMatchingSite', () => {
  const sites = [
    { id: 's1', name: 'X', domains: ['x.com', 'twitter.com'], enabled: true },
    { id: 's2', name: 'Reddit', domains: ['reddit.com'], enabled: false },
  ];

  it('matches enabled sites only', () => {
    assert.equal(findMatchingSite('https://twitter.com/user', sites)?.id, 's1');
    assert.equal(findMatchingSite('https://old.reddit.com/r/all', sites), null);
    assert.equal(findMatchingSite('chrome://extensions', sites), null);
  });
});

describe('parseBlockedPageParams & isSafeHttpUrl', () => {
  it('preserves raw DNR substituted URLs with query strings and hashes', () => {
    const href =
      'chrome-extension://abcdef/src/blocked.html?target=https://x.com/search?q=app&src=typed#latest';
    const parsed = parseBlockedPageParams(href);
    assert.equal(parsed.reason, 'blocked');
    assert.equal(parsed.target, 'https://x.com/search?q=app&src=typed#latest');
  });

  it('decodes encoded target URLs with reason and siteId', () => {
    const target = 'https://instagram.com/direct/inbox/?tab=1';
    const href = `chrome-extension://abcdef/src/blocked.html?reason=expired&siteId=site-ig&target=${encodeURIComponent(target)}`;
    const parsed = parseBlockedPageParams(href);
    assert.equal(parsed.reason, 'expired');
    assert.equal(parsed.siteId, 'site-ig');
    assert.equal(parsed.target, target);
  });

  it('rejects unsafe javascript: or chrome: target URLs', () => {
    assert.equal(isSafeHttpUrl('javascript:alert(1)'), false);
    assert.equal(isSafeHttpUrl('chrome://settings'), false);
    const parsed = parseBlockedPageParams(
      'chrome-extension://abcdef/src/blocked.html?target=javascript:alert(1)'
    );
    assert.equal(parsed.target, '');
  });
});
