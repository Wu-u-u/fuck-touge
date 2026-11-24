/** 智慧树视频页：观察 DOM，点击交给 background 的 debugger 真输入。 */
import {
  DEFAULT_ZHS_CONFIG,
  MAX_ZHS_LOGS,
  ZHS_CONFIG_KEY,
  ZHS_LOGS_KEY,
  ZHS_STATUS_KEY,
  ZHS_WATCH_KEY,
  addZhsWatch,
  answerOptionIndexes,
  isCompletedState,
  mergeZhsLogs,
  normalizeZhsConfig,
  normalizeZhsLogs,
  normalizeZhsStatus,
  normalizeZhsWatch,
  parseCorrectAnswer,
  textIndicatesCompleted,
  type ZhsConfig,
  type ZhsLog,
  type ZhsState,
  type ZhsStatus,
  type ZhsWatch,
} from "./types";
import { findClose, findQuiz, findSubmit, normalizeQuizTitle, optionsOf, textOf, visible } from "./quiz-dom";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

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

const optionTexts = (options: HTMLElement[]): string[] =>
  options.map((option) => textOf(option).replace(/^[A-Ha-h][.、．:：]\s*/, ""));

const selected = (option: HTMLElement): boolean => {
  if (option instanceof HTMLLabelElement || option.querySelector("input")) {
    const input = option.querySelector("input") as HTMLInputElement | null;
    if (input) return input.checked;
  }
  return /(^|\s)(active|selected|checked|is-checked|topic-item-active)(\s|$)/.test(option.className);
};

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
let closeRetries = 0;
let lastNextAt = 0;
let lastNextLabel = "";
let lastChapter = "";
let qualityApplied = false;
let speedUiApplied = false;
let lastSpeedAttempt = 0;
let speedWarned = false;
let lastQualityAttempt = 0;
let qualityWarned = false;
let nextHumanPauseAt = 0;
let humanPauseUntil = 0;
let nextMouseMoveAt = 0;
let videoSeen = false;
let watch: ZhsWatch = normalizeZhsWatch(null);
let lastWatchAt = 0;
let lastVideoTime = 0;
let lastWatchSave = 0;

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

