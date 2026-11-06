/**
 * GPT / Codex 对话桥 —— Host 半边。
 *
 * 职责：
 *  1. 调本机 codex CLI（`codex exec`），新建会话或 `codex exec resume <thread>` 续接；
 *  2. 把每一轮的 prompt / 回复 / 元数据写进 <workspace>/.bridge，并在 conversations.json 里建索引；
 *  3. 通过 /api/codex-bridge/* 给 Client 半边提供只读数据；
 *  4. 注册 `codex_gpt` 工具，让 DSH agent 能直接把 GPT 当子代理调用（同一个 conversationId 多次调用即为多轮）。
 *
 * 会话默认持久化（不加 --ephemeral），因此这些对话会出现在 Codex 软件的会话库里，可继续在 Codex 内复核。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";

const ROUTE_PREFIX = "/api/codex-bridge";
const DEFAULT_WORKSPACE =
  process.env.DSH_CODEX_BRIDGE_WORKSPACE || process.cwd();
const DEFAULT_MODEL = process.env.DSH_CODEX_BRIDGE_MODEL || "";
const DEFAULT_REASONING = process.env.DSH_CODEX_BRIDGE_REASONING || "";
const TIMEOUT_SEC = Number(process.env.DSH_CODEX_BRIDGE_TIMEOUT_SEC || 900);
/** true = 不加载 Codex 用户配置（skills / MCP / 记忆 / 人设指令都看不到）。默认沿用用户配置。 */
const ISOLATED = process.env.DSH_CODEX_BRIDGE_ISOLATE === "1";

const UTF8 = "utf8";

/**
 * 选一个工作区：显式环境变量 → 已经带 .bridge 的 workspace → 注册表里的第一个 workspace
 * → workingDirectory 默认值 → 进程 cwd。懒计算，跟随用户当前工作区。
 */
function resolveWorkspace(ctx) {
  const env = process.env.DSH_CODEX_BRIDGE_WORKSPACE;
  if (env) return env;

  try {
    const registry = ctx.get("workspaceRegistry");
    const list = registry?.list?.() ?? [];
    const withBridge = list.find((w) => w?.path && fs.existsSync(path.join(w.path, ".bridge")));
    if (withBridge) return withBridge.path;
    if (list[0]?.path) return list[0].path;
  } catch {
    /* 服务未就绪 */
  }

  try {
    const wd = ctx.get("workingDirectory");
    if (wd?.defaultDirectory) return wd.defaultDirectory;
  } catch {
    /* 没有该服务 */
  }

  return process.env.DSH_CODEX_BRIDGE_WORKSPACE || process.cwd() || DEFAULT_WORKSPACE;
}

function bridgeRoot(workspace) {
  return path.join(workspace, ".bridge");
}

function ensureDirs(root) {
  for (const dir of ["queue", "outbox", "inbox", "logs"]) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
  }
}

function stamp() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function newId(prefix) {
  return `${prefix}-${stamp()}-${Math.random().toString(16).slice(2, 7)}`;
}

/** Codex 可执行文件：环境变量 → PATH → 新版 App 安装目录。 */
function resolveCodex() {
  const explicit = process.env.DSH_CODEX_BRIDGE_CODEX || process.env.CODEX_BIN;
  if (explicit && fs.existsSync(explicit)) return explicit;

  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  const binDir = path.join(localAppData, "OpenAI", "Codex", "bin");
  try {
    const candidates = fs
      .readdirSync(binDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => ({
        dir: path.join(binDir, e.name),
        mtime: fs.statSync(path.join(binDir, e.name)).mtimeMs,
      }))
      .sort((a, b) => b.mtime - a.mtime);
    for (const c of candidates) {
      const exe = path.join(c.dir, process.platform === "win32" ? "codex.exe" : "codex");
      if (fs.existsSync(exe)) return exe;
    }
  } catch {
    /* 目录不存在就落到 PATH 上 */
  }

  for (const name of process.platform === "win32" ? ["codex.exe", "codex"] : ["codex"]) {
    for (const dir of (process.env.PATH || "").split(path.delimiter)) {
      if (!dir) continue;
      const candidate = path.join(dir, name);
      try {
        if (fs.existsSync(candidate)) return candidate;
      } catch {
        /* 权限问题忽略 */
      }
    }
  }
  return "";
}

// ── 存储 ─────────────────────────────────────────────────────────────

function indexPath(root) {
  return path.join(root, "conversations.json");
}

