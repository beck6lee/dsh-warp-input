/**
 * dsh-warp-input client half (v2)
 *
 * 接管 conversation.composer（chain 槽）：
 *  - 智能识别命令 vs 对话（无需 $ 前缀）：常见命令词表 / shell 操作符 / CJK 判定 /
 *    未知词可执行探测（POST /warp/check）；$ 或反引号仍可强制命令；徽标可点击手动切换。
 *  - 命令 → 提交 `/run <cmd>`（注册的命令在会话目录执行，结果作为节点进入对话流）。
 *  - 对话 → inputActions.submit()（斜杠命令等原有行为保留）。
 *  - 命令模式下 ↑/↓ 浏览历史。
 */
window.__ModuleLoader__.load({
  id: 'dsh-warp-input',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    var React = require('react')

    var inject = ['slots', 'sessions']

    // ---- 命令智能识别 ----
    // 词表只放无歧义命令（shell 内建 + 常见工具）；歧义英文词（make/go/time/open/find 等）
    // 交给可执行探测（≤2 词）判定，避免 "make it work" 这类误判。
    var COMMAND_WORDS = new Set(('cd ls pwd cat echo git npm node python python3 pip pip3 curl wget mkdir rm rmdir mv cp touch grep egrep fgrep sed awk head tail uniq wc chmod chown sudo env export unset which whereis ps kill killall tar gzip gunzip zip unzip cmake cargo ruby php java javac docker docker-compose kubectl brew yarn pnpm npx sh bash zsh source defaults plutil xattr lsof df du ping ssh scp rsync man tree jq yq xargs basename dirname realpath readlink ln dd stat strings sqlite3 redis-cli mysql psql mongosh dsh gh rg fd bat tldr ffmpeg podman terraform ansible xcodebuild swift swiftc clang gcc cc').split(' '))
    var hasCJK = function (t) { return /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(t) }
    var hasShellOp = function (t) { return /[|&;<>*]/.test(t) }
    var stripPrefix = function (t) {
      var s = t.trim()
      if (s.charAt(0) === '$') return s.slice(1).trim()
      if (s.charAt(0) === '`' && s.charAt(s.length - 1) === '`' && s.length > 2) return s.slice(1, -1).trim()
      return s
    }
    var detectBase = function (draft) {
      var t = draft.trim()
      if (!t) return 'conversation'
      // 多行：用首行做词表/前缀判定，操作符看全文
      var firstLine = t.split('\n')[0].trim()
      if (firstLine.charAt(0) === '$') return 'command'
      if (firstLine.charAt(0) === '`' && firstLine.charAt(firstLine.length - 1) === '`' && firstLine.length > 2) return 'command'
      // 斜杠行（/run xxx、/plan xxx 等）：交给机器内建斜杠裁决，绝不包 /run
      if (firstLine.charAt(0) === '/') return 'conversation'
      if (hasCJK(t)) return 'conversation'
      var first = firstLine.split(/\s+/)[0].toLowerCase()
      if (COMMAND_WORDS.has(first)) return 'command'
      if (hasShellOp(t)) return 'command'
      var c0 = first.charAt(0)
      if ((c0 === '-' || c0 === '.' || c0 === '/') && t.split(/\s+/).length <= 2) return 'command'
      return 'conversation'
    }
    var checkToken = function (token) {
      return fetch('/warp/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: token }),
      })
        .then(function (r) { return r.json() })
        .then(function (res) { return !!(res && res.exists) })
        .catch(function () { return false })
    }
    var resolveMode = function (draft) {
      var base = detectBase(draft)
      if (base === 'command') return Promise.resolve('command')
      var t = draft.trim()
      var tokens = t.split(/\s+/)
      if (tokens.length >= 1 && tokens.length <= 2 && !hasCJK(t)) {
        var first = tokens[0].replace(/[,.;:'"!?]$/, '').toLowerCase()
        if (first && !COMMAND_WORDS.has(first) && !/^[./\-]/.test(first)) {
          return checkToken(first).then(function (ok) { return ok ? 'command' : 'conversation' })
        }
      }
      return Promise.resolve('conversation')
    }

    // ---- 命令历史（localStorage 持久化，跨重启保留）----
    var HISTORY = (function () {
      try {
        var raw = window.localStorage.getItem('dsh-warp-history')
        if (raw) return JSON.parse(raw)
      } catch (e) {}
      return Object.create(null)
    })()
    var HISTORY_CAP = 50
    function saveHistory() {
      try { window.localStorage.setItem('dsh-warp-history', JSON.stringify(HISTORY)) } catch (e) {}
    }
    function pushHistory(sessionId, text, mode) {
      var list = HISTORY[sessionId] || (HISTORY[sessionId] = [])
      var last = list[list.length - 1]
      // 去重：连续相同文本+模式不重复记录
      if (!last || last.text !== text || last.mode !== mode) {
        list.push({ text: text, mode: mode })
        if (list.length > HISTORY_CAP) list.splice(0, list.length - HISTORY_CAP)
        saveHistory()
      }
    }

    // 斜杠命令列表缓存（/warp/commands），会话级
    var COMMANDS_CACHE = Object.create(null)
    // 桌面端启动恢复的一次性守卫
    var DESKTOP_RESTORE_DONE = false
    function fetchCommands(sessionId) {
      if (COMMANDS_CACHE[sessionId]) return Promise.resolve(COMMANDS_CACHE[sessionId])
      return fetch('/warp/commands', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: sessionId }),
      })
        .then(function (r) { return r.json() })
        .then(function (res) {
          COMMANDS_CACHE[sessionId] = (res && res.commands) || []
          return COMMANDS_CACHE[sessionId]
        })
        .catch(function () {
          COMMANDS_CACHE[sessionId] = []
          return []
        })
    }

    function apply(ctx) {
      var slots = ctx.slots

      var css = [
        '.warp-composer { position:relative; display:flex; flex-direction:column; gap:8px; width:100%; max-width:var(--dsh-composer-card-max-width, 780px); margin:0 auto; padding:10px 12px 14px; border:1px solid var(--dsw-alias-border-l2); border-radius:16px; background:var(--dsw-alias-bg-base); }',
        '.warp-palette { position:absolute; bottom:calc(100% - 2px); left:0; right:0; z-index:20; background:var(--dsw-specific-menu); border:1px solid var(--dsw-alias-border-l2); border-radius:12px; box-shadow:var(--dsw-shadow-lv2); max-height:280px; overflow:auto; padding:4px; display:flex; flex-direction:column; gap:2px; }',
        '.warp-palette-item { display:flex; align-items:center; gap:8px; width:100%; border:none; background:transparent; color:var(--dsw-alias-label-primary); border-radius:8px; padding:6px 8px; cursor:pointer; text-align:left; }',
        '.warp-palette-item:hover, .warp-palette-active { background:var(--dsw-alias-interactive-bg-hover); }',
        '.warp-palette-name { font:12px/16px var(--ds-font-family-code, monospace); color:var(--dsw-alias-state-business-primary); flex:none; }',
        '.warp-palette-desc { font-size:12px; color:var(--dsw-alias-label-tertiary); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }',
        '.warp-stats { color:var(--dsw-alias-label-caption); font-size:11px; line-height:16px; border-top:1px solid var(--dsw-alias-border-l1); padding-top:6px; margin-top:2px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }',
        '.warp-textarea { width:100%; min-height:48px; max-height:200px; resize:none; border:none; outline:none; background:transparent; color:var(--dsw-alias-label-primary); font:14px/20px var(--ds-font-family, -apple-system); }',
        '.warp-editor { position:relative; }',
        '.warp-ghost { position:absolute; inset:0; pointer-events:none; color:var(--dsw-alias-label-primary); font:14px/20px var(--ds-font-family, -apple-system); white-space:pre-wrap; overflow:hidden; }',
        '.warp-ghost-suffix { color:var(--dsw-alias-label-caption); }',
        '.warp-textarea-ghost { color:transparent; caret-color:var(--dsw-alias-label-primary); }',
        '.warp-textarea:disabled { opacity:.6; }',
        '.warp-row { display:flex; align-items:center; gap:8px; }',
        '.warp-badge { font:11px/16px var(--ds-font-family-code, monospace); color:var(--dsw-alias-state-business-primary); background:color-mix(in srgb, var(--dsw-alias-state-business-primary) 12%, transparent); border-radius:6px; padding:1px 8px; cursor:pointer; }',
        '.warp-badge-chat { color:var(--dsw-alias-label-tertiary); background:var(--dsw-alias-bg-module-platform); }',
        '.warp-badge-force { outline:1px dashed var(--dsw-alias-border-l3); }',
        '.warp-send { margin-left:auto; border:none; border-radius:10px; background:var(--dsw-alias-state-business-primary); color:#fff; font-size:13px; padding:6px 14px; cursor:pointer; }',
        '.warp-send:disabled { opacity:.5; cursor:default; }',
        '.warp-hint { color:var(--dsw-alias-label-caption); font-size:11px; }',
        '.warp-cmdview { display:flex; flex-direction:column; gap:6px; min-width:0; }',
        '.warp-cmdview-head { display:flex; align-items:center; gap:8px; min-width:0; }',
        '.warp-cmdview-name { color:var(--dsw-alias-label-secondary); font:12px/18px var(--ds-font-family-code, monospace); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }',
        '.warp-cmdview-pill { font:11px/16px var(--ds-font-family-code, monospace); border-radius:999px; padding:1px 8px; flex:none; }',
        '.warp-cmdview-ok { color:var(--dsw-alias-state-success-primary); background:color-mix(in srgb, var(--dsw-alias-state-success-primary) 14%, transparent); }',
        '.warp-cmdview-err { color:var(--dsw-alias-state-error-primary); background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 14%, transparent); }',
        '.warp-cmdview-run { color:var(--dsw-alias-state-warn-label); background:color-mix(in srgb, var(--dsw-alias-state-warn-label) 14%, transparent); }',
        '.warp-cmdview-body { margin:0; color:var(--dsw-alias-label-primary); background:var(--dsw-alias-bg-layer-1); border-radius:8px; padding:8px 10px; font:12px/19px var(--ds-font-family-code, monospace); white-space:pre-wrap; word-break:break-all; max-height:360px; overflow:auto; }',
        '.warp-cmdview-errbody { color:var(--dsw-alias-state-error-primary); }',
        '.warp-cmdview-actions { margin-left:auto; display:flex; gap:6px; flex:none; }',
        '.warp-cmdview-btn { border:1px solid var(--dsw-alias-border-l2); background:var(--dsw-alias-bg-module-platform); color:var(--dsw-alias-label-secondary); border-radius:6px; font-size:11px; padding:1px 8px; cursor:pointer; }',
        '.warp-cmdview-btn:hover { background:var(--dsw-alias-interactive-bg-hover); color:var(--dsw-alias-label-primary); }',
      ].join('\n')

      ctx.effect(function () {
        var tag = document.createElement('style')
        tag.dataset.plugin = 'dsh-warp-input'
        tag.textContent = css
        document.head.appendChild(tag)
        return function () { tag.remove() }
      })

      function WarpComposer(props) {
        var useInput = props.useInput
        var inputActions = props.inputActions
        var useProjection = props.useProjection
        var useSession = props.useSession
        var sessionId = props.sessionId
        var input = typeof useInput === 'function' ? useInput(function (s) { return s }) : undefined
        var draft = (input && input.draft) || ''
        // 重建被隐藏的默认统计行（token 使用 / 轮次，与 web 端一致）
        var usage = typeof useProjection === 'function' ? useProjection('tokenUsage') : undefined
        var sessionStats = typeof useProjection === 'function' ? useProjection('sessionStats') : undefined
        // 当前会话节点（判断是否空白会话，桌面端启动恢复用）
        var nodes = typeof useSession === 'function'
          ? useSession(function (s) { var c = s && s.chat; return (c && c.legacy && c.legacy.nodes) || [] })
          : []
        var forceState = React.useState(null)
        var force = forceState[0]
        var setForce = forceState[1]
        var exeState = React.useState(false)
        var exeCmd = exeState[0]
        var setExeCmd = exeState[1]
        var idxState = React.useState(-1)
        var idx = idxState[0]
        var setIdx = idxState[1]
        var pendingState = React.useState('')
        var pending = pendingState[0]
        var setPending = pendingState[1]
        var recallState = React.useState(false)
        var recallFlag = recallState[0]
        var setRecallFlag = recallState[1]
        var historyList = HISTORY[sessionId] || []
        // 斜杠命令补全弹窗
        var cmdState = React.useState([])
        var cmdList = cmdState[0]
        var setCmdList = cmdState[1]
        var popupState = React.useState(-1)
        var popupIdx = popupState[0]
        var setPopupIdx = popupState[1]
        // z 风格幽灵补全
        var ghostState = React.useState(null)
        var ghost = ghostState[0]
        var setGhost = ghostState[1]

        // 会话级拉取命令列表（仅 sessionId 变化时）
        React.useEffect(function () {
          var dead = false
          fetchCommands(sessionId).then(function (list) { if (!dead) setCmdList(list) })
          return function () { dead = true }
        }, [sessionId])

        // 幽灵补全：z 风格——不依赖命令判定，任何非 CJK/单行/非斜杠草稿都可建议
        React.useEffect(function () {
          var t = draft.trim()
          var eligible = t && !t.endsWith(' ') && t.indexOf('\n') === -1 && !hasCJK(t) && t.charAt(0) !== '/'
          if (!eligible) {
            setGhost(null)
            return
          }
          var dead = false
          var timer = setTimeout(function () {
            fetch('/warp/complete', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                sessionId: sessionId,
                draft: draft,
                history: historyList.map(function (h) { return h.text }),
              }),
            })
              .then(function (r) { return r.json() })
              .then(function (res) { if (!dead) setGhost(res && res.ghost ? res.ghost : null) })
              .catch(function () { if (!dead) setGhost(null) })
          }, 150)
          return function () { dead = true; clearTimeout(timer) }
        }, [draft, sessionId])

        // 桌面端启动恢复：当前为空白会话时，打开最近的非空主会话（每页仅一次）
        React.useEffect(function () {
          if (DESKTOP_RESTORE_DONE) return
          if (typeof window === 'undefined' || !window.location || !window.location.search) return
          if (window.location.search.indexOf('dsh=desktop') === -1) return
          var sessionsCtx = ctx.get('sessions')
          if (!sessionsCtx || typeof sessionsCtx.open !== 'function') return
          if (nodes && nodes.length > 0) return // 当前会话有内容，不打扰
          DESKTOP_RESTORE_DONE = true
          fetch('/warp/last-session', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId: sessionId }),
          })
            .then(function (r) { return r.json() })
            .then(function (res) {
              if (res && res.sessionId && res.sessionId !== sessionId) sessionsCtx.open(res.sessionId)
            })
            .catch(function () {})
        }, [sessionId, nodes.length])

        // 补全匹配：草稿以 / 开头时，按第一个 token 过滤（popupIdx 在 onChange 里重置）
        var token = ''
        var matches = []
        var popupOpen = false
        if (draft.trim().charAt(0) === '/') {
          token = draft.trim().slice(1).split(/\s/)[0].toLowerCase()
          matches = cmdList.filter(function (c) { return c && c.name && c.name.indexOf(token) === 0 })
          popupOpen = matches.length > 0
        }
        // 幽灵显示条件：命令模式 + 单行 + 总长限制（避免换行错位）
        var showGhost = ghost && draft.trim() && draft.indexOf('\n') === -1 && (draft + ghost).length < 80

        React.useEffect(function () {
          var t = draft.trim()
          var tokens = t.split(/\s+/)
          var first = tokens[0] ? tokens[0].replace(/[,.;:'"!?]$/, '').toLowerCase() : ''
          var ambiguous = t && detectBase(draft) === 'conversation' && tokens.length <= 2 && !hasCJK(t) && first && !COMMAND_WORDS.has(first) && !/^[./\-]/.test(first)
          if (!ambiguous) { setExeCmd(false); return }
          var dead = false
          var timer = setTimeout(function () {
            checkToken(first).then(function (ok) { if (!dead) setExeCmd(ok) })
          }, 400)
          return function () { dead = true; clearTimeout(timer) }
        }, [draft])

        var detected = detectBase(draft)
        var effective = force || (detected === 'conversation' && exeCmd ? 'command' : detected)
        var isCommand = effective === 'command'

        var toggleForce = function () {
          setForce(isCommand ? 'conversation' : 'command')
          setRecallFlag(false)
        }

        var submitCommand = function (draft) {
          var cmd = stripPrefix(draft)
          if (!cmd) return
          // 斜杠行直接提交（机器裁决），不包 /run，避免 /run /run xxx
          if (cmd.charAt(0) === '/') {
            if (typeof inputActions.submit === 'function') inputActions.submit()
            return
          }
          pushHistory(sessionId, cmd, 'command')
          if (typeof inputActions.setDraft === 'function') inputActions.setDraft('/run ' + cmd)
          if (typeof inputActions.submit === 'function') inputActions.submit()
          if (idx !== -1) setIdx(-1)
          if (pending) setPending('')
        }

        var send = function () {
          if (force) {
            if (force === 'command') submitCommand(draft)
            else {
              if (draft.trim()) pushHistory(sessionId, draft, 'conversation')
              if (typeof inputActions.submit === 'function') inputActions.submit()
            }
            return
          }
          resolveMode(draft).then(function (mode) {
            if (mode === 'command') {
              submitCommand(draft)
            } else {
              if (draft.trim()) pushHistory(sessionId, draft, 'conversation')
              if (typeof inputActions.submit === 'function') inputActions.submit()
            }
          })
        }

        var pickCommand = function (i) {
          if (typeof inputActions.setDraft === 'function') inputActions.setDraft('/' + matches[i].name + ' ')
          setPopupIdx(-1)
        }

        var onKeyDown = function (e) {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            if (popupOpen && popupIdx >= 0) pickCommand(popupIdx)
            else send()
            return
          }
          // 斜杠补全弹窗开启时：↑/↓ 导航、Tab 选中
          if (popupOpen && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
            e.preventDefault()
            var next = e.key === 'ArrowDown'
              ? (popupIdx >= matches.length - 1 ? 0 : popupIdx + 1)
              : (popupIdx <= 0 ? matches.length - 1 : popupIdx - 1)
            setPopupIdx(next)
            return
          }
          if (popupOpen && e.key === 'Tab') {
            e.preventDefault()
            if (popupIdx >= 0) pickCommand(popupIdx)
            return
          }
          // z 风格 Tab 补全：命令模式且有幽灵时接受补全
          if (e.key === 'Tab' && ghost && !e.nativeEvent.isComposing) {
            e.preventDefault()
            if (typeof inputActions.setDraft === 'function') inputActions.setDraft(draft + ghost)
            setGhost(null)
            return
          }
          // ↑/↓ 历史：命令模式、空草稿、或已在浏览中（idx≠-1，浏览对话条目时持续生效）；
          // 非命令的非空草稿（未浏览）保留 textarea 默认行为
          if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.nativeEvent.isComposing
            && (isCommand || draft.trim() === '' || idx !== -1)) {
            if (historyList.length === 0) return
            e.preventDefault()
            var recall = function (entry) {
              if (typeof inputActions.setDraft === 'function') inputActions.setDraft(entry.text)
              setForce(entry.mode)
              setRecallFlag(true)
            }
            if (e.key === 'ArrowUp') {
              if (idx === -1) setPending(draft)
              var up = idx === -1 ? historyList.length - 1 : Math.max(0, idx - 1)
              setIdx(up)
              recall(historyList[up])
            } else {
              if (idx === -1) return
              var down = idx + 1
              if (down >= historyList.length) {
                setIdx(-1)
                if (typeof inputActions.setDraft === 'function') inputActions.setDraft(pending)
                setForce(null)
                setRecallFlag(false)
              } else {
                setIdx(down)
                recall(historyList[down])
              }
            }
          }
        }

        var renderPalette = function () {
          if (!popupOpen) return null
          return React.createElement('div', { className: 'warp-palette' },
            matches.map(function (c, i) {
              return React.createElement('button', {
                key: c.name,
                className: 'warp-palette-item' + (i === popupIdx ? ' warp-palette-active' : ''),
                onMouseEnter: function () { setPopupIdx(i) },
                onClick: function () { pickCommand(i) },
              },
                React.createElement('span', { className: 'warp-palette-name' }, '/' + c.name),
                React.createElement('span', { className: 'warp-palette-desc' }, c.description || ''),
              )
            }),
          )
        }

        // 与 web 端 StatsLine 完全一致的统计行（zh 文案、| 分隔、同款显示条件）
        var renderStatsLine = function () {
          var groups = []
          var stats = sessionStats
          if (stats && stats.steps > 0) {
            groups.push(stats.turns + ' 轮 · ' + stats.steps + ' 步')
            var durations = []
            if (stats.llmMs > 0) durations.push('LLM ' + formatDuration(stats.llmMs))
            if (stats.toolMs > 0) durations.push('工具调用 ' + formatDuration(stats.toolMs))
            if (durations.length > 0) groups.push(durations.join(' · '))
            var speeds = []
            if (stats.ttftSteps > 0) speeds.push('首 token 平均 ' + formatDuration(stats.ttftMs / stats.ttftSteps))
            if (stats.decodeMs > 0) speeds.push(formatTokensPerSecond(stats.decodeTokens / (stats.decodeMs / 1e3)) + ' tok/s')
            if (speeds.length > 0) groups.push(speeds.join(' · '))
          }
          if (usage && (billedInputTokens(usage) > 0 || usage.outputTokens > 0)) {
            var hit = cacheHitPercent(usage)
            if (hit !== null) groups.push('缓存命中 ' + hit + '%')
            groups.push('输入 ' + formatTokens(billedInputTokens(usage)) + ' tok · 输出 ' + formatTokens(usage.outputTokens) + ' tok')
          }
          if (groups.length === 0) return null
          var line = groups.join(' | ')
          return React.createElement('div', { className: 'warp-stats', title: line }, line)
        }

        return React.createElement('div', { className: 'warp-composer' },
          renderPalette(),
          React.createElement('div', { className: 'warp-editor' },
            showGhost
              ? React.createElement('div', { className: 'warp-ghost', 'aria-hidden': true },
                  draft,
                  React.createElement('span', { className: 'warp-ghost-suffix' }, ghost),
                )
              : null,
            React.createElement('textarea', {
              className: 'warp-textarea' + (showGhost ? ' warp-textarea-ghost' : ''),
              value: draft,
              placeholder: '对话或命令（智能识别，如 ls -la；输入 / 弹出命令补全）',
              // 关闭 macOS 系统自动纠正/首字母大写（WKWebView 会弹悬浮建议并空格替换）
              autoCorrect: 'off',
              autoCapitalize: 'off',
              spellCheck: false,
              onChange: function (e) {
                if (force) setForce(null)
                setRecallFlag(false)
                if (idx !== -1) { setIdx(-1); setPending('') }
                setPopupIdx(-1)
                if (typeof inputActions.setDraft === 'function') inputActions.setDraft(e.target.value)
              },
              onKeyDown: onKeyDown,
            }),
          ),
          React.createElement('div', { className: 'warp-row' },
            React.createElement('button', {
              className: 'warp-badge' + (isCommand ? '' : ' warp-badge-chat') + (force && !recallFlag ? ' warp-badge-force' : ''),
              onClick: toggleForce,
              title: '点击切换命令/对话（虚线=手动模式）',
            }, isCommand ? '$ 命令' : '对话'),
            (isCommand && historyList.length > 0)
              ? React.createElement('span', { className: 'warp-hint' }, '↑/↓ 历史')
              : null,
            React.createElement('button', { className: 'warp-send', onClick: send },
              isCommand ? '执行' : '发送'),
          ),
          renderStatsLine(),
        )
      }

      // ---- 与 web StatsLine 一致的格式化（照抄客户端实现）----
      function formatTokens(n) {
        var scaled = function (v) { return v >= 100 ? String(Math.round(v)) : String(Math.round(v * 10) / 10) }
        if (n < 1e3) return String(n)
        if (n < 1e6) return scaled(n / 1e3) + 'K'
        return scaled(n / 1e6) + 'M'
      }
      function formatTokensPerSecond(tps) {
        var clamped = Math.max(0, tps)
        return clamped >= 10 ? String(Math.round(clamped)) : String(Math.round(clamped * 10) / 10)
      }
      function formatDuration(ms) {
        var s = ms / 1e3
        if (s < 60) return String(Math.round(s * 10) / 10) + 's'
        var whole = Math.round(s)
        return Math.floor(whole / 60) + 'm' + (whole % 60) + 's'
      }
      function billedInputTokens(u) {
        return u.uncachedInputTokens + u.cacheReadTokens + u.cacheWriteTokens
      }
      function cacheHitPercent(u) {
        var d = billedInputTokens(u)
        return d === 0 ? null : Math.round(u.cacheReadTokens / d * 100)
      }

      // ---- /run 命令的对话流视图：默认展开完整输出 ----
      function RunCommandView(props) {
        var node = props.node
        var args = (node && node.args ? String(node.args).trim() : '')
        var outcome = node ? node.outcome : null
        var head = '/run' + (args ? ' ' + args : '')
        var text = outcome && outcome.text ? String(outcome.text) : ''
        var expandState = React.useState(true)
        var expanded = expandState[0]
        var setExpanded = expandState[1]
        var copiedState = React.useState(false)
        var copied = copiedState[0]
        var setCopied = copiedState[1]
        var pill
        if (!outcome) {
          pill = { cls: 'warp-cmdview-run', text: '执行中…' }
        } else if (outcome.kind === 'success') {
          pill = { cls: 'warp-cmdview-ok', text: 'exit 0' }
        } else {
          pill = { cls: 'warp-cmdview-err', text: '失败' }
        }
        var copyText = function () {
          var ok = function () {
            setCopied(true)
            setTimeout(function () { setCopied(false) }, 1200)
          }
          var fallback = function (txt) {
            var ta = document.createElement('textarea')
            ta.value = txt
            ta.style.position = 'fixed'
            ta.style.opacity = '0'
            document.body.appendChild(ta)
            ta.select()
            try { document.execCommand('copy') } catch (e) {}
            document.body.removeChild(ta)
          }
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(ok).catch(function () { fallback(text); ok() })
          } else {
            fallback(text)
            ok()
          }
        }
        return React.createElement('div', { className: 'warp-cmdview' },
          React.createElement('div', { className: 'warp-cmdview-head' },
            React.createElement('span', { className: 'warp-cmdview-name', title: head }, head),
            React.createElement('span', { className: 'warp-cmdview-pill ' + pill.cls }, pill.text),
            text
              ? React.createElement('span', { className: 'warp-cmdview-actions' },
                  React.createElement('button', { className: 'warp-cmdview-btn', onClick: copyText },
                    copied ? '已复制' : '复制'),
                  React.createElement('button', { className: 'warp-cmdview-btn', onClick: function () { setExpanded(!expanded) } },
                    expanded ? '收起' : '展开'),
                )
              : null,
          ),
          expanded && text
            ? React.createElement('pre', {
                className: 'warp-cmdview-body' + (outcome && outcome.kind === 'error' ? ' warp-cmdview-errbody' : ''),
              }, text)
            : null,
        )
      }

      slots.inject('conversation.chat.commandview', function () {
        return slots.register({
          name: 'conversation.chat.commandview',
          key: 'run',
        }, function (props) {
          return React.createElement(RunCommandView, props)
        })
      })

      slots.inject('conversation.composer', function () {
        return slots.register({
          name: 'conversation.composer',
          select: function (owner) {
            // 无会话（hero 阶段）或存在待处理交互（问题/审批接管）时让位
            if (!owner || !owner.session) return null
            var interactions = owner.interactions
            if (interactions && interactions.length > 0) return null
            return { kind: 'warp-command' }
          },
        }, function (props) {
          return React.createElement(WarpComposer, props)
        })
      })
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
