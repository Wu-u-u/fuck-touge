// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  PASTE_ATTRS,
  PASTE_ATTR_SELECTOR,
  installAttrCleaner,
  stripAttrs,
} from "../../src/features/attrs";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("attrs 选择器", () => {
  it("只覆盖 onpaste / oncopy / oncut", () => {
    expect([...PASTE_ATTRS]).toEqual(["onpaste", "oncopy", "oncut"]);
    expect(PASTE_ATTR_SELECTOR).toBe("[onpaste],[oncopy],[oncut]");
    expect(PASTE_ATTR_SELECTOR).not.toContain("ondrop");
    expect(PASTE_ATTR_SELECTOR).not.toContain("oncontextmenu");
  });
});

describe("stripAttrs", () => {
  it("清除容器及子元素上的三个属性，保留 ondrop / oncontextmenu", () => {
    const root = document.createElement("div");
    root.setAttribute("onpaste", "x");
    root.setAttribute("ondrop", "y");
    root.setAttribute("oncontextmenu", "z");
    const child = document.createElement("span");
    child.setAttribute("oncopy", "a");
    child.setAttribute("oncut", "b");
    child.setAttribute("oncontextmenu", "c");
    root.appendChild(child);
    document.body.appendChild(root);

    stripAttrs(root);

    expect(root.hasAttribute("onpaste")).toBe(false);
    expect(root.hasAttribute("ondrop")).toBe(true); // 不动
    expect(root.hasAttribute("oncontextmenu")).toBe(true);
    expect(child.hasAttribute("oncopy")).toBe(false);
    expect(child.hasAttribute("oncut")).toBe(false);
    expect(child.hasAttribute("oncontextmenu")).toBe(true);

    root.remove();
  });

  it("清除 body 上的三个属性", () => {
    document.body.setAttribute("onpaste", "x");
    document.body.setAttribute("oncut", "y");
    stripAttrs(document);
    expect(document.body.hasAttribute("onpaste")).toBe(false);
    expect(document.body.hasAttribute("oncut")).toBe(false);
  });
});

describe("installAttrCleaner", () => {
  it("安装时清理已有节点，之后新增节点也会被清理", async () => {
    const old = document.createElement("div");
    old.setAttribute("onpaste", "x");
    document.body.appendChild(old);

    installAttrCleaner();
    expect(old.hasAttribute("onpaste")).toBe(false);

    const added = document.createElement("div");
    added.setAttribute("oncopy", "y");
    document.body.appendChild(added);
    await tick();
    expect(added.hasAttribute("oncopy")).toBe(false);

    old.remove();
    added.remove();
  });

  it("之后新挂上的属性会被监听并移除", async () => {
    installAttrCleaner();
    const el = document.createElement("div");
    document.body.appendChild(el);
    el.setAttribute("oncut", "z");
    await tick();
    expect(el.hasAttribute("oncut")).toBe(false);
    el.remove();
  });
});
