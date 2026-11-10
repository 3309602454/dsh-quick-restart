import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'

/**
 * dsh-quick-restart — host half.
 *
 * Routes called by the conversation-header button:
 *   GET  /dsh-quick-restart/status   -> where this Host runs, and whether a restart applies
 *   POST /dsh-quick-restart/restart  -> close the desktop app and relaunch it
 *
 * ## Why a scheduled task, and why pythonw
 *
 * 1. The Web Host is a CHILD of the Electron main process, and anything it spawns
 *    inherits that tree — `taskkill /F /T` on the app killed the helper too
 *    (measured: the app closed and never came back). A task registered with
 *    `schtasks /create` runs under the Task Scheduler service instead, outside
 *    the tree, so it survives and can start the app again. `/it` keeps it in the
 *    interactive session, which a GUI relaunch needs.
 *
 * 2. The task must not open a console window. A `.cmd` trampoline or a console
 *    executable makes Windows allocate one, which the user sees flash on screen.
 *    `pythonw.exe` is a GUI-subsystem binary: the helper process has no console at
 *    all (verified: GetConsoleWindow() returns 0).
 */

export const name = 'dsh-quick-restart'
export const inject = []

const ROUTE_PREFIX = '/dsh-quick-restart'
const HELPER_DIR = 'dsh-quick-restart'
const HELPER_SOURCE = fileURLToPath(new URL('./restart-helper.py', import.meta.url))
const TASK_NAME = 'DSHQuickRestart'
const APP_PROCESS_NAME = 'DeepSeek Harness'

