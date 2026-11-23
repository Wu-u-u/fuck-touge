/** 智慧树视频页：观察 DOM，点击交给 background 的 debugger 真输入。 */
import {
  DEFAULT_ZHS_CONFIG,
  MAX_ZHS_LOGS,
  ZHS_CONFIG_KEY,
  ZHS_LOGS_KEY,
  ZHS_STATUS_KEY,
  answerOptionIndexes,
  isCompletedState,
  mergeZhsLogs,
  normalizeZhsConfig,
  normalizeZhsLogs,
  normalizeZhsStatus,
  parseCorrectAnswer,
  textIndicatesCompleted,
  type ZhsConfig,
  type ZhsLog,
  type ZhsState,
  type ZhsStatus,
} from "./types";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const visible = (el: Element | null): el is HTMLElement => {
  if (!el) return false;
  const rect = el.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) return false;
  const style = getComputedStyle(el);
  return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || "1") > 0;
};

const textOf = (el: Element | null): string => (el?.textContent || "").replace(/\s+/g, " ").trim();

const findVideo = (): HTMLVideoElement | null => {
  const direct = document.querySelector("video");
  if (visible(direct)) return direct as HTMLVideoElement;
  for (const iframe of document.querySelectorAll("iframe")) {
    try {
      const doc = iframe.contentDocument;
      const nested = doc?.querySelector("video") ?? null;
      if (visible(nested)) return nested as HTMLVideoElement;
    } catch (e) {}
  }
  return null;
};

const findQuiz = (): HTMLElement | null => {
  const candidates = document.querySelectorAll<HTMLElement>(
    "#playTopic-dialog, [class*='topic-dialog'], .el-dialog__wrapper .el-dialog",
  );
  for (const el of candidates) {
    if (!visible(el)) continue;
    const body = textOf(el);
    if (body.length > 2 && /题|正确答案|选择|判断/.test(body)) return el;
  }
  return null;
};

const optionsOf = (dialog: HTMLElement): HTMLElement[] => {
  const selectors = [
    ".topic-item", ".option-item", ".choice-item", ".answer-option", ".topic .radio ul > li",
  ];
  for (const selector of selectors) {
    const found = [...dialog.querySelectorAll<HTMLElement>(selector)].filter(visible);
    if (found.length) return found;
  }
  const fallback = [...dialog.querySelectorAll<HTMLElement>("ul > li")]
    .filter((el) => visible(el) && textOf(el) && !/^\\d+$/.test(textOf(el)));
  return fallback;
};

const optionTexts = (options: HTMLElement[]): string[] =>
  options.map((option) => textOf(option).replace(/^[A-Ha-h][.、．:：]\s*/, ""));

const selected = (option: HTMLElement): boolean => {
  if (option instanceof HTMLLabelElement || option.querySelector("input")) {
    const input = option.querySelector("input") as HTMLInputElement | null;
    if (input) return input.checked;
  }
  return /(^|\\s)(active|selected|checked|is-checked|topic-item-active)(\\s|$)/.test(option.className);
};

const findSubmit = (dialog: HTMLElement): HTMLElement | null => {
  const buttons = [...dialog.querySelectorAll<HTMLElement>("button, .btn, .topic-btn, .confirm, [role='button']")]
    .filter(visible);
  return buttons.find((button) => /提交|确定|确认|回答|知道了/.test(textOf(button))) || null;
};

const findClose = (dialog: HTMLElement): HTMLElement | null =>
  [...dialog.querySelectorAll<HTMLElement>(".close-btn, .topic-close, .el-dialog__close, [aria-label*='关闭']")]
    .find(visible) || null;

const topPoint = (el: Element): { x: number; y: number } => {
  el.scrollIntoView({ block: "center", inline: "center" });
  const rect = el.getBoundingClientRect();
  let x = rect.left + rect.width / 2;
  let y = rect.top + rect.height / 2;
  let win: Window | null = window;
  for (let depth = 0; win && win !== win.top && depth < 8; depth++) {
    try {
      const frame: Element | null = win.frameElement;
      if (!frame) break;
      const frameRect = frame.getBoundingClientRect();
      x += frameRect.left;
      y += frameRect.top;
      win = frame.ownerDocument.defaultView;
    } catch (e) {
      break;
    }
  }
  return { x, y };
};

