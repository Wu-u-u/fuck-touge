"""页面操作层：状态/探针 JS、probe_state 与 Page（按文本点击、等待、评测等）。"""

import json
import time

import cdp

from .util import log


STATE_JS = r"""
JSON.stringify((function(){
  const text = (document.body ? document.body.innerText : '') || '';
  const m = text.match(/第(\d+)关\s*[：:]\s*([^\n]{1,60})/);
  const models = (window.Monaco && window.Monaco.editor) ? window.Monaco.editor.getModels() : [];
  const btns = [...document.querySelectorAll('button,[role=button]')];
  const evalBtn = btns.find(b => (b.innerText||'').trim() === '评测');
  const evalDisabled = !!(evalBtn && evalBtn.disabled);
  const cd = btns.find(b => /^\d+\s*S$/.test((b.innerText||'').trim()));
  const next = [...document.querySelectorAll('a,button')].find(el =>
    (el.innerText||'').trim() === '下一关' && !el.closest('.evaluate-result-container'));
  const prev = [...document.querySelectorAll('a,button')].find(el =>
    (el.innerText||'').trim() === '上一关' && !el.closest('.evaluate-result-container'));
  const popup = [...document.querySelectorAll('.evaluate-result-container')].find(b => {
    const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
  const popupBtns = popup ? [...popup.querySelectorAll('a,button,[role=button]')]
      .map(el => (el.innerText||'').trim()).filter(Boolean) : [];
  const toasts = [...document.querySelectorAll('div')]
      .filter(d => d.style && d.style.position === 'fixed' && d.style.top === '26px')
      .map(d => d.textContent || '');
  const failMsgs = [...document.querySelectorAll('.ant-message-notice')]
      .filter(el => (el.innerText||'').includes('评测未通过')).length;
  const options = [...document.querySelectorAll('.option')];
  const checked = [...document.querySelectorAll('.option input[type=radio]')].filter(i => i.checked).length;
  return {
    url: location.href,
    ready: document.readyState,
    index: m ? +m[1] : 0,
    name: m ? m[2].trim() : '',
    hasEditor: !!document.querySelector('.monaco-editor'),
    models: models.length,
    hasEval: !!evalBtn,
    evalDisabled: evalDisabled,
    countdown: cd ? (cd.innerText||'').trim() : null,
    hasNext: !!next,
    hasPrev: !!prev,
    choiceCount: options.length,
    checkedCount: checked,
    popup: !!popup,
    popupBtns: popupBtns,
    toasts: toasts,
    failMsgs: failMsgs,
    fontPrompt: !!document.querySelector('.fuck-touge-ui-prompt'),
  };
})())
"""


# 结果探针：在页面里常驻一个 MutationObserver，记录扩展 toast 与庆祝弹层，
# 避免"秒完成"的选择题评测把信号漏掉（轮询 0.4s 也可能错过）。
# 要点：每个 toast 元素只记一次并打标 __aaSeen，重置日志不会让上一关的残留提示语
# 再次被计入（踩过坑：最后一关被上一关的"已跳转"提示骗过）。
PROBE_JS = r"""
(function(){
  if (!window.__aaObs) {
    window.__aaObs = new MutationObserver(function(){
      var L = window.__aaLog; if (!L) return;
      var ds = document.querySelectorAll('div');
      for (var i = 0; i < ds.length; i++) {
        var d = ds[i], s = d.style;
        if (s && s.position === 'fixed' && s.top === '26px' && !d.__aaSeen) {
          d.__aaSeen = true;
          var t = d.textContent || '';
          if (t && L.toasts.indexOf(t) < 0) L.toasts.push(t);
        }
      }
      var p = document.querySelector('.evaluate-result-container');
      var vis = false;
      if (p) { var r = p.getBoundingClientRect(); vis = r.width > 0 && r.height > 0; }
      if (vis && !L.popupVisible) L.popups++;
      L.popupVisible = vis;
    });
    window.__aaObs.observe(document.documentElement,
      {childList: true, subtree: true, characterData: true});
  }
  var p = document.querySelector('.evaluate-result-container');
  var r = p ? p.getBoundingClientRect() : null;
  window.__aaLog = {
    toasts: [],
    popups: 0,
    popupVisible: !!(r && r.width > 0 && r.height > 0)
  };
  return 'ok';
})()
"""


def probe_state(ws: cdp.WS) -> dict:
    try:
        return ws.eval_json("JSON.stringify(window.__aaLog || {toasts: [], popups: 0})")
    except cdp.CDPError:
        return {"toasts": [], "popups": 0}


