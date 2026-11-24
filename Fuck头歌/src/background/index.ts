/** Service worker：按站点切换 popup，并为智慧树提供可信鼠标输入。 */
import { isZhsUrl } from "../sites/zhihuishu/types";

const ZHS_POPUP = "popup-zhihuishu.html";
const EDU_POPUP = "popup.html";
const attached = new Set<number>();
const detachTimers = new Map<number, ReturnType<typeof setTimeout>>();

const clearDetach = (tabId: number): void => {
  const timer = detachTimers.get(tabId);
  if (timer) clearTimeout(timer);
  detachTimers.delete(tabId);
};

const scheduleDetach = (tabId: number): void => {
  clearDetach(tabId);
  detachTimers.set(tabId, setTimeout(() => {
    detachTimers.delete(tabId);
    void detach(tabId);
  }, 1500));
};

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
  clearDetach(tabId);
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
  clearDetach(tabId);
  attached.delete(tabId);
  try {
    await chrome.debugger.detach({ tabId });
  } catch (e) {}
};

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId) {
    clearDetach(source.tabId);
    attached.delete(source.tabId);
  }
});

/** 页面刷新/扩展重载后旧的 debugger 会话会失效；清掉 attached 后重连一次。 */
const sendCommand = async (tabId: number, method: string, params: Record<string, unknown>): Promise<void> => {
  try {
    await attach(tabId);
    await chrome.debugger.sendCommand({ tabId }, method, params);
  } catch (error) {
    const message = String((error as any)?.message || error);
    if (!/Detached|not attached|Session closed|No tab with given id/i.test(message)) throw error;
    attached.delete(tabId);
    clearDetach(tabId);
    await attach(tabId);
    await chrome.debugger.sendCommand({ tabId }, method, params);
  }
};

const click = async (tabId: number, x: number, y: number): Promise<void> => {
  const px = Math.round(x);
  const py = Math.round(y);
  await sendCommand(tabId, "Input.dispatchMouseEvent", {
    type: "mouseMoved", x: px, y: py, button: "none", clickCount: 0,
  });
  await sendCommand(tabId, "Input.dispatchMouseEvent", {
    type: "mousePressed", x: px, y: py, button: "left", clickCount: 1,
  });
  await sendCommand(tabId, "Input.dispatchMouseEvent", {
    type: "mouseReleased", x: px, y: py, button: "left", clickCount: 1,
  });
  scheduleDetach(tabId);
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
    void sendCommand(tabId, "Input.dispatchMouseEvent", {
      type: "mouseMoved", x: Math.round(x), y: Math.round(y), button: "none", clickCount: 0,
    })
      .then(() => { scheduleDetach(tabId); sendResponse({ ok: true }); })
      .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }
  if (message?.type === "zhs:key" && message.key === "Escape") {
    void (async () => {
      const params = {
        key: "Escape", code: "Escape",
        windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27,
      };
      await sendCommand(tabId, "Input.dispatchKeyEvent", { type: "keyDown", ...params });
      await sendCommand(tabId, "Input.dispatchKeyEvent", { type: "keyUp", ...params });
      scheduleDetach(tabId);
    })()
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