const isBlockedPage = (): boolean =>
  !!(document.querySelector("#yidun_popup, .yidun_popup, [id^='tcaptcha_transform'], .tcaptcha") &&
    visible(document.querySelector("#yidun_popup, .yidun_popup, [id^='tcaptcha_transform'], .tcaptcha")));

let config: ZhsConfig = { ...DEFAULT_ZHS_CONFIG };
let timer = 0;
let busy = false;
let started = false;
let statusKey = "";
let logs: ZhsLog[] = [];
let quizKey = "";
let quizStage = 0;
let quizAt = 0;
let quizAttempts = 0;
let lastNextAt = 0;
let lastNextLabel = "";
let lastChapter = "";
let qualityApplied = false;

const chapterText = (): string => {
  const current = document.querySelector(".current_play, [class*='current_play']");
  return textOf(current).slice(0, 120);
};

const writeStatus = (state: ZhsState, message: string): void => {
  const status: ZhsStatus = {
    updatedAt: Date.now(),
    state,
    chapter: chapterText(),
    message: message.slice(0, 300),
  };
  const key = `${status.state}|${status.chapter}|${status.message}`;
  if (key === statusKey) return;
  statusKey = key;
  try {
    void chrome.storage.local.set({ [ZHS_STATUS_KEY]: status });
  } catch (e) {}
};

const pushLog = (level: string, text: string): void => {
  const entry: ZhsLog = { at: Date.now(), level, text: text.slice(0, 300) };
  logs = mergeZhsLogs(logs, [entry], MAX_ZHS_LOGS);
  try {
    void chrome.storage.local.set({ [ZHS_LOGS_KEY]: logs });
  } catch (e) {}
};

const send = (message: unknown): Promise<any> => {
  try {
    return chrome.runtime.sendMessage(message).catch(() => null) as Promise<any>;
  } catch (e) {
    return Promise.resolve(null);
  }
};

const click = async (el: HTMLElement, label: string): Promise<boolean> => {
  if (!visible(el)) return false;
  const { x, y } = topPoint(el);
  const res = await send({ type: "zhs:click", x, y, label });
  if (!res?.ok) {
    pushLog("error", `${label}点击失败：${res?.error || "真实点击未启用"}`);
    writeStatus("error", `真实点击失败：${res?.error || "请重新加载扩展"}`);
    return false;
  }
  await sleep(120);
  return true;
};

const applyAnswer = async (dialog: HTMLElement, answer: string[], options: HTMLElement[]): Promise<boolean> => {
  const indexes = answerOptionIndexes(answer, optionTexts(options));
  if (!indexes.length) return false;
  const wanted = new Set(indexes);
  for (let i = 0; i < options.length; i++) {
    const want = wanted.has(i);
    if (selected(options[i]) !== want) {
      if (!(await click(options[i], `选项 ${i + 1}`))) return false;
      await sleep(160);
    }
  }
  return true;
};

const finishQuiz = async (dialog: HTMLElement, note: string): Promise<void> => {
  const submit = findSubmit(dialog);
  if (submit && (await click(submit, "提交答案"))) {
    await sleep(350);
  }
  const still = findQuiz();
  if (still) {
    const close = findClose(still);
    if (close) await click(close, "关闭弹题");
  }
  pushLog("info", note);
  quizStage = 3;
  quizAt = Date.now();
  const video = findVideo();
  if (video) void video.play().catch(() => {});
};

