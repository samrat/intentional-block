export const STORAGE_KEYS = {
  SETTINGS: 'settings',
  SITES: 'sites',
  GRANTS: 'grants',
  HISTORY: 'history',
};

export const DEFAULT_MODEL = '';

export const DEFAULT_SETTINGS = {
  apiKey: '',
  model: DEFAULT_MODEL,
  disableThinking: false,
  strictness: 'balanced', // 'gentle' | 'balanced' | 'strict'
  maxMinutes: 45,
  customInstructions: '',
  showTimerPill: true,
};

export const DEFAULT_SITES = [
  {
    id: 'site-twitter',
    name: 'X / Twitter',
    domains: ['x.com', 'twitter.com'],
    enabled: true,
  },
  {
    id: 'site-instagram',
    name: 'Instagram',
    domains: ['instagram.com'],
    enabled: true,
  },
];

export const PRESET_SITES = [
  { name: 'X / Twitter', domains: ['x.com', 'twitter.com'] },
  { name: 'Instagram', domains: ['instagram.com'] },
  { name: 'Reddit', domains: ['reddit.com'] },
  { name: 'YouTube', domains: ['youtube.com'] },
  { name: 'TikTok', domains: ['tiktok.com'] },
  { name: 'Facebook', domains: ['facebook.com'] },
  { name: 'LinkedIn', domains: ['linkedin.com'] },
  { name: 'Twitch', domains: ['twitch.tv'] },
  { name: 'Hacker News', domains: ['news.ycombinator.com'] },
  { name: 'Threads', domains: ['threads.net', 'threads.com'] },
];

export const MAX_HISTORY_ENTRIES = 500;
export const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