function readIndex(root) {
  const p = indexPath(root);
  if (!fs.existsSync(p)) return { version: 1, conversations: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(p, UTF8));
    if (!Array.isArray(parsed?.conversations)) return { version: 1, conversations: [] };
    return parsed;
  } catch {
    return { version: 1, conversations: [] };
  }
}

function writeIndex(root, index) {
  const p = indexPath(root);
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(index, null, 2), UTF8);
  fs.renameSync(tmp, p);
}

function readJsonSafe(p) {
  try {
    return JSON.parse(fs.readFileSync(p, UTF8));
  } catch {
    return null;
  }
}

function readTextSafe(p) {
  try {
    return fs.readFileSync(p, UTF8);
  } catch {
    return "";
  }
}

/**
 * 老格式兼容：conversations.json 出现之前，记录只有 outbox/<id>.prompt.md 和 inbox/<id>.reply.md。
 * 这里把没有进索引的那些也扫出来，并尽量从 inbox/<id>.json 或 logs/<id>.stdout.jsonl 里
 * 捞出当时的 Codex thread_id（旧记录虽然是 ephemeral，事件流里仍记着它）。
 */
function scanLegacyTurns(root, knownTurnIds) {
  const outboxDir = path.join(root, "outbox");
  const inboxDir = path.join(root, "inbox");
  const logsDir = path.join(root, "logs");

  let names = [];
  try {
    names = fs.readdirSync(outboxDir).filter((n) => n.endsWith(".prompt.md"));
  } catch {
    return [];
  }

  const turns = [];
  for (const name of names) {
    const id = name.replace(/\.prompt\.md$/, "");
    if (knownTurnIds.has(id)) continue;

    const prompt = readTextSafe(path.join(outboxDir, name));
    const reply = readTextSafe(path.join(inboxDir, `${id}.reply.md`));
    if (!prompt.trim() && !reply.trim()) continue;

    const meta = readJsonSafe(path.join(inboxDir, `${id}.json`)) || {};
    let threadId = String(meta.thread_id || meta.threadId || meta.resumeThreadId || "");
    if (!threadId) {
      const log = readTextSafe(path.join(logsDir, `${id}.stdout.jsonl`));
      const hit = log.match(/"thread_id"\s*:\s*"([0-9a-fA-F-]{8,})"/);
      if (hit) threadId = hit[1];
    }

    let at = 0;
    for (const candidate of [path.join(inboxDir, `${id}.reply.md`), path.join(outboxDir, name)]) {
      try {
        at = fs.statSync(candidate).mtimeMs;
        break;
      } catch {
        /* 换下一个候选 */
      }
    }

    turns.push({
      id,
      prompt,
      reply,
      meta,
      threadId,
      at,
      model: String(meta.model || ""),
    });
  }
  turns.sort((a, b) => a.at - b.at);
  return turns;
}

// ── Codex 会话库回读 ─────────────────────────────────────────────────
//
// Codex 把每条会话的完整时间线写在 $CODEX_HOME/sessions/YYYY/MM/DD/rollout-*-<threadId>.jsonl。
// 用户在 Codex 软件里继续同一会话后，新轮次只存在于那里；回读它，侧栏才能看到「两边都算」的完整对话。

const rolloutIndexCache = { at: 0, files: [] };

