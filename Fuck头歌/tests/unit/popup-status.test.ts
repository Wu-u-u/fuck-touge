// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initPopup, type PopupChromeApi } from "../../src/popup/popup";
import {
  SCRIPT_LOGS_CLEARED_KEY,
  SCRIPT_LOGS_KEY,
  SCRIPT_STATUS_KEY,
  type ScriptLogEntry,
  type ScriptStatus,
} from "../../src/shared/script-status";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function buildDom(): void {
  document.body.innerHTML = `
    <input id="tt" type="checkbox">
    <input id="tf" type="checkbox">
    <input id="tc" type="checkbox">
    <div id="themeSub"></div>
    <div id="themePick">
      <button class="opt" data-name="catppuccin"></button>
      <button class="opt" data-name="github"></button>
    </div>
    <div id="msg"></div>
    <div id="scriptCard" data-state="red">
      <span id="scriptTitle"></span>
      <span id="scriptSlot"></span>
      <div id="scriptMeta"></div>
      <div id="scriptMsg"></div>
    </div>
    <span id="logCount"></span>
    <div id="logList"></div>
    <button id="copyLogs"></button>
    <button id="clearLogs"></button>`;
}

const status = (patch: Partial<ScriptStatus> = {}): ScriptStatus => ({
  version: 1,
  updatedAt: Date.now(),
  state: "running",
  slot: "15",
  course: "数据结构与算法2026秋季",
  chapter: "实验二：树",
  level: "第3关",
  message: "正在写代码",
  ...patch,
});

const log = (patch: Partial<ScriptLogEntry> = {}): ScriptLogEntry => ({
  at: Date.now(),
  level: "info",
  slot: "15",
  course: "数据结构与算法2026秋季",
  chapter: "实验二：树",
  levelName: "第3关",
  text: "评测成功",
  ...patch,
});

function makeApi(initialStatus: ScriptStatus | null, initialLogs: ScriptLogEntry[], deferGet = false) {
  const items: Record<string, unknown> = {
    [SCRIPT_STATUS_KEY]: initialStatus,
    [SCRIPT_LOGS_KEY]: initialLogs,
  };
  const listeners: Array<(changes: Record<string, { newValue?: unknown }>, area: string) => void> = [];
  const removed: string[] = [];
  const pendingGets: Array<() => void> = [];
  const api: PopupChromeApi = {
    tabs: {
      query: async () => [{ id: 1, url: "https://www.educoder.net/tasks/a/b/c" }],
    },
    scripting: {
      executeScript: async () => [
        {
          result: { theme: true, font: true, themeName: "catppuccin", cursor: false },
        },
      ],
    },
    storage: {
      local: {
        get: (_keys, callback) => {
          const run = () => callback({ ...items });
          if (deferGet) pendingGets.push(run);
          else run();
        },
        set: (patch) => Object.assign(items, patch),
        remove: (keys, callback) => {
          for (const key of Array.isArray(keys) ? keys : [keys]) {
            removed.push(key);
            delete items[key];
          }
          callback?.();
        },
      },
      onChanged: {
        addListener: (callback) => listeners.push(callback),
        removeListener: (callback) => {
          const i = listeners.indexOf(callback);
          if (i >= 0) listeners.splice(i, 1);
        },
      },
    },
  };
  return { api, items, listeners, removed, pendingGets };
}

beforeEach(buildDom);
afterEach(() => {
  window.dispatchEvent(new Event("unload"));
  document.body.innerHTML = "";
});

