// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { initPopup, type PopupChromeApi } from "../../src/popup/popup";
import type { PublicSettings } from "../../src/shared/types";

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
    <div id="msg"></div>`;
}

function el(id: string): HTMLInputElement {
  return document.getElementById(id) as HTMLInputElement;
}

function makeApi(options: {
  url?: string;
  initial?: PublicSettings | null;
  themeDelay?: number;
  cursorDelay?: number;
} = {}) {
  let state: PublicSettings = options.initial ?? {
    theme: true,
    font: true,
    themeName: "catppuccin",
    cursor: false,
  };
  const api: PopupChromeApi = {
    tabs: {
      query: async () => [{ id: 1, url: options.url ?? "https://www.educoder.net/tasks/a/b/c" }],
    },
    scripting: {
      executeScript: async ({ args }) => {
        if (!args.length) {
          await sleep(1);
          return [{ result: options.initial === null ? null : { ...state } }];
        }
        const patch = args[0] as Partial<PublicSettings>;
        Object.assign(state, patch);
        const snapshot = { ...state };
        const delay = "theme" in patch ? (options.themeDelay ?? 60) : (options.cursorDelay ?? 5);
        await sleep(delay);
        return [{ result: snapshot }];
      },
    },
  };
  return { api, state: () => state };
}

beforeEach(() => {
  buildDom();
});

describe("popup 初始化", () => {
  it("读取状态并渲染开关与主题名", async () => {
    const { api } = makeApi();
    initPopup(api);
    await sleep(30);

    expect(el("tt").checked).toBe(true);
    expect(el("tf").checked).toBe(true);
    expect(el("tc").checked).toBe(false);
    expect(document.getElementById("themeSub")!.textContent).toContain("Catppuccin");
    expect(document.getElementById("msg")!.textContent).toBe("修改即时生效");
  });

  it("非头歌页面：禁用开关并提示", async () => {
    const { api } = makeApi({ url: "https://example.com/" });
    initPopup(api);
    await sleep(20);
    expect(el("tt").disabled).toBe(true);
    expect(document.getElementById("msg")!.textContent).toBe("当前页面不是头歌页面");
  });

  it("页面未就绪：禁用开关并提示刷新", async () => {
    const { api } = makeApi({ initial: null });
    initPopup(api);
    await sleep(20);
    expect(el("tf").disabled).toBe(true);
    expect(document.getElementById("msg")!.textContent).toContain("页面未就绪");
  });
});

describe("连点竞态（seq）", () => {
  it("慢响应（theme）不覆盖后发起的快响应（cursor）", async () => {
    const { api } = makeApi({ themeDelay: 60, cursorDelay: 5 });
    initPopup(api);
    await sleep(30);

    el("tt").click();
    el("tc").click();

    await sleep(120);
    expect(el("tt").checked).toBe(false);
    expect(el("tc").checked).toBe(true);
    expect(document.getElementById("msg")!.textContent).toBe("修改即时生效");
  });
});
