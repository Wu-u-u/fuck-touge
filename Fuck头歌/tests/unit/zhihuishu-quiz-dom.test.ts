// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { findClose, findQuiz, normalizeQuizTitle } from "../../src/sites/zhihuishu/quiz-dom";

const layout = (el: Element): void => {
  el.getBoundingClientRect = () => ({
    x: 0, y: 0, left: 0, top: 0, right: 120, bottom: 24,
    width: 120, height: 24, toJSON: () => ({}),
  }) as DOMRect;
};

afterEach(() => {
  document.body.innerHTML = "";
});

describe("zhihuishu quiz DOM", () => {
  it("finds the close button outside the narrow AI quiz root", () => {
    document.body.innerHTML = `
      <div class="ai-card">
        <div class="ai-content">
          <div class="ai-title">AI助教小智给你出题啦！学习过程中有问题，随时点我</div>
          <div class="question">【单选题】戴维孙—革末实验证明了（ ）</div>
          <label class="option"><input type="radio" name="q"> A. 电子的粒子性</label>
          <label class="option"><input type="radio" name="q"> B. 电子的波动性</label>
          <div class="answer">正确答案：B</div>
        </div>
        <button class="close-btn">关闭</button>
      </div>`;
    document.querySelectorAll("*:not(.ai-card)").forEach(layout);
    const dialog = findQuiz();
    expect(dialog).not.toBeNull();
    expect(dialog?.className).toBe("ai-content");
    const close = findClose(dialog!);
    expect(close?.textContent?.trim()).toBe("关闭");
  });

  it("normalizes the quiz title when the platform appends the answer", () => {
    const before = normalizeQuizTitle("AI助教小智 单选题 A. 一 B. 二 C. 三");
    const after = normalizeQuizTitle("AI助教小智 单选题 A. 一 B. 二 C. 三 正确答案：B");
    expect(after).toBe(before);
    expect(normalizeQuizTitle("  题目  正确答案：A  ")).toBe("题目");
  });

  it("finds a text-only close button and ignores the whole dialog wrapper", () => {
    document.body.innerHTML = `
      <div class="topic-dialog">
        <div class="topic-title">【单选题】测试题</div>
        <label><input type="radio"> A</label>
        <div class="topic-footer"><span class="close">关闭</span></div>
      </div>`;
    document.querySelectorAll("*").forEach(layout);
    const dialog = findQuiz();
    expect(dialog).not.toBeNull();
    const close = findClose(dialog!);
    expect(close?.className).toBe("close");
  });
});
