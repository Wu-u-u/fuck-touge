# Rust 重构评估（2026-11-22）

> 结论先行：**不做全量重构；已做局部可选试点**。当前主要耗时在页面导航、平台接口和固定冷却，不在 Python CPU；原语言足够，Rust 只在 `ftstatus` 状态快照写入上做 opt-in 试点，默认仍走 Python。

## 1. 当前瓶颈

- `run` 的时间主要花在：
  - 打开/等待 educoder 页面；
  - 详情表接口请求；
  - 评测执行/冷却；
  - Monaco/CodeMirror 编辑器加载。
- Python 侧的 JSON、HTTP、WebSocket 和日志开销相对很小。
- 状态上报每 2 秒一次，日志最多 25 条，不构成性能压力。
- TUI 只是子进程封装，性能瓶颈是子进程和页面，不是 TUI 本身。

## 2. Rust 可选方案

| 方案 | 适合解决 | 代价 |
|---|---|---|
| PyO3 扩展：CDP WebSocket / JSON | 协议层 CPU 开销 | 构建链、跨 Python 版本 wheel、回退路径 |
| Rust sidecar：状态/日志桥 | 长时间稳定运行 | 新进程生命周期、扩展通信 |
| Rust CLI：批量调度 | 多进程调度 | 与现有 Python CLI 重复 |
| 不重构 | 当前需求 | 无新增风险 |

## 3. 建议

1. 先给现有 `run/harvest/TUI` 做基准：记录总耗时、页面等待、评测冷却、Python 函数耗时。
2. 只有证明 Python 层占比显著时才考虑 Rust。
3. 如果做，优先 **独立 sidecar**（状态/日志/调度），不改答题业务；失败可回退 Python。
4. 不重写编辑器/页面交互；那是平台等待，不是语言性能。
5. 不引入 Rust 也能满足当前功能和维护性。

## 4. 验收门槛

- Rust 版本必须与 Python 输出/档案/状态契约完全一致；
- 有可回退开关；
- 全量测试和真实槽位 1 流程通过；
- 性能提升可量化，否则不合并。

## 5. 已落地局部试点（2026-11-22）

- `rust/ftstatus/`：stdin NDJSON → 原子写 `state.status.json`，无第三方 crate。
- Python `status.py` 只有 `EDUAUTO_RUST_STATUS=1` 且 release 二进制存在时才启动 sidecar；否则继续 Python 原子写。
- sidecar 退出/构建缺失自动回退，不影响刷题和 popup 状态桥。
- 结论：不接全量 Rust；状态写盘不是主要瓶颈，但这是安全的局部验证，后续可用同一模式试 CDP/调度。
