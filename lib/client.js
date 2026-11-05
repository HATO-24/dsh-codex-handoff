/**
 * GPT / Codex 对话桥 —— Client 半边。
 *
 * 两个入口：
 *  1. `sidebar.panellist` + `main`  侧栏面板（整页查看）
 *  2. `conversation.session.header.utilities` 按钮 + `shell.overlay` 右侧抽屉（贴着对话看）
 *
 * 数据全部来自 Host 半边的 /api/codex-bridge/*。
 */
window.__ModuleLoader__.load({
  id: "dsh-codex-bridge",
  factory(require) {
    const React = require("react");
    const h = React.createElement;
    const { useState, useEffect, useCallback, useMemo, useRef } = React;

    const ROUTE = "/api/codex-bridge";
    const DRAWER_WIDTH = 430;

    // ── 抽屉开关：模块级小 store，按钮与抽屉共享 ──────────────────────
    const drawerStore = { open: false, listeners: new Set() };
    function setDrawerOpen(open) {
      if (drawerStore.open === open) return;
      drawerStore.open = open;
      for (const listener of drawerStore.listeners) {
        try {
          listener(open);
        } catch {
          /* 单个订阅者出错不影响其他 */
        }
      }
    }
    function useDrawerOpen() {
      const [open, setOpen] = useState(drawerStore.open);
      useEffect(() => {
        const listener = (value) => setOpen(value);
        drawerStore.listeners.add(listener);
        return () => drawerStore.listeners.delete(listener);
      }, []);
      return open;
    }

    // ── 样式 ─────────────────────────────────────────────────────────
    const colors = {
      bg: "var(--dsw-alias-bg, #16181d)",
      panel: "var(--dsw-alias-surface, rgba(127,127,127,.06))",
      border: "var(--dsw-alias-border, rgba(127,127,127,.24))",
      accent: "var(--dsw-alias-accent, #4f8ef7)",
      text: "var(--dsw-alias-text, #e6edf3)",
      code: "var(--dsw-alias-code-bg, rgba(127,127,127,.10))",
    };

    const styles = {
      root: {
        display: "flex",
        flexDirection: "column",
        height: "100%",
        minHeight: 0,
        background: colors.bg,
        color: colors.text,
        fontFamily: "inherit",
      },
      head: {
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 8,
        padding: "12px 16px",
        borderBottom: `1px solid ${colors.border}`,
        flex: "0 0 auto",
      },
      headTitle: { fontSize: 14, fontWeight: 600, margin: 0, lineHeight: 1.3 },
      headSub: { fontSize: 11, opacity: 0.6, marginTop: 2 },
      headActions: { display: "flex", alignItems: "center", gap: 6 },
      btn: {
        appearance: "none",
        border: `1px solid ${colors.border}`,
        background: "transparent",
        color: "inherit",
        borderRadius: 6,
        padding: "4px 10px",
        fontSize: 12,
        lineHeight: "18px",
        cursor: "pointer",
        fontFamily: "inherit",
      },
      iconBtn: {
        appearance: "none",
        border: "none",
        background: "transparent",
        color: "inherit",
        cursor: "pointer",
        display: "grid",
        placeItems: "center",
        width: 28,
        height: 28,
        borderRadius: 6,
        opacity: 0.75,
        padding: 0,
      },
      body: { flex: "1 1 auto", overflowY: "auto", padding: 12 },
      list: { display: "flex", flexDirection: "column", gap: 8 },
      card: {
        border: `1px solid ${colors.border}`,
        borderRadius: 8,
        padding: "9px 11px",
        cursor: "pointer",
        background: colors.panel,
      },
      cardActive: {
        borderColor: colors.accent,
        boxShadow: `0 0 0 1px ${colors.accent} inset`,
      },
      cardTitle: { fontSize: 12.5, fontWeight: 600, lineHeight: 1.5, wordBreak: "break-word" },
      meta: {
        fontSize: 10.5,
        opacity: 0.62,
        marginTop: 4,
        display: "flex",
        flexWrap: "wrap",
        gap: 8,
      },
      empty: { fontSize: 12, opacity: 0.6, lineHeight: 1.75, padding: "8px 4px" },
      turn: {
        borderTop: `1px dashed ${colors.border}`,
        paddingTop: 10,
        marginTop: 10,
      },
      label: { fontSize: 10.5, fontWeight: 600, opacity: 0.7, marginBottom: 4 },
      rowBetween: {
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 8,
      },
      pre: {
        margin: 0,
        padding: "8px 10px",
        borderRadius: 6,
        background: colors.code,
        fontSize: 11.5,
        lineHeight: 1.7,
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
        maxHeight: 320,
        overflowY: "auto",
        fontFamily: "inherit",
      },
      error: { color: "#d06a5a", fontSize: 12, padding: "8px 4px", lineHeight: 1.7 },
      /* 底部发送区 */
      composer: {
        flex: "0 0 auto",
        borderTop: `1px solid ${colors.border}`,
        padding: "8px 12px 10px",
        display: "flex",
        flexDirection: "column",
        gap: 6,
        background: colors.bg,
      },
      textarea: {
        width: "100%",
        boxSizing: "border-box",
        resize: "none",
        border: `1px solid ${colors.border}`,
        borderRadius: 6,
        background: colors.code,
        color: "inherit",
        fontFamily: "inherit",
        fontSize: 12,
        lineHeight: 1.6,
        padding: "6px 8px",
        outline: "none",
      },
      composerRow: { display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" },
      select: {
        appearance: "auto",
        border: `1px solid ${colors.border}`,
        borderRadius: 6,
        background: colors.bg,
        color: colors.text,
        /* 让原生下拉（option 列表）跟随主题，而不是系统默认的白底 */
        colorScheme: "light dark",
        fontFamily: "inherit",
        fontSize: 11,
        padding: "3px 4px",
        maxWidth: 150,
        cursor: "pointer",
      },
      option: {
        background: colors.bg,
        color: colors.text,
      },
      /* 自绘下拉：原生 select 的弹层由系统绘制，深色模式下不受主题控制，也截不到图。 */
      dropdown: { position: "relative" },
      dropdownBtn: {
        display: "flex",
        alignItems: "center",
        gap: 5,
        border: `1px solid ${colors.border}`,
        borderRadius: 6,
        background: colors.code,
        color: colors.text,
        fontFamily: "inherit",
        fontSize: 11,
        lineHeight: "16px",
        padding: "3px 7px",
        cursor: "pointer",
        maxWidth: 160,
        whiteSpace: "nowrap",
      },
      dropdownMenu: {
        position: "absolute",
        bottom: "100%",
        left: 0,
        marginBottom: 4,
        minWidth: "100%",
        maxHeight: 240,
        overflowY: "auto",
        background: colors.bg,
        border: `1px solid ${colors.border}`,
        borderRadius: 6,
        boxShadow: "0 10px 28px rgba(0,0,0,.45)",
        zIndex: 1000,
        padding: 4,
      },
      dropdownItem: {
        padding: "4px 9px",
        borderRadius: 4,
        fontSize: 11.5,
        lineHeight: "17px",
        cursor: "pointer",
        whiteSpace: "nowrap",
        color: colors.text,
      },
      dropdownItemActive: {
        background: colors.code,
        color: colors.accent,
        fontWeight: 600,
      },
      sendBtn: {
        appearance: "none",
        border: "none",
        borderRadius: 6,
        background: colors.accent,
        color: "#fff",
        fontFamily: "inherit",
        fontSize: 12,
        fontWeight: 600,
        padding: "5px 14px",
        cursor: "pointer",
        marginLeft: "auto",
      },
      composerHint: { fontSize: 10.5, opacity: 0.55 },
      /* 抽屉：顶部必须避开窗口控制按钮（− □ ×）——那片区域在页面之上，提高 z-index 也盖不过去。 */
      drawer: {
        position: "fixed",
        top: 48,
        right: 0,
        bottom: 0,
        width: DRAWER_WIDTH,
        maxWidth: "92vw",
        display: "flex",
        flexDirection: "column",
        pointerEvents: "auto",
        background: colors.bg,
        borderLeft: `1px solid ${colors.border}`,
        borderTopLeftRadius: 8,
        boxShadow: "-18px 0 40px rgba(0,0,0,.28)",
        zIndex: 900,
        color: colors.text,
        fontFamily: "inherit",
      },
    };

    function formatTime(ms) {
      if (!ms) return "";
      const d = new Date(ms);
      const p = (n) => String(n).padStart(2, "0");
      return `${d.getMonth() + 1}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
    }

    /** 头部副标题里展示当前默认配置（来自 Host 的 /list defaults）。 */
    function defaultsLabel(defaults) {
      if (!defaults) return "";
      const parts = [defaults.model || "模型 Codex 默认"];
      parts.push(defaults.reasoning ? `推理 ${defaults.reasoning}` : "推理默认");
      if (defaults.isolated) parts.push("已隔离");
      return ` · ${parts.join(" / ")}`;
    }

    async function getJson(url) {
      const response = await fetch(url, { headers: { accept: "application/json" } });
      if (!response.ok) {
        let detail = "";
        try {
          const body = await response.json();
          detail = body?.error || "";
        } catch {
          /* 非 JSON 错误体 */
        }
        throw new Error(detail || `HTTP ${response.status}`);
      }
      return response.json();
    }

    // ── 数据 ─────────────────────────────────────────────────────────
    function useConversationList(intervalMs) {
      const [data, setData] = useState(null);
      const [error, setError] = useState("");
      const load = useCallback(async () => {
        try {
          const payload = await getJson(`${ROUTE}/list`);
          setData(payload);
          setError("");
        } catch (err) {
          setError(`读取对话记录失败：${String(err?.message ?? err)}`);
        }
      }, []);
      useEffect(() => {
        void load();
        if (!intervalMs) return undefined;
        const timer = setInterval(() => void load(), intervalMs);
        return () => clearInterval(timer);
      }, [load, intervalMs]);
      return { data, error, reload: load };
    }

    function useConversationDetail(selected) {
      const [detail, setDetail] = useState(null);
      const [error, setError] = useState("");
      const [loading, setLoading] = useState(false);
      useEffect(() => {
        if (!selected) {
          setDetail(null);
          setError("");
          return undefined;
        }
        let cancelled = false;
        setLoading(true);
        setError("");
        getJson(`${ROUTE}/read?id=${encodeURIComponent(selected)}`)
          .then((payload) => {
            if (!cancelled) setDetail(payload);
          })
          .catch((err) => {
            if (!cancelled) setError(`读取该对话失败：${String(err?.message ?? err)}`);
          })
          .finally(() => {
            if (!cancelled) setLoading(false);
          });
        return () => {
          cancelled = true;
        };
      }, [selected]);
      return { detail, error, loading };
    }

    // ── 展示件 ───────────────────────────────────────────────────────
    function TurnBlock({ turn, index }) {
      const meta = turn.meta || {};
      const usage = meta.usage;
      return h(
        "div",
        { style: styles.turn },
        h(
          "div",
          { style: styles.rowBetween },
          h("div", { style: styles.label }, `第 ${index + 1} 轮 · ${formatTime(turn.at)}`),
          h(
            "div",
            { style: styles.meta },
            (meta.actualModel || meta.model) ? h("span", null, meta.actualModel || meta.model) : null,
            (meta.actualEffort || meta.reasoning)
              ? h("span", null, `推理 ${meta.actualEffort || meta.reasoning}`)
              : null,
            usage
              ? h(
                  "span",
                  { title: `input ${usage.input_tokens} / cached ${usage.cached_input_tokens ?? 0}` },
                  `${Math.round((usage.input_tokens || 0) / 1000)}k in`,
                )
              : null,
          ),
        ),
        h("div", { style: styles.label }, "提问"),
        h("pre", { style: styles.pre }, turn.prompt || "(空)"),
        h("div", { style: { ...styles.label, marginTop: 8 } }, "GPT 回复"),
        h("pre", { style: styles.pre }, turn.reply || "(空)"),
      );
    }

    /**
     * Codex 会话库回读：rollout 里可能包含用户在 Codex 软件里继续的轮次，
     * 那些不在桥的记录里，标成「Codex 侧新增」。
     */
    function CodexTimeline({ timeline }) {
      const [expanded, setExpanded] = useState(false);
      const messages = timeline?.messages ?? [];
      if (messages.length === 0) return null;
      const COLLAPSED = 3;
      const shown = expanded ? messages : messages.slice(-COLLAPSED);
      const externalCount = messages.filter((m) => m.external).length;

      return h(
        "div",
        {
          style: {
            marginTop: 12,
            borderTop: `1px dashed ${colors.border}`,
            paddingTop: 10,
          },
        },
        h(
          "div",
          { style: styles.rowBetween },
          h(
            "div",
            { style: styles.label },
            `Codex 会话原文 · ${messages.length} 条`,
            externalCount > 0 ? `（${externalCount} 条 Codex 侧新增）` : "",
          ),
          messages.length > COLLAPSED
            ? h(
                "button",
                { type: "button", style: styles.btn, onClick: () => setExpanded(!expanded) },
                expanded ? "收起" : "展开全部",
              )
            : null,
        ),
        shown.map((message, index) =>
          h(
            "div",
            { key: index, style: { marginTop: 8 } },
            h(
              "div",
              {
                style: {
                  ...styles.label,
                  color: message.external ? colors.accent : undefined,
                },
              },
              message.role === "user" ? "用户" : "GPT",
              message.external ? " · Codex 侧新增" : "",
            ),
            h("pre", { style: styles.pre }, message.text || "(空)"),
          ),
        ),
      );
    }

    const FALLBACK_EFFORTS = ["none", "low", "medium", "high", "xhigh"];

    /**
     * 自绘下拉。原生 <select> 的弹层由系统绘制，深色模式下不受 DSH 主题控制
     * （Windows 上会变成白底），所以这里自己画一个，token 一改就跟着变。
     */
    function Dropdown({ value, options, onChange, disabled, title, width }) {
      const [open, setOpen] = useState(false);
      const rootRef = useRef(null);

      useEffect(() => {
        if (!open) return undefined;
        const onPointerDown = (event) => {
          if (rootRef.current && !rootRef.current.contains(event.target)) setOpen(false);
        };
        const onKeyDown = (event) => {
          if (event.key === "Escape") setOpen(false);
        };
        document.addEventListener("mousedown", onPointerDown);
        document.addEventListener("keydown", onKeyDown);
        return () => {
          document.removeEventListener("mousedown", onPointerDown);
          document.removeEventListener("keydown", onKeyDown);
        };
      }, [open]);

      const current = options.find((item) => item.value === value) || options[0];

      return h(
        "div",
        { ref: rootRef, style: { ...styles.dropdown, width } },
        h(
          "button",
          {
            type: "button",
            style: { ...styles.dropdownBtn, opacity: disabled ? 0.55 : 1 },
            disabled,
            title,
            "aria-haspopup": "listbox",
            "aria-expanded": open,
            onClick: () => setOpen(!open),
          },
          h(
            "span",
            { style: { overflow: "hidden", textOverflow: "ellipsis" } },
            current ? current.label : "",
          ),
          h("span", { style: { opacity: 0.6, fontSize: 9 } }, "▾"),
        ),
        open
          ? h(
              "div",
              { style: styles.dropdownMenu, role: "listbox" },
              options.map((item) =>
                h(
                  "div",
                  {
                    key: item.value || "__default__",
                    role: "option",
                    "aria-selected": item.value === value,
                    style: {
                      ...styles.dropdownItem,
                      ...(item.value === value ? styles.dropdownItemActive : null),
                    },
                    onClick: () => {
                      onChange(item.value);
                      setOpen(false);
                    },
                  },
                  item.label,
                ),
              ),
            )
          : null,
      );
    }

    /**
     * 底部发送区：直接在这里给 GPT 发消息，并选择模型与推理强度。
     * conversationId 有值时续接那个 Codex 会话，否则新开一段。
     */
    function Composer({ conversation, onSent }) {
      const conversationId = conversation?.id || "";
      const [message, setMessage] = useState("");
      const [model, setModel] = useState(conversation?.model || "");
      const [effort, setEffort] = useState(conversation?.reasoning || "");
      const [models, setModels] = useState([]);
      const [sending, setSending] = useState(false);
      const [error, setError] = useState("");

      // 会话级记忆：切换（或首次选中）会话时，下拉回填该会话上次用的模型与推理强度。
      useEffect(() => {
        setModel(conversation?.model || "");
        setEffort(conversation?.reasoning || "");
        // 只跟随会话切换；发送后列表刷新不应覆盖用户当前选择。
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [conversationId]);

      useEffect(() => {
        let cancelled = false;
        getJson(`${ROUTE}/models`)
          .then((data) => {
            if (!cancelled) setModels(Array.isArray(data?.models) ? data.models : []);
          })
          .catch(() => {
            /* 模型目录拿不到就只留「默认」 */
          });
        return () => {
          cancelled = true;
        };
      }, []);

      const selectedModel = models.find((item) => item.slug === model);
      const efforts =
        selectedModel && selectedModel.reasoningLevels && selectedModel.reasoningLevels.length > 0
          ? selectedModel.reasoningLevels
          : FALLBACK_EFFORTS;

      async function submit() {
        const text = message.trim();
        if (!text || sending) return;
        setSending(true);
        setError("");
        try {
          const response = await fetch(`${ROUTE}/send`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              message: text,
              conversationId: conversationId || undefined,
              model: model || undefined,
              reasoning: effort || undefined,
            }),
          });
          let body = null;
          try {
            body = await response.json();
          } catch {
            body = null;
          }
          if (!response.ok) throw new Error(body?.error || `HTTP ${response.status}`);
          setMessage("");
          if (onSent) onSent(body);
        } catch (err) {
          setError(`发送失败：${String(err?.message ?? err)}`);
        } finally {
          setSending(false);
        }
      }

      const modelOptions = useMemo(
        () => [
          { value: "", label: "模型 · 默认" },
          ...models.map((item) => ({ value: item.slug, label: item.displayName || item.slug })),
        ],
        [models],
      );
      const effortOptions = useMemo(
        () => [
          { value: "", label: "推理 · 默认" },
          ...efforts.map((level) => ({ value: level, label: level })),
        ],
        [efforts],
      );

      return h(
        "div",
        { style: styles.composer },
        h("textarea", {
          style: styles.textarea,
          rows: 2,
          placeholder: conversationId ? "续接选中的 Codex 会话…" : "新开一段对话发给 GPT…",
          value: message,
          disabled: sending,
          onChange: (event) => setMessage(event.target.value),
          onKeyDown: (event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void submit();
            }
          },
        }),
        error ? h("div", { style: styles.error }, error) : null,
        h(
          "div",
          { style: styles.composerRow },
          h(Dropdown, {
            value: model,
            options: modelOptions,
            onChange: (next) => {
              setModel(next);
              setEffort("");
            },
            disabled: sending,
            title: "模型",
            width: 132,
          }),
          h(Dropdown, {
            value: effort,
            options: effortOptions,
            onChange: setEffort,
            disabled: sending,
            title: "推理强度",
            width: 98,
          }),
          h(
            "button",
            {
              type: "button",
              style: {
                ...styles.sendBtn,
                opacity: sending || !message.trim() ? 0.55 : 1,
                cursor: sending || !message.trim() ? "default" : "pointer",
              },
              disabled: sending || !message.trim(),
              onClick: () => void submit(),
            },
            sending ? "发送中…" : "发送",
          ),
        ),
        h("div", { style: styles.composerHint }, "Enter 发送 · Shift+Enter 换行 · 会消耗 Codex 额度"),
      );
    }

    function ConversationList({ conversations, selected, onSelect, detail, detailError, detailLoading }) {
      return h(
        "div",
        { style: styles.list },
        conversations.map((item) =>
          h(
            "div",
            {
              key: item.id,
              style: { ...styles.card, ...(item.id === selected ? styles.cardActive : null) },
              onClick: () => onSelect(item.id === selected ? "" : item.id),
              role: "button",
              tabIndex: 0,
              onKeyDown: (event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onSelect(item.id === selected ? "" : item.id);
                }
              },
            },
            h("div", { style: styles.cardTitle }, item.title),
            h(
              "div",
              { style: styles.meta },
              h("span", null, formatTime(item.updatedAt)),
              h("span", null, `${item.turnCount} 轮`),
              item.model ? h("span", null, item.model) : null,
              item.reasoning ? h("span", null, `推理 ${item.reasoning}`) : null,
              item.threadId ? h("span", null, `#${item.threadId.slice(0, 6)}`) : null,
              item.legacy ? h("span", null, "旧记录") : null,
            ),
            item.id === selected
              ? h(
                  "div",
                  null,
                  detailLoading ? h("div", { style: styles.empty }, "载入中…") : null,
                  detailError ? h("div", { style: styles.error }, detailError) : null,
                  detail
                    ? h(
                        "div",
                        null,
                        detail.threadId
                          ? h(
                              "div",
                              { style: { ...styles.meta, marginTop: 8 } },
                              h("span", null, `Codex 会话 ${detail.threadId}`),
                            )
                          : null,
                        (detail.turns || []).map((turn, index) =>
                          h(TurnBlock, { key: turn.id, turn, index }),
                        ),
                        h(CodexTimeline, { timeline: detail.codexTimeline }),
                      )
                    : null,
                )
              : null,
          ),
        ),
      );
    }

    function EmptyState({ hasList }) {
      if (!hasList) return h("div", { style: styles.empty }, "载入中…");
      return h(
        "div",
        { style: styles.empty },
        "还没有对话记录。",
        h("br"),
        "让 DSH agent 调用 codex_gpt 工具，或用 gpt_bridge.ps1 发一条消息，这里就会出现。",
      );
    }

    // ── 侧栏主面板 ───────────────────────────────────────────────────
    function BridgePanel() {
      const { data, error, reload } = useConversationList(15000);
      const [selected, setSelected] = useState("");
      const { detail, error: detailError, loading } = useConversationDetail(selected);
      const conversations = data?.conversations ?? [];
      const activeConversation = conversations.find((item) => item.id === selected) || null;

      return h(
        "div",
        { style: styles.root },
        h(
          "div",
          { style: styles.head },
          h(
            "div",
            null,
            h("h2", { style: styles.headTitle }, "GPT 对话"),
            h(
              "div",
              { style: styles.headSub },
              `Codex 桥 · ${conversations.length} 段会话${defaultsLabel(data?.defaults)}`,
            ),
          ),
          h("button", { type: "button", style: styles.btn, onClick: () => void reload() }, "刷新"),
        ),
        h(
          "div",
          { style: styles.body },
          error ? h("div", { style: styles.error }, error) : null,
          data && conversations.length === 0 ? h(EmptyState, { hasList: true }) : null,
          !data && !error ? h(EmptyState, { hasList: false }) : null,
          conversations.length > 0
            ? h(ConversationList, {
                conversations,
                selected,
                onSelect: setSelected,
                detail,
                detailError,
                detailLoading: loading,
              })
            : null,
        ),
        h(Composer, {
          conversation: activeConversation,
          onSent: (result) => {
            if (result && result.conversationId) setSelected(result.conversationId);
            void reload();
          },
        }),
      );
    }

    // ── 右侧抽屉 ─────────────────────────────────────────────────────
    function BridgeDrawer() {
      const open = useDrawerOpen();
      // 抽屉常驻挂载（关闭时只是隐藏），避免每次打开都重新拉数据、也方便保留展开状态。
      const { data, error, reload } = useConversationList(open ? 15000 : 0);
      const [selected, setSelected] = useState("");
      const { detail, error: detailError, loading } = useConversationDetail(selected);
      const conversations = data?.conversations ?? [];
      const activeConversation = conversations.find((item) => item.id === selected) || null;

      useEffect(() => {
        if (!open) return undefined;
        const onKey = (event) => {
          if (event.key === "Escape") setDrawerOpen(false);
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
      }, [open]);

      if (!open) return null;

      return h(
        "div",
        { style: styles.drawer, role: "dialog", "aria-label": "GPT 对话" },
        h(
          "div",
          { style: styles.head },
          h(
            "div",
            null,
            h("h2", { style: styles.headTitle }, "GPT 对话"),
            h(
              "div",
              { style: styles.headSub },
              `Codex 桥 · ${conversations.length} 段会话${defaultsLabel(data?.defaults)}`,
            ),
          ),
          h(
            "div",
            { style: styles.headActions },
            h("button", { type: "button", style: styles.btn, onClick: () => void reload() }, "刷新"),
            h(
              "button",
              {
                type: "button",
                style: styles.iconBtn,
                title: "关闭 (Esc)",
                "aria-label": "关闭",
                onClick: () => setDrawerOpen(false),
              },
              h(
                "svg",
                { viewBox: "0 0 16 16", width: 14, height: 14, fill: "none", "aria-hidden": true },
                h("path", {
                  d: "M4 4l8 8M12 4l-8 8",
                  stroke: "currentColor",
                  strokeWidth: 1.6,
                  strokeLinecap: "round",
                }),
              ),
            ),
          ),
        ),
        h(
          "div",
          { style: styles.body },
          error ? h("div", { style: styles.error }, error) : null,
          data && conversations.length === 0 ? h(EmptyState, { hasList: true }) : null,
          !data && !error ? h(EmptyState, { hasList: false }) : null,
          conversations.length > 0
            ? h(ConversationList, {
                conversations,
                selected,
                onSelect: setSelected,
                detail,
                detailError,
                detailLoading: loading,
              })
            : null,
        ),
        h(Composer, {
          conversation: activeConversation,
          onSent: (result) => {
            if (result && result.conversationId) setSelected(result.conversationId);
            void reload();
          },
        }),
      );
    }

    // ── 图标 ─────────────────────────────────────────────────────────
    function BridgeGlyph({ size = 18 }) {
      return h(
        "svg",
        { viewBox: "0 0 24 24", width: size, height: size, "aria-hidden": true, fill: "none" },
        h("path", {
          d: "M4 7.5A2.5 2.5 0 0 1 6.5 5h6A2.5 2.5 0 0 1 15 7.5v3A2.5 2.5 0 0 1 12.5 13H9l-3 2.4V13H6.5A2.5 2.5 0 0 1 4 10.5v-3Z",
          stroke: "currentColor",
          strokeWidth: 1.6,
          strokeLinejoin: "round",
        }),
        h("path", {
          d: "M13 15.5A2.5 2.5 0 0 1 15.5 13h2A2.5 2.5 0 0 1 20 15.5v2A2.5 2.5 0 0 1 17.5 20H17v2l-2.4-2H15.5A2.5 2.5 0 0 1 13 17.5v-2Z",
          stroke: "currentColor",
          strokeWidth: 1.6,
          strokeLinejoin: "round",
        }),
      );
    }

    /** 侧栏入口图标（receives { size, active }）。 */
    function BridgePanelIcon(props) {
      return h(BridgeGlyph, { size: props?.size ?? 18 });
    }

    /** 会话头部按钮：切换右侧抽屉。 */
    function BridgeToggle() {
      const open = useDrawerOpen();
      return h(
        "button",
        {
          type: "button",
          style: {
            appearance: "none",
            border: "none",
            background: open ? colors.panel : "transparent",
            color: "inherit",
            cursor: "pointer",
            display: "grid",
            placeItems: "center",
            width: 28,
            height: 28,
            borderRadius: 6,
            opacity: open ? 1 : 0.78,
            padding: 0,
          },
          title: open ? "关闭 GPT 对话" : "打开 GPT 对话",
          "aria-label": "GPT 对话",
          "aria-pressed": open,
          onClick: () => setDrawerOpen(!open),
        },
        h(BridgeGlyph, { size: 16 }),
      );
    }

    return {
      inject: ["slots"],
      apply(ctx) {
        // 1) 侧栏面板入口 + 主面板
        ctx.slots.inject("sidebar.panellist", () =>
          ctx.slots.register(
            { name: "sidebar.panellist", id: "codex-bridge", order: 30, label: "GPT 对话" },
            BridgePanelIcon,
          ),
        );
        ctx.slots.inject("main", () =>
          ctx.slots.register({ name: "main", key: "codex-bridge" }, BridgePanel),
        );

        // 2) 会话头部按钮 + 右侧抽屉
        ctx.slots.inject("conversation.session.header.utilities", () =>
          ctx.slots.register(
            { name: "conversation.session.header.utilities", id: "codex-bridge-toggle", order: 2 },
            BridgeToggle,
          ),
        );
        ctx.slots.inject("shell.overlay", () =>
          ctx.slots.register({ name: "shell.overlay", id: "codex-bridge.drawer", order: 40 }, BridgeDrawer),
        );
      },
    };
  },
});