function codexHomeDir() {
  return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

// ── 让 exec 会话在 Codex App 里可见 ──────────────────────────────────
//
// Codex 桌面版的会话列表只列出 `source = "vscode"` 的线程（实测：App 里能看到的
// 全是 vscode，CLI 产生的是 exec，即使 rollout、projection、turns 都齐全也不显示）。
// `codex exec --thread-source vscode` 实测无效（写入的仍是 exec），所以只能事后把
// `state_N.sqlite` 里这一条的 source 改成 vscode。只动这一个字段，失败不影响主流程。
// 用 Node 内置的 node:sqlite（Node >= 22.5），不可用时静默跳过。

let sqliteModule;
async function loadSqlite() {
  if (sqliteModule !== undefined) return sqliteModule;
  try {
    sqliteModule = await import("node:sqlite");
  } catch {
    sqliteModule = null;
  }
  return sqliteModule;
}

/** 找版本号最大的 state_N.sqlite（Codex 升级会换文件名）。 */
function findStateDb() {
  const dir = codexHomeDir();
  try {
    const names = fs
      .readdirSync(dir)
      .filter((name) => /^state_\d+\.sqlite$/.test(name))
      .sort((a, b) => {
        const na = Number((a.match(/\d+/) || [0])[0]);
        const nb = Number((b.match(/\d+/) || [0])[0]);
        return nb - na;
      });
    return names.length > 0 ? path.join(dir, names[0]) : "";
  } catch {
    return "";
  }
}

async function promoteThreadForApp(threadId) {
  if (!threadId) return false;
  if (process.env.DSH_CODEX_BRIDGE_APP_VISIBLE === "0") return false;

  const sqlite = await loadSqlite();
  if (!sqlite || typeof sqlite.DatabaseSync !== "function") return false;

  const dbPath = findStateDb();
  if (!dbPath) return false;

  try {
    const db = new sqlite.DatabaseSync(dbPath);
    try {
      db.exec("PRAGMA busy_timeout = 3000");
      db.prepare("UPDATE threads SET source = 'vscode' WHERE id = ? AND source LIKE 'exec%'").run(threadId);
    } finally {
      db.close();
    }
    return true;
  } catch (error) {
    console.error(`[codex-bridge] 无法把会话标记为 Codex App 可见: ${String(error)}`);
    return false;
  }
}

function listRolloutFiles() {
  if (Date.now() - rolloutIndexCache.at < 30000 && rolloutIndexCache.files.length > 0) {
    return rolloutIndexCache.files;
  }
  const files = [];
  const walk = (dir, depth) => {
    if (depth > 4) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.name.endsWith(".jsonl")) files.push(full);
    }
  };
  walk(path.join(codexHomeDir(), "sessions"), 0);
  rolloutIndexCache.at = Date.now();
  rolloutIndexCache.files = files;
  return files;
}

function findRolloutForThread(threadId) {
  if (!threadId) return "";
  const wanted = String(threadId).toLowerCase();
  return listRolloutFiles().find((file) => file.toLowerCase().includes(wanted)) || "";
}

/** 从 rollout 里抽 user/assistant 原文，跳过环境上下文与 developer 注入。 */
function readRolloutTimeline(file, maxMessages = 60) {
  let raw;
  try {
    raw = fs.readFileSync(file, UTF8);
  } catch {
    return [];
  }
  const messages = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event?.type !== "response_item") continue;
    const payload = event.payload;
    if (payload?.type !== "message") continue;
    const role = payload.role;
    if (role !== "user" && role !== "assistant") continue;
    let text = "";
    for (const part of payload.content || []) {
      if (typeof part?.text === "string") text += part.text;
    }
    if (!text.trim()) continue;
    if (role === "user" && text.trimStart().startsWith("<environment_context>")) continue;
    messages.push({ role, text, at: event.timestamp || "" });
  }
  return messages.slice(-maxMessages);
}



/** 模型目录（`codex debug models` 解析，10 分钟缓存）。 */
const modelsCache = { at: 0, codex: "", models: [] };

function listModels(codex) {
  if (!codex) return modelsCache.models;
  if (Date.now() - modelsCache.at < 600000 && modelsCache.codex === codex && modelsCache.models.length > 0) {
    return modelsCache.models;
  }
  try {
    const raw = execFileSync(codex, ["debug", "models"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 15000,
      maxBuffer: 32 * 1024 * 1024,
    });
    const parsed = JSON.parse(raw);
    const models = (Array.isArray(parsed?.models) ? parsed.models : []).map((model) => ({
      slug: String(model.slug || ""),
      displayName: String(model.display_name || model.slug || ""),
      defaultReasoning: String(model.default_reasoning_level || ""),
      reasoningLevels: (Array.isArray(model.supported_reasoning_levels) ? model.supported_reasoning_levels : [])
        .map((level) => String(level?.effort || level?.level || ""))
        .filter(Boolean),
    })).filter((model) => model.slug);
    modelsCache.at = Date.now();
    modelsCache.codex = codex;
    modelsCache.models = models;
    return models;
  } catch (error) {
    console.error(`[codex-bridge] 读取模型目录失败: ${String(error)}`);
    return modelsCache.models;
  }
}

/**
 * 从 rollout 的 `turn_context` 读这一轮**实际**使用的模型与推理强度。
 * 桥记录的 model 只是「请求时传了什么」，不传就是空的；实际值只有 Codex 自己知道。
 */
