/**
 * Normalize user-supplied domain or URL into a clean lowercase hostname without www.
 * Returns null if invalid.
 */
export function normalizeDomain(input) {
  if (!input || typeof input !== 'string') return null;
  let value = input.trim().toLowerCase();
  if (!value) return null;

  // Strip protocol if provided
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    try {
      const parsed = new URL(value);
      value = parsed.hostname.toLowerCase();
    } catch {
      return null;
    }
  } else {
    // Strip path, query, hash, port
    value = value.split(/[/?#]/)[0];
    value = value.split(':')[0];
  }

  // Strip leading wildcard or www.
  value = value.replace(/^\*\./, '').replace(/^www\./, '').replace(/\.$/, '');

  // Basic hostname validation (must contain a dot and valid chars)
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(value)) {
    return null;
  }

  return value;
}

/**
 * Parse a comma/whitespace-separated domain string into unique normalized domains.
 */
export function parseDomainsInput(input) {
  if (!input || typeof input !== 'string') return [];
  const parts = input.split(/[\s,]+/).filter(Boolean);
  const seen = new Set();
  const result = [];
  for (const part of parts) {
    const normalized = normalizeDomain(part);
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      result.push(normalized);
    }
  }
  return result;
}

/**
 * Check if a hostname matches a normalized blocked domain (exact match or subdomain).
 */
export function hostnameMatchesDomain(hostname, domain) {
  if (!hostname || !domain) return false;
  const h = hostname.toLowerCase().replace(/\.$/, '');
  const d = domain.toLowerCase().replace(/\.$/, '');
  return h === d || h.endsWith(`.${d}`);
}

/**
 * Extract hostname from an http(s) URL, or return null for non-web URLs.
 */
export function getWebHostname(url) {
  if (!url || typeof url !== 'string') return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Validate a target redirect URL (only http/https allowed).
 */
export function isSafeHttpUrl(url) {
  return getWebHostname(url) !== null;
}

/**
 * Find the enabled site entry matching a given URL.
 */
export function findMatchingSite(url, sites) {
  const hostname = getWebHostname(url);
  if (!hostname || !Array.isArray(sites)) return null;
  for (const site of sites) {
    if (!site.enabled) continue;
    if (Array.isArray(site.domains) && site.domains.some((d) => hostnameMatchesDomain(hostname, d))) {
      return site;
    }
  }
  return null;
}

/**
 * Find any site entry (enabled or disabled) matching a hostname.
 */
export function findSiteByHostname(hostname, sites) {
  if (!hostname || !Array.isArray(sites)) return null;
  for (const site of sites) {
    if (Array.isArray(site.domains) && site.domains.some((d) => hostnameMatchesDomain(hostname, d))) {
      return site;
    }
  }
  return null;
}

/**
 * Escape a domain for RE2 regex used by chrome.declarativeNetRequest.
 */
export function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build a declarativeNetRequest regexFilter for a normalized domain.
 * Matches http/https on the domain and any subdomains.
 */
export function buildDomainRegexFilter(domain) {
  const escaped = escapeRegex(domain.toLowerCase());
  return `^https?://([a-z0-9-]+\\.)*${escaped}([:/?#].*)?$`;
}

/**
 * Extract the target URL from a blocked.html URL cleanly, preserving query params & hashes.
 * Supports:
 *   blocked.html?target=https://x.com/home?a=1&b=2#top
 *   blocked.html?reason=expired&target=https://x.com/home
 */
export function parseBlockedPageParams(fullHref) {
  try {
    const url = new URL(fullHref);
    const reason = url.searchParams.get('reason') || 'blocked';
    const siteId = url.searchParams.get('siteId') || '';

    // Because DNR regexSubstitution appends the raw target URL as ?target=\0,
    // parse raw everything after "target=" so target's own & and # are preserved.
    const rawQueryStart = fullHref.indexOf('?');
    let target = '';
    if (rawQueryStart !== -1) {
      const rawAfterQuery = fullHref.slice(rawQueryStart + 1);
      const match = rawAfterQuery.match(/(?:^|&)target=(.*)$/);
      if (match) {
        const rawTarget = match[1];
        // If it was URI-encoded (e.g. from tabs.update), decode it; if raw http(s):// from DNR, keep as-is.
        if (/^https?%3A%2F%2F/i.test(rawTarget)) {
          try {
            target = decodeURIComponent(rawTarget);
          } catch {
            target = rawTarget;
          }
        } else {
          target = rawTarget;
        }
      }
    }

    return {
      reason,
      siteId,
      target: isSafeHttpUrl(target) ? target : '',
    };
  } catch {
    return { reason: 'blocked', siteId: '', target: '' };
  }
}

/**
 * Format a concise URL display like "x.com/compose/post".
 */
export function formatShortUrl(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, '');
    const path = parsed.pathname === '/' ? '' : parsed.pathname;
    const combined = `${host}${path}`;
    return combined.length > 52 ? `${combined.slice(0, 49)}...` : combined;
  } catch {
    return url || '';
  }
}
