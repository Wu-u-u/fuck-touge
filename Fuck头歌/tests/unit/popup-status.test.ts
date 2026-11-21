// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initPopup, type PopupChromeApi } from "../../src/popup/popup";
import {
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

function makeApi(initialStatus: ScriptStatus | null, initialLogs: ScriptLogEntry[]) {
  const items: Record<string, unknown> = {
    [SCRIPT_STATUS_KEY]: initialStatus,
    [SCRIPT_LOGS_KEY]: initialLogs,
  };
  const listeners: Array<(changes: Record<string, { newValue?: unknown }>, area: string) => void> = [];
  const removed: string[] = [];
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
        get: (_keys, callback) => callback({ ...items }),
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
      },
    },
  };
  return { api, items, listeners, removed };
}

beforeEach(buildDom);
afterEach(() => {
  window.dispatchEvent(new Event("unload"));
  document.body.innerHTML = "";
});

describe("popup 脚本状态", () => {
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
