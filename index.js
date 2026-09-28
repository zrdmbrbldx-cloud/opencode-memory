/**
 * opencode-memory — cross-session memory for OpenCode v2
 * ======================================================
 *
 * Gives OpenCode a memory that survives sessions, modelled on how a long-lived
 * assistant keeps notes:
 *
 *   1. RECALL  — a `context` hook injects the relevant memory files into the
 *                system prompt on every model request.
 *   2. WRITE   — `memory_write` / `memory_search` / `memory_read` tools let the
 *                agent record and look things up itself.
 *   3. COMMANDS— `/remember` and `/memory` for the human.
 *
 * Layout (under the OpenCode config directory, so your repos stay clean):
 *
 *   <config>/memory/
 *     user/MEMORY.md                        cross-project facts and preferences
 *     projects/<slug>/MEMORY.md             curated, durable project knowledge
 *     projects/<slug>/log/YYYY-MM-DD.md     append-only daily work log
 *     projects/<slug>/.project              the original project path (for humans)
 *
 * Everything is plain Markdown, greppable and editable by hand.
 *
 * NOTE: this file deliberately does NOT import "@opencode/plugin". A local
 * plugin directory is outside the CLI's module resolution scope, so that import
 * fails with "Cannot find package '@opencode/plugin'". Exporting a plain object
 * with `id` + `setup` is the supported shape and needs no dependency.
 */

import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { fileURLToPath } from "node:url"

/* ------------------------------------------------------------------ config */

const DEFAULTS = {
  // "config" keeps memory under the OpenCode config dir; "project" writes to
  // <project>/.opencode/memory instead (visible in the repo, mind your .gitignore).
  storage: "config",
  injectUserMemory: true,
  injectProjectMemory: true,
  injectRecentLog: true,
  recentLogDays: 1,
  maxMemoryChars: 4000,
  maxLogChars: 3000,
  maxInjectChars: 12000,
  // Opt-in: after a session that actually did work, ask a model to distil a few
  // memory-worthy facts into the daily log. Costs one extra (cheap) model call.
  autoCapture: false,
  autoCaptureMinToolCalls: 4,
}

/* ------------------------------------------------------------- path helpers */

const HERE = path.dirname(fileURLToPath(import.meta.url)) // <config>/plugins/memory

function configDir() {
  // The plugin lives at <config>/plugins/memory, so walk up twice.
  try {
    const candidate = path.resolve(HERE, "..", "..")
    if (fs.existsSync(path.join(candidate, "opencode.jsonc"))) return candidate
    if (fs.existsSync(path.join(candidate, "opencode.json"))) return candidate
    if (fs.existsSync(candidate)) return candidate
  } catch {}
  const xdg = process.env.XDG_CONFIG_HOME
  if (xdg) return path.join(xdg, "opencode")
  return path.join(os.homedir(), ".config", "opencode")
}

const CONFIG_DIR = configDir()
const MEMORY_ROOT = path.join(CONFIG_DIR, "memory")

/** "D:\2026" -> "D--2026" (stable, readable, filesystem-safe). */
function slugFor(dir) {
  const raw = String(dir || "unknown").replace(/[:\\/]+/g, "-").replace(/[<>:"|?*\s]+/g, "_")
  const trimmed = raw.replace(/^-+|-+$/g, "")
  return trimmed || "unknown"
}

function memoryPaths(projectDir) {
  const slug = slugFor(projectDir)
  const projectRoot = path.join(MEMORY_ROOT, "projects", slug)
  return {
    slug,
    userMemory: path.join(MEMORY_ROOT, "user", "MEMORY.md"),
    projectRoot,
    projectMarker: path.join(projectRoot, ".project"),
    projectMemory: path.join(projectRoot, "MEMORY.md"),
    logDir: path.join(projectRoot, "log"),
  }
}

/* -------------------------------------------------------------- file helpers */

function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true })
    return true
  } catch {
    return false
  }
}

function readSafe(file) {
  try {
    return fs.readFileSync(file, "utf8")
  } catch {
    return ""
  }
}

function writeSafe(file, content) {
  try {
    ensureDir(path.dirname(file))
    fs.writeFileSync(file, content, "utf8")
    return true
  } catch {
    return false
  }
}

