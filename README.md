# dsh-quick-restart

DSH 会话标题栏右上角的一键**重启**按钮：点它，DSH 桌面端会自己关掉再启动回来，**全程不弹控制台黑框**。

> English summary below. One-click restart button for the DSH desktop app — it warns
> about running work first, then closes and relaunches the app without opening a
> console window.

## 它做什么

1. 点会话视图右上角的 **⟳ 重启**。
2. 插件先问 Host「重启会打断什么」。
   - **没有任务在跑** → 直接重启。
   - **还有任务在跑** → 弹窗列出正在跑的会话与后台作业，给出 **取消 / 仍然重启**，无视警告继续重启始终允许。
3. 应用关闭，几秒后自动回来。

任务检测的口径照抄桌面端自己的退出检查（`hasDesktopActiveTasks`），所以弹窗列的东西和「点叉退出时它自己说的」完全一致：

| 算作「正在跑」 | 不算 |
| --- | --- |
| 正在生成回答的 agent | 定时任务（重启后照常触发） |
| 收件箱里有排队消息或待执行步骤的 agent | 已结束的后台作业 |
| 状态是 `running` / `stopping` 的后台作业 | |

## 安装

```sh
dsh plugin --profile desktop add github:3309602454/dsh-quick-restart
```

装完**重启一次桌面端**，客户端那一半才会注入。

按钮需要 DSH 的 `conversation.session.header.utilities` 槽，0.2.x 的官方 Web/Desktop 前端都有。

## 限制

- **仅支持 Windows 桌面版。** 重启靠 Windows 计划任务执行，macOS / Linux 还没做。其他平台上插件照常加载，按钮会明确说「不支持」，而不是瞎报错。
- 必须是**桌面版**应用。在 `dsh web`（命令行）里没有外壳可重启，按钮会直接说明。
- 重启会**打断正在跑的工作** —— 这正是那个警告弹窗存在的意义。
- 定时任务不受影响，重启后照常触发。

## 原理

```
DeepSeek Harness.exe            ← Electron 主进程（应用窗口）
  └── dsh-desktop-host          ← Node 子进程，插件跑在这层
        └── 注册并触发一个 Windows 计划任务
              └── pythonw.exe   ← 无窗口助手，在 App 进程树之外
                    杀主进程 → 等待 → 重新拉起应用
```

有两个约束是这个设计的原因，都是**实测**出来的，不是拍脑袋：

**助手必须待在 App 进程树之外。** 插件跑在 Electron 主进程的子进程里，它 spawn 出来的东西都在同一棵树内，`taskkill /F /T` 会一起带走——最初用 `spawn(..., {detached: true})` 的助手，结果就是**应用关了但没回来**。改用 `schtasks` 注册的计划任务后，任务由 Task Scheduler 服务（svchost）执行，完全在树外，杀不掉。

**助手不能有控制台。** 用 `.cmd` 或任何控制台程序，Windows 都会分配一个控制台窗口，用户看到黑框一闪。`pythonw.exe` 是 GUI 子系统的二进制，进程根本没有控制台（`GetConsoleWindow()` 返回 `0`）。

任务用 `schtasks /create /xml` 注册而不是 `/tr`，因为 `/tr` 会拒绝超过 261 字符的命令行，而 `pythonw.exe` 的真实路径加上带引号的 App 路径会超。

助手跑完会删掉这个计划任务，下次 Host 启动时也会清理残留，陈旧的触发器不可能在以后某天突然执行。

## HTTP 接口

