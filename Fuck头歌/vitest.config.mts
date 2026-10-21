import { defineConfig } from "vitest/config";

// ?raw 需要开启 CSS 处理，否则 Vitest 会把 CSS 模块置空
export default defineConfig({
  test: { css: true },
});
