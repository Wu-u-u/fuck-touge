import { CUSTOM_CONFIG_KEY, normalizeCustomConfig } from "../shared/custom";

const BRIDGE_SOURCE = "fuck-touge-bridge";
const MAIN_SOURCE = "fuck-touge-main";

const post = (config: unknown): void => {
  try {
    window.postMessage({ source: BRIDGE_SOURCE, type: "config", config }, "*");
  } catch (e) {}
};

const push = (): void => {
  try {
    chrome.storage.local.get(CUSTOM_CONFIG_KEY, (result) => {
      if (chrome.runtime?.lastError) return;
      post(normalizeCustomConfig(result?.[CUSTOM_CONFIG_KEY]));
    });
  } catch (e) {
    post(normalizeCustomConfig(null));
  }
};

// MAIN world 在 document_start 可能还没装好监听；它准备好后会主动发 config-request。
window.addEventListener("message", (e: MessageEvent): void => {
  if (e.source !== window) return;
  const data = e.data as { source?: string; type?: string } | null;
  if (!data || data.source !== MAIN_SOURCE || data.type !== "config-request") return;
  push();
});

try {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes[CUSTOM_CONFIG_KEY]) return;
    post(normalizeCustomConfig(changes[CUSTOM_CONFIG_KEY].newValue));
  });
} catch (e) {}

push();
