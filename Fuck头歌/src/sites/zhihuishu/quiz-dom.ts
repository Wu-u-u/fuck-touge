/** 智慧树弹题 DOM 定位：纯 DOM 逻辑，便于在 jsdom 里回归测试。 */

export const visible = (el: Element | null): el is HTMLElement => {
  if (!el) return false;
  const rect = el.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) return false;
  const style = getComputedStyle(el);
  return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || "1") > 0;
};

export const textOf = (el: Element | null): string => (el?.textContent || "").replace(/\s+/g, " ").trim();

const containsOptions = (el: HTMLElement): boolean =>
  !!el.querySelector("input[type='radio'], input[type='checkbox'], .topic-item, .option-item, .choice-item, .answer-option");

/** 去掉平台回显的答案和尾部空白，避免同一个弹题每秒被当成新题。 */
export const normalizeQuizTitle = (text: string): string =>
  text.replace(/正确答案[\s\S]*$/, "").replace(/\s+/g, " ").trim().slice(0, 120);

export const findQuiz = (doc: Document = document): HTMLElement | null => {
  const candidates = doc.querySelectorAll<HTMLElement>(
    "#playTopic-dialog, [class*='topic-dialog'], .el-dialog__wrapper .el-dialog, [role='dialog']",
  );
  for (const el of candidates) {
    if (!visible(el)) continue;
    const body = textOf(el);
    if (body.length > 2 && /题|正确答案|选择|判断/.test(body) && containsOptions(el)) return el;
  }
  // AI 助教小智弹题经常没有 .el-dialog，只靠标题和单选/多选控件。
  const title = [...doc.querySelectorAll<HTMLElement>("div,span,h1,h2,h3")]
    .find((el) => visible(el) && /AI助教小智给你出题|AI助教.*出题/.test(textOf(el)));
  if (!title) return null;
  let root: HTMLElement | null = title;
  for (let depth = 0; depth < 7 && root && root !== doc.body; depth++) {
    const rect = root.getBoundingClientRect();
    if (visible(root) && rect.width < 1600 && rect.height < 1200
      && containsOptions(root) && /题|选择|判断|正确答案/.test(textOf(root))) {
      return root;
    }
    root = root.parentElement;
  }
  return null;
};

export const optionsOf = (dialog: HTMLElement): HTMLElement[] => {
  const selectors = [
    ".topic-item", ".option-item", ".choice-item", ".answer-option", ".topic .radio ul > li",
  ];
  for (const selector of selectors) {
    const found = [...dialog.querySelectorAll<HTMLElement>(selector)].filter(visible);
    if (found.length) return found;
  }
  const inputs = [...dialog.querySelectorAll<HTMLInputElement>("input[type='radio'], input[type='checkbox']")]
    .filter((input) => visible(input) || visible((input as Element).closest("label")))
    .map((input) => ((input as Element).closest("label") || input.parentElement || input) as HTMLElement);
  if (inputs.length) return inputs;
  const fallback = [...dialog.querySelectorAll<HTMLElement>("ul > li")]
    .filter((el) => visible(el) && textOf(el) && !/^\d+$/.test(textOf(el)));
  return fallback;
};

export const findSubmit = (dialog: HTMLElement): HTMLElement | null => {
  const buttons = [...dialog.querySelectorAll<HTMLElement>("button, .btn, .topic-btn, .confirm, [role='button']")]
    .filter(visible);
  return buttons.find((button) => /提交|确定|确认|回答|知道了/.test(textOf(button))) || null;
};

const CLOSE_TEXT = /^(关闭|关闭弹窗|知道了|继续学习|确定|完成)$/;
const CLOSE_SELECTOR = [
  ".close-btn", ".topic-close", ".el-dialog__close", ".el-dialog__headerbtn",
  "[aria-label*='关闭']", "[title*='关闭']", "[class*='close']",
].join(",");

const closeSized = (el: HTMLElement): boolean => {
  const rect = el.getBoundingClientRect();
  return rect.width >= 12 && rect.width <= 420 && rect.height >= 12 && rect.height <= 100
    && getComputedStyle(el).pointerEvents !== "none";
};

/** 从弹题根节点向上逐层找关闭控件；AI 小智的按钮常在题目内容根节点的兄弟/父节点里。 */
export const findClose = (dialog: HTMLElement): HTMLElement | null => {
  const doc = dialog.ownerDocument;
  const scopes: HTMLElement[] = [];
  let node: HTMLElement | null = dialog;
  while (node && node !== doc.body) {
    scopes.push(node);
    node = node.parentElement;
  }
  if (doc.body) scopes.push(doc.body);

  const center = (): { x: number; y: number } => {
    const rect = dialog.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  };
  const pickNearest = (items: HTMLElement[]): HTMLElement | null => {
    if (!items.length) return null;
    const target = center();
    return items
      .map((el) => {
        const rect = el.getBoundingClientRect();
        const dx = rect.left + rect.width / 2 - target.x;
        const dy = rect.top + rect.height / 2 - target.y;
        return { el, d: dx * dx + dy * dy };
      })
      .sort((a, b) => a.d - b.d)[0].el;
  };

  for (const scope of scopes) {
    const explicit = [...scope.querySelectorAll<HTMLElement>(CLOSE_SELECTOR)]
      .filter((el) => visible(el) && closeSized(el));
    if (explicit.length) return pickNearest(explicit);

    const textMatches = [...scope.querySelectorAll<HTMLElement>(
      "button, [role='button'], a, .btn, .topic-btn, div, span",
    )]
      .filter((el) => visible(el) && closeSized(el) && CLOSE_TEXT.test(textOf(el)));
    // 去掉包含同名子节点的外层容器，避免点到整块弹题。
    const leaves = textMatches.filter((el) => !textMatches.some((other) => other !== el && el.contains(other)));
    if (leaves.length) return pickNearest(leaves);
  }
  return null;
};
