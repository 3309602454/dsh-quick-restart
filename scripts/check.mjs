/**
 * Self-check: verifies the plugin's pure functions without needing DSH or a
 * restart. Run with `node scripts/check.mjs`.
 *
 * These are the invariants that broke during development, so each one is pinned:
 *   - the activity probe counts exactly the work the Desktop shell counts;
 *   - the task command stays inside schtasks' `/tr` cap (the reason XML is used);
 *   - desktop/platform detection does not depend on the executable name.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  collectActiveWork,
  desktopFacts,
  renderTaskCommand,
  renderTaskXml,
  resolvePythonw,
} from '../lib/index.js'

let failures = 0

let checks = 0
const check = (label, fn) => {
  try {
    fn()
    checks += 1
    console.log(`ok   ${label}`)
  } catch (error) {
    failures += 1
    console.log(`FAIL ${label}`)
    console.log(`     ${error instanceof Error ? error.message : String(error)}`)
  }
}

// --- activity probe --------------------------------------------------------
const idle = (id) => ({ id, status: 'idle', inbox: { nextTurn: [], nextStep: [] } })

check('empty registries report no work', () => {
  const work = collectActiveWork({ agents: { list: () => [] }, jobs: { list: () => [] } })
  assert.equal(work.active, false)
})

check('a generating agent counts as work', () => {
  const agent = { ...idle('s1'), status: 'running' }
  assert.equal(collectActiveWork({ agents: { list: () => [agent] }, jobs: { list: () => [] } }).active, true)
})

check('queued inbox messages count as work', () => {
  const agent = { ...idle('s2'), inbox: { nextTurn: [{}], nextStep: [] } }
  assert.equal(collectActiveWork({ agents: { list: () => [agent] }, jobs: { list: () => [] } }).active, true)
})

check('a running background job counts as work', () => {
  const work = collectActiveWork({
    agents: { list: () => [] },
    jobs: { list: () => [{ id: 'j1', status: 'running' }] },
  })
  assert.equal(work.active, true)
})

check('a settled job does not count', () => {
  const work = collectActiveWork({
    agents: { list: () => [] },
    jobs: { list: () => [{ id: 'j1', status: 'succeeded' }] },
  })
  assert.equal(work.active, false)
})

check('a throwing job registry does not break the probe', () => {
  const work = collectActiveWork({
    agents: { list: () => [] },
    jobs: {
      list: () => {
        throw new Error('boom')
      },
    },
  })
  assert.equal(work.active, false)
})

// --- task rendering --------------------------------------------------------
const longPythonw =
  'C:\\Users\\someone\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\runtime\\primary-runtime\\dependencies\\python\\pythonw.exe'
const longExe = 'C:\\Users\\someone\\AppData\\Local\\Programs\\DeepSeek Harness\\DeepSeek Harness.exe'
const helperPath = 'C:\\Users\\someone\\AppData\\Local\\Temp\\dsh-quick-restart\\restart-helper.py'

check('the interpolated command can exceed the /tr cap (why XML is used)', () => {
  const command = renderTaskCommand({ pythonw: longPythonw, helperPath, mainPid: 1234, exe: longExe })
  assert.ok(command.length > 261, `expected >261 characters, got ${command.length}`)
})

check('task XML escapes the configured paths', () => {
  const xml = renderTaskXml({
    pythonw: 'C:\\a & b\\pythonw.exe',
    arguments: '"C:\\x" 1 "C:\\y y\\app.exe" "DeepSeek Harness"',
    userId: 'PC\\user',
  })
  assert.match(xml, /<Command>C:\\a &amp; b\\pythonw\.exe<\/Command>/u)
  assert.doesNotMatch(xml, /<Command>[^<]*&(?!amp;)/u)
})

check('task XML declares no trigger, so it only runs on demand', () => {
  const xml = renderTaskXml({ pythonw: 'p', arguments: 'a', userId: 'u' })
  assert.match(xml, /<Triggers \/>/u)
  assert.match(xml, /<AllowStartOnDemand>true<\/AllowStartOnDemand>/u)
})

// --- environment detection -------------------------------------------------
check('desktop detection does not depend on the executable name', () => {
  assert.equal(desktopFacts({ DSH_CLIENT_VERSION: '1.0.0' }, '/Applications/DeepSeek Harness', 1, 'darwin').desktop, true)
  assert.equal(desktopFacts({ DSH_CLIENT_VERSION: '1.0.0' }, 'C:\\x\\DeepSeek Harness.exe', 1, 'win32').desktop, true)
  assert.equal(desktopFacts({}, '/usr/bin/node', 1, 'linux').desktop, false)
})

check('only Windows is reported as supported', () => {
  const env = { DSH_CLIENT_VERSION: '1.0.0' }
  assert.equal(desktopFacts(env, 'C:\\x\\a.exe', 1, 'win32').supported, true)
  assert.equal(desktopFacts(env, '/Applications/a', 1, 'darwin').supported, false)
  assert.equal(desktopFacts(env, '/usr/bin/a', 1, 'linux').supported, false)
})

check('resolvePythonw returns null instead of throwing when nothing matches', () => {
  const result = resolvePythonw('C:\\nowhere\\app.exe', 'C:\\no-such-home')
  assert.equal(result, null)
})

// --- package manifest ------------------------------------------------------
check('package.json declares the bundle manifest and a client half', () => {
  const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'))
  assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml')
  assert.equal(pkg.dsh?.client?.platform, 'web')
  assert.ok(pkg.exports?.['./client'], 'exports["./client"] must exist')
  assert.ok(pkg.files?.includes('lib'), 'files must ship lib/')
})

check('cordis.patch.yml mounts the host half by package name', () => {
  const patch = readFileSync(fileURLToPath(new URL('../cordis.patch.yml', import.meta.url)), 'utf8')
  const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'))
  assert.ok(patch.includes(`name: ${pkg.name}`), 'patch must reference the package name')
})

check('the shipped helper exists and mentions both kill and relaunch', () => {
  const helper = readFileSync(fileURLToPath(new URL('../lib/restart-helper.py', import.meta.url)), 'utf8')
  assert.ok(helper.includes('taskkill'))
  assert.ok(helper.includes('launch_app'))
  assert.ok(helper.includes('watchdog'))
})

console.log(failures === 0 ? `\nall ${checks} checks passed` : `\n${failures} of ${checks + failures} checks failed`)
process.exitCode = failures === 0 ? 0 : 1