class Page:
    """对某个页面会话的便捷封装（状态、点击、跳关等）。"""

    def __init__(self, ws: cdp.WS, target: dict | None = None):
        self.ws = ws
        self.target = target or {}

    def state(self) -> dict:
        return self.ws.eval_json(STATE_JS) or {}

    # ---------- 等待 ----------

    def wait_level(self, want_index: int | None = None, timeout: float = 60,
                   need_editor: bool | None = None) -> dict:
        """等待任务页就绪。want_index 指定则必须是对应关卡。"""
        deadline = time.time() + timeout
        last = {}
        while time.time() < deadline:
            try:
                st = self.state()
            except cdp.CDPError:
                st = {}
            if st:
                last = st
                if st.get("fontPrompt"):
                    self.ws.eval(
                        "(function(){const p=document.querySelector('.fuck-touge-ui-prompt');"
                        "if(p){const b=[...p.querySelectorAll('button')].find(x=>/暂不|关闭/.test(x.innerText));"
                        "if(b)b.click();}})()"
                    )
                ready = (
                    st.get("ready") == "complete"
                    and st.get("index", 0) > 0
                    and (st.get("hasEditor") or st.get("choiceCount", 0) > 0)
                )
                if want_index is not None:
                    ready = ready and st.get("index") == want_index
                if need_editor is True:
                    ready = ready and st.get("models", 0) >= 1
                if ready:
                    return st
            time.sleep(0.5)
        return last

    # ---------- 点击 ----------

    def click_expr(self, expr: str) -> bool:
        """按 JS 表达式找到元素并用真实鼠标点击；失败回退 DOM click。

        窗口窄时元素可能被挤出视口，这里取「元素与视口的交集」中心点来点，
        避免在屏幕外坐标上点击（elementFromPoint 会返回 null）。
        """
        info = self.ws.eval(
            "(function(){const el=(" + expr + "); if(!el) return null;"
            "el.scrollIntoView({block:'center', inline:'center'});"
            "const r=el.getBoundingClientRect();"
            "const x1=Math.max(r.left,0), x2=Math.min(r.right,innerWidth);"
            "const y1=Math.max(r.top,0), y2=Math.min(r.bottom,innerHeight);"
            "if(x2-x1<2||y2-y1<2) return null;"
            "return JSON.stringify({x:(x1+x2)/2,y:(y1+y2)/2});})()"
        )
        if info:
            pos = json.loads(info)
            self.ws.mouse_click(pos["x"], pos["y"])
            return True
        return bool(self.ws.eval(
            "(function(){const el=(" + expr + "); if(!el) return false; el.click(); return true;})()"
        ))

    def click_toolbar(self, text: str) -> bool:
        """点击工具栏的 上一关/下一关（排除弹层内）。"""
        expr = (
            "[...document.querySelectorAll('a,button')].find(el=>"
            f"(el.innerText||'').trim()==={json.dumps(text)} && "
            "!el.closest('.evaluate-result-container'))"
        )
        return self.click_expr(expr)

    def wait_eval_ready(self, timeout: float = 120) -> bool:
        """等「评测」按钮变成可点状态（处理跨关卡共享的评测冷却）。

        平台在部分情况下会把上一关评测的冷却带到下一关：按钮是灰的或显示
        「NN S」。此时点击不会生效，必须先等冷却结束。
        """
        logged = False
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                st = self.state()
            except cdp.CDPError:
                time.sleep(0.8)
                continue
            if st.get("hasEval") and not st.get("evalDisabled"):
                if logged:
                    log("  · 评测按钮已就绪，继续。")
                return True
            if not logged:
                what = st.get("countdown") or ("灰色" if st.get("evalDisabled") else "不可点")
                log(f"  · 评测按钮当前{what}（可能是冷却），等就绪再点…")
                logged = True
            time.sleep(0.8)
        return False

    def click_eval(self) -> bool:
        """点「评测」并确认已开始：先等冷却结束，再 DOM click，没有反应补真实鼠标点击。"""
        expr = ("[...document.querySelectorAll('button,[role=button]')].find("
                "b=>(b.innerText||'').trim()==='评测')")
        self.wait_eval_ready()
        self.ws.eval(PROBE_JS)                    # 重置结果探针

        def started(st0: dict) -> bool:
            """判断评测是否已经开始/结束（选择题可能瞬间完成）。"""
            try:
                st = self.state()
            except cdp.CDPError:
                return False
            if st.get("countdown") or st.get("popup"):
                return True
            if st.get("evalDisabled") and not st0.get("evalDisabled"):
                return True                       # 按钮被点灰 = 点击已生效（v0.9.6）
            if st.get("failMsgs", 0) > st0.get("failMsgs", 0):
                return True
            if st.get("index") != st0.get("index") or st.get("url") != st0.get("url"):
                return True
            pr = probe_state(self.ws)
            return bool(pr.get("popups") or pr.get("toasts"))

        st0 = self.state()
        self.ws.eval(
            "(function(){const b=(" + expr + "); if(!b) return false; b.click(); return true;})()"
        )
        for _ in range(10):
            time.sleep(1)
            if started(st0):
                return True
        # 兜底：等冷却（如果刚进入冷却）结束后，真实鼠标点击一次
        self.wait_eval_ready(timeout=90)
        self.click_expr(expr)
        for _ in range(10):
            time.sleep(1)
            if started(st0):
                return True
        return False


# ─────────────────────────── 课堂/关卡操作 ───────────────────────────

