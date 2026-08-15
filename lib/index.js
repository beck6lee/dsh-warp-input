/**
 * dsh-warp-input host half (v2)
 *
 * 1) 注册命令 `/run`：在会话目录执行 shell 命令，结果以命令节点进入对话流。
 * 2) HTTP 路由 POST /warp/check：探测某 token 是否为可执行文件（客户端智能识别辅助）。
 * 3) HTTP 路由 POST /warp/complete：命令输入智能补全（z 风格幽灵文本）。
 */
export const name = 'dsh-warp-input'

export const inject = ['webServer', 'shell', 'commands', 'subprocess']

const DEFAULT_TIMEOUT_MS = 60000
const MAX_OUTPUT = 8000

// ---- 补全数据 ----
const CMD_PATH_ENV = { PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin' }
const COMMAND_WORDS_HOST = new Set(('cd ls pwd cat echo git npm node python python3 pip pip3 curl wget mkdir rm rmdir mv cp touch grep egrep fgrep sed awk head tail uniq wc chmod chown sudo env export unset which whereis ps kill killall tar gzip gunzip zip unzip cmake cargo ruby php java javac docker docker-compose kubectl brew yarn pnpm npx sh bash zsh source defaults plutil xattr lsof df du ping ssh scp rsync man tree jq yq xargs basename dirname realpath readlink ln dd stat strings sqlite3 redis-cli mysql psql mongosh dsh gh rg fd bat tldr ffmpeg podman terraform ansible xcodebuild swift swiftc clang gcc cc').split(' '))
const GIT_SUBCOMMANDS = ['status', 'add', 'commit', 'diff', 'log', 'push', 'pull', 'checkout', 'branch', 'merge', 'stash', 'tag', 'fetch', 'clone', 'init', 'remote', 'reset', 'rebase', 'rm', 'mv', 'show', 'restore', 'switch', 'cherry-pick', 'clean', 'describe', 'grep', 'help']

let COMPGEN_CACHE = null
async function commandNames(shell) {
  if (COMPGEN_CACHE) return COMPGEN_CACHE
  try {
    const spec = shell.resolve({ command: 'compgen -c', timeoutMs: 3000, env: CMD_PATH_ENV })
    const result = await shell.run(spec)
    const out = ((result.stdout && result.stdout.text) || '')
    COMPGEN_CACHE = out.split('\n').map((s) => s.trim()).filter(Boolean)
    return COMPGEN_CACHE
  } catch (e) {
    return []
  }
}

function json(res, status, payload) {
  const text = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
  })
  res.end(text)
}

