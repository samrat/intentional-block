# Intentional Block

A Manifest V3 Chrome extension that keeps distracting sites blocked **all the time** — no complex schedules or time-window rules. Whenever you try to open a blocked site, you pause at an **Intention Gate** powered by **OpenRouter** — one prompt, one reply.

State your intention clearly:
- Want to blow off steam and scroll for a few minutes? If you haven't been scrolling nonstop, you'll get a short guilt-free break (e.g. 5 minutes).
- Want to post updates or screenshots of your app? You'll get a generous task-appropriate window (e.g. 15–30 minutes).
- Trying to scroll for the fourth time in an hour? The gatekeeper sees your recent history and keeps the site blocked.

## Features

- **Always-on blocking** with zero-flash `declarativeNetRequest` redirects plus automatic tab lockout when time expires.
- **Single-turn AI Intention Gate** — one prompt and one decisive reply (approve with a tailored duration or stay blocked), with no chat haggling.
- **OpenRouter integration** — bring your own API key and enter any OpenRouter model ID.
- **Subtle in-page countdown pill** (toggleable) so you see your remaining time and can lock early with one click once you're done.
- **Simple Blocked Sites list** — comes with X/Twitter and Instagram ready to go, plus quick-add presets and one-click blocking of the current tab from the toolbar popup.
- **Full Intention History** — searchable log with stats and JSON export.

## Install in Chrome (Load Unpacked)

No build step required!

1. Open Chrome and go to `chrome://extensions`.
2. Toggle **Developer mode** on (top-right corner).
3. Click **Load unpacked** and select this folder (`/Users/samrat/code/intentional-block`).
4. Click the **Intentional Block** extension icon (or open its **Settings**) and paste your [OpenRouter API key](https://openrouter.ai/keys).
5. Pick your preferred model, click **Test OpenRouter Connection**, and hit **Save Settings**.

## Running Tests

```bash
node --test tests/*.test.js
```