function readActualModel(threadId) {
  const file = findRolloutForThread(threadId);
  if (!file) return null;
  let raw;
  try {
    raw = fs.readFileSync(file, UTF8);
  } catch {
    return null;
  }
  let last = null;
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event?.type !== "turn_context" || !event.payload) continue;
    const payload = event.payload;
    const effort =
      payload.effort ||
      payload.reasoning_effort ||
      payload.collaboration_mode?.settings?.reasoning_effort ||
      "";
    if (payload.model || effort) {
      last = { model: String(payload.model || ""), effort: String(effort || "") };
    }
  }
  return last;
}

/** 把 rollout 时间线与桥自己记录的回复对照，标出「只在 Codex 侧出现过」的那些轮次。 */function buildCodexTimeline(threadId, knownReplies) {
  const file = findRolloutForThread(threadId);
  if (!file) return { file: "", messages: [] };
  const messages = readRolloutTimeline(file).map((message) => {
    const text = String(message.text || "").trim();
    return {
      role: message.role,
      text: message.text,
      at: message.at,
      // 只有回复能确定身份；用户输入会被桥包装过，不做匹配。
      external: message.role === "assistant" && knownReplies.size > 0 && !knownReplies.has(text),
    };
  });
  return { file, messages };
}

function buildArgv({ codex, workspace, threadId, model, reasoning, replyPath, persist }) {
  // 注意：`codex exec resume` 的选项集比顶层 `codex exec` 小——它接受
  // --skip-git-repo-check / --json / -o / -m / -c，但不接受 -C、-s 和 --color。
  // resume 的 cwd 由 spawn 的 cwd 决定，沙箱沿用原会话。
  const argv = [codex, "exec"];
  if (threadId) {
    argv.push("resume", threadId, "-", "--skip-git-repo-check", "--json", "-o", replyPath);
  } else {
    argv.push(
      "-C",
      workspace,
      "-s",
      "read-only",
      "--skip-git-repo-check",
      "--color",
      "never",
      "--json",
      "-o",
      replyPath,
    );
  }
  if (!persist) argv.push("--ephemeral");
  if (ISOLATED) argv.push("--ignore-user-config");
  if (model) argv.push("-m", model);
  if (reasoning) argv.push("-c", `model_reasoning_effort="${reasoning}"`);
  return argv;
}

/**
 * 跑一次 codex exec。返回 { threadId, reply, usage, exitCode, durationMs, stdout, stderr }。
 * @param {object} opts
 */
function runCodex(opts) {
  const {
    codex,
    workspace,
    threadId = "",
    prompt,
    model = "",
    reasoning = "",
    replyPath,
    persist = true,
    timeoutSec = TIMEOUT_SEC,
    signal,
  } = opts;

  const argv = buildArgv({ codex, workspace, threadId, model, reasoning, replyPath, persist });
  const started = Date.now();

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), {
        cwd: workspace,
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      reject(error);
      return;
    }

    const out = [];
    const err = [];
    let settled = false;
    let timer = null;

    const onAbort = () => {
      try {
        child.kill();
      } catch {
        /* 已退出 */
      }
    };

    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      err.push(`\n[bridge] 超时 ${timeoutSec}s，已终止。\n`);
    }, timeoutSec * 1000);

    child.stdout.on("data", (buf) => out.push(buf));
    child.stderr.on("data", (buf) => err.push(buf));

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });

    child.on("close", (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);

      const stdout = Buffer.concat(out).toString("utf8");
      const stderr = Buffer.concat(err).toString("utf8");

      let resolvedThreadId = threadId;
      let usage = null;
      let lastMessage = "";
      let failure = "";
      for (const line of stdout.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("{")) continue;
        let event;
        try {
          event = JSON.parse(trimmed);
        } catch {
          continue;
        }
        if (event.type === "thread.started" && event.thread_id) resolvedThreadId = event.thread_id;
        if (event.type === "turn.completed" && event.usage) usage = event.usage;
        if (
          event.type === "item.completed" &&
          event.item?.type === "agent_message" &&
          typeof event.item.text === "string"
        ) {
          lastMessage = event.item.text;
        }
        // turn.failed 才是致命错误；顶层 error 事件可能只是重连提示，item 里的 error 多是特性告警。
        if (event.type === "turn.failed") {
          const raw = String(event.error?.message || "");
          let message = raw;
          try {
            const parsed = JSON.parse(raw);
            message = String(parsed?.error?.message || parsed?.message || raw);
          } catch {
            /* raw 本来就是纯文本 */
          }
          failure = message || "codex turn failed";
        }
      }

      let reply = readTextSafe(replyPath);
      if (!reply.trim()) reply = lastMessage;

      resolve({
        threadId: resolvedThreadId,
        reply,
        usage,
        exitCode,
        failure,
        durationMs: Date.now() - started,
        stdout,
        stderr,
      });
    });

    child.stdin.on("error", () => {
      /* EPIPE：进程提前退出，close 会处理 */
    });
    child.stdin.write(prompt, UTF8);
    child.stdin.end();
  });
}