export function apply(ctx) {
  const { webServer, shell, commands, subprocess } = ctx

  // ---- /run 命令：结果进入对话流 ----
  const register = () => commands.register({
    name: 'run',
    description: '在会话目录执行 shell 命令并显示结果',
    // 必须有 input 描述符：ui-commands 的 matchEnter 对「带参数的裸命令且无 input」直接放弃，
    // 加上后才把参数交给 claim.submit → commands.execute（否则 /run ls 会回退成普通消息）。
    input: { hint: 'shell 命令' },
    handler: async (invocation) => {
      const line = (invocation.rawInput || '').trim()
      if (!line) return { kind: 'error', text: '空命令' }
      const sess = invocation.agent && invocation.agent.session
      const cwd = sess && sess.header ? sess.header.cwd : undefined
      try {
        // 注入标准 macOS PATH（含 Homebrew），避免 dsh 进程精简 PATH 下 npm/brew 等找不到
        const request = {
          command: line,
          timeoutMs: DEFAULT_TIMEOUT_MS,
          env: {
            PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
          },
        }
        if (typeof cwd === 'string' && cwd) request.workdir = cwd
        const spec = shell.resolve(request)
        const result = await shell.run(spec)
        const out = ((result.stdout && result.stdout.text) || '') + ((result.stderr && result.stderr.text) || '')
        const tail = out.length > MAX_OUTPUT ? out.slice(-MAX_OUTPUT) + '\n…（输出过长已截断）' : out
        const meta = result.timedOut ? ' [TIMEOUT]' : (result.exitCode === null ? '' : ' [exit ' + result.exitCode + ']')
        return { kind: result.exitCode === 0 ? 'success' : 'error', text: (tail || '(无输出)') + meta }
      } catch (e) {
        return { kind: 'error', text: String((e && e.message) || e) }
      }
    },
  })

  // ---- /warp/check：token 是否为可执行文件 ----
  const checkHandler = async (req, res) => {
    if (req.method !== 'POST') {
      json(res, 405, { exists: false })
      return
    }
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > 1_000_000) req.destroy()
    })
    req.on('end', async () => {
      let parsed
      try {
        parsed = JSON.parse(body || '{}')
      } catch {
        json(res, 400, { exists: false })
        return
      }
      const token = typeof parsed.token === 'string' ? parsed.token.trim() : ''
      if (!token || !subprocess || typeof subprocess.resolveExecutable !== 'function') {
        json(res, 200, { exists: false })
        return
      }
      try {
        await subprocess.resolveExecutable(token)
        json(res, 200, { exists: true })
      } catch {
        json(res, 200, { exists: false })
      }
    })
  }

  // ---- /warp/commands：会话可用的斜杠命令列表（客户端补全弹窗用）----
  const agents = ctx.get('agents')
  const commandsHandler = async (req, res) => {
    if (req.method !== 'POST') {
      json(res, 405, { commands: [] })
      return
    }
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > 1_000_000) req.destroy()
    })
    req.on('end', async () => {
      let parsed
      try {
        parsed = JSON.parse(body || '{}')
      } catch {
        json(res, 400, { commands: [] })
        return
      }
      let list = []
      if (agents && typeof agents.get === 'function') {
        const agent = agents.get(parsed.sessionId)
        if (agent) {
          try {
            list = commands.list(agent)
          } catch (e) {
            list = []
          }
        }
      }
      json(res, 200, { commands: list })
    })
  }

  ctx.effect(() => webServer.register({ kind: 'exact', path: '/warp/check', handler: checkHandler }))
  ctx.effect(() => webServer.register({ kind: 'exact', path: '/warp/commands', handler: commandsHandler }))

  // ---- /warp/complete：命令输入智能补全（幽灵文本）----
  const completeHandler = async (req, res) => {
    if (req.method !== 'POST') {
      json(res, 405, { ghost: null, suggestions: [] })
      return
    }
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > 1_000_000) req.destroy()
    })
    req.on('end', async () => {
      let parsed
      try {
        parsed = JSON.parse(body || '{}')
      } catch {
        json(res, 400, { ghost: null, suggestions: [] })
        return
      }
      const draft = typeof parsed.draft === 'string' ? parsed.draft : ''
      const trimmed = draft.trim()
      // 空/末尾空格/多行：不补全
      if (!trimmed || trimmed.endsWith(' ') || trimmed.indexOf('\n') !== -1) {
        json(res, 200, { ghost: null, suggestions: [] })
        return
      }
      const tokens = trimmed.split(/\s+/)
      const current = tokens[tokens.length - 1]
      if (!current) {
        json(res, 200, { ghost: null, suggestions: [] })
        return
      }
      const matches = []
      if (tokens.length === 1) {
        // 首词：命令名
        const names = await commandNames(shell)
        const set = new Set([...COMMAND_WORDS_HOST, ...names])
        for (const c of set) {
          if (c.indexOf(current) === 0 && c !== current) {
            matches.push({ text: c.slice(current.length) + ' ', rank: 2 })
          }
        }
      } else if (tokens[0] === 'git' && tokens.length === 2) {
        // git 子命令
        for (const c of GIT_SUBCOMMANDS) {
          if (c.indexOf(current) === 0 && c !== current) {
            matches.push({ text: c.slice(current.length) + ' ', rank: 1 })
          }
        }
      } else {
        // 文件/目录（会话 cwd）
        const sessionsSvc = ctx.get('sessions')
        const sess = sessionsSvc && typeof sessionsSvc.get === 'function' ? sessionsSvc.get(parsed.sessionId) : undefined
        const cwd = sess && sess.header ? sess.header.cwd : undefined
        const fsService = ctx.get('fs')
        if (fsService && typeof fsService.resolve === 'function' && typeof fsService.listDir === 'function' && cwd) {
          try {
            const slash = current.lastIndexOf('/')
            const dirPart = slash >= 0 ? current.slice(0, slash + 1) : ''
            const base = slash >= 0 ? current.slice(slash + 1) : current
            const dirTarget = await fsService.resolve(dirPart || '.', { cwd })
            const entries = await fsService.listDir(dirTarget)
            for (const e of entries) {
              if (e.name.indexOf(base) === 0 && e.name !== base) {
                matches.push({ text: e.name.slice(base.length) + (e.type === 'directory' ? '/' : ' '), rank: 1 })
              }
            }
          } catch (e) {
            // 目录不可读则忽略文件补全
          }
        }
      }
      // 历史合并（client 提供，最近优先）
      const history = Array.isArray(parsed.history) ? parsed.history : []
      for (const h of history) {
        if (typeof h === 'string' && h.indexOf(current) === 0 && h !== current) {
          const after = h.slice(current.length).split(/\s/)[0]
          if (after) matches.push({ text: after + ' ', rank: 1 })
        }
      }
      let ghost = null
      if (matches.length) {
        matches.sort((a, b) => a.rank - b.rank)
        ghost = matches[0].text
      }
      const suggestions = matches.slice(0, 8).map((m) => m.text.trim()).filter(Boolean)
      json(res, 200, { ghost, suggestions })
    })
  }
  ctx.effect(() => webServer.register({ kind: 'exact', path: '/warp/complete', handler: completeHandler }))

  // ---- /warp/last-session：最近的非空主会话（桌面端启动恢复用）----
  const sessionQuery = ctx.get('sessionQuery')
  const lastSessionHandler = async (req, res) => {
    if (req.method !== 'POST') {
      json(res, 405, { sessionId: null })
      return
    }
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > 1_000_000) req.destroy()
    })
    req.on('end', async () => {
      let parsed
      try {
        parsed = JSON.parse(body || '{}')
      } catch {
        json(res, 400, { sessionId: null })
        return
      }
      const currentId = parsed.sessionId
      if (!sessionQuery || typeof sessionQuery.listSessions !== 'function' || typeof sessionQuery.readSession !== 'function') {
        json(res, 200, { sessionId: null })
        return
      }
      try {
        const records = await sessionQuery.listSessions()
        const candidates = records
          .filter(function (r) {
            const h = r && r.header
            if (!h || !h.id || h.id === currentId) return false
            if (h.origin === 'subagent' || (h.delegationDepth || 0) > 0) return false
            return true
          })
          .sort(function (a, b) { return b.header.createdAt - a.header.createdAt })
        for (const c of candidates) {
          const snap = await sessionQuery.readSession(c.header.id).catch(function () { return null })
          const events = snap && snap.events ? snap.events.length : 0
          if (events > 0) {
            json(res, 200, { sessionId: c.header.id })
            return
          }
        }
        json(res, 200, { sessionId: null })
      } catch (e) {
        json(res, 200, { sessionId: null })
      }
    })
  }
  ctx.effect(() => webServer.register({ kind: 'exact', path: '/warp/last-session', handler: lastSessionHandler }))

  return register()
}
