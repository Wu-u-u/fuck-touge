/** Vite/Vitest 原生支持 ?raw；esbuild 侧由 build.mjs 的 raw-css 插件处理 */
declare module "*.css?raw" {
  const css: string;
  export default css;
}
