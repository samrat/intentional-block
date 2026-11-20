/**
 * Format a relative time string like "12m ago", "2h ago", "3d ago".
 */
export function formatRelativeTime(timestamp, now = Date.now()) {
  const diffMs = Math.max(0, now - timestamp);
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

/**
 * Compute usage statistics from history for both the UI and the AI context.
 */
export function computeUsageStats(history, siteId = null, now = Date.now()) {
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const todayMs = startOfToday.getTime();
  const sixHoursAgo = now - 6 * 60 * 60 * 1000;
  const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;

  const stats = {
    todayAll: { approvals: 0, denials: 0, minutes: 0 },
    todaySite: { approvals: 0, denials: 0, minutes: 0 },
    last6hAll: { approvals: 0, denials: 0, minutes: 0 },
    last6hSite: { approvals: 0, denials: 0, minutes: 0 },
    last7dAll: { approvals: 0, denials: 0, minutes: 0, byCategory: {} },
  };

  for (const item of history || []) {
    const ts = item.timestamp || 0;
    const isApproved = item.decision === 'approve';
    const mins = isApproved ? (typeof item.actualMinutes === 'number' ? item.actualMinutes : item.grantedMinutes || 0) : 0;
    const isThisSite = siteId && item.siteId === siteId;

    if (ts >= sevenDaysAgo) {
      if (isApproved) {
        stats.last7dAll.approvals += 1;
        stats.last7dAll.minutes += mins;
        const cat = item.category || 'other';
        stats.last7dAll.byCategory[cat] = (stats.last7dAll.byCategory[cat] || 0) + mins;
      } else {
        stats.last7dAll.denials += 1;
      }
    }

    if (ts >= todayMs) {
      if (isApproved) {
        stats.todayAll.approvals += 1;
        stats.todayAll.minutes += mins;
      } else {
        stats.todayAll.denials += 1;
      }
      if (isThisSite) {
        if (isApproved) {
          stats.todaySite.approvals += 1;
          stats.todaySite.minutes += mins;
        } else {
          stats.todaySite.denials += 1;
        }
      }
    }

    if (ts >= sixHoursAgo) {
      if (isApproved) {
        stats.last6hAll.approvals += 1;
        stats.last6hAll.minutes += mins;
      } else {
        stats.last6hAll.denials += 1;
      }
      if (isThisSite) {
        if (isApproved) {
          stats.last6hSite.approvals += 1;
          stats.last6hSite.minutes += mins;
        } else {
          stats.last6hSite.denials += 1;
        }
      }
    }
  }

  return stats;
}

const STRICTNESS_GUIDANCE = {
  gentle:
    'Tone & strictness: GENTLE. Be supportive and trusting. Approve brief leisure breaks (5-10 min) readily unless usage has been very heavy today. Give generous windows (15-45 min) for purposeful or creative work.',
  balanced:
    'Tone & strictness: BALANCED. Be warm, pragmatic, and observant — like a thoughtful accountability partner. Brief leisure/blowing off steam is completely fine in moderation (3-7 min), unless they already had multiple leisure unlocks recently. Purposeful tasks (posting app updates, screenshots, specific replies, research) merit generous time (10-30 min, up to max). Push back gently on vague autopilot impulses or repeated back-to-back scrolling.',
  strict:
    'Tone & strictness: STRICT. Guard their focus firmly (never rude, always respectful). Keep casual scrolling very short (2-5 min) and deny it if they already scrolled in the last 3-4 hours. Require clear, specific intentions before granting longer productive blocks (10-20 min).',
};

/**
 * Build the system prompt given current site, settings, and history.
 */
export function buildSystemPrompt({ site, targetUrl, settings, history, now = Date.now() }) {
  const maxMinutes = Math.max(1, Math.min(180, Number(settings?.maxMinutes) || 45));
  const strictnessText = STRICTNESS_GUIDANCE[settings?.strictness] || STRICTNESS_GUIDANCE.balanced;
  const stats = computeUsageStats(history, site?.id, now);

  const localTimeStr = new Date(now).toLocaleString('en-US', {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });

  const recentEntries = (history || []).slice(0, 20);
  let historyBlock = 'No prior unlock history yet — this is a fresh start.';
  if (recentEntries.length > 0) {
    historyBlock = recentEntries
      .map((entry) => {
        const rel = formatRelativeTime(entry.timestamp, now);
        const outcome =
          entry.decision === 'approve'
            ? `APPROVED ${entry.grantedMinutes}m${
                typeof entry.actualMinutes === 'number' && entry.actualMinutes < entry.grantedMinutes
                  ? ` (ended early at ${entry.actualMinutes}m)`
                  : ''
              }`
            : 'DENIED';
        const label = entry.summary || entry.intention || '(no summary)';
        return `- [${rel}] ${entry.siteName || entry.domain} | ${outcome} | ${entry.category || 'other'} | "${label}"`;
      })
      .join('\n');
  }

  const categoryBreakdown = Object.entries(stats.last7dAll.byCategory)
    .map(([k, v]) => `${k}: ${Math.round(v)}m`)
    .join(', ');

  const customBlock = settings?.customInstructions?.trim()
    ? `\nUser's personal rules & context (follow closely):\n${settings.customInstructions.trim()}\n`
    : '';

  return `You are the AI Gatekeeper inside "Intentional Block", a focus extension that keeps distracting sites blocked by default until the user states a clear intention.

This is a SINGLE-TURN evaluation: the user gives ONE intention and you give ONE final decision. There is NO back-and-forth chat, NO follow-up questions, and NO haggling.

Your job is to weigh their stated intention alongside their recent usage history and make a clear, grounded call:
1. "approve" — grant temporary access for an appropriate number of minutes (between 1 and ${maxMinutes}).
2. "deny" — keep the site blocked when the intention is too vague/autopilot (e.g. "idk", "just checking", "bored"), when their history shows heavy or repeated mindless scrolling, or when the request goes against their focus goals.

How to size the time allotment when approving:
- Casual break / blowing off steam / scrolling: short guilt-free window (typically 3–7 minutes), provided they haven't been repeatedly scrolling recently.
- Quick specific check (check one notification, reply to a specific DM, look up one link): 5–10 minutes.
- Purposeful / creative / work task (posting app updates or screenshots, writing a thread, customer support, focused research): generous task-appropriate window (typically 15–30 minutes, up to ${maxMinutes} min max).
- Always factor in their recent history below! Notice patterns naturally (e.g., if they just had 2 leisure sessions in the last hour, gently decline or keep it brief; if they've been focused all day, a 5-minute breather is totally fair).
- Never ask a follow-up question or invite a reply — your message is the final word for this visit.

${strictnessText}
${customBlock}
Current Context:
- Local time: ${localTimeStr}
- Blocked site: ${site?.name || 'Site'} (${(site?.domains || []).join(', ')})
- Target URL: ${targetUrl || '(site homepage)'}
- Today (this site): ${stats.todaySite.approvals} unlocks, ${Math.round(stats.todaySite.minutes)} min used (${stats.todaySite.denials} denied)
- Today (all blocked sites): ${stats.todayAll.approvals} unlocks, ${Math.round(stats.todayAll.minutes)} min used
- Last 6 hours (all blocked sites): ${stats.last6hAll.approvals} unlocks, ${Math.round(stats.last6hAll.minutes)} min used
- Last 7 days total: ${stats.last7dAll.approvals} unlocks, ${Math.round(stats.last7dAll.minutes)} min used${categoryBreakdown ? ` (${categoryBreakdown})` : ''}

Recent History (newest first):
${historyBlock}

CRITICAL OUTPUT FORMAT:
Respond ONLY with a single valid JSON object — no markdown code fences, no extra text before or after.
Schema:
{
  "decision": "approve" | "deny",
  "minutes": <integer from 1 to ${maxMinutes} if decision is "approve", otherwise 0>,
  "summary": "<concise 3-8 word summary of the user's stated intention>",
  "category": "productive" | "communication" | "leisure" | "habitual" | "other",
  "message": "<your concise 1-2 sentence final reply to the user, with no questions>"
}

Example approval:
{"decision":"approve","minutes":20,"summary":"Post app update screenshots","category":"productive","message":"Posting progress screenshots is a solid reason to hop on. I've unlocked X for 20 minutes so you can compose and share without rushing."}

Example short leisure approval:
{"decision":"approve","minutes":5,"summary":"Quick scroll to blow off steam","category":"leisure","message":"You haven't taken a break in a few hours — 5 minutes to unwind sounds fair. Enjoy the breather."}

Example denial:
{"decision":"deny","minutes":0,"summary":"Another casual scroll session","category":"habitual","message":"You already scrolled Instagram twice in the last hour (12 min total). Give your brain a real break before hopping back in."}`;
}

const VALID_DECISIONS = new Set(['approve', 'deny']);
const VALID_CATEGORIES = new Set(['productive', 'communication', 'leisure', 'habitual', 'other']);

/**
 * Robustly extract and validate the Gatekeeper JSON decision from any LLM output.
 */
export function parseGatekeeperResponse(rawContent, maxMinutes = 45) {
  const safeMax = Math.max(1, Math.min(180, Number(maxMinutes) || 45));
  const text = (rawContent || '').trim();

  if (!text) {
    return {
      decision: 'deny',
      minutes: 0,
      summary: 'Intention not approved',
      category: 'other',
      message: 'Keeping this site blocked for now — take a breath and come back with a clear intention.',
    };
  }

  const candidates = [];

  // 1. Direct text
  candidates.push(text);

  // 2. Inside markdown code fences
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch && fenceMatch[1]) {
    candidates.push(fenceMatch[1].trim());
  }

  // 3. First outermost JSON object
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    candidates.push(text.slice(firstBrace, lastBrace + 1));
  }

  let parsed = null;
  for (const candidate of candidates) {
    try {
      const obj = JSON.parse(candidate);
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
        parsed = obj;
        break;
      }
    } catch {
      // Try next candidate
    }
  }

  if (!parsed) {
    // Graceful fallback if the model returned plain text — never start a chat loop
    return {
      decision: 'deny',
      minutes: 0,
      summary: 'Intention reviewed',
      category: 'other',
      message: text.slice(0, 600),
    };
  }

  const rawDecision = String(parsed.decision || '').toLowerCase().trim();
  const decision = VALID_DECISIONS.has(rawDecision) ? rawDecision : 'deny';

  let minutes = 0;
  if (decision === 'approve') {
    const num = Math.round(Number(parsed.minutes));
    minutes = Number.isFinite(num) && num > 0 ? Math.min(safeMax, Math.max(1, num)) : 5;
  }

  const rawCategory = String(parsed.category || 'other').toLowerCase().trim();
  const category = VALID_CATEGORIES.has(rawCategory) ? rawCategory : 'other';

  const summary =
    typeof parsed.summary === 'string' && parsed.summary.trim()
      ? parsed.summary.trim().slice(0, 120)
      : 'Stated intention';

  const message =
    typeof parsed.message === 'string' && parsed.message.trim()
      ? parsed.message.trim()
      : decision === 'approve'
        ? `Unlocked for ${minutes} minute${minutes === 1 ? '' : 's'}.`
        : 'Keeping this site blocked for now.';

  return {
    decision,
    minutes,
    summary,
    category,
    message,
  };
}
