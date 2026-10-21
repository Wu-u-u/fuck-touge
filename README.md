# Fuck 头歌 · 头歌（educoder.net）工具箱

一个专门对付[头歌实践教学平台](https://www.educoder.net/)的小工具箱，包含两个独立又互补的部分：

| 组件 | 形态 | 作用 |
|---|---|---|
| **Fuck头歌** | Edge / Chromium 浏览器扩展（MV3，TypeScript + esbuild） | 解锁粘贴/复制、阻止头歌篡改剪贴板、答对自动「下一关」、编辑器美化（主题/字体/光标）+ 页面深色皮肤 |
| **头歌答题脚本** | Python 半自动答题器（默认零依赖 CDP，可选 Playwright 后端） | 按「标准答案档案」自动填答案、点评测，自动跳过已满分关卡、整章刷完自动换章；支持自动采集已做完的答案、多代码文件关卡（v0.9）、多账号档案槽 |

仅供学习交流，**禁止倒卖与盈利**。使用本工具产生的一切后果由使用者自负。

---

## 目录结构

```
.
├── Fuck头歌/          # 扩展源码（TypeScript + esbuild）与构建脚本
│   ├── src/          # 源码：content / features / shared / ui / popup / api
│   ├── tests/unit/   # Vitest 单测
│   ├── build.mjs     # 构建脚本（输出 dist/，不入库）
│   └── dist/         # 构建产物（Edge 加载这个文件夹）
├── 头歌答题脚本/       # Python 自动答题器
│   ├── 答题.py         # CLI 入口（browser / harvest / run）
│   ├── eduauto/       # 逻辑模块：后端接口 / 配置 / 浏览器 / 关卡 / 编辑器 / 答案 / 流程
│   ├── cdp.py         # 零依赖 CDP 客户端（默认后端）
│   ├── config.toml    # 配置
│   ├── answers.toml   # 标准答案档案（章节顺序 + 每关答案）
│   ├── 使用教程.txt    # 面向使用者的终端教程
│   ├── 脚本详细.md     # 开发者文档
│   └── 更新记录.md     # 改动日志
├── 项目详细/           # 扩展开发者文档（项目详解 + 更新记录）
└── 历史版本/           # 早期的油猴脚本与控制台版本
```

## 快速开始

### 一、浏览器扩展（Fuck头歌）

1. 构建（需要 Node.js ≥ 20）：`cd Fuck头歌 && npm ci && npm run build`，产物在 `Fuck头歌/dist/`；
   也可以直接下载 **Releases** 里的 `FuckTouge-v2.5.0.zip`（已构建好，解压即用）。
2. Edge → 扩展 → 管理扩展 → 打开「开发人员选项」→「加载解压缩的扩展」→ 选择 `Fuck头歌/dist` 文件夹
   （用 zip 的话，选择解压后的 `Fuck头歌` 文件夹）；
3. 打开头歌页面刷新即生效。

功能：解除粘贴/复制限制、拦截头歌往剪贴板写空格、答对自动点「下一关/最后一关/完成」、Catppuccin / GitHub 高对比主题、Maple Mono 字体、光标动画、页面皮肤（选择题等无编辑器页面也保持深色）。

### 二、自动答题脚本

```bash
cd 头歌答题脚本
python3 答题.py browser            # 启动副本浏览器并打开课程列表
python3 答题.py cd -ls             # 列出课程和序号
python3 答题.py cd 1               # 进入课程（也可写课程名片段）
python3 答题.py harvest            # 只处理当前课程：补骨架/采集答案
# 课程答案在 answers/<课程名>-<课程码>.toml，第一次 cd 自动创建
python3 答题.py run -y             # 只处理当前课程：自动跳过已满分关卡
# 章节参数直接跟在命令后，如：run -y 五 七 / harvest 八
```

#### 可选：Playwright 后端

默认使用脚本自带的零依赖 CDP 客户端；**不设置任何环境变量时行为完全不变**。
只有显式指定 `EDUAUTO_BACKEND=playwright` 才会切换到 Playwright，接管**已经启动**的调试 Edge：

```bash
python3 -m pip install -r requirements.txt   # playwright>=1.40，仅此模式需要

EDUAUTO_BACKEND=playwright python3 答题.py browser -ls
EDUAUTO_BACKEND=playwright python3 答题.py harvest
EDUAUTO_BACKEND=playwright python3 答题.py run -y "章节名"
```

Playwright 模式的限制（与默认 cdp 的差异）：

- **要求 Edge 已经启动**并开放调试端口（默认 9222）；脚本不会自动启动浏览器，也不会关闭共享 Edge。
- **不自动切换档案槽**：直接复用当前运行中的 Edge。需要换槽时先手动退出 Edge，或用 cdp 模式运行 `browser N`。
- **不管理扩展**：沿用浏览器里已加载的 Fuck头歌；未加载时脚本会走自己的跳关兜底。
- **按键仅支持 Escape**（关代码弹窗兜底）；其他按键/未实现的 CDP 方法会明确报错，不会静默忽略。
- 连接现有 Edge 不需要执行 `playwright install` 下载浏览器内核。

更多命令与场景（采集已完成答案、多账号档案槽、失败续跑等）见
`头歌答题脚本/使用教程.txt`；实现原理与平台踩坑见 `头歌答题脚本/脚本详细.md`。

## 文档

- 扩展实现档案：[项目详细/项目详解.md](项目详细/项目详解.md)
- 脚本实现档案：[头歌答题脚本/脚本详细.md](头歌答题脚本/脚本详细.md)
- 脚本使用教程：[头歌答题脚本/使用教程.txt](头歌答题脚本/使用教程.txt)
- 更新记录：[项目详细/更新记录.md](项目详细/更新记录.md)、[头歌答题脚本/更新记录.md](头歌答题脚本/更新记录.md)

## 贡献者

<table>
  <tr>
    <td align="center" width="140">
      <a href="https://github.com/Wu-u-u"><img src="https://avatars.githubusercontent.com/u/245545308?v=4" width="64" alt="Wu-u-u" /><br /><b>Wu-u-u</b></a><br /><sub>项目作者 / 需求与测试</sub>
    </td>
    <td align="center" width="140">
      <a href="https://github.com/deepseek-ai"><img src="https://avatars.githubusercontent.com/u/148330874?v=4" width="64" alt="DeepSeek" /><br /><b>DeepSeek</b></a><br /><sub>AI 结对开发 / 编码与文档</sub>
    </td>
  </tr>
</table>

## 免责声明

- 本项目仅用于学习交流，**禁止倒卖与盈利**；
- 不提供绕过考试监考等功能；请遵守学校与平台的相关规定；
- 平台改版可能导致功能失效，欢迎 Issue 反馈。

## License

代码采用 MIT 协议；`Fuck头歌/src/assets/fonts/` 下的 Maple Mono 字体遵循其自身 OFL 协议（构建后位于 `dist/fonts/LICENSE.txt`）。
