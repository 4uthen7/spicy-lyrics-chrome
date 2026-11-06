/**
 * Service worker: install defaults, settings persistence, the toolbar action
 * command, and the small message bridge used by the popup.
 */
importScripts('../shared/contract.js', '../shared/store.js');

const SL = globalThis.SL;

const SPOTIFY_TABS = 'https://open.spotify.com/*';

async function activeSpotifyTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true, url: SPOTIFY_TABS });
  if (tab) return tab;
  const [fallback] = await chrome.tabs.query({ url: SPOTIFY_TABS });
  return fallback || null;
}

chrome.runtime.onInstalled.addListener(async (details) => {
  try {
    const got = await chrome.storage.sync.get(SL.store.SETTINGS_KEY);
    if (!got || !got[SL.store.SETTINGS_KEY]) {
      await chrome.storage.sync.set({ [SL.store.SETTINGS_KEY]: SL.store.DEFAULT_SETTINGS });
    }
  } catch (err) {
    console.warn('[spicy] install defaults failed', err);
  }
  if (details.reason === 'install') {
    chrome.tabs.create({ url: 'https://open.spotify.com/' }).catch(() => {});
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle-overlay') return;
  const tab = await activeSpotifyTab();
  if (!tab) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'spicy:toggle' });
  } catch {
    /* content script not injected yet */
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') return false;

  if (message.type === 'spicy:clear-cache') {
    const tab = sender && sender.tab;
    if (tab && tab.id) {
      chrome.tabs.sendMessage(tab.id, { type: 'spicy:clear-cache' }).catch(() => {});
    }
    SL.store.clearCache().then((count) => sendResponse({ ok: true, cleared: count }));
    return true;
  }

  if (message.type === 'spicy:get-settings') {
    chrome.storage.sync
      .get(SL.store.SETTINGS_KEY)
      .then((got) => sendResponse({ ok: true, settings: SL.store.sanitizeSettings(got[SL.store.SETTINGS_KEY]) }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (message.type === 'spicy:set-settings') {
    const settings = SL.store.sanitizeSettings(message.settings);
    chrome.storage.sync
      .set({ [SL.store.SETTINGS_KEY]: settings })
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (message.type === 'spicy:open-overlay' || message.type === 'spicy:toggle') {
    activeSpotifyTab()
      .then((tab) => (tab ? chrome.tabs.sendMessage(tab.id, { type: message.type }) : null))
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  return false;
});
