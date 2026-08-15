/**
 * dsh-warp-input host half (v2)
 *
 * 1) 注册命令 `/run`：在会话目录执行 shell 命令，结果以命令节点进入对话流。
 * 2) HTTP 路由 POST /warp/check：探测某 token 是否为可执行文件（客户端智能识别辅助）。
 */
export const name = 'dsh-warp-input'

export const inject = ['webServer', 'shell', 'commands', 'subprocess']

const DEFAULT_TIMEOUT_MS = 60000
const MAX_OUTPUT = 8000

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

  ctx.effect(() => webServer.register({ kind: 'exact', path: '/warp/check', handler: checkHandler }))
  return register()
}
