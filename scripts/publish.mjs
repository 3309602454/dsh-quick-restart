#!/usr/bin/env node
/**
 * Fills the GitHub username into the tracked files and prepares the
 * awesome-dsh-plugin entry. Stops before any push or PR, so you can review.
 *
 * Usage:
 *   node scripts/publish.mjs <github-user> [--name "Display Name"] [--email you@example.com] [--check-only]
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const repoName = 'dsh-quick-restart'

const args = process.argv.slice(2)
const flag = (name, fallback = '') => {
  const index = args.indexOf(name)
  return index === -1 || index === args.length - 1 ? fallback : args[index + 1]
}
const has = (name) => args.includes(name)

const user = args.find((value) => !value.startsWith('--') && args[args.indexOf(value) - 1]?.startsWith('--') !== true)
if (user === undefined || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/u.test(user)) {
  console.error('usage: node scripts/publish.mjs <github-user> [--name "..."] [--email "..."] [--check-only]')
  console.error(`received: ${JSON.stringify(user ?? null)}`)
  process.exit(1)
}

const displayName = flag('--name', '')
const email = flag('--email', '')
const checkOnly = has('--check-only')
const repoUrl = `https://github.com/${user}/${repoName}`

console.log(`repo:   ${repoUrl}`)
console.log(`author: ${displayName === '' ? user : displayName}`)
console.log('')

/**
 * Apply literal replacements in memory and report the result.
 *
 * Nothing is written until {@link flush} runs: `--check-only` must be able to
 * validate a username without leaving it in the tracked files, which is exactly
 * the mistake this function exists to make impossible.
 */
const pending = new Map()

function patch(relative, edits) {
  const path = join(repoRoot, relative)
  let text = pending.get(relative) ?? readFileSync(path, 'utf8')
  for (const { from, to } of edits) {
    if (!text.includes(from)) {
      throw new Error(`${relative}: pattern not found -> ${JSON.stringify(from.slice(0, 60))}`)
    }
    text = text.split(from).join(to)
  }
  pending.set(relative, text)
  console.log(`prepared ${relative}`)
}

function flush() {
  for (const [relative, text] of pending) {
    writeFileSync(join(repoRoot, relative), text, 'utf8')
    console.log(`wrote ${relative}`)
  }
  pending.clear()
}

patch('README.md', [
  {
    from: 'dsh plugin --profile desktop add github:<owner>/dsh-quick-restart',
    to: `dsh plugin --profile desktop add github:${user}/${repoName}`,
  },
])

patch('LICENSE', [
  {
    from: 'dsh-quick-restart contributors',
    to: displayName === '' ? user : displayName,
  },
])

patch('package.json', [
  {
    from: `  "license": "MIT"
}`,
    to: `  "repository": {
    "type": "git",
    "url": "git+${repoUrl}.git"
  },
  "homepage": "${repoUrl}",
  "bugs": {
    "url": "${repoUrl}/issues"
  },
  "license": "MIT"
}`,
  },
])

// Verify the patched manifest in memory, before anything touches disk.
const manifest = JSON.parse(pending.get('package.json'))
if (manifest.dsh?.bundle?.patch !== './cordis.patch.yml') throw new Error('package.json lost its dsh.bundle manifest')
if (!manifest.repository?.url?.includes(user)) throw new Error('repository URL was not filled in')
if (manifest.files?.includes('scripts')) throw new Error('files[] must not ship scripts/')
console.log('manifest verified')

// Self-check (runs against the committed sources, not the pending patch).
execFileSync(process.execPath, [join(repoRoot, 'scripts', 'check.mjs')], { stdio: 'inherit' })

if (checkOnly) {
  console.log('\n--check-only: nothing written, no git commit')
  process.exit(0)
}

flush()

// Market entry: one YAML file for awesome-dsh-plugin. Written OUTSIDE the repo
// (next to it, in the OS temp dir) because it belongs in that project's
// data/plugins/, not in this package.
const entryDir = join(tmpdir(), 'dsh-market-entry')
mkdirSync(entryDir, { recursive: true })
const entryPath = join(entryDir, `${user}__${repoName}.yml`)
writeFileSync(
  entryPath,
  [
    `url: ${repoUrl}`,
    `name: ${user}/${repoName}`,
    'category: ui',
    'description:',
    "  en: 'One-click restart button in the DSH conversation header: it checks for running sessions and background jobs and warns before restarting, then closes and relaunches the desktop app without opening a console window.'",
    "  zh: 'DSH 会话标题栏的一键重启按钮：重启前会检查并警告正在运行的会话与后台任务，点击后关闭并重新启动桌面端，全程不弹控制台窗口。'",
    '',
  ].join('\n'),
  'utf8',
)
console.log(`market entry (outside the repo): ${entryPath}`)

// Commit with an explicit identity so it works without global git config.
const identity = [displayName === '' ? user : displayName, email === '' ? `${user}@users.noreply.github.com` : email]
const git = (...gitArgs) =>
  execFileSync('git', ['-c', `user.name=${identity[0]}`, '-c', `user.email=${identity[1]}`, ...gitArgs], {
    cwd: repoRoot,
    stdio: 'inherit',
  })

if (!existsSync(join(repoRoot, '.git'))) git('init', '-b', 'main')
git('add', '-A')
git('commit', '-m', 'feat: one-click restart button for the DSH desktop app')

console.log(`
=== next steps (yours) ===
1. Create an empty repo "${repoName}" at https://github.com/new (no README, no .gitignore, no license).
2. Push:
     cd "${repoRoot}"
     git remote add origin ${repoUrl}.git
     git push -u origin main
3. Add the topic "dsh-plugin": repo page -> About (gear) -> Topics -> dsh-plugin -> Save.
4. Fork awesome-dsh-plugin, copy market-entry/${user}__${repoName}.yml into data/plugins/, open a PR.

Note: the market requires the repo to be at least 1 day old, so a PR opened today fails CI by design.
`)
