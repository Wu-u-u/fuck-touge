import type { PublicSettings } from "../shared/types";

/** 最小 Chrome API 面（便于单测注入；真实弹窗用全局 chrome） */
export interface PopupChromeApi {
  tabs: {
    query(queryInfo: { active: boolean; currentWindow: boolean }): Promise<
      Array<{ id?: number; url?: string }>
    >;
  };
  scripting: {
    executeScript<T = unknown>(injection: {
      target: { tabId: number };
      world: "MAIN";
      func: (...args: any[]) => T;
      args: any[];
    }): Promise<Array<{ result?: T }>>;
  };
}

const LABELS: Record<string, string> = { catppuccin: "Catppuccin", github: "GitHub 高对比" };

const isEducoder = (url?: string): boolean =>
  /^https?:\/\/([^/]*\.)?educoder\.net\//.test(url || "");

export function initPopup(chromeApi: PopupChromeApi, doc: Document = document): void {
  const tt = doc.getElementById("tt") as HTMLInputElement;
  const tf = doc.getElementById("tf") as HTMLInputElement;
  const tc = doc.getElementById("tc") as HTMLInputElement;
  const themeSub = doc.getElementById("themeSub") as HTMLElement;
  const themePick = doc.getElementById("themePick") as HTMLElement;
  const opts = [...themePick.querySelectorAll<HTMLElement>(".opt")];
  const msg = doc.getElementById("msg") as HTMLElement;

  const setMsg = (text: string, warn = false): void => {
    msg.textContent = text;
    msg.className = warn ? "desc warn" : "desc";
  };

  async function withPage<T>(
    func: (...args: any[]) => T,
    args: any[] = [],
  ): Promise<{ ok: boolean; value?: T }> {
    const [tab] = await chromeApi.tabs.query({ active: true, currentWindow: true });
    if (!tab || !isEducoder(tab.url) || tab.id == null) return { ok: false };
    try {
      const [res] = await chromeApi.scripting.executeScript({
        target: { tabId: tab.id },
        world: "MAIN",
        func,
        args,
      });
      return { ok: true, value: res ? res.result : undefined };
    } catch (e) {
      return { ok: false };
    }
  }

  (async () => {
    const st = await withPage(() => (window.__fuckTougeUI ? window.__fuckTougeUI.get() : null));
    if (!st.ok) {
      tt.disabled = tf.disabled = tc.disabled = true;
      setMsg("当前页面不是头歌页面", true);
      return;
    }
    const initial = st.value;
    if (!initial) {
      tt.disabled = tf.disabled = tc.disabled = true;
      setMsg("页面未就绪或脚本未注入，刷新页面后重试", true);
      return;
    }

    let picked = "catppuccin";
    const render = (s: PublicSettings): void => {
      tt.checked = !!s.theme;
      tf.checked = !!s.font;
      tc.checked = !!s.cursor;
      picked = LABELS[s.themeName] ? s.themeName : "catppuccin";
      themeSub.textContent = LABELS[picked] + " · 深浅自动";
      themePick.hidden = !tt.checked;
      opts.forEach((b) => {
        const on = b.dataset.name === picked;
        b.classList.toggle("on", on);
        b.setAttribute("aria-pressed", String(on)); // 主题选项是“按下”式切换按钮，状态同步给读屏
      });
    };
    render(initial);
    setMsg("修改即时生效");

    // 连点竞态：tabs.query / executeScript 的完成顺序不保证，旧请求的响应可能后到，
    // 把新请求刚渲染的状态又盖回去 —— 给每次请求发一个单调递增序号，
    // 响应回来时限次不同（已有更新操作存在）→ 过期响应整条丢弃：不渲染、不再提示。
    // 同时只推本次变化的字段：页面端 __fuckTougeUI.set 支持局部更新，全量快照反而放大竞态窗口。
    let seq = 0;
    const push = async (patch: Partial<PublicSettings>): Promise<void> => {
      const my = ++seq;
      const r = await withPage(
        (n: Partial<PublicSettings>) => window.__fuckTougeUI && window.__fuckTougeUI.set(n),
        [patch],
      );
      if (my !== seq) return;
      if (r.ok && r.value) {
        render(r.value);
        setMsg("修改即时生效");
      } else {
        setMsg("页面已刷新或不是头歌页面，请重试", true);
      }
    };

    tt.addEventListener("change", () => push({ theme: tt.checked }));
    tf.addEventListener("change", () => push({ font: tf.checked }));
    tc.addEventListener("change", () => push({ cursor: tc.checked }));
    opts.forEach((b) =>
      b.addEventListener("click", () =>
        push({ themeName: b.dataset.name as PublicSettings["themeName"] }),
      ),
    );
  })();
}

// 真实弹窗环境自动初始化；单测（jsdom，无 chrome）只导入 initPopup
if (typeof chrome !== "undefined" && typeof document !== "undefined") {
  initPopup(chrome as unknown as PopupChromeApi);
}
