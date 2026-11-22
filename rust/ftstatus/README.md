# ftstatus（局部 Rust 试点）

一个只负责把 stdin 的 JSON 行原子写入状态文件的极简 sidecar，供
`EDUAUTO_RUST_STATUS=1` 时可选使用；默认 Python 实现完全不变。

```bash
cd rust/ftstatus
cargo build --release
printf '{"state":"running"}\n' | ./target/release/ftstatus /tmp/status.json
```

Python 侧开关：

```bash
EDUAUTO_RUST_STATUS=1 python3 答题.py cd
```

没有构建、进程失败或开关未设置时自动回退 Python 的 `state.status.json` 写入。
