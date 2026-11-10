"""Restart helper for dsh-quick-restart — windowless.

Registered as a Windows scheduled task by the Host plugin, so it runs outside the
app's process tree (killing the app cannot take it down) and under the Task
Scheduler service.

Why Python and not a .cmd/.js trampoline: launching a batch or a console
executable from Task Scheduler allocates a console window the user sees flash on
screen. `pythonw.exe` is a GUI-subsystem binary, so this process has no console
at all — verified: GetConsoleWindow() returns 0.

Arguments: <mainPid> <exePath> [processName]

Steps: wait for the HTTP response to land -> kill the main process -> wait for
every remaining app process -> relaunch -> verify, and retry once if nothing
came back. The scheduled task is removed again by this script and by the next
Host start, so a stale trigger cannot fire later.
"""

import ctypes
import os
import subprocess
import sys
import time
from datetime import datetime

APP_PROCESS_NAME = "DeepSeek Harness"
TASK_NAME = "DSHQuickRestart"
LOG_DIR = os.path.join(os.environ.get("TEMP", os.getcwd()), "dsh-quick-restart")
LOG_PATH = os.path.join(LOG_DIR, "helper.log")

# Let the HTTP response reach the browser before the app starts dying.
KILL_DELAY = 1.5
# How long the app gets to exit on its own after the main process dies.
EXIT_WAIT = 6.0
# Settle time between "app is gone" and the relaunch.
RELAUNCH_SETTLE = 1.0
# How long the relaunched app gets to show up before the retry.
WATCHDOG = 40.0


def log(message):
    """Append one timestamped line to the helper log. Never raises."""
    try:
        os.makedirs(LOG_DIR, exist_ok=True)
        with open(LOG_PATH, "a", encoding="utf-8") as handle:
            handle.write(f"{datetime.now().isoformat()} [{os.getpid()}] {message}\n")
    except Exception:
        pass


def run(args):
    """Run a command with no console window and return (status, output)."""
    try:
        result = subprocess.run(
            args,
            capture_output=True,
            text=True,
            errors="replace",
            timeout=30,
            creationflags=subprocess.CREATE_NO_WINDOW,
        )
        return result.returncode, (result.stdout or "") + (result.stderr or "")
    except Exception as error:  # noqa: BLE001 - reported through the log
        return -1, str(error)


def app_pids(name):
    """PIDs of the app image that are not this process."""
    status, text = run(["tasklist.exe", "/FI", f"IMAGENAME eq {name}.exe", "/FO", "CSV", "/NH"])
    if status != 0:
        return []
    if f"{name.lower()}.exe" not in text.lower():
        return []
    pids = []
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        columns = line.split('","')
        if len(columns) < 2:
            continue
        try:
            pid = int(columns[1].replace('"', ""))
        except ValueError:
            continue
        if pid > 0 and pid != os.getpid():
            pids.append(pid)
    return pids


def clean_env():
    """Environment for the relaunched app; never a Node-mode child."""
    env = dict(os.environ)
    for name in ("ELECTRON_RUN_AS_NODE", "ELECTRON_NO_ATTACH_CONSOLE", "DSH_DESKTOP_NODE_EXECUTABLE"):
        env.pop(name, None)
    return env


def drop_task():
    """Delete the scheduled task so it cannot fire again."""
    run(["schtasks.exe", "/delete", "/tn", TASK_NAME, "/f"])


def launch_app(exe):
    """Start the app detached and report the new pid, or None."""
    if not exe or not os.path.isfile(exe):
        log(f"executable missing, cannot relaunch: {exe}")
        return None
    try:
        # DETACHED_PROCESS + CREATE_NEW_PROCESS_GROUP: fully independent of this
        # helper, which exits moments later.
        process = subprocess.Popen(
            [exe],
            close_fds=True,
            creationflags=(
                subprocess.DETACHED_PROCESS
                | subprocess.CREATE_NEW_PROCESS_GROUP
                | subprocess.CREATE_NO_WINDOW
            ),
            env=clean_env(),
            cwd=os.path.dirname(exe) or None,
        )
        log(f"relaunched {exe} pid={process.pid}")
        return process.pid
    except Exception as error:  # noqa: BLE001
        log(f"relaunch failed: {error}")
        return None


def main():
    if len(sys.argv) < 3:
        log(f"missing arguments: {sys.argv[1:]}")
        return 1
    try:
        main_pid = int(sys.argv[1])
    except ValueError:
        log(f"invalid main pid: {sys.argv[1]}")
        return 1
    exe = sys.argv[2]
    process_name = sys.argv[3] if len(sys.argv) > 3 else APP_PROCESS_NAME

    if main_pid <= 0:
        log(f"invalid main pid: {main_pid}")
        return 1

    log(f"helper started (windowless, via scheduled task); target main={main_pid} exe={exe}")

    time.sleep(KILL_DELAY)

    # Only the main process: /T is unnecessary (this helper is outside the tree)
    # and would take the renderers down before the sweep can count them.
    status, output = run(["taskkill.exe", "/F", "/PID", str(main_pid)])
    log(f"taskkill {main_pid} (status={status}): {output.strip()}")

    deadline = time.monotonic() + EXIT_WAIT
    remaining = app_pids(process_name)
    while time.monotonic() < deadline and remaining:
        time.sleep(0.3)
        remaining = app_pids(process_name)

    if remaining:
        log(f"app processes lingered ({','.join(map(str, remaining))}); killing them individually")
        for pid in remaining:
            if pid != os.getpid():
                run(["taskkill.exe", "/F", "/PID", str(pid)])
        sweep_deadline = time.monotonic() + 5.0
        left = app_pids(process_name)
        while time.monotonic() < sweep_deadline and left:
            time.sleep(0.25)
            left = app_pids(process_name)
        log(f"after sweep, still alive: {','.join(map(str, left)) if left else 'none'}")

    time.sleep(RELAUNCH_SETTLE)
    started = launch_app(exe)

    time.sleep(WATCHDOG)
    alive = app_pids(process_name)
    log(f"watchdog: {len(alive)} app process(es) after relaunch (started pid={started})")
    if not alive:
        log("watchdog: nothing came back; retrying once")
        launch_app(exe)
        time.sleep(15)
        log(f"watchdog retry result: {len(app_pids(process_name))} process(es)")

    drop_task()
    return 0


if __name__ == "__main__":
    # No console exists here, but stdout/stderr can still be None under pythonw;
    # never let a stray print crash the helper (a known pythonw trap).
    if sys.stdout is None:
        sys.stdout = open(os.devnull, "w", encoding="utf-8")
    if sys.stderr is None:
        sys.stderr = open(os.devnull, "w", encoding="utf-8")
    try:
        sys.exit(main())
    except Exception as fatal:  # noqa: BLE001
        log(f"helper crashed: {fatal!r}")
        sys.exit(1)