const send = (message: unknown, timeout = 4000): Promise<any> => {
  const request = (() => {
    try {
      return (chrome.runtime.sendMessage(message) as Promise<any>).catch(() => null);
    } catch (e) {
      return Promise.resolve(null);
    }
  })();
  // debugger attach/detach 偶尔会卡住；不能让 click 永久挂起 busy。
  return Promise.race([
    request,
    new Promise((resolve) => setTimeout(() => resolve(null), timeout)),
  ]);
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

const move = async (el: HTMLElement): Promise<void> => {
  if (!visible(el)) return;
  const { x, y } = topPoint(el);
  await send({ type: "zhs:move", x, y });
  await sleep(180);
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

/** 关闭弹题：从题目根节点向上找按钮，点击后用 Esc 兜底；AI 小智只有底部「关闭」。 */
const closeQuiz = async (dialog: HTMLElement, attempts: number): Promise<boolean> => {
  for (let i = 0; i < attempts; i++) {
    const still = findQuiz();
    if (!still) return true;
    const close = findClose(still);
    if (!close) {
      if (i === 0) pushLog("warn", "未找到弹题关闭按钮");
      break;
    }
    if (!(await click(close, "关闭弹题"))) break;
    await sleep(360);
    if (!findQuiz()) return true;
  }
  if (findQuiz()) {
    const pressed = await send({ type: "zhs:key", key: "Escape" });
    if (pressed?.ok) {
      await sleep(320);
      if (!findQuiz()) {
        pushLog("info", "已用 Esc 关闭弹题");
        return true;
      }
    }
  }
  return !findQuiz();
};

const finishQuiz = async (dialog: HTMLElement, note: string): Promise<void> => {
  const submit = findSubmit(dialog);
  if (submit && (await click(submit, "提交答案"))) {
    await sleep(350);
  }
  const closed = await closeQuiz(dialog, 2);
  if (closed) {
    pushLog("info", note);
  } else {
    pushLog("warn", `${note}，但弹题仍未关闭，继续重试`);
    writeStatus("quiz", "已作答，正在重试关闭弹题");
  }
  quizStage = 3;
  quizAt = Date.now();
  closeRetries = 0;
  const video = findVideo();
  if (video) void video.play().catch(() => {});
};

const handleQuiz = async (dialog: HTMLElement): Promise<void> => {
  if (busy) return;
  const body = textOf(dialog);
  const options = optionsOf(dialog);
  if (!options.length) return;
  const scope = dialog.closest(".el-dialog__wrapper, [class*='dialog'], [class*='modal']") as HTMLElement | null
    || dialog;
  const scopeText = () => textOf(scope);
  const title = normalizeQuizTitle(
    textOf(dialog.querySelector(".topic-title, .topic-content, .question-topic")) || body,
  );
  const page = textOf(dialog.querySelector(".el-pager .number.active"));
  const key = `${page}|${title}|${optionTexts(options).join("|")}`;
  if (key !== quizKey) {
    quizKey = key;
    quizStage = 0;
    quizAttempts = 0;
    closeRetries = 0;
    pushLog("info", `识别到弹题：${title.slice(0, 40)}（${options.length} 个选项）`);
  }
  if (quizStage >= 3) {
    if (quizStage > 3 || Date.now() - quizAt < 900) return;
    if (closeRetries >= 4) return;
    closeRetries++;
    quizAt = Date.now();
    if (await closeQuiz(dialog, 1)) {
      pushLog("info", "弹题重试关闭成功");
      quizStage = 4;
      const video = findVideo();
      if (video) void video.play().catch(() => {});
    } else if (closeRetries >= 4) {
      pushLog("error", "弹题多次关闭失败，请手动关闭");
      writeStatus("quiz", "弹题多次关闭失败，等待人工处理");
    }
    return;
  }
  if (quizAttempts >= 4) {
    await finishQuiz(dialog, "弹题超过重试次数，已关闭");
    return;
  }
  busy = true;
  quizAttempts++;
  try {
    writeStatus("quiz", config.mode === "correct" ? "处理弹题（正确作答）" : "处理弹题（快速作答）");
    const answer = parseCorrectAnswer(scopeText());
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
        pushLog("info", "已选择随机选项，等待平台回显正确答案");
        quizStage = 1;
        quizAt = Date.now();
      }
      return;
    }
    if (quizStage === 1 && Date.now() - quizAt >= 700) {
      const late = parseCorrectAnswer(scopeText());
      if (late.length && (await applyAnswer(dialog, late, options))) {
        await finishQuiz(dialog, `已按正确答案 ${late.join("")} 修正`);
        return;
      }
      const submit = findSubmit(dialog);
      if (submit && (await click(submit, "提交以显示答案"))) {
        quizAt = Date.now();
        quizStage = 2;
        return;
      }
      // AI 小智弹题没有提交按钮，选择后可能延迟回显答案；保留弹题继续等，不要直接关掉。
      quizAt = Date.now();
      quizStage = 2;
      return;
    }
    if (quizStage === 2 && Date.now() - quizAt >= 1200) {
      const late = parseCorrectAnswer(scopeText());
      if (late.length && (await applyAnswer(dialog, late, options))) {
        await finishQuiz(dialog, `已按正确答案 ${late.join("")} 修正`);
      } else {
        writeStatus("quiz", "未读到正确答案，保留弹题等待人工处理");
        pushLog("warn", "弹题没有回显正确答案，未自动关闭");
        quizStage = 3;
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

type NextChoice = { el: HTMLElement; completed: boolean };

const findNext = (allowCompleted: boolean): NextChoice | null => {
  const items = [...document.querySelectorAll<HTMLElement>(".clearfix.video, [class*='video-item']")]
    .filter(visible);
  if (items.length) {
    const current = items.findIndex((item) => item.classList.contains("current_play") || /current_play/.test(item.className));
    const ordered = current >= 0
      ? items.slice(current + 1).concat(items.slice(0, current))
      : items.slice();
    const incomplete = ordered.find((item) => !textIndicatesCompleted(textOf(item)));
    if (incomplete) return { el: incomplete, completed: false };
    if (allowCompleted) {
      const review = ordered.find((item) => textIndicatesCompleted(textOf(item)))
        || items[current >= 0 ? current : 0];
      if (review) return { el: review, completed: true };
    }
  }
  const buttons = [...document.querySelectorAll<HTMLElement>(
    "button, [role='button'], a, .next, [class*='next-btn'], [class*='nextBtn'], [class*='next-topic']",
  )].filter(visible);
  const button = buttons.find((item) => /下一节|下一课|下一个/.test(textOf(item)));
  return button ? { el: button, completed: false } : null;
};

const rateOf = (el: HTMLElement): number => {
  const attr = el.getAttribute("rate");
  const raw = attr || textOf(el).replace(/[^0-9.]/g, "");
  return parseFloat(raw);
};

const speedMenuItem = (target: number): HTMLElement | null => {
  const items = [...document.querySelectorAll<HTMLElement>(
    ".speedList [rate], .speedList li, .speedTab15, .speedTab125, [class*='speedTab']",
  )].filter(visible);
  return items.find((item) => {
    const rate = rateOf(item);
    return Number.isFinite(rate) && Math.abs(rate - target) < 0.001;
  }) || null;
};

/**
 * 不直接改 video.playbackRate；先让平台自己的倍速菜单生效，
 * 这样播放器 UI 和内部状态一致，避免“速度变了但界面还是 1.0”的检测点。
 */
const ensureSpeed = async (video: HTMLVideoElement): Promise<void> => {
  if (speedUiApplied && Math.abs(video.playbackRate - config.speed) > 0.05) speedUiApplied = false;
  if (speedUiApplied) return;
  if (Date.now() - lastSpeedAttempt < 5000) return;
  lastSpeedAttempt = Date.now();
  let box = document.querySelector<HTMLElement>(".speedBox");
  if (!box) {
    if (!speedWarned) {
      speedWarned = true;
      pushLog("warn", "播放器没有倍速菜单，保持原速（不直接改 playbackRate）");
    }
    return;
  }
  if (!visible(box)) await move(video);
  box = document.querySelector<HTMLElement>(".speedBox");
  if (!visible(box)) {
    if (!speedWarned) {
      speedWarned = true;
      pushLog("warn", "倍速菜单未显示，保持原速");
    }
    return;
  }
  let list = document.querySelector<HTMLElement>(".speedList");
  if (!visible(list)) {
    // 有些播放器是 hover 展开，不是 click 展开；先移动真实鼠标，再必要时点击。
    await move(box);
    await sleep(250);
    list = document.querySelector<HTMLElement>(".speedList");
  }
  if (!visible(list)) {
    await click(box, "倍速菜单");
    await sleep(350);
    list = document.querySelector<HTMLElement>(".speedList");
  }
  const item = speedMenuItem(config.speed);
  if (!item) {
    if (!speedWarned) {
      speedWarned = true;
      pushLog("warn", `播放器没有 ${config.speed}x 档位，保持原速`);
    }
    return;
  }
  if (await click(item, `倍速 ${config.speed}x`)) {
    await sleep(500);
    if (Math.abs(video.playbackRate - config.speed) < 0.05) {
      speedUiApplied = true;
      pushLog("info", `已通过播放器菜单设置 ${config.speed}x`);
      return;
    }
  }
  if (!speedWarned) {
    speedWarned = true;
    pushLog("warn", "倍速菜单点击后未生效，保持原速");
  }
};

const applyQuality = async (): Promise<void> => {
  if (qualityApplied || config.quality !== "smooth") return;
  if (Date.now() - lastQualityAttempt < 5000) return;
  lastQualityAttempt = Date.now();
  let box = document.querySelector<HTMLElement>(".definiBox");
  if (!visible(box)) {
    const video = findVideo();
    if (video) await move(video);
    box = document.querySelector<HTMLElement>(".definiBox");
  }
  if (!visible(box)) {
    if (!qualityWarned) {
      qualityWarned = true;
      pushLog("warn", "清晰度菜单未显示，保持默认画质");
    }
    return;
  }
  await move(box);
  await sleep(250);
  if (!visible(document.querySelector<HTMLElement>(".line1bq"))) {
    await click(box, "清晰度菜单");
    await sleep(350);
  }
  const smooth = document.querySelector<HTMLElement>(".line1bq");
  if (!visible(smooth)) {
    if (!qualityWarned) {
      qualityWarned = true;
      pushLog("warn", "未找到流畅画质选项，保持默认画质");
    }
    return;
  }
  if (await click(smooth, "流畅画质")) {
    qualityApplied = true;
    pushLog("info", "已通过播放器菜单设置流畅画质");
  }
};

const mouseMoveDelay = (): number => 25_000 + Math.round(Math.random() * 45_000);

const nudgeMouse = (video: HTMLVideoElement): void => {
  try {
    const rect = video.getBoundingClientRect();
    const x = rect.left + rect.width * (0.2 + Math.random() * 0.6);
    const y = rect.top + rect.height * (0.2 + Math.random() * 0.6);
    const target = video.ownerDocument || document;
    target.dispatchEvent(new MouseEvent("mousemove", {
      bubbles: true, cancelable: true, view: window, clientX: x, clientY: y,
    }));
  } catch (e) {}
};

const humanPauseDelay = (): number => 42_000 + Math.round(Math.random() * 78_000);

const goNext = async (): Promise<void> => {
  if (busy) return;
  const next = findNext(config.reviewCompleted);
  if (!next) {
    writeStatus("done", config.reviewCompleted ? "没有可复习的已完成课程" : "没有下一节");
    return;
  }
  const label = textOf(next.el).slice(0, 100);
  if (label === lastNextLabel && Date.now() - lastNextAt < 60_000) {
    writeStatus("next", "已点击下一节，但页面还没切换");
    return;
  }
  if (Date.now() - lastNextAt < 8000) return;
  busy = true;
  lastWatchAt = 0;
  lastNextAt = Date.now();
  lastNextLabel = label;
  try {
    writeStatus("next", next.completed ? "复习已完成课程" : "准备下一节");
    // 每次切换前随机停顿 1.031–2.5s，避免机械连点。
    await sleep(1031 + Math.round(Math.random() * 1469));
    const ok = await click(next.el, next.completed ? "复习已完成课程" : "下一节");
    if (ok) {
      pushLog("info", `${next.completed ? "复习" : "切换到"}：${label.slice(0, 80)}`);
      qualityApplied = false;
      speedUiApplied = false;
      speedWarned = false;
      qualityWarned = false;
      lastSpeedAttempt = 0;
      lastQualityAttempt = 0;
      nextMouseMoveAt = Date.now() + mouseMoveDelay();
      lastVideoTime = 0;
      await sleep(1200);
      const video = findVideo();
      if (video) {
        await ensureSpeed(video);
        void video.play().catch(() => {});
      }
    }
  } finally {
    busy = false;
  }
};

const saveWatch = (force = false): void => {
  const now = Date.now();
  if (!force && now - lastWatchSave < 2000) return;
  lastWatchSave = now;
  try {
    void chrome.storage.local.set({ [ZHS_WATCH_KEY]: watch });
  } catch (e) {}
};

const accumulateWatch = (video: HTMLVideoElement | null): void => {
  const now = Date.now();
  const current = video?.currentTime || 0;
  const advanced = !!video && current > lastVideoTime + 0.01 && current - lastVideoTime < 5;
  lastVideoTime = current;
  const active = !!video
    && !video.paused
    && video.readyState >= 2
    && document.visibilityState === "visible"
    && advanced;
  if (!active) {
    lastWatchAt = 0;
    return;
  }
  if (lastWatchAt > 0) {
    watch = addZhsWatch(watch, (now - lastWatchAt) / 1000, now);
    saveWatch();
  }
  lastWatchAt = now;
};

const tick = async (): Promise<void> => {
  if (!config.enabled || busy) return;
  const chapter = chapterText();
  if (chapter !== lastChapter) {
    lastChapter = chapter;
    lastNextLabel = "";
  }
  if (isBlockedPage()) {
    lastWatchAt = 0;
    writeStatus("blocked", "检测到安全验证，已暂停，请手动完成");
    return;
  }
  const quiz = findQuiz();
  if (quiz) {
    lastWatchAt = 0;
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
    lastWatchAt = 0;
    writeStatus("waiting", "等待视频加载");
    return;
  }
  if (!videoSeen) {
    videoSeen = true;
    nextHumanPauseAt = Date.now() + humanPauseDelay();
    nextMouseMoveAt = Date.now() + mouseMoveDelay();
    pushLog("info", "已识别视频，开始播放监控");
  }
  const now = Date.now();
  if (humanPauseUntil > 0) {
    if (now < humanPauseUntil) {
      lastWatchAt = 0;
      writeStatus("paused", "模拟人工动作，暂停约 3 秒");
      return;
    }
    humanPauseUntil = 0;
    nextHumanPauseAt = now + humanPauseDelay();
    void video.play().catch(() => {});
  } else if (!video.paused && now >= nextHumanPauseAt) {
    humanPauseUntil = now + 3000;
    nextHumanPauseAt = now + humanPauseDelay();
    lastWatchAt = 0;
    try { video.pause(); } catch (e) {}
    writeStatus("paused", "模拟人工动作，暂停约 3 秒");
    return;
  }
  if (!video.paused && now >= nextMouseMoveAt) {
    nudgeMouse(video);
    nextMouseMoveAt = now + mouseMoveDelay();
  }
  await ensureSpeed(video);
  accumulateWatch(video);
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
    const actual = Number.isFinite(video.playbackRate) ? video.playbackRate : 1;
    const applied = Math.abs(actual - config.speed) < 0.05;
    writeStatus(
      "playing",
      applied ? `播放中 · ${actual}x` : `播放中 · 原速 ${actual}x（${config.speed}x 菜单未生效）`,
    );
  }
};

const start = (): void => {
  if (started) return;
  started = true;
  humanPauseUntil = 0;
  videoSeen = false;
  nextHumanPauseAt = Date.now() + humanPauseDelay();
  nextMouseMoveAt = Date.now() + mouseMoveDelay();
  writeStatus("waiting", "正在检测视频…");
  pushLog("info", "自动化已启动（首次点击时建立真实输入连接）");
  if (!timer) timer = window.setInterval(() => { void tick(); }, 1000);
  void tick();
};

const stop = (): void => {
  started = false;
  if (timer) {
    clearInterval(timer);
    timer = 0;
  }
  saveWatch(true);
  lastWatchAt = 0;
  humanPauseUntil = 0;
  nextMouseMoveAt = 0;
  lastVideoTime = 0;
  writeStatus("idle", "已停止");
  void send({ type: "zhs:detach" });
};

const load = (): void => {
  try {
    chrome.storage.local.get([ZHS_CONFIG_KEY, ZHS_LOGS_KEY, ZHS_WATCH_KEY], (result) => {
      config = normalizeZhsConfig(result?.[ZHS_CONFIG_KEY]);
      logs = normalizeZhsLogs(result?.[ZHS_LOGS_KEY]);
      watch = normalizeZhsWatch(result?.[ZHS_WATCH_KEY]);
      if (config.enabled) start();
      else writeStatus("idle", "未启动");
    });
  } catch (e) {
    writeStatus("error", "读取配置失败");
  }
};

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes[ZHS_CONFIG_KEY]) return;
  const next = normalizeZhsConfig(changes[ZHS_CONFIG_KEY].newValue);
  if (next.speed !== config.speed) {
    speedUiApplied = false;
    speedWarned = false;
    lastSpeedAttempt = 0;
  }
  if (next.quality !== config.quality) {
    qualityApplied = false;
    qualityWarned = false;
    lastQualityAttempt = 0;
  }
  config = next;
  if (config.enabled) start();
  else stop();
});

if (window.top === window.self) {
  load();
  window.addEventListener("pagehide", () => {
    saveWatch(true);
    if (started) void send({ type: "zhs:detach" });
  });
}
