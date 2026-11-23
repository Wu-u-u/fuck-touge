/** Service worker：按站点切换 popup，并为智慧树提供可信鼠标输入。 */
import { isZhsUrl } from "../sites/zhihuishu/types";

const ZHS_POPUP = "popup-zhihuishu.html";
const EDU_POPUP = "popup.html";
const attached = new Set<number>();

const setPopup = (tabId: number, url: string | undefined): void => {
  const popup = isZhsUrl(url) ? ZHS_POPUP : EDU_POPUP;
  try {
    void chrome.action.setPopup({ tabId, popup });
  } catch (e) {}
};

const syncTab = (tabId: number): void => {
  try {
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError) return;
      setPopup(tabId, tab?.url);
    });
  } catch (e) {}
};

chrome.tabs.onActivated.addListener(({ tabId }) => syncTab(tabId));
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url || changeInfo.status === "complete") setPopup(tabId, tab.url);
});
chrome.tabs.onRemoved.addListener((tabId) => {
  attached.delete(tabId);
  try {
    void chrome.debugger.detach({ tabId });
  } catch (e) {}
});

const attach = async (tabId: number): Promise<void> => {
  if (attached.has(tabId)) return;
  try {
    await chrome.debugger.attach({ tabId }, "1.3");
  } catch (error) {
    // 扩展重载后，旧的 debugger 会话可能还挂在 tab 上；能发命令就说明仍是自己的。
    const message = String((error as any)?.message || error);
    if (!/already attached/i.test(message)) throw error;
    await chrome.debugger.sendCommand({ tabId }, "Page.enable");
    attached.add(tabId);
    return;
  }
  attached.add(tabId);
  try {
    await chrome.debugger.sendCommand({ tabId }, "Page.enable");
  } catch (e) {}
};

const detach = async (tabId: number): Promise<void> => {
  attached.delete(tabId);
  try {
    await chrome.debugger.detach({ tabId });
  } catch (e) {}
};

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId) attached.delete(source.tabId);
});

const click = async (tabId: number, x: number, y: number): Promise<void> => {
  await attach(tabId);
  const px = Math.round(x);
  const py = Math.round(y);
  await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
    type: "mouseMoved", x: px, y: py, button: "none", clickCount: 0,
  });
  await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
    type: "mousePressed", x: px, y: py, button: "left", clickCount: 1,
  });
  await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
    type: "mouseReleased", x: px, y: py, button: "left", clickCount: 1,
  });
};

chrome.runtime.onMessage.addListener((message: any, sender, sendResponse) => {
  const tabId = sender.tab?.id;
  if (!tabId) {
    sendResponse({ ok: false, error: "没有可操作的标签页" });
    return false;
  }
  if (message?.type === "zhs:attach") {
    void attach(tabId)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }
  if (message?.type === "zhs:detach") {
    void detach(tabId)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }
  if (message?.type === "zhs:move") {
    const x = Number(message.x);
    const y = Number(message.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      sendResponse({ ok: false, error: "移动坐标无效" });
      return false;
    }
    void attach(tabId)
      .then(() => chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
        type: "mouseMoved", x: Math.round(x), y: Math.round(y), button: "none", clickCount: 0,
      }))
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }
  if (message?.type === "zhs:click") {
    const x = Number(message.x);
    const y = Number(message.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      sendResponse({ ok: false, error: "点击坐标无效" });
      return false;
    }
    void click(tabId, x, y)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }
  return false;
});

const syncAll = (): void => {
  try {
    chrome.tabs.query({}, (tabs) => {
      for (const tab of tabs) if (tab.id) setPopup(tab.id, tab.url);
    });
  } catch (e) {}
};

chrome.runtime.onInstalled.addListener(syncAll);
chrome.runtime.onStartup.addListener(syncAll);
void syncAll();