function appendSafe(file, content) {
  try {
    ensureDir(path.dirname(file))
    fs.appendFileSync(file, content, "utf8")
    return true
  } catch {
    return false
  }
}

function truncate(text, max) {
  if (!text || text.length <= max) return text || ""
  return text.slice(0, max) + `\n\n…（已截断，原文 ${text.length} 字符）`
}

function today() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function stamp() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, "0")
  return `${p(d.getHours())}:${p(d.getMinutes())}`
}

/** Walk every .md file under MEMORY_ROOT, newest first. */
function listMemoryFiles() {
  const out = []
  const walk = (dir, depth) => {
    if (depth > 4) return
    let entries = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) walk(full, depth + 1)
      else if (e.name.endsWith(".md")) {
        let stat = null
        try {
          stat = fs.statSync(full)
        } catch {}
        out.push({ file: full, rel: path.relative(MEMORY_ROOT, full), mtime: stat?.mtimeMs ?? 0, size: stat?.size ?? 0 })
      }
    }
  }
  walk(MEMORY_ROOT, 0)
  return out.sort((a, b) => b.mtime - a.mtime)
}

/* ---------------------------------------------------------------- the plugin */

export default {
  id: "memory",

  async setup(ctx) {
    // Options may come from the plugin entry in opencode.jsonc, or from
    // <memory>/config.json. The file is the practical route because an
    // auto-discovered plugin has no entry to attach options to.
    let fileOptions = {}
    try {
      fileOptions = JSON.parse(readSafe(path.join(MEMORY_ROOT, "config.json")) || "{}")
    } catch {}
    const options = { ...DEFAULTS, ...fileOptions, ...(ctx.options ?? {}) }
    const useProjectStorage = options.storage === "project"

    /** Resolve the memory paths for a session's project directory. */
    function pathsFor(projectDir) {
      if (!useProjectStorage) return memoryPaths(projectDir)
      const root = path.join(projectDir, ".opencode", "memory")
      return {
        slug: slugFor(projectDir),
        userMemory: path.join(MEMORY_ROOT, "user", "MEMORY.md"),
        projectRoot: root,
        projectMarker: path.join(root, ".project"),
        projectMemory: path.join(root, "MEMORY.md"),
        logDir: path.join(root, "log"),
      }
    }

    // ---------------------------------------------------------- project lookup
    // ctx.location is the *service* location (often the filesystem root), not the
    // session's project, so resolve it per session and cache it.
    const projectCache = new Map()

    async function projectDirFor(sessionID) {
      if (sessionID && projectCache.has(sessionID)) return projectCache.get(sessionID)
      let dir = ctx.location?.directory || process.cwd()
      if (sessionID) {
        try {
          const res = await ctx.session.get({ sessionID })
          const info = res?.data ?? res
          const d = info?.location?.directory
          if (d) dir = d
        } catch {}
        projectCache.set(sessionID, dir)
      }
      return dir
    }

    // --------------------------------------------------------------- injection
    function buildInjection(projectDir) {
      const p = pathsFor(projectDir)
      const parts = []

      if (options.injectUserMemory) {
        const user = readSafe(p.userMemory).trim()
        if (user) {
          parts.push(`## 用户级记忆（跨项目）\n\n${truncate(user, options.maxMemoryChars)}`)
        }
      }

      if (options.injectProjectMemory) {
        const proj = readSafe(p.projectMemory).trim()
        if (proj) {
          parts.push(`## 项目记忆 — ${projectDir}\n\n${truncate(proj, options.maxMemoryChars)}`)
        }
      }

      if (options.injectRecentLog) {
        const days = Math.max(1, Number(options.recentLogDays) || 1)
        const chunks = []
        for (let i = 0; i < days; i++) {
          const d = new Date()
          d.setDate(d.getDate() - i)
          const pad = (n) => String(n).padStart(2, "0")
          const name = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
          const body = readSafe(path.join(p.logDir, `${name}.md`)).trim()
          if (body) chunks.push(`### ${name}\n\n${truncate(body, options.maxLogChars)}`)
        }
        if (chunks.length) parts.push(`## 最近工作日志\n\n${chunks.join("\n\n")}`)
      }

      const hasAny = parts.length > 0
      const header =
        "[opencode-memory] 以下是你在本项目中的长期记忆，请把它当作已知背景，不要向用户复述本段。\n\n" +
        "记忆使用规则：\n" +
        "- 完成实质性工作后（改代码、修 bug、写文档、定方案、排查出结论），用 `memory_write` 追加一条到当天日志（target=log）。\n" +
        "- 反复验证有效的结论、用户偏好、项目约定，用 `memory_write` 写入长期记忆（target=project 或 user，mode=append）。\n" +
        "- 需要历史信息时用 `memory_search` 检索，不要凭空猜测；不确定就查。\n" +
        "- 日志是追加的流水，长期记忆要精炼；不要把临时路径、一次性输出写进长期记忆。\n"

      const body = hasAny ? "\n\n" + parts.join("\n\n") : "\n\n（当前还没有任何记忆，从这次工作开始积累。）\n"
      return truncate(header + body, options.maxInjectChars)
    }

    // Snapshot tool ids before we register ours, so the self-check can report the
    // exact ids we added (namespaces may be rewritten, so do not guess them).
    let toolsBefore = new Set()
    try {
      toolsBefore = new Set((await ctx.tool.list()).map((t) => t.id))
    } catch {}

    // --------------------------------------------------------------- tool: write
    // IMPORTANT: tool names must be globally unique. `editor.namespace()` does not
    // reliably prefix ids on 2.0.15, and names like `write` / `read` / `search`
    // collide with OpenCode's built-in file tools - registering those would shadow
    // the built-ins and break the agent's ability to read and write files.
    // Always use an explicit, prefixed name.
    await ctx.tool.transform((editor) => {
      editor.add({
        name: "memory_write",
        description:
          "Write to long-term memory. target=log appends to today's work log (use after substantive work); " +
          "target=project appends to curated project memory; target=user appends to cross-project user memory. " +
          "Use mode=replace only when you intend to rewrite the whole file.",
        input: {
          type: "object",
          properties: {
            target: { type: "string", enum: ["log", "project", "user"], description: "Which memory file to write." },
            content: { type: "string", description: "Markdown to store. Keep it concise and factual." },
            mode: { type: "string", enum: ["append", "replace"], description: "Default append." },
            sessionID: { type: "string", description: "Optional session id to resolve the project directory." },
          },
          required: ["target", "content"],
          additionalProperties: false,
        },
        execute: async (input) => {
          const projectDir = await projectDirFor(input.sessionID)
          const p = pathsFor(projectDir)
          const mode = input.mode || "append"
          let file
          let payload

          if (input.target === "user") {
            file = p.userMemory
            payload = mode === "append" ? `\n\n- ${input.content.trim()}\n` : input.content
          } else if (input.target === "project") {
            file = p.projectMemory
            payload = mode === "append" ? `\n\n- ${input.content.trim()}\n` : input.content
          } else {
            file = path.join(p.logDir, `${today()}.md`)
            const isNew = !fs.existsSync(file)
            payload =
              (isNew ? `# ${today()} 工作日志\n` : "") +
              `\n## ${stamp()}\n\n${input.content.trim()}\n`
          }

          ensureDir(p.projectRoot)
          if (input.target !== "user" && !fs.existsSync(p.projectMarker)) {
            writeSafe(p.projectMarker, projectDir + "\n")
          }

          const ok = mode === "replace" ? writeSafe(file, payload) : appendSafe(file, payload)
          if (!ok) return { content: `写入失败：${file}` }
          return {
            content: `已写入 ${input.target} → ${path.relative(MEMORY_ROOT, file).split(path.sep).join("/")}`,
            metadata: { file },
          }
        },
      })

      // ------------------------------------------------------------- tool: search
      editor.add({
        name: "memory_search",
        description: "Search all memory files (user memory, project memory, daily logs) for a keyword or phrase.",
        input: {
          type: "object",
          properties: {
            query: { type: "string", description: "Text to look for (case-insensitive substring)." },
            limit: { type: "number", description: "Max matching lines to return (default 40)." },
          },
          required: ["query"],
          additionalProperties: false,
        },
        execute: async (input) => {
          const q = String(input.query || "").toLowerCase()
          if (!q) return { content: "query 为空。" }
          const limit = Math.max(1, Math.min(200, Number(input.limit) || 40))
          const files = listMemoryFiles()
          const hits = []
          for (const f of files) {
            const lines = readSafe(f.file).split(/\r?\n/)
            for (let i = 0; i < lines.length; i++) {
              if (lines[i].toLowerCase().includes(q)) {
                hits.push(`${f.rel.split(path.sep).join("/")}:${i + 1}: ${lines[i].trim().slice(0, 220)}`)
                if (hits.length >= limit) break
              }
            }
            if (hits.length >= limit) break
          }
          if (!hits.length) {
            return {
              content: `没有匹配「${input.query}」。已检索 ${files.length} 个记忆文件：\n` +
                files.map((f) => "  - " + f.rel.split(path.sep).join("/")).join("\n"),
            }
          }
          return { content: `匹配 ${hits.length} 行：\n\n${hits.join("\n")}` }
        },
      })

      // --------------------------------------------------------------- tool: read
      editor.add({
        name: "memory_read",
        description:
          "Read a memory file, or list the memory index when called without arguments. " +
          "target: index|user|project|log. For log, pass `date` as YYYY-MM-DD (default today).",
        input: {
          type: "object",
          properties: {
            target: { type: "string", enum: ["index", "user", "project", "log"] },
            date: { type: "string", description: "YYYY-MM-DD for target=log." },
            sessionID: { type: "string", description: "Optional session id to resolve the project directory." },
          },
          additionalProperties: false,
        },
        execute: async (input) => {
          const target = input.target || "index"
          const projectDir = await projectDirFor(input.sessionID)
          const p = pathsFor(projectDir)

          if (target === "index") {
            const files = listMemoryFiles()
            if (!files.length) {
              return { content: `记忆库还是空的。根目录：${MEMORY_ROOT}\n项目目录：${p.projectRoot}` }
            }
            const lines = files.map(
              (f) => `- ${f.rel.split(path.sep).join("/")}  (${f.size} 字节)`
            )
            return {
              content:
                `记忆根目录：${MEMORY_ROOT}\n当前项目：${projectDir}（slug: ${p.slug}）\n\n` +
                `共 ${files.length} 个文件：\n${lines.join("\n")}`,
            }
          }

          if (target === "user") {
            const body = readSafe(p.userMemory)
            return { content: body.trim() ? body : `（${p.userMemory} 为空或不存在）` }
          }
          if (target === "project") {
            const body = readSafe(p.projectMemory)
            return { content: body.trim() ? body : `（${p.projectMemory} 为空或不存在）` }
          }

          const date = /^\d{4}-\d{2}-\d{2}$/.test(String(input.date || "")) ? input.date : today()
          const file = path.join(p.logDir, `${date}.md`)
          const body = readSafe(file)
          return { content: body.trim() ? body : `（${date} 没有日志，或文件不存在：${file}）` }
        },
      })
    })

    // ---------------------------------------------------------------- commands
    try {
      await ctx.command.transform((editor) => {
        editor.add({
          name: "remember",
          description: "把一段内容写入记忆（交给 agent 判断写入日志还是长期记忆）",
          execute: async ({ sessionID, prompt, delivery }) => {
            const text = String(prompt?.text || "").trim()
            await ctx.session.prompt({
              ...prompt,
              sessionID,
              text:
                "请把下面这段内容写入记忆：用 `memory_write` 工具。" +
                "如果是当天做过的事/结论，用 target=log；如果是长期有效的约定或偏好，用 target=project 或 user。" +
                "写完只用一句话确认。\n\n内容：\n" +
                (text || "（用户没有提供内容，请询问要记什么。）"),
              delivery,
            })
          },
        })

        editor.add({
          name: "memory",
          description: "查看当前记忆索引与项目记忆",
          execute: async ({ sessionID, prompt, delivery }) => {
            await ctx.session.prompt({
              ...prompt,
              sessionID,
              text:
                "请用 `memory_read` 工具（target=index）查看记忆索引，再读一遍 project 记忆，" +
                "然后用简洁的中文向我汇报：有哪些记忆文件、项目长期记忆里都记了什么。不要修改任何内容。",
              delivery,
            })
          },
        })
      })
    } catch (e) {
      // Commands are a convenience; never let them break the plugin.
      console.error("[memory] command registration failed:", e?.message || e)
    }

    // ------------------------------------------------------------- recall hook
    try {
      await ctx.session.hook("context", async (event) => {
        try {
          const projectDir = await projectDirFor(event.sessionID)
          const text = buildInjection(projectDir)
          if (text) event.system.push({ type: "text", text })
        } catch (e) {
          // Memory must never break a request.
          console.error("[memory] injection failed:", e?.message || e)
        }
      })
    } catch (e) {
      console.error("[memory] context hook registration failed:", e?.message || e)
    }

    // ------------------------------------------------------------- self-check
    // A small health record so you can see at a glance that the plugin loaded and
    // what it registered. Handy when a plugin silently fails to load.
    try {
      const allTools = await ctx.tool.list().catch(() => [])
      const toolIDs = allTools.map((t) => t.id)
      const addedTools = toolIDs.filter((id) => !toolsBefore.has(id))
      let commandNames = []
      try {
        const res = await ctx.command.list()
        const list = res?.data ?? res ?? []
        commandNames = list.map((c) => c.name)
      } catch {}
      ensureDir(MEMORY_ROOT)
      writeSafe(
        path.join(MEMORY_ROOT, ".status.json"),
        JSON.stringify(
          {
            at: new Date().toISOString(),
            opencode: ctx.app?.version,
            memoryRoot: MEMORY_ROOT,
            storage: options.storage,
            autoCapture: !!options.autoCapture,
            options,
            tools: addedTools,
            toolsTotal: toolIDs.length,
            allToolIDs: toolIDs,
            commands: commandNames.filter((n) => /remember|memory/i.test(n)),
            hooks: ["session.hook:context"],
          },
          null,
          2
        )
      )
    } catch (e) {
      console.error("[memory] self-check failed:", e?.message || e)
    }

    // ------------------------------------------------------ optional auto-capture
    if (options.autoCapture) {
      const toolCalls = new Map()
      const captured = new Set()

      try {
        await ctx.tool.hook("execute.after", (event) => {
          try {
            if (event.sessionID) toolCalls.set(event.sessionID, (toolCalls.get(event.sessionID) || 0) + 1)
          } catch {}
        })
      } catch {}

      const ac = new AbortController()
      void (async () => {
        try {
          for await (const ev of ctx.event.subscribe({ signal: ac.signal })) {
            if (ev.type !== "session.execution.succeeded") continue
            const sessionID = ev.data?.sessionID
            if (!sessionID || captured.has(sessionID)) continue
            const count = toolCalls.get(sessionID) || 0
            if (count < options.autoCaptureMinToolCalls) continue
            captured.add(sessionID)

            try {
              const projectDir = await projectDirFor(sessionID)
              const p = pathsFor(projectDir)
              const messages = await ctx.session.context({ sessionID })
              const transcript = (Array.isArray(messages) ? messages : [])
                .map((m) => {
                  const t = m?.type || m?.role || "?"
                  const text =
                    typeof m?.text === "string"
                      ? m.text
                      : (m?.parts || [])
                          .map((part) => part?.text || part?.content || "")
                          .filter(Boolean)
                          .join("\n")
                  return text ? `[${t}] ${text}` : ""
                })
                .filter(Boolean)
                .join("\n")
                .slice(-12000)

              if (transcript.length < 400) continue

              const model = await ctx.model.default().catch(() => undefined)
              if (!model) continue

              const res = await ctx.generate.text({
                model: { providerID: model.providerID, id: model.modelID ?? model.id },
                prompt:
                  "下面是一次 OpenCode 会话的记录。请提取 1-3 条值得长期记住的事实，" +
                  "每条一行，以 `- ` 开头，只写事实与结论，不要寒暄、不要复述过程。" +
                  "如果这次会话没有值得记住的内容，只回复 NONE。\n\n" +
                  transcript,
              })
              const text = String(res?.text || "").trim()
              if (!text || /^NONE$/i.test(text)) continue

              const file = path.join(p.logDir, `${today()}.md`)
              const isNew = !fs.existsSync(file)
              appendSafe(
                file,
                (isNew ? `# ${today()} 工作日志\n` : "") +
                  `\n## ${stamp()}（自动记录）\n\n${text}\n`
              )
            } catch (e) {
              console.error("[memory] auto-capture failed:", e?.message || e)
            }
          }
        } catch {}
      })()

      return () => ac.abort()
    }

    return () => {
      projectCache.clear()
    }
  },
}
