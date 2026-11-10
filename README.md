# dsh-quick-restart

A one-click **restart** button in the DSH conversation header. It closes the DSH
desktop app and starts it again 鈥?without any console window flashing on screen.

## What it does

1. Click **鉄?閲嶅惎** in the top-right of the session view.
2. The plugin asks the Host what a restart would interrupt.
   - **Nothing running** 鈫?it restarts immediately.
   - **Work still running** 鈫?a warning lists the busy sessions and background
     jobs, with **鍙栨秷 / 浠嶇劧閲嶅惎**. Restarting anyway is always allowed.
3. The app closes and comes back on its own.

The activity check mirrors the Desktop shell's own quit inspection, so the warning
matches what the app itself considers live work:

| Counted as running work | Not counted |
| --- | --- |
| An agent that is generating | Scheduled reminders (they fire again after a restart) |
| An agent with queued inbox messages or steps | Settled background jobs |
| A background job that is `running` or `stopping` | |

## Install

```sh
dsh plugin --profile desktop add github:3309602454/dsh-quick-restart
```

Restart the desktop app once after installing, so the client half is injected.

The button needs DSH's `conversation.session.header.utilities` slot, which exists
in the stock Web/Desktop frontend from 0.2.x.

## Requirements and limits

- **Windows desktop app only.** The restart is carried out through Windows Task
  Scheduler; there is no macOS/Linux implementation yet. On other platforms the
  button reports that plainly instead of failing, and the plugin loads normally.
- The app must be the **desktop** build. Under a plain `dsh web` (CLI) server
  there is no shell to restart, and the button says so.
- A restart **interrupts running work**. That is what the warning is for.

## How it works

```
DeepSeek Harness.exe            鈫?Electron main process (the app's window)
  鈹斺攢鈹€ dsh-desktop-host          鈫?Node child; plugins run here
        鈹斺攢鈹€ registers + fires a Windows scheduled task
              鈹斺攢鈹€ pythonw.exe   鈫?windowless helper, outside the app's process tree
                    kills the main process, waits, relaunches the app
```

Two constraints shaped this design, both measured rather than assumed:

**The helper must live outside the app's process tree.** Plugins run in a child
of the Electron main process, so anything the plugin spawns is killed along with
the app 鈥?a plain `spawn(..., {detached: true})` helper closed the app and never
brought it back. A task registered with `schtasks` runs under the Task Scheduler
service instead, so it survives the kill and can start the app again.

**The helper must not own a console.** A `.cmd` trampoline or any console
executable makes Windows allocate a console window, which the user sees flash.
`pythonw.exe` is a GUI-subsystem binary: the helper process has no console at all
(`GetConsoleWindow()` returns `0`).

The task is registered through `schtasks /create /xml` rather than `/tr`, because
`/tr` rejects command lines longer than 261 characters 鈥?the real path to
`pythonw.exe` plus the quoted app path is longer than that.

The helper deletes the task when it finishes, and the next Host start clears any
leftover, so a stale trigger can never fire later.

## HTTP routes

Both are registered by the Host half and served under the app's own origin.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/dsh-quick-restart/status` | `{ desktop, supported, platform, exe, exeExists, mainPid, clientVersion }` |
| `GET` | `/dsh-quick-restart/activity` | `{ ok, active, agents[], jobs[] }` 鈥?what a restart would interrupt |
| `POST` | `/dsh-quick-restart/restart` | Restart. Body `{"force":true}` skips the work check |

`restart` error codes: `not-desktop`, `unsupported-platform`, `exe-missing`,
`tasks-active` (response carries the `agents` / `jobs` detail), `relaunch-failed`
(with a `detail` string).

## Logs

`%TEMP%\dsh-quick-restart\helper.log` 鈥?one line per step, including the
`taskkill` and relaunch outcome. Check this first if a restart misbehaves.

Task name: `DSHQuickRestart`. Inspect or clear it with
`schtasks /query /tn DSHQuickRestart`.

## License

MIT
