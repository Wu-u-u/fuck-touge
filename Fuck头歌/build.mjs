// Fuck头歌 构建脚本：esbuild 多入口 → dist/；复制静态资源；--zip 生成分享包
import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, "dist");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const manifest = JSON.parse(readFileSync(join(root, "src/manifest.json"), "utf8"));

if (manifest.version !== pkg.version) {
  throw new Error(`版本不一致：manifest=${manifest.version} package=${pkg.version}`);
}

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

await build({
  entryPoints: {
    "允许粘贴": join(root, "src/content/main.ts"),
    fonts: join(root, "src/content/fonts.ts"),
    popup: join(root, "src/popup/popup.ts"),
  },
  outdir: dist,
  bundle: true,
  format: "iife",
  target: ["chrome111"],
  platform: "browser",
  sourcemap: true,
  minify: false,
  legalComments: "inline",
  banner: { js: "//! Fuck头歌 — 由 src/ 构建生成，请勿直接编辑 dist" },
  logLevel: "info",
});

// 静态资源
cpSync(join(root, "src/manifest.json"), join(dist, "manifest.json"));
cpSync(join(root, "src/popup/popup.html"), join(dist, "popup.html"));
for (const name of ["icon16.png", "icon48.png", "icon128.png"]) {
  cpSync(join(root, "src/assets/icons", name), join(dist, name));
}
cpSync(join(root, "src/assets/fonts"), join(dist, "fonts"), { recursive: true });

console.log("构建完成 →", dist);

if (process.argv.includes("--zip")) {
  const zipPath = resolve(root, "..", "Fuck头歌.zip");
  const doc = join(root, "使用说明.txt");
  const script = `
import os, sys, zipfile
zip_path, dist_dir, doc = sys.argv[1], sys.argv[2], sys.argv[3]
with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as z:
    z.write(doc, "使用说明.txt")
    for base, _dirs, files in os.walk(dist_dir):
        for f in files:
            if f.endswith(".map"):
                continue
            p = os.path.join(base, f)
            rel = os.path.relpath(p, dist_dir).replace(os.sep, "/")
            z.write(p, "Fuck头歌/" + rel)
print("打包完成:", zip_path, os.path.getsize(zip_path), "bytes")
`;
  execFileSync("python3", ["-c", script, zipPath, dist, doc], { stdio: "inherit" });
}
