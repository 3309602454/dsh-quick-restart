/**
 * dsh-quick-restart — client half.
 *
 * Adds a "重启" button to the conversation header (the row in the top-right of
 * the session view, slot `conversation.session.header.utilities`).
 *
 * Clicking it is a two-step flow:
 *   1. ask the Host whether anything is still running (`GET /activity`);
 *   2. with live work, show a warning that lists what would be interrupted and
 *      offers "仍然重启" — with nothing running, restart straight away.
 *
 * Loaded through the `dsh.client` bundle format; the registration id MUST equal
 * the loader row name (`dsh-quick-restart`), otherwise the module system reports
 * "loaded without registering".
 */
window.__ModuleLoader__.load({
  id: 'dsh-quick-restart',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')

    const ROUTE_PREFIX = '/dsh-quick-restart'
    const STYLE_ID = 'dsh-quick-restart-style'

    const CSS = `
[data-dsh-quick-restart] {
  align-items: center;
  appearance: none;
  background: transparent;
  border: 1px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, .28));
  border-radius: 18px;
  color: var(--dsw-alias-label-primary, #111827);
  cursor: pointer;
  display: inline-flex;
  font-family: var(--dsw-font-family);
  font-size: 13px;
  font-weight: 400;
  gap: 5px;
  height: 32px;
  justify-content: center;
  line-height: 20px;
  padding: 6px 12px;
  white-space: nowrap;
}
[data-dsh-quick-restart]:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, .1));
}
[data-dsh-quick-restart]:disabled {
  color: var(--dsw-alias-label-dimmed, #9ca3af);
  cursor: progress;
}
[data-dsh-quick-restart] .dsh-quick-restart__icon {
  display: inline-block;
  font-size: 14px;
  line-height: 1;
}
[data-dsh-quick-restart][data-busy="true"] .dsh-quick-restart__icon {
  animation: dsh-quick-restart-spin .9s linear infinite;
}
@keyframes dsh-quick-restart-spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

[data-dsh-qr-backdrop] {
  align-items: center;
  background: rgba(0, 0, 0, .34);
  display: flex;
  inset: 0;
  justify-content: center;
  position: fixed;
  z-index: 1300;
}
[data-dsh-qr-dialog] {
  background: var(--dsw-alias-bg-layer-1, #fff);
  border: 1px solid var(--dsw-alias-border-l1, rgba(127, 127, 127, .2));
  border-radius: 12px;
  box-shadow: 0 18px 48px rgba(0, 0, 0, .28);
  color: var(--dsw-alias-label-primary, #111827);
  display: flex;
  flex-direction: column;
  font-family: var(--dsw-font-family);
  font-size: 13px;
  gap: 14px;
  max-height: 76vh;
  max-width: 460px;
  overflow: auto;
  padding: 20px 22px 16px;
  width: min(460px, calc(100vw - 48px));
}
[data-dsh-qr-dialog] .dsh-qr-title {
  font-size: 15px;
  font-weight: 600;
}
[data-dsh-qr-dialog] .dsh-qr-body {
  line-height: 1.6;
}
[data-dsh-qr-dialog] .dsh-qr-list {
  border: 1px solid var(--dsw-alias-border-l1, rgba(127, 127, 127, .18));
  border-radius: 8px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 0;
  max-height: 34vh;
  overflow: auto;
  padding: 10px 12px;
}
[data-dsh-qr-dialog] .dsh-qr-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
[data-dsh-qr-dialog] .dsh-qr-item-main {
  font-weight: 500;
}
[data-dsh-qr-dialog] .dsh-qr-item-note {
  color: var(--dsw-alias-label-tertiary, #9ca3af);
  font-size: 12px;
}
[data-dsh-qr-dialog] .dsh-qr-hint {
  color: var(--dsw-alias-label-tertiary, #9ca3af);
  font-size: 12px;
}
[data-dsh-qr-dialog] .dsh-qr-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  margin-top: 2px;
}
[data-dsh-qr-dialog] button {
  appearance: none;
  border-radius: 8px;
  cursor: pointer;
  font-family: inherit;
  font-size: 13px;
  height: 32px;
  padding: 0 16px;
}
[data-dsh-qr-dialog] .dsh-qr-cancel {
  background: transparent;
  border: 1px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, .3));
  color: var(--dsw-alias-label-primary, #111827);
}
[data-dsh-qr-dialog] .dsh-qr-cancel:hover {
  background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, .1));
}
[data-dsh-qr-dialog] .dsh-qr-confirm {
  background: rgb(220, 38, 38);
  border: 1px solid rgb(220, 38, 38);
  color: #fff;
}
[data-dsh-qr-dialog] .dsh-qr-confirm:hover {
  background: rgb(185, 28, 28);
}
`

    /** Detect the app's deploy prefix (reverse proxies can mount DSH under a sub-path). */
    const detectAppBase = (doc) => {
      if (!doc) return ''
      try {
        const script = doc.currentScript
        const href = script && script.src ? new URL(script.src, doc.baseURI).pathname : ''
        const match = /^(.*?)\/plugins\//.exec(href)
        if (match) return match[1].replace(/\/+$/, '')
      } catch {
        /* not a browser document */
      }
      return ''
    }

    const APP_BASE = detectAppBase(typeof document === 'undefined' ? undefined : document)
    const absAppPath = (path) => (APP_BASE && !path.startsWith(`${APP_BASE}/`) ? APP_BASE + path : path)

    function ensureStyle(doc) {
      if (!doc) return () => {}
      if (doc.getElementById(STYLE_ID)) return () => {}
      const style = doc.createElement('style')
      style.id = STYLE_ID
      style.textContent = CSS
      doc.head.appendChild(style)
      return () => {
        style.remove()
      }
    }

    async function readJson(response) {
      return response.json().catch(() => ({}))
    }

    /** Map a Host error code to something a person can read. */
    function describeError(code, status) {
      switch (code) {
        case 'not-desktop':
          return '重启只对桌面版有效（当前是命令行 / web 环境）'
        case 'unsupported-platform':
          return '重启目前只支持 Windows 桌面版'
        case 'relaunch-failed':
          return '拉起新进程失败'
        case 'exe-missing':
          return '找不到 DeepSeek Harness 可执行文件'
        case 'tasks-active':
          return '还有任务在跑'
        default:
          return code ?? `HTTP ${String(status)}`
      }
    }

    /** Ask the Host what a restart would interrupt. Never throws. */
    async function probeActivity() {
      try {
        const response = await fetch(absAppPath(`${ROUTE_PREFIX}/activity`), {
          method: 'GET',
          credentials: 'same-origin',
          cache: 'no-store',
        })
        const data = await readJson(response)
        if (!response.ok || data.ok !== true) return { active: false, agents: [], jobs: [], unknown: true }
        return data
      } catch {
        // The probe is advisory: if it cannot answer, let the user restart anyway
        // rather than blocking the button on a broken route.
        return { active: false, agents: [], jobs: [], unknown: true }
      }
    }

    /** Send the restart request. `force` acknowledges interrupted work. */
    async function requestRestart(force) {
      const response = await fetch(absAppPath(`${ROUTE_PREFIX}/restart`), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(force ? { force: true } : {}),
        credentials: 'same-origin',
      })
      const data = await readJson(response)
      if (!response.ok || data.ok !== true) {
        const error = new Error(describeError(data.error, response.status))
        error.code = data.error
        error.payload = data
        throw error
      }
      return data
    }

    /** "写插件 · 生成中" / "有 2 条排队" — one line per busy agent. */
    function describeAgent(agent) {
      const name = agent.title ?? agent.id ?? '会话'
      const notes = []
      if (agent.status === 'running') notes.push('正在生成')
      if (agent.queuedTurn > 0) notes.push(`${String(agent.queuedTurn)} 条排队消息`)
      if (agent.queuedStep > 0) notes.push(`${String(agent.queuedStep)} 个待执行步骤`)
      return { main: name, note: notes.join(' · ') }
    }

    function describeJob(job) {
      const kind = job.kind ?? '后台任务'
      return {
        main: String(kind),
        note: `${job.status === 'stopping' ? '正在停止' : '运行中'} · ${String(job.id ?? '')}`,
      }
    }

    /** The warning dialog shown only when something is actually running. */
    function ActiveWorkDialog({ work, onCancel, onConfirm }) {
      const items = [...(work.agents ?? []).map(describeAgent), ...(work.jobs ?? []).map(describeJob)]
      return React.createElement(
        'div',
        {
          'data-dsh-qr-backdrop': '',
          role: 'presentation',
          onMouseDown: (event) => {
            if (event.target === event.currentTarget) onCancel()
          },
        },
        React.createElement(
          'div',
          { 'data-dsh-qr-dialog': '', role: 'dialog', 'aria-modal': 'true', 'aria-label': '还有任务在运行' },
          React.createElement('div', { className: 'dsh-qr-title' }, '还有任务在运行'),
          React.createElement(
            'div',
            { className: 'dsh-qr-body' },
            '现在重启会打断下面这些工作，它们的进度不会保留：',
          ),
          React.createElement(
            'div',
            { className: 'dsh-qr-list' },
            ...items.map((item, index) =>
              React.createElement(
                'div',
                { className: 'dsh-qr-item', key: `${String(item.main)}-${String(index)}` },
                React.createElement('span', { className: 'dsh-qr-item-main' }, item.main),
                item.note === '' ? null : React.createElement('span', { className: 'dsh-qr-item-note' }, item.note),
              ),
            ),
          ),
          React.createElement(
            'div',
            { className: 'dsh-qr-hint' },
            '定时任务不受影响，重启后仍会照常触发。',
          ),
          React.createElement(
            'div',
            { className: 'dsh-qr-actions' },
            React.createElement(
              'button',
              { type: 'button', className: 'dsh-qr-cancel', onClick: onCancel },
              '取消',
            ),
            React.createElement(
              'button',
              { type: 'button', className: 'dsh-qr-confirm', onClick: onConfirm },
              '仍然重启',
            ),
          ),
        ),
      )
    }

    function RestartButton() {
      const [busy, setBusy] = React.useState(false)
      const [work, setWork] = React.useState(null)

      const start = React.useCallback((force) => {
        setBusy(true)
        requestRestart(force).catch((error) => {
          setBusy(false)
          // A raced-in task: show the dialog again instead of a bare alert.
          if (error.code === 'tasks-active') {
            setWork(error.payload ?? { agents: [], jobs: [] })
            return
          }
          window.alert(`重启失败：${error.message}`)
        })
      }, [])

      const onClick = React.useCallback(async () => {
        if (busy) return
        setBusy(true)
        const state = await probeActivity()
        if (!state.active) {
          start(false)
          return
        }
        setBusy(false)
        setWork(state)
      }, [busy, start])

      const dialog =
        work === null
          ? null
          : React.createElement(ActiveWorkDialog, {
              work,
              onCancel: () => {
                setWork(null)
              },
              onConfirm: () => {
                setWork(null)
                start(true)
              },
            })

      return React.createElement(
        React.Fragment,
        null,
        React.createElement(
          'button',
          {
            type: 'button',
            'data-dsh-quick-restart': '',
            'data-busy': busy ? 'true' : undefined,
            title: '关闭并重新启动 DSH',
            disabled: busy,
            onClick,
          },
          React.createElement('span', { className: 'dsh-quick-restart__icon', 'aria-hidden': 'true' }, '⟳'),
          React.createElement('span', null, busy ? '重启中' : '重启'),
        ),
        dialog,
      )
    }

    function apply(ctx) {
      const doc = typeof document === 'undefined' ? undefined : document
      ctx.effect(() => ensureStyle(doc), 'dsh-quick-restart: styles')
      ctx.slots.inject('conversation.session.header.utilities', () =>
        ctx.slots.register(
          {
            name: 'conversation.session.header.utilities',
            id: 'dsh-quick-restart',
            order: 40,
          },
          RestartButton,
        ),
      )
    }

    exports.name = 'dsh-quick-restart/client'
    exports.apply = apply
    exports.inject = ['slots']
    return module.exports
  },
})
