const tt = document.getElementById("tt");
const tf = document.getElementById("tf");
const tc = document.getElementById("tc");
const themeSub = document.getElementById("themeSub");
const themePick = document.getElementById("themePick");
const opts = [...themePick.querySelectorAll(".opt")];
const msg = document.getElementById("msg");

const LABELS = { catppuccin: "Catppuccin", github: "GitHub 高对比" };

const isEducoder = url => /^https?:\/\/([^/]*\.)?educoder\.net\//.test(url || "");

async function withPage(func, args) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !isEducoder(tab.url)) return { ok: false, reason: "not-educoder" };
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: "MAIN",
      func,
      args,
    });
    return { ok: true, value: res ? res.result : undefined };
  } catch (e) {
    return { ok: false, reason: "error" };
  }
}

const setMsg = (text, warn) => {
  msg.textContent = text;
  msg.className = warn ? "desc warn" : "desc";
};

(async () => {
  const st = await withPage(() => (window.__fuckTougeUI ? window.__fuckTougeUI.get() : null));
  if (!st.ok) {
    tt.disabled = tf.disabled = tc.disabled = true;
    setMsg("当前页面不是头歌页面", true);
    return;
  }
  if (!st.value) {
    tt.disabled = tf.disabled = tc.disabled = true;
    setMsg("页面未就绪或脚本未注入，刷新页面后重试", true);
    return;
  }

  let picked = "catppuccin";
  const render = s => {
    tt.checked = !!s.theme;
    tf.checked = !!s.font;
    tc.checked = !!s.cursor;
    picked = LABELS[s.themeName] ? s.themeName : "catppuccin";
    themeSub.textContent = LABELS[picked] + " · 深浅自动";
    themePick.hidden = !tt.checked;
    opts.forEach(b => b.classList.toggle("on", b.dataset.name === picked));
  };
  render(st.value);
  setMsg("修改即时生效");

  const push = async next => {
    const r = await withPage(
      n => window.__fuckTougeUI && window.__fuckTougeUI.set(n),
      [next]
    );
    if (r.ok && r.value) {
      render(r.value);
      setMsg("修改即时生效");
    } else {
      setMsg("页面已刷新或不是头歌页面，请重试", true);
    }
  };
  const state = () => ({ theme: tt.checked, font: tf.checked, themeName: picked, cursor: tc.checked });

  tt.addEventListener("change", () => push(state()));
  tf.addEventListener("change", () => push(state()));
  tc.addEventListener("change", () => push(state()));
  opts.forEach(b => b.addEventListener("click", () => {
    picked = b.dataset.name;
    push(state());
  }));
})();