describe("popup 脚本状态", () => {
  it("dispose 移除 storage 监听且可重复调用", async () => {
    const { api, listeners } = makeApi(status(), [log()]);
    const dispose = initPopup(api);
    await sleep(20);
    expect(listeners.length).toBe(2);
    dispose();
    expect(listeners.length).toBe(0);
    dispose();
    expect(listeners.length).toBe(0);
  });

  it("dispose 后 clipboard promise resolve 不再改复制按钮", async () => {
    let resolveWrite: (() => void) | null = null;
    const writeText = vi.fn(() => new Promise<void>((resolve) => { resolveWrite = resolve; }));
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const { api } = makeApi(status(), [log()]);
    const dispose = initPopup(api);
    await sleep(20);
    const copy = document.getElementById("copyLogs") as HTMLButtonElement;
    copy.click();
    await sleep(0);
    expect(writeText).toHaveBeenCalledTimes(1);
    dispose();
    resolveWrite?.();
    await sleep(0);
    expect(copy.textContent).toBe("");
  });

  it("dispose 后到达的 storage 回调不再渲染", () => {
    const { api, pendingGets } = makeApi(status({ message: "迟到的状态" }), [], true);
    const dispose = initPopup(api);
    expect(pendingGets.length).toBeGreaterThan(0);
    dispose();
    pendingGets.forEach((fn) => fn());
    expect(document.getElementById("scriptTitle")!.textContent).toBe("");
    expect(document.getElementById("scriptMeta")!.textContent).toBe("");
  });

  it("running 绿色，显示当前槽位/课程，并渲染日志", async () => {
    const { api } = makeApi(status(), [log(), log({ text: "开始评测", level: "warn" })]);
    initPopup(api);
    await sleep(20);

    expect(document.getElementById("scriptCard")!.dataset.state).toBe("green");
    expect(document.getElementById("scriptTitle")!.textContent).toBe("运行中");
    expect(document.getElementById("scriptSlot")!.textContent).toBe("槽位 15");
    expect(document.getElementById("scriptMeta")!.textContent).toContain("数据结构与算法2026秋季");
    expect(document.getElementById("scriptMsg")!.textContent).toBe("正在写代码");
    expect(document.getElementById("logCount")!.textContent).toBe("2");
    expect(document.getElementById("logList")!.textContent).toContain("评测成功");
    expect(document.getElementById("logList")!.textContent).toContain("第3关");
    expect((document.getElementById("copyLogs") as HTMLButtonElement).disabled).toBe(false);
  });

  it("日志的课程/章节变化时更新行 title（签名包含上下文）", async () => {
    const { api, listeners } = makeApi(status(), [log({ course: "课程一", chapter: "章一" })]);
    initPopup(api);
    await sleep(20);
    expect((document.querySelector(".log-item") as HTMLElement).title).toContain("课程一");

    listeners.forEach((cb) => cb({ [SCRIPT_LOGS_KEY]: { newValue: [log({ course: "课程二", chapter: "章二" })] } }, "local"));
    await sleep(10);
    expect((document.querySelector(".log-item") as HTMLElement).title).toContain("课程二");
  });

  it("心跳只改 updatedAt 时不重写状态节点，message 变化才更新", async () => {
    const { api, listeners } = makeApi(status(), [log()]);
    initPopup(api);
    await sleep(20);
    const card = document.getElementById("scriptCard")!;
    let mutations = 0;
    const obs = new MutationObserver((records) => { mutations += records.length; });
    obs.observe(card, { childList: true, subtree: true, characterData: true, attributes: true });

    // 只推进 updatedAt，可见文案（context 作为 meta）不变
    listeners.forEach((cb) => cb({ [SCRIPT_STATUS_KEY]: { newValue: status({ updatedAt: Date.now() + 1000 }) } }, "local"));
    await sleep(10);
    expect(mutations).toBe(0);

    listeners.forEach((cb) => cb({ [SCRIPT_STATUS_KEY]: { newValue: status({ message: "新消息" }) } }, "local"));
    await sleep(10);
    expect(mutations).toBeGreaterThan(0);
    obs.disconnect();
  });

  it("多槽位：只显示当前状态槽位日志（旧格式无 slot 保留）", async () => {
    const { api, listeners } = makeApi(status({ slot: "1" }), [
      log({ slot: "1", text: "槽位一日志" }),
      log({ slot: "2", text: "槽位二日志" }),
      log({ slot: "", text: "旧格式日志" }),
    ]);
    initPopup(api);
    await sleep(20);
    expect(document.getElementById("logCount")!.textContent).toBe("2");
    expect(document.getElementById("logList")!.textContent).toContain("槽位一日志");
    expect(document.getElementById("logList")!.textContent).toContain("旧格式日志");
    expect(document.getElementById("logList")!.textContent).not.toContain("槽位二日志");

    listeners.forEach((cb) => cb({ [SCRIPT_STATUS_KEY]: { newValue: status({ slot: "2" }) } }, "local"));
    expect(document.getElementById("logCount")!.textContent).toBe("2");
    expect(document.getElementById("logList")!.textContent).toContain("槽位二日志");
    expect(document.getElementById("logList")!.textContent).not.toContain("槽位一日志");
  });

  it("心跳只改状态时不重建日志 DOM；槽位变化才重建", async () => {
    const { api, listeners } = makeApi(status(), [log()]);
    initPopup(api);
    await sleep(20);
    const list = document.getElementById("logList")!;
    let mutations = 0;
    const obs = new MutationObserver((records) => { mutations += records.length; });
    obs.observe(list, { childList: true, subtree: true, characterData: true });

    listeners.forEach((cb) => cb({ [SCRIPT_STATUS_KEY]: { newValue: status({ message: "新消息" }) } }, "local"));
    await sleep(10);
    expect(mutations).toBe(0);
    obs.disconnect();

    let changed = 0;
    const obs2 = new MutationObserver((records) => { changed += records.length; });
    obs2.observe(list, { childList: true, subtree: true });
    listeners.forEach((cb) => cb({ [SCRIPT_STATUS_KEY]: { newValue: status({ slot: "2" }) } }, "local"));
    await sleep(10);
    expect(changed).toBeGreaterThan(0);
    obs2.disconnect();
  });

  it("waiting / stopped 黄色，10.31s 无心跳红色", async () => {
    const { api, listeners } = makeApi(status({ state: "waiting", message: "等待中" }), []);
    initPopup(api);
    await sleep(20);
    expect(document.getElementById("scriptCard")!.dataset.state).toBe("yellow");
    expect(document.getElementById("scriptTitle")!.textContent).toBe("等待中");

    const stopped = status({ state: "stopped", updatedAt: Date.now() - 60_000, message: "正常结束" });
    listeners.forEach((cb) => cb({ [SCRIPT_STATUS_KEY]: { newValue: stopped } }, "local"));
    expect(document.getElementById("scriptCard")!.dataset.state).toBe("yellow");
    expect(document.getElementById("scriptTitle")!.textContent).toBe("已停止");

    const stale = status({ state: "running", updatedAt: Date.now() - 10_400 });
    listeners.forEach((cb) => cb({ [SCRIPT_STATUS_KEY]: { newValue: stale } }, "local"));
    expect(document.getElementById("scriptCard")!.dataset.state).toBe("red");
    expect(document.getElementById("scriptTitle")!.textContent).toBe("刷题脚本未执行");
    expect(document.getElementById("scriptMsg")!.textContent).toContain("10.31");
  });

  it("复制只包含当前槽位日志，槽位切换后跟随", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const { api, listeners } = makeApi(status({ slot: "1" }), [
      log({ slot: "1", text: "槽位一日志" }),
      log({ slot: "2", text: "槽位二日志" }),
    ]);
    initPopup(api);
    await sleep(20);
    const copy = document.getElementById("copyLogs") as HTMLButtonElement;

    copy.click();
    await sleep(0);
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText.mock.calls[0][0]).toContain("槽位一日志");
    expect(writeText.mock.calls[0][0]).not.toContain("槽位二日志");

    listeners.forEach((cb) => cb({ [SCRIPT_STATUS_KEY]: { newValue: status({ slot: "2" }) } }, "local"));
    copy.click();
    await sleep(0);
    expect(writeText).toHaveBeenCalledTimes(2);
    expect(writeText.mock.calls[1][0]).toContain("槽位二日志");
    expect(writeText.mock.calls[1][0]).not.toContain("槽位一日志");
  });

  it("清空只清当前槽位，其他槽位历史保留", async () => {
    const { api, listeners, items } = makeApi(status({ slot: "1" }), [
      log({ slot: "1", text: "槽位一日志" }),
      log({ slot: "2", text: "槽位二日志" }),
    ]);
    initPopup(api);
    await sleep(20);

    (document.getElementById("clearLogs") as HTMLButtonElement).click();
    await sleep(10);
    expect(document.getElementById("logList")!.textContent).toContain("暂无日志");
    expect((items[SCRIPT_LOGS_KEY] as Array<{ text: string }>).map((x) => x.text)).toEqual(["槽位二日志"]);

    listeners.forEach((cb) => cb({ [SCRIPT_STATUS_KEY]: { newValue: status({ slot: "2" }) } }, "local"));
    expect(document.getElementById("logList")!.textContent).toContain("槽位二日志");
    expect((document.getElementById("copyLogs") as HTMLButtonElement).disabled).toBe(false);
  });

  it("重载/重开时 marker 仍过滤清空前的旧日志", async () => {
    const now = Date.now();
    const oldLog = log({ slot: "1", text: "marker-old", at: now - 5000 });
    const freshLog = log({ slot: "1", text: "marker-fresh", at: now + 1000 });
    const { api, items } = makeApi(status({ slot: "1" }), [oldLog, freshLog]);
    items[SCRIPT_LOGS_CLEARED_KEY] = { "1": now };
    initPopup(api);
    await sleep(20);
    expect(document.getElementById("logList")!.textContent).toContain("marker-fresh");
    expect(document.getElementById("logList")!.textContent).not.toContain("marker-old");
    expect(document.getElementById("logCount")!.textContent).toBe("1");
  });

  it("清空后 bridge 并发写回旧日志会被 marker 过滤（含无 slot 旧格式）", async () => {
    const now = Date.now();
    const oldLog = log({ slot: "1", text: "旧日志", at: now - 1000 });
    const legacy = log({ slot: "", text: "旧格式", at: now - 800 });
    const { api, listeners, items } = makeApi(status({ slot: "1" }), [oldLog, legacy]);
    initPopup(api);
    await sleep(20);
    (document.getElementById("clearLogs") as HTMLButtonElement).click();
    await sleep(5);
    const marker = items[SCRIPT_LOGS_CLEARED_KEY] as Record<string, number>;
    expect(marker["1"]).toBeTruthy();
    expect(marker[""]).toBeTruthy();

    // 模拟 bridge 在清空后写回清空前的旧日志（含无 slot）
    listeners.forEach((cb) => cb({ [SCRIPT_LOGS_KEY]: { newValue: [oldLog, legacy] } }, "local"));
    expect(document.getElementById("logList")!.textContent).toContain("暂无日志");
  });

  it("当前槽位无日志时复制/清空禁用（其他槽位有日志）", async () => {
    const { api } = makeApi(status({ slot: "3" }), [log({ slot: "1", text: "别的槽位" })]);
    initPopup(api);
    await sleep(20);
    expect((document.getElementById("copyLogs") as HTMLButtonElement).disabled).toBe(true);
    expect((document.getElementById("clearLogs") as HTMLButtonElement).disabled).toBe(true);
  });

  it("清空日志：按钮禁用，storage.remove 被调用", async () => {
    const { api, removed } = makeApi(status({ state: "error", message: "评测失败" }), [log()]);
    initPopup(api);
    await sleep(20);

    expect(document.getElementById("scriptCard")!.dataset.state).toBe("red");
    expect(document.getElementById("scriptTitle")!.textContent).toBe("脚本错误");
    (document.getElementById("clearLogs") as HTMLButtonElement).click();
    await sleep(5);
    expect(removed).toContain(SCRIPT_LOGS_KEY);
    expect(document.getElementById("logCount")!.textContent).toBe("0");
    expect((document.getElementById("copyLogs") as HTMLButtonElement).disabled).toBe(true);
    expect((document.getElementById("clearLogs") as HTMLButtonElement).disabled).toBe(true);
  });
});