function respond(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

/**
 * Read a tiny JSON body without ever buffering more than a few bytes.
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<object>}
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk) => {
      data += chunk
      if (data.length > 4096) {
        req.destroy()
        reject(new Error('body too large'))
      }
    })
    req.on('end', () => {
      if (data.trim() === '') return resolve({})
      try {
        resolve(JSON.parse(data))
      } catch {
        reject(new Error('invalid JSON'))
      }
    })
    req.on('error', reject)
  })
}

/**
 * Whether this Host runs inside the DSH desktop app, and where the app lives.
 *
 * The Desktop shell exports `DSH_CLIENT_VERSION` into the Host child's
 * environment. That marker is platform-independent; the executable name is not
 * (`DeepSeek Harness.exe` on Windows, `DeepSeek Harness` on macOS/Linux), so the
 * name is only used to locate the binary, never as the desktop test itself.
 *
 * `supported` is false where this plugin has no restart mechanism: the task is
 * registered through Windows Task Scheduler, and there is no macOS/Linux
 * equivalent wired up yet. The button reports that instead of failing obscurely.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [execPath]
 * @param {number} [ppid]
 * @param {string} [platform]
 */
export function desktopFacts(env = process.env, execPath = process.execPath, ppid = process.ppid, platform = process.platform) {
  const desktop = typeof env.DSH_CLIENT_VERSION === 'string' && env.DSH_CLIENT_VERSION !== ''
  return {
    desktop,
    supported: desktop && platform === 'win32',
    platform,
    exe: execPath,
    exeExists: existsSync(execPath),
    mainPid: ppid,
    clientVersion: env.DSH_CLIENT_VERSION ?? null,
  }
}

/**
 * Collect the work a restart would interrupt.
 *
 * Mirrors the Desktop shell's own quit inspection (`hasDesktopActiveTasks` in
 * dsh-desktop-host) so the button warns about exactly what the app itself
 * considers live work:
 *
 *   - an agent whose turn is generating, or that still has queued inbox entries
 *     for the next turn/step;
 *   - a background job that is running or stopping, owned by any agent (a job's
 *     owner is the agent id, and `jobs.list(undefined)` covers the global ones).
 *
 * Scheduled reminders are deliberately NOT counted: they survive a restart and
 * fire later, so they are not work being interrupted.
 *
 * @param {object} services - live Host services
 * @param {object} [services.agents] - agent registry with `list()`
 * @param {object} [services.jobs] - job registry with `list(owner)`
 * @returns {{ active: boolean, agents: Array<object>, jobs: Array<object> }}
 */
export function collectActiveWork({ agents, jobs } = {}) {
  const liveAgents = typeof agents?.list === 'function' ? agents.list() : []

  const busyAgents = []
  for (const agent of liveAgents) {
    const running = agent?.status === 'running'
    const queuedTurn = (agent?.inbox?.nextTurn?.length ?? 0) > 0
    const queuedStep = (agent?.inbox?.nextStep?.length ?? 0) > 0
    if (!running && !queuedTurn && !queuedStep) continue
    busyAgents.push({
      id: agent?.id ?? null,
      status: agent?.status ?? null,
      title: agent?.header?.title ?? agent?.title ?? null,
      cwd: agent?.header?.cwd ?? null,
      queuedTurn: agent?.inbox?.nextTurn?.length ?? 0,
      queuedStep: agent?.inbox?.nextStep?.length ?? 0,
    })
  }

  const busyJobs = []
  if (typeof jobs?.list === 'function') {
    // `[undefined, ...liveAgents]` is the shape the Desktop shell uses: one call
    // for the global roster plus one per agent.
    for (const owner of [undefined, ...liveAgents]) {
      const ownerId = owner?.id
      let listed
      try {
        listed = jobs.list(ownerId)
      } catch {
        continue
      }
      for (const job of listed ?? []) {
        if (job?.status !== 'running' && job?.status !== 'stopping') continue
        if (busyJobs.some((seen) => seen.id === job.id)) continue
        busyJobs.push({
          id: job.id ?? null,
          status: job.status,
          kind: job.kind ?? job.command ?? null,
          owner: ownerId ?? null,
          startedAt: job.startedAt ?? null,
        })
      }
    }
  }

  return {
    active: busyAgents.length > 0 || busyJobs.length > 0,
    agents: busyAgents,
    jobs: busyJobs,
  }
}


/**
 * Locate `pythonw.exe` from the bundled runtime.
 *
 * Never `process.execPath`: inside the Host that is `DeepSeek Harness.exe`, so
 * the task would open a second GUI instance rather than run any script.
 *
 * Candidates are ordered shortest-path-first. `/tr` has a 261-character cap (the
 * task is registered through XML to avoid it), but a shorter runner still keeps
 * the command line well inside other limits and reads better in Task Scheduler.
 * @param {{ appPath?: string, home?: string }} [options]
 * @returns {string|null}
 */
export function resolvePythonw(appPath = process.execPath, home = process.env.USERPROFILE) {
  const appDir = dirname(appPath)
  const candidates = [
    // Harness home copy of the runtime (short path, preferred)
    ...(typeof home === 'string' && home !== ''
      ? [join(home, '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python', 'pythonw.exe')]
      : []),
    // Desktop install: <app>\resources\runtime\primary-runtime\dependencies\python
    join(appDir, 'resources', 'runtime', 'primary-runtime', 'dependencies', 'python', 'pythonw.exe'),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

/**
 * Build the `/TR` value: one command line with the helper arguments quoted.
 * @param {{ pythonw: string, helperPath: string, mainPid: number, exe: string, processName: string }} options
 * @returns {string}
 */
export function renderTaskCommand({ pythonw, helperPath, mainPid, exe, processName = APP_PROCESS_NAME }) {
  const quote = (value) => `"${String(value).replace(/"/gu, '""')}"`
  return [
    quote(pythonw),
    quote(helperPath),
    String(mainPid),
    quote(exe),
    quote(processName),
  ].join(' ')
}

/** Escape a value for XML text content. */
function xmlEscape(value) {
  return String(value)
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
}

/**
 * Render a task definition as XML.
 *
 * `schtasks /create /tr` rejects a command line longer than 261 characters
 * (measured: our pythonw path plus a quoted app path is ~290). `/create /xml`
 * has no such limit, so the task is always registered this way.
 *
 * The task has no trigger on purpose: it is registered once and fired
 * immediately with `/run`. `ExecutionTimeLimit` is unlimited so a relaunch that
 * waits on a slow shutdown is never cut short.
 *
 * @param {{ pythonw: string, arguments: string, userId: string }} options
 * @returns {string}
 */
export function renderTaskXml({ pythonw, arguments: args, userId }) {
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>dsh-quick-restart: close and relaunch DSH (windowless helper)</Description>
  </RegistrationInfo>
  <Triggers />
  <Principals>
    <Principal id="Author">
      <UserId>${xmlEscape(userId)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>false</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xmlEscape(pythonw)}</Command>
      <Arguments>${xmlEscape(args)}</Arguments>
    </Exec>
  </Actions>
</Task>
`
}

/** Remove a task left behind by an earlier run. */
export function clearTask() {
  const result = spawnSync('schtasks.exe', ['/delete', '/tn', TASK_NAME, '/f'], {
    encoding: 'utf8',
    windowsHide: true,
  })
  return result.status === 0
}

/**
 * Copy the helper into a stable private directory and register the task.
 * @param {{ mainPid: number, exe: string, processName?: string }} options
 * @returns {{ ok: boolean, detail?: string }}
 */
export function registerRestartTask({ mainPid, exe, processName = APP_PROCESS_NAME }) {
  const pythonw = resolvePythonw()
  if (pythonw === null) {
    return { ok: false, detail: 'bundled pythonw.exe not found; cannot register a restart task' }
  }

  const dir = join(tmpdir(), HELPER_DIR)
  try {
    mkdirSync(dir, { recursive: true })
  } catch (error) {
    return { ok: false, detail: `mkdir failed: ${String(error)}` }
  }

  // Copy beside the log so the task points at a stable path even if a plugin
  // update replaces the package directory while the task is still armed.
  const helperPath = join(dir, 'restart-helper.py')
  try {
    writeFileSync(helperPath, readFileSync(HELPER_SOURCE, 'utf8'), 'utf8')
  } catch (error) {
    return { ok: false, detail: `helper copy failed: ${String(error)}` }
  }

  clearTask()

  // Register through XML, not `/tr`: the latter rejects command lines above 261
  // characters and the real pythonw + app paths are longer than that.
  const quote = (value) => `"${String(value).replace(/"/gu, '""')}"`
  const args = [quote(helperPath), String(mainPid), quote(exe), quote(processName)].join(' ')
  const userId = `${process.env.USERDOMAIN ?? ''}\\${process.env.USERNAME ?? ''}`
  const xmlPath = join(dir, 'restart-task.xml')
  try {
    const xml = renderTaskXml({ pythonw, arguments: args, userId })
    // Task Scheduler reads /xml files as UTF-16; without the BOM it rejects them.
    writeFileSync(xmlPath, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, 'utf16le')]))
  } catch (error) {
    return { ok: false, detail: `task xml write failed: ${String(error)}` }
  }

  const created = spawnSync('schtasks.exe', ['/create', '/tn', TASK_NAME, '/xml', xmlPath, '/f'], {
    encoding: 'utf8',
    windowsHide: true,
  })
  const createdText = `${created.stdout ?? ''}${created.stderr ?? ''}`.trim()
  if (created.status !== 0) {
    return { ok: false, detail: `schtasks create failed (${String(created.status)}): ${createdText}` }
  }

  const started = spawnSync('schtasks.exe', ['/run', '/tn', TASK_NAME], { encoding: 'utf8', windowsHide: true })
  const startedText = `${started.stdout ?? ''}${started.stderr ?? ''}`.trim()
  if (started.status !== 0) {
    clearTask()
    return { ok: false, detail: `schtasks run failed (${String(started.status)}): ${startedText}` }
  }

  return { ok: true }
}

