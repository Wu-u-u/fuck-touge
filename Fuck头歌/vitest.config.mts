import { defineConfig } from "vitest/config";

// ?raw 需要开启 CSS 处理，否则 Vitest 会把 CSS 模块置空
export default defineConfig({
  test: {
    css: true,
    server: {
      deps: {
        // 该包是 ESM，内部相对导入省略 .js；inline 后交给 Vite 解析
        inline: ["@material/material-color-utilities"],
      },
    },
  },
});