const handleQuiz = async (dialog: HTMLElement): Promise<void> => {
  if (busy) return;
  const body = textOf(dialog);
  const options = optionsOf(dialog);
  if (!options.length) return;
  const title = textOf(dialog.querySelector(".topic-title, .topic-content, .question-topic"))
    || body.replace(/正确答案[\s\S]*$/, "").slice(0, 120);
  const page = textOf(dialog.querySelector(".el-pager .number.active"));
  const key = `${page}|${title}|${optionTexts(options).join("|")}`;
  if (key !== quizKey) {
    quizKey = key;
    quizStage = 0;
    quizAttempts = 0;
  }
  if (quizStage >= 3) return;
  if (quizAttempts >= 4) {
    await finishQuiz(dialog, "弹题超过重试次数，已关闭");
    return;
  }
  busy = true;
  quizAttempts++;
  try {
    writeStatus("quiz", config.mode === "correct" ? "处理弹题（正确作答）" : "处理弹题（快速作答）");
    const answer = parseCorrectAnswer(body);
    if (config.mode === "quick") {
      if (await click(options[0], "快速选项")) {
        await sleep(250);
        await finishQuiz(dialog, "快速作答完成");
      }
      return;
    }
    if (answer.length) {
      if (await applyAnswer(dialog, answer, options)) {
        await finishQuiz(dialog, `已按正确答案 ${answer.join("")} 作答`);
      } else {
        await finishQuiz(dialog, "答案无法映射到选项，已关闭");
      }
      return;
    }
    if (quizStage === 0) {
      if (await click(options[0], "触发正确答案")) {
        quizStage = 1;
        quizAt = Date.now();
      }
      return;
    }
    if (quizStage === 1 && Date.now() - quizAt >= 700) {
      const submit = findSubmit(dialog);
      if (submit && (await click(submit, "提交以显示答案"))) {
        quizAt = Date.now();
        quizStage = 2;
      } else {
        await finishQuiz(dialog, "没有正确答案回显，已关闭");
      }
      return;
    }
    if (quizStage === 2 && Date.now() - quizAt >= 700) {
      const late = parseCorrectAnswer(textOf(dialog));
      if (late.length && (await applyAnswer(dialog, late, options))) {
        await finishQuiz(dialog, `已按正确答案 ${late.join("")} 修正`);
      } else {
        await finishQuiz(dialog, "未读到正确答案，已快速关闭");
      }
    }
  } finally {
    busy = false;
  }
};

const progressOf = (video: HTMLVideoElement): number => {
  if (!Number.isFinite(video.duration) || video.duration <= 0) return 0;
  return Math.min(1, Math.max(0, video.currentTime / video.duration));
};

const completed = (video: HTMLVideoElement): boolean => {
  const bar = document.querySelector(".current_play .progressbar, .progressbar");
  let barProgress = 0;
  if (bar instanceof HTMLElement) {
    const width = parseFloat(bar.style.width || "0");
    if (Number.isFinite(width)) barProgress = width > 1 ? width / 100 : width;
  }
  const current = document.querySelector(".current_play");
  const completedText = !!current && textIndicatesCompleted(textOf(current));
  return isCompletedState({
    ended: video.ended,
    completed: completedText,
    progress: Math.max(progressOf(video), barProgress),
  });
};

const findNext = (): HTMLElement | null => {
  const items = [...document.querySelectorAll<HTMLElement>(".clearfix.video, [class*='video-item']")]
    .filter(visible);
  if (items.length) {
    const current = items.findIndex((item) => item.classList.contains("current_play") || /current_play/.test(item.className));
    const next = current >= 0 ? items[current + 1] : items.find((item) => !/已完成|完成/.test(textOf(item)));
    if (next && !/已完成|完成/.test(textOf(next))) return next;
  }
  const buttons = [...document.querySelectorAll<HTMLElement>(
    "button, [role='button'], a, .next, [class*='next-btn'], [class*='nextBtn'], [class*='next-topic']",
  )].filter(visible);
  return buttons.find((button) => /下一节|下一课|下一个/.test(textOf(button))) || null;
};

const applyVideoSettings = (video: HTMLVideoElement): void => {
  if (Math.abs(video.playbackRate - config.speed) > 0.01) {
    try { video.playbackRate = config.speed; } catch (e) {}
  }
};

