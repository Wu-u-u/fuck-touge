# Popup 脚本状态与日志协作约定

> 目的：把「答题脚本状态 / 日志 → Fuck头歌 popup 底部展示」的接口和分工固定下来。
> 本文件是跨对话共享约定；当前对话负责脚本侧，隔壁对话负责 popup/bridge。

## 分工

### 当前对话（脚本侧）

- `eduauto/status.py`：状态发布器、heartbeat、日志 ring buffer。
- `flows.py` / 入口命令：在 run / harvest / subjective / cd 时发布状态。
- 脚本侧测试。
- 不修改 `Fuck头歌/src/popup/*` 和 `Fuck头歌/src/content/bridge.ts`。

### 隔壁对话（插件侧）

- `popup.html`：底部状态/日志区域。
- `popup.ts`：读取 `chrome.storage.local`、监听变化、状态颜色、复制/清空。
- `bridge.ts`：接收脚本 `postMessage` 并写入 storage。
- 插件侧 popup 测试。
- 不修改 `eduauto/`。

## 传输

```text
答题脚本
  → CDP Runtime.evaluate
  → window.postMessage({ source: "fuck-touge-script", type: "status", payload })
  → bridge.ts（ISOLATED world）
  → chrome.storage.local
  → popup 读取/监听
```

不使用 native messaging，不引入 localhost HTTP 服务。

## Storage Key

```text
fuckTougeScriptStatus
fuckTougeScriptLogs
```

## 状态 Payload

```json
{
  "version": 1,
  "updatedAt": 1790000000000,
  "state": "running",
  "slot": "15",
  "course": "数据结构与算法2026秋季",
  "chapter": "2026数据结构实验二：树",
  "level": "第3关",
  "message": "正在写代码"
}
```

`state` 取值：

```text
running   绿色
waiting   黄色（cd / browser 等，等待中）
stopped   黄色（正常结束）
error     红色
```

没有状态、或 `Date.now() - updatedAt > 10310` 且状态不是明确的 stopped：红色「刷题脚本未执行」。

- 只有 `run` / `harvest` / `subjective` 算 `running`。
- `cd` / `browser` 算 `waiting`。
- 脚本正常退出主动写 `stopped`。
- 进程被杀/崩溃时没有 `stopped`，10.31 秒后 red。

## 日志

```json
{
  "at": 1790000000000,
  "level": "info",
  "slot": "15",
  "course": "数据结构与算法2026秋季",
  "chapter": "2026数据结构实验二：树",
  "levelName": "第3关",
  "text": "评测成功"
}
```

- 保留最近 **25 条**。
- 不记录答案正文、Cookie、密码。
- popup 支持复制、清空。
- 红色状态下保留最后日志，可清空。

## 当前槽位

- status payload 带 `slot`。
- popup 显示最近状态对应的槽位。
- 多槽位顺序运行时，显示当前正在跑的槽位。
- 不按账号名显示，只用槽位号/课程/章节。

## 验收

- 脚本 `run` 时 popup 绿色并滚动日志。
- `cd` 时黄色「等待中」。
- 正常结束黄色「已停止」。
- 进程被杀后 10.31 秒变红「刷题脚本未执行」。
- 日志最多 25 条，可复制/清空。
- 不新增 popup 控制按钮（仅展示）。