三条路由都由 Host 半注册，挂在应用自己的 origin 下。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/dsh-quick-restart/status` | `{ desktop, supported, platform, exe, exeExists, mainPid, clientVersion }` |
| `GET` | `/dsh-quick-restart/activity` | `{ ok, active, agents[], jobs[] }` —— 重启会打断什么 |
| `POST` | `/dsh-quick-restart/restart` | 执行重启。body `{"force":true}` 跳过任务检查 |

`restart` 的错误码：`not-desktop`、`unsupported-platform`、`exe-missing`、
`tasks-active`（响应里带 `agents` / `jobs` 明细）、`relaunch-failed`（带 `detail` 字符串）。

## 日志

`%TEMP%\dsh-quick-restart\helper.log` —— 每一步一行，包括 `taskkill` 和重新拉起的结果。重启出问题时先看它。

计划任务名：`DSHQuickRestart`，用 `schtasks /query /tn DSHQuickRestart` 查看或清理。

## English

A one-click **restart** button in the DSH conversation header. It closes the DSH
desktop app and starts it again — without any console window flashing on screen.

1. Click **⟳ 重启** in the top-right of the session view.
2. The plugin asks the Host what a restart would interrupt.
   - **Nothing running** → it restarts immediately.
   - **Work still running** → a warning lists the busy sessions and background
     jobs, with **取消 / 仍然重启**. Restarting anyway is always allowed.
3. The app closes and comes back on its own.

The activity check mirrors the Desktop shell's own quit inspection, so the warning
matches what the app itself considers live work: an agent that is generating, an
agent with queued inbox messages or steps, and a background job that is `running`
or `stopping`. Scheduled reminders are *not* counted — they fire again after a
restart.

### Requirements and limits

- **Windows desktop app only.** The restart is carried out through Windows Task
  Scheduler; there is no macOS/Linux implementation yet. On other platforms the
  button reports that plainly instead of failing, and the plugin loads normally.
- The app must be the **desktop** build. Under a plain `dsh web` (CLI) server
  there is no shell to restart, and the button says so.
- A restart **interrupts running work**. That is what the warning is for.

### How it works

```
DeepSeek Harness.exe            ← Electron main process (the app's window)
  └── dsh-desktop-host          ← Node child; plugins run here
        └── registers + fires a Windows scheduled task
              └── pythonw.exe   ← windowless helper, outside the app's process tree
                    kills the main process, waits, relaunches the app
```

Two constraints shaped this design, both measured rather than assumed:

**The helper must live outside the app's process tree.** Plugins run in a child
of the Electron main process, so anything the plugin spawns is killed along with
the app — a plain `spawn(..., {detached: true})` helper closed the app and never
brought it back. A task registered with `schtasks` runs under the Task Scheduler
service instead, so it survives the kill and can start the app again.

**The helper must not own a console.** A `.cmd` trampoline or any console
executable makes Windows allocate a console window, which the user sees flash.
`pythonw.exe` is a GUI-subsystem binary: the helper process has no console at all
(`GetConsoleWindow()` returns `0`).

The task is registered through `schtasks /create /xml` rather than `/tr`, because
`/tr` rejects command lines longer than 261 characters — the real path to
`pythonw.exe` plus the quoted app path is longer than that.

The helper deletes the task when it finishes, and the next Host start clears any
leftover, so a stale trigger can never fire later.

### HTTP routes

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/dsh-quick-restart/status` | `{ desktop, supported, platform, exe, exeExists, mainPid, clientVersion }` |
| `GET` | `/dsh-quick-restart/activity` | `{ ok, active, agents[], jobs[] }` — what a restart would interrupt |
| `POST` | `/dsh-quick-restart/restart` | Restart. Body `{"force":true}` skips the work check |

`restart` error codes: `not-desktop`, `unsupported-platform`, `exe-missing`,
`tasks-active` (response carries the `agents` / `jobs` detail), `relaunch-failed`
(with a `detail` string).

### Logs

`%TEMP%\dsh-quick-restart\helper.log` — one line per step, including the
`taskkill` and relaunch outcome. Check this first if a restart misbehaves.

Task name: `DSHQuickRestart`. Inspect or clear it with
`schtasks /query /tn DSHQuickRestart`.

## 许可

MIT