// ── 会话操作 ─────────────────────────────────────────────────────────

function findConversation(index, id) {
  return index.conversations.find((c) => c.id === id);
}

function summarize(text, max = 72) {
  const oneLine = String(text || "").replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine || "(未命名对话)";
}

/**
 * 老记录的 prompt 带着桥模板头（`# Bridge message …` / `## Role` / `## Rules`），
 * 直接截前 72 字只会显示模板。`## Request` 之后才是用户真正问的话。
 */
function deriveTitle(prompt) {
  const text = String(prompt || "");
  const marker = "## Request";
  const at = text.indexOf(marker);
  const body = at >= 0 ? text.slice(at + marker.length) : text;
  const cleaned = body
    .replace(/^[\s#>-]+/, "")
    .split(/\n##\s/)[0]
    .trim();
  return summarize(cleaned);
}

function turnFiles(root, turnId) {
  return {
    prompt: path.join(root, "outbox", `${turnId}.prompt.md`),
    reply: path.join(root, "inbox", `${turnId}.reply.md`),
    meta: path.join(root, "inbox", `${turnId}.json`),
    stdout: path.join(root, "logs", `${turnId}.stdout.jsonl`),
    stderr: path.join(root, "logs", `${turnId}.stderr.log`),
  };
}

/**
 * 发一轮对话。conversationId 为空则新建会话；否则续接该会话的 Codex thread。
 */
async function sendTurn(ctx, { workspace, conversationId, message, model, reasoning, threadId: explicitThread, signal }) {
  const root = bridgeRoot(workspace);
  ensureDirs(root);
  const codex = resolveCodex();
  if (!codex) throw new Error("找不到 codex 可执行文件；设置 DSH_CODEX_BRIDGE_CODEX 或把 codex 加进 PATH。");
  if (!message || !message.trim()) throw new Error("message 不能为空。");

  const index = readIndex(root);
  let conversation = conversationId ? findConversation(index, conversationId) : undefined;
  if (conversationId && !conversation) throw new Error(`找不到对话 ${conversationId}`);

  const turnId = newId("m");
  const files = turnFiles(root, turnId);
  fs.writeFileSync(files.prompt, message, UTF8);

  const effectiveModel = model || conversation?.model || DEFAULT_MODEL;
  const effectiveReasoning = reasoning || conversation?.reasoning || DEFAULT_REASONING;
  const effectiveThread = conversation?.threadId || explicitThread || "";

  fs.writeFileSync(
    files.meta,
    JSON.stringify(
      {
        id: turnId,
        conversationId: conversation?.id ?? "",
        state: "running",
        created_at: new Date().toISOString(),
        model: effectiveModel,
        reasoning: effectiveReasoning,
        resumeThreadId: effectiveThread,
      },
      null,
      2,
    ),
    UTF8,
  );

  let result;
  try {
    result = await runCodex({
      codex,
      workspace,
      threadId: effectiveThread,
      prompt: message,
      model: effectiveModel,
      reasoning: effectiveReasoning,
      replyPath: files.reply,
      persist: true,
      signal,
    });
  } catch (error) {
    fs.writeFileSync(
      files.meta,
      JSON.stringify(
        {
          id: turnId,
          conversationId: conversation?.id ?? "",
          state: "failed",
          created_at: new Date().toISOString(),
          error: String(error?.message ?? error),
        },
        null,
        2,
      ),
      UTF8,
    );
    throw error;
  }

  fs.writeFileSync(files.stdout, result.stdout, UTF8);
  fs.writeFileSync(files.stderr, result.stderr, UTF8);

  // 空回复等于这一轮失败（模型不支持该参数、额度不足、网络中断等），
  // 把原因写下来并在索引里留痕，避免侧栏出现「看起来成功但是空的」记录。
  const failed = !result.reply.trim();
  const failureReason = result.failure || `codex 退出码 ${result.exitCode}，没有产生回复`;
  if (failed) fs.writeFileSync(files.reply, `(无回复) ${failureReason}`, UTF8);

  // Codex 实际用的模型只有它自己的 rollout 里才有；请求参数没传时这里是唯一来源。
  const actual = readActualModel(result.threadId || conversation?.threadId || "");
  const actualModel = actual?.model || "";
  const actualEffort = actual?.effort || "";

  if (!conversation) {
    conversation = {
      id: newId("c"),
      title: summarize(message),
      threadId: result.threadId || "",
      model: effectiveModel,
      reasoning: effectiveReasoning,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      turns: [],
    };
    index.conversations.unshift(conversation);
  }

  if (result.threadId) conversation.threadId = result.threadId;
  // 会话级记忆记的是「最近一次实际用的」，这样下次续接能沿用最后一次的选择。
  if (actualModel) conversation.model = actualModel;
  if (actualEffort) conversation.reasoning = actualEffort;
  conversation.updatedAt = Date.now();
  conversation.turns.push({
    id: turnId,
    at: Date.now(),
    promptFile: path.relative(root, files.prompt),
    replyFile: path.relative(root, files.reply),
    metaFile: path.relative(root, files.meta),
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    failed,
  });
  writeIndex(root, index);

  const meta = {
    id: turnId,
    conversationId: conversation.id,
    state: failed ? "failed" : "done",
    created_at: new Date().toISOString(),
    model: effectiveModel,
    reasoning: effectiveReasoning,
    actualModel,
    actualEffort,
    threadId: conversation.threadId,
    exit_code: result.exitCode,
    duration_s: Math.round(result.durationMs / 100) / 10,
    usage: result.usage,
    error: failed ? failureReason : undefined,
  };
  fs.writeFileSync(files.meta, JSON.stringify(meta, null, 2), UTF8);

  if (failed) throw new Error(`Codex 没有产生回复：${failureReason}`);

  return { conversation, turn: { id: turnId, ...meta }, reply: result.reply };
}

// ── HTTP 路由（给 Client 半边读） ────────────────────────────────────

/** 路由改用 Node 原生 handler（resource 路由只放行 GET/HEAD，收不了 POST）。 */

function listPayload(workspace) {
  const root = bridgeRoot(workspace);
  const index = readIndex(root);

  const knownTurnIds = new Set();
  for (const c of index.conversations) {
    for (const turn of c.turns || []) knownTurnIds.add(turn.id);
  }

  const conversations = index.conversations
    .slice()
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .map((c) => ({
      id: c.id,
      title: c.title,
      threadId: c.threadId || "",
      model: c.model || "",
      reasoning: c.reasoning || "",
      createdAt: c.createdAt || 0,
      updatedAt: c.updatedAt || 0,
      turnCount: (c.turns || []).length,
      lastTurnAt: (c.turns || []).at?.(-1)?.at ?? c.updatedAt ?? 0,
      legacy: false,
    }));

  // 老格式记录（索引里没有的那些）各自作为一段单轮会话列出。
  for (const turn of scanLegacyTurns(root, knownTurnIds)) {
    conversations.push({
      id: turn.id,
      title: deriveTitle(turn.prompt),
      threadId: turn.threadId,
      model: turn.model,
      reasoning: String(turn.meta?.reasoning || ""),
      createdAt: turn.at,
      updatedAt: turn.at,
      turnCount: 1,
      lastTurnAt: turn.at,
      legacy: true,
    });
  }

  conversations.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return {
    workspace,
    bridgeRoot: root,
    codex: resolveCodex(),
    defaults: {
      model: DEFAULT_MODEL,
      reasoning: DEFAULT_REASONING,
      isolated: ISOLATED,
      timeoutSec: TIMEOUT_SEC,
    },
    conversations,
  };
}

function readPayload(workspace, conversationId) {
  const root = bridgeRoot(workspace);
  const index = readIndex(root);
  const conversation = findConversation(index, conversationId);

  if (!conversation) {
    // 老格式：直接按 id 找那一轮的 prompt / reply。
    const turn = scanLegacyTurns(root, new Set()).find((t) => t.id === conversationId);
    if (!turn) return null;
    const knownReplies = new Set([String(turn.reply || "").trim()].filter(Boolean));
    return {
      id: turn.id,
      title: deriveTitle(turn.prompt),
      threadId: turn.threadId,
      model: turn.model,
      createdAt: turn.at,
      updatedAt: turn.at,
      legacy: true,
      turns: [
        {
          id: turn.id,
          at: turn.at,
          exitCode: turn.meta?.exit_code ?? null,
          durationMs: (turn.meta?.duration_s ?? 0) * 1000,
          prompt: turn.prompt,
          reply: turn.reply,
          meta: turn.meta,
        },
      ],
      codexTimeline: buildCodexTimeline(turn.threadId, knownReplies),
    };
  }

  const turns = (conversation.turns || []).map((turn) => ({
    id: turn.id,
    at: turn.at,
    exitCode: turn.exitCode,
    durationMs: turn.durationMs,
    prompt: readTextSafe(path.join(root, turn.promptFile)),
    reply: readTextSafe(path.join(root, turn.replyFile)),
    meta: readJsonSafe(path.join(root, turn.metaFile)),
  }));
  const knownReplies = new Set(
    turns.map((turn) => String(turn.reply || "").trim()).filter(Boolean),
  );
  return {
    id: conversation.id,
    title: conversation.title,
    threadId: conversation.threadId || "",
    model: conversation.model || "",
    createdAt: conversation.createdAt || 0,
    updatedAt: conversation.updatedAt || 0,
    legacy: false,
    turns,
    codexTimeline: buildCodexTimeline(conversation.threadId, knownReplies),
  };
}

function makeHandler(ctx, resolveWorkspace) {
  return async (req, res) => {
    const send = (status, value) => {
      try {
        const body = JSON.stringify(value);
        res.writeHead(status, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
          "content-length": Buffer.byteLength(body),
        });
        res.end(body);
      } catch (error) {
        try {
          res.destroy();
        } catch {
          /* 连接已断 */
        }
        console.error(`[codex-bridge] 响应失败: ${String(error)}`);
      }
    };

    let url;
    try {
      url = new URL(req.url || "/", "http://localhost");
    } catch {
      send(400, { error: "bad url" });
      return;
    }
    const workspace = resolveWorkspace();
    const rest = (url.pathname || "").slice(ROUTE_PREFIX.length).replace(/^\/+/, "");

    try {
      // POST /api/codex-bridge/send   —— 发一轮真实对话（会消耗 Codex 额度）
      // POST /api/codex-bridge/promote —— 把某段会话标记成 Codex App 可见（按需触发，改完需重启 App）
      if (req.method === "POST") {
        if (rest !== "send" && rest !== "promote") {
          send(404, { error: "not found" });
          return;
        }

        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        let body = {};
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") || {};
        } catch {
          body = {};
        }

        if (rest === "promote") {
          const conversationId = String(body?.conversationId || "");
          const threadId = String(body?.threadId || "");
          let targetThread = threadId;
          if (!targetThread && conversationId) {
            const index = readIndex(root);
            const found = findConversation(index, conversationId);
            targetThread = found?.threadId || "";
          }
          if (!targetThread) {
            send(400, { error: "找不到该对话的 Codex thread" });
            return;
          }
          const ok = await promoteThreadForApp(targetThread);
          send(200, { ok, threadId: targetThread });
          return;
        }

        const result = await sendTurn(undefined, {
          workspace,
          conversationId: String(body?.conversationId || ""),
          threadId: String(body?.threadId || ""),
          message: String(body?.message || ""),
          model: String(body?.model || ""),
          reasoning: String(body?.reasoning || ""),
        });
        send(200, {
          conversationId: result.conversation.id,
          threadId: result.conversation.threadId || "",
          reply: result.reply,
        });
        return;
      }

      if (req.method !== "GET" && req.method !== "HEAD") {
        send(405, { error: "method not allowed" });
        return;
      }

      if (rest === "" || rest === "list") {
        send(200, listPayload(workspace));
        return;
      }
      if (rest === "models") {
        send(200, { models: listModels(resolveCodex()) });
        return;
      }
      if (rest === "status") {
        send(200, {
          workspace,
          bridgeRoot: bridgeRoot(workspace),
          codex: resolveCodex(),
          model: DEFAULT_MODEL,
          reasoning: DEFAULT_REASONING,
          isolated: ISOLATED,
          timeoutSec: TIMEOUT_SEC,
        });
        return;
      }
      if (rest === "read") {
        const id = url.searchParams.get("id") || "";
        const payload = readPayload(workspace, id);
        if (!payload) {
          send(404, { error: `找不到对话 ${id}` });
          return;
        }
        send(200, payload);
        return;
      }
      send(404, { error: "not found" });
    } catch (error) {
      send(500, { error: String(error?.message ?? error) });
    }
  };
}

// ── 插件入口 ─────────────────────────────────────────────────────────

/** 由 apply 填充，供工具执行使用。 */
let runtime = null;

/**
 * DSH 0.2.2 起部分核心服务（webServer / tools）可能晚于插件就绪，
 * `apply` 时 ctx.get() 拿到 undefined 就再也等不到了。这里短轮询等它出现。
 * 返回一个清理函数：取消轮询并释放已建立的注册。
 */
function whenService(ctx, name, attempts, onReady) {
  let cancelled = false;
  let dispose = null;

  const attempt = (remaining) => {
    if (cancelled) return;
    let service;
    try {
      service = ctx.get(name);
    } catch {
      service = undefined;
    }

    if (service !== undefined && service !== null) {
      try {
        const result = onReady(service);
        dispose = typeof result === "function" ? result : null;
      } catch (error) {
        console.error(`[codex-bridge] 注册 ${name} 失败: ${String(error)}`);
      }
      return;
    }

    if (remaining > 0) {
      setTimeout(() => attempt(remaining - 1), 250);
    } else {
      console.warn(`[codex-bridge] 服务 ${name} 始终不可用`);
    }
  };

  attempt(attempts);

  return () => {
    cancelled = true;
    if (typeof dispose === "function") {
      try {
        dispose();
      } catch {
        /* 已释放 */
      }
    }
  };
}

export function apply(ctx) {
  const state = {
    getWorkspace: () => resolveWorkspace(ctx),
    running: new Map(),
  };
  runtime = state;

  ctx.effect(() => {
    const root = bridgeRoot(state.getWorkspace());
    try {
      ensureDirs(root);
    } catch (error) {
      console.error(`[codex-bridge] 无法创建 ${root}: ${String(error)}`);
    }

    return whenService(ctx, "webServer", 40, (webServer) =>
      webServer.register({
        kind: "prefix",
        path: ROUTE_PREFIX,
        handler: makeHandler(ctx, () => state.getWorkspace()),
      }),
    );
  }, "codex-bridge: http route");

  // ── 工具：把 GPT 当子代理调用 ──────────────────────────────────────
  ctx.effect(() => {
    return whenService(ctx, "tools", 40, (tools) =>
      tools.register({
      name: "codex_gpt",
      description:
        "把任务交给本机 Codex（GPT）执行，并返回它的回复。同一个 conversationId 再次调用即为多轮续接（同一个 Codex 会话），" +
        "适合与 GPT 做内部协作与复核。省略 conversationId 时新开一个会话。会话默认落进 Codex 会话库，可在 Codex 软件内继续查看。",
      parameters: {
        type: "object",
        properties: {
          message: { type: "string", description: "要发给 GPT 的内容。" },
          conversationId: {
            type: "string",
            description: "续接已有会话的 id；省略则新建。id 来自上一次调用的返回，或侧栏里看到的记录 id。",
          },
          threadId: {
            type: "string",
            description:
              "可选：直接续接一个 Codex thread（例如侧栏里旧记录上显示的 #短码对应的完整 id）。与 conversationId 二选一。",
          },
          model: {
            type: "string",
            description:
              "可选，模型 slug，例如 gpt-6.1-sol。不传则用 Codex 配置里的默认模型；可用值来自 codex debug models。",
          },
          reasoning: {
            type: "string",
            description:
              "可选，推理深度。不同模型支持的值不同（gpt-6-sol 支持 none/low/medium/high/xhigh/max），不传则用 Codex 默认。",
          },
        },
        required: ["message"],
      },
      output: {
        schema: {
          type: "object",
          properties: {
            conversationId: { type: "string" },
            threadId: { type: "string" },
            reply: { type: "string" },
          },
          required: ["conversationId", "reply"],
        },
        render(_args, value) {
          return [{ type: "text", text: String(value?.reply ?? "") }];
        },
      },
      async execute(args, exec) {
        const input = args && typeof args === "object" ? args : {};
        const result = await sendTurn(ctx, {
          workspace: state.getWorkspace(),
          conversationId: String(input.conversationId || ""),
          threadId: String(input.threadId || ""),
          message: String(input.message || ""),
          model: String(input.model || ""),
          reasoning: String(input.reasoning || ""),
          signal: exec?.signal,
        });
        return {
          conversationId: result.conversation.id,
          threadId: result.conversation.threadId || "",
          reply: result.reply,
        };
      },
      }),
    );
  }, "codex-bridge: codex_gpt tool");

  return { workspace: state.getWorkspace() };
}

export default { apply };