const applyQuality = async (): Promise<void> => {
  if (qualityApplied || config.quality !== "smooth") return;
  const box = document.querySelector<HTMLElement>(".definiBox");
  if (!visible(box)) return;
  qualityApplied = true;
  await click(box, "清晰度菜单");
  await sleep(300);
  const smooth = document.querySelector<HTMLElement>(".line1bq");
  if (visible(smooth)) await click(smooth, "流畅画质");
};

const goNext = async (): Promise<void> => {
  if (busy) return;
  const next = findNext();
  if (!next) {
    writeStatus("done", "没有下一节");
    return;
  }
  const label = textOf(next).slice(0, 100);
  if (label === lastNextLabel && Date.now() - lastNextAt < 60_000) {
    writeStatus("next", "已点击下一节，但页面还没切换");
    return;
  }
  if (Date.now() - lastNextAt < 8000) return;
  busy = true;
  lastNextAt = Date.now();
  lastNextLabel = label;
  try {
    writeStatus("next", "准备下一节");
    const ok = await click(next, "下一节");
    if (ok) {
      pushLog("info", `切换到：${label.slice(0, 80)}`);
      qualityApplied = false;
      await sleep(1200);
      const video = findVideo();
      if (video) {
        applyVideoSettings(video);
        void video.play().catch(() => {});
      }
    }
  } finally {
    busy = false;
  }
};

const tick = async (): Promise<void> => {
  if (!config.enabled || busy) return;
  const chapter = chapterText();
  if (chapter !== lastChapter) {
    lastChapter = chapter;
    lastNextLabel = "";
  }
  if (isBlockedPage()) {
    writeStatus("blocked", "检测到安全验证，已暂停，请手动完成");
    return;
  }
  const quiz = findQuiz();
  if (quiz) {
    await handleQuiz(quiz);
    return;
  }
  if (quizStage === 3) {
    quizKey = "";
    quizStage = 0;
    quizAttempts = 0;
  }
  const video = findVideo();
  if (!video) {
    writeStatus("waiting", "等待视频加载");
    return;
  }
  applyVideoSettings(video);
  if (config.quality === "smooth" && !qualityApplied && !video.paused) {
    void applyQuality();
  }
  if (completed(video)) {
    if (config.autoNext) {
      await goNext();
    } else {
      writeStatus("done", "本节已完成");
    }
    return;
  }
  if (video.paused) {
    writeStatus("paused", "视频已暂停，尝试恢复播放");
    void video.play().catch(() => writeStatus("paused", "浏览器阻止自动播放，请手动点播放"));
  } else {
    writeStatus("playing", `播放中 · ${config.speed}x`);
  }
};

const start = (): void => {
  if (started) return;
  started = true;
  writeStatus("waiting", "正在连接智慧树页面…");
  void send({ type: "zhs:attach" }).then((res) => {
    if (!res?.ok) {
      pushLog("error", `真实点击未启用：${res?.error || "debugger 权限不可用"}`);
      writeStatus("error", "真实点击未启用，请重新加载扩展");
    } else {
      pushLog("info", "真实点击已连接");
    }
  });
  if (!timer) timer = window.setInterval(() => { void tick(); }, 1000);
  void tick();
};

const stop = (): void => {
  started = false;
  if (timer) {
    clearInterval(timer);
    timer = 0;
  }
  writeStatus("idle", "已停止");
  void send({ type: "zhs:detach" });
};

const load = (): void => {
  try {
    chrome.storage.local.get([ZHS_CONFIG_KEY, ZHS_LOGS_KEY], (result) => {
      config = normalizeZhsConfig(result?.[ZHS_CONFIG_KEY]);
      logs = normalizeZhsLogs(result?.[ZHS_LOGS_KEY]);
      if (config.enabled) start();
      else writeStatus("idle", "未启动");
    });
  } catch (e) {
    writeStatus("error", "读取配置失败");
  }
};

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes[ZHS_CONFIG_KEY]) return;
  config = normalizeZhsConfig(changes[ZHS_CONFIG_KEY].newValue);
  if (config.enabled) start();
  else stop();
});

if (window.top === window.self) {
  load();
  window.addEventListener("pagehide", () => {
    if (started) void send({ type: "zhs:detach" });
  });
}