/** Drop a helper copy left by an interrupted attempt, keeping the log. */
function removeStaleHelper() {
  const helperPath = join(tmpdir(), HELPER_DIR, 'restart-helper.py')
  try {
    if (existsSync(helperPath)) unlinkSync(helperPath)
  } catch {
    /* best effort */
  }
  // The .cjs/.cmd pair from the previous design must not linger either.
  for (const name of ['restart-helper.cjs', 'restart.cmd']) {
    try {
      const stale = join(tmpdir(), HELPER_DIR, name)
      if (existsSync(stale)) unlinkSync(stale)
    } catch {
      /* best effort */
    }
  }
}

export function apply(ctx) {
  ctx.inject(['webServer', 'agents', 'jobs'], (scoped) => {
    // Clean up after a previous run: an armed task would fire today at 23:59, and
    // a stale helper copy would carry the old pid.
    try {
      clearTask()
      removeStaleHelper()
    } catch {
      /* best effort */
    }
    const facts = desktopFacts()

    /** Live services are read per request: they are optional and may arrive late. */
    const activeWork = () =>
      collectActiveWork({
        agents: scoped.get?.('agents') ?? scoped.agents,
        jobs: scoped.get?.('jobs') ?? scoped.jobs,
      })

    scoped.effect(
      () =>
        scoped.webServer.register({
          kind: 'exact',
          path: `${ROUTE_PREFIX}/status`,
          handler: (req, res) => {
            if (req.method !== 'GET' && req.method !== 'HEAD') {
              return respond(res, 405, { ok: false, error: 'method-not-allowed' })
            }
            respond(res, 200, facts)
          },
        }),
      'dsh-quick-restart: status route',
    )

    scoped.effect(
      () =>
        scoped.webServer.register({
          kind: 'exact',
          path: `${ROUTE_PREFIX}/activity`,
          handler: (req, res) => {
            if (req.method !== 'GET' && req.method !== 'HEAD') {
              return respond(res, 405, { ok: false, error: 'method-not-allowed' })
            }
            let work
            try {
              work = activeWork()
            } catch (error) {
              return respond(res, 500, { ok: false, error: 'probe-failed', detail: String(error) })
            }
            respond(res, 200, { ok: true, ...work })
          },
        }),
      'dsh-quick-restart: activity route',
    )

    scoped.effect(
      () =>
        scoped.webServer.register({
          kind: 'exact',
          path: `${ROUTE_PREFIX}/restart`,
          handler: async (req, res) => {
            if (req.method !== 'POST') {
              return respond(res, 405, { ok: false, error: 'method-not-allowed' })
            }
            let body
            try {
              body = await readBody(req)
            } catch {
              return respond(res, 400, { ok: false, error: 'bad-request' })
            }
            if (!facts.desktop) {
              return respond(res, 409, {
                ok: false,
                error: 'not-desktop',
                detail: 'Restart is only available inside the DSH desktop app.',
              })
            }
            if (!facts.supported) {
              return respond(res, 409, {
                ok: false,
                error: 'unsupported-platform',
                detail: `Restart is implemented for the Windows desktop app only (this Host runs on ${facts.platform}).`,
              })
            }
            if (!facts.exeExists) {
              return respond(res, 500, { ok: false, error: 'exe-missing', detail: facts.exe })
            }

            // The button asks first and confirms with `force: true`. Calling this
            // route directly without that flag still works, but reports the work
            // it is about to interrupt.
            if (body?.force !== true) {
              let work
              try {
                work = activeWork()
              } catch {
                work = { active: false, agents: [], jobs: [] }
              }
              if (work.active) {
                return respond(res, 409, {
                  ok: false,
                  error: 'tasks-active',
                  detail: 'Work is still running. Resend with {"force":true} to restart anyway.',
                  agents: work.agents,
                  jobs: work.jobs,
                })
              }
            }

            const registered = registerRestartTask({ mainPid: facts.mainPid, exe: facts.exe })
            if (!registered.ok) {
              scoped.logger?.warn?.(`[dsh-quick-restart] task registration failed: ${registered.detail ?? 'unknown'}`)
              return respond(res, 500, { ok: false, error: 'relaunch-failed', detail: registered.detail ?? null })
            }

            scoped.logger?.info?.(
              `[dsh-quick-restart] restart task "${TASK_NAME}" started${body?.force === true ? ' (forced)' : ''}; the app will close and relaunch`,
            )
            // The helper waits before killing, so this response always lands first.
            respond(res, 200, { ok: true, closing: true, mainPid: facts.mainPid })
          },
        }),
      'dsh-quick-restart: restart route',
    )
  })
}

/** Kept for callers that still import it; the payload lives under %TEMP%. */
export function cleanHelperDir() {
  try {
    rmSync(join(tmpdir(), HELPER_DIR), { recursive: true, force: true })
  } catch {
    /* leftovers are harmless */
  }
}
