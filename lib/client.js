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
  id: "dsh-codex-handoff",
  factory(require) {
    const React = require("react");
    const h = React.createElement;
    const { useState, useEffect, useCallback, useMemo, useRef } = React;

    const ROUTE = "/api/codex-bridge";
    const DRAWER_WIDTH = 430;
    const DRAWER_WIDTH_KEY = "dsh-codex-handoff:drawer-width";
    /** 右侧栏 tab 的 id（也是 sidebar.right.pane.tab 的 key）。 */
    const TAB_ID = "dsh-codex-handoff";
    const TAB_RESOURCE = "dsh-resource://codex-bridge/main";

    /**
     * 打开入口：优先激活右侧栏 tab；宿主没有 sidebarRight 服务时退回抽屉。
     * apply 里会按实际情况覆盖。
     */
    const bridgeOpeners = {
      open: () => setDrawerOpen(true),
    };

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
    // 全部使用 DSH 的 alias token（cordis_inspect Theme.listTokens 列出的名字），
    // 这样明暗主题、用户换肤都会自动跟随，外观也和本体一致。
    const colors = {
      bg: "var(--dsw-alias-bg-base, #16181d)",
      panel: "var(--dsw-alias-bg-layer-1, rgba(127,127,127,.06))",
      layer2: "var(--dsw-alias-bg-layer-2, rgba(127,127,127,.10))",
      overlay: "var(--dsw-alias-bg-overlay, #1c1f26)",
      sidebar: "var(--dsw-specific-sidebar-fill, #16181d)",
      border: "var(--dsw-alias-border-l1, rgba(127,127,127,.24))",
      borderStrong: "var(--dsw-alias-border-l2, rgba(127,127,127,.36))",
      accent: "var(--dsw-alias-brand-primary, #4f8ef7)",
      text: "var(--dsw-alias-label-primary, #e6edf3)",
      textSecondary: "var(--dsw-alias-label-secondary, #9aa4b2)",
      idle: "var(--dsw-alias-state-idle-primary, #8b949e)",
      error: "var(--dsw-alias-state-error-primary, #d06a5a)",
      success: "var(--dsw-alias-state-success-primary, #3fb950)",
      warn: "var(--dsw-alias-state-warn-primary, #d29922)",
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
      content: {
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
        background: colors.panel,
      },
      cardHead: {
        position: "relative",
        cursor: "pointer",
        paddingRight: 16,
      },
      cardBody: { marginTop: 10 },
      chevron: {
        position: "absolute",
        right: 0,
        top: 0,
        fontSize: 10,
        opacity: 0.45,
        lineHeight: "18px",
      },
      threadRow: {
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 8,
        marginBottom: 2,
      },
      threadText: {
        fontSize: 10.5,
        color: colors.textSecondary,
        wordBreak: "break-all",
      },
      resizeHandle: {
        position: "absolute",
        left: -3,
        top: 0,
        bottom: 0,
        width: 7,
        cursor: "col-resize",
        zIndex: 2,
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
        paddingTop: 12,
        marginTop: 12,
      },
      label: { fontSize: 10.5, fontWeight: 600, opacity: 0.7, marginBottom: 4 },
      rowBetween: {
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 8,
      },
      turnHead: {
        display: "flex",
        alignItems: "center",
        gap: 6,
        flexWrap: "wrap",
        marginBottom: 8,
      },
      turnIndex: { fontSize: 11, fontWeight: 700, opacity: 0.5 },
      turnTime: { fontSize: 11, opacity: 0.5 },
      pill: {
        fontSize: 10,
        padding: "0 6px",
        lineHeight: "16px",
        borderRadius: 999,
        border: `1px solid ${colors.border}`,
        opacity: 0.85,
        whiteSpace: "nowrap",
      },
      pillMuted: { fontSize: 10, opacity: 0.45, whiteSpace: "nowrap" },
      messageAsk: {
        borderRadius: 8,
        background: colors.layer2,
        padding: "8px 10px",
        marginBottom: 8,
      },
      messageReply: {
        borderRadius: 8,
        border: `1px solid ${colors.border}`,
        padding: "8px 10px",
      },
      messageLabel: { fontSize: 10.5, fontWeight: 600, opacity: 0.6, marginBottom: 4 },
      messageText: {
        fontSize: 12,
        lineHeight: 1.8,
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
        fontFamily: "inherit",
      },
      linkBtn: {
        appearance: "none",
        border: "none",
        background: "transparent",
        color: colors.accent,
        fontSize: 11,
        padding: "4px 0",
        cursor: "pointer",
        fontFamily: "inherit",
      },
      externalBlock: {
        marginTop: 14,
        paddingTop: 12,
        borderTop: `1px dashed ${colors.border}`,
      },
      externalTitle: { fontSize: 11, fontWeight: 600, color: colors.accent },
      externalItem: { marginTop: 8 },
      pre: {
        /* 兜底：不再限制高度，内层滚动会截走滚轮，长文交给外层容器统一滚动 */
        margin: 0,
        padding: "8px 10px",
        borderRadius: 6,
        background: colors.layer2,
        fontSize: 11.5,
        lineHeight: 1.75,
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
        fontFamily: "inherit",
      },
      error: { color: colors.error, fontSize: 12, padding: "8px 4px", lineHeight: 1.7 },
      okNote: { color: colors.success, fontSize: 11, lineHeight: 1.6 },
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
        background: colors.layer2,
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
        background: colors.layer2,
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
        background: colors.layer2,
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
    const COLLAPSE_CHARS = 900;

    /** 一条消息正文：过长时默认收起。内层不滚动，滚轮交给外层容器统一处理。 */
    function MessageBody({ text }) {
      const [expanded, setExpanded] = useState(false);
      const value = String(text || "");
      const isLong = value.length > COLLAPSE_CHARS;
      const shown = expanded || !isLong ? value : `${value.slice(0, COLLAPSE_CHARS)}…`;

      return h(
        "div",
        null,
        h("div", { style: styles.messageText }, shown),
        isLong
          ? h(
              "button",
              {
                type: "button",
                style: styles.linkBtn,
                onClick: () => setExpanded(!expanded),
              },
              expanded ? "收起" : `展开全文（${value.length} 字）`,
            )
          : null,
      );
    }

    function TurnBlock({ turn, index }) {
      const meta = turn.meta || {};
      const usage = meta.usage;
      const model = meta.actualModel || meta.model || "";
      const effort = meta.actualEffort || meta.reasoning || "";

      return h(
        "div",
        { style: styles.turn },
        h(
          "div",
          { style: styles.turnHead },
          h("span", { style: styles.turnIndex }, `#${index + 1}`),
          h("span", { style: styles.turnTime }, formatTime(turn.at)),
          model ? h("span", { style: styles.pill }, model) : null,
          effort ? h("span", { style: styles.pill }, `推理 ${effort}`) : null,
          usage
            ? h(
                "span",
                {
                  style: styles.pillMuted,
                  title: `input ${usage.input_tokens} / cached ${usage.cached_input_tokens ?? 0}`,
                },
                `${Math.round((usage.input_tokens || 0) / 1000)}k in`,
              )
            : null,
        ),
        h(
          "div",
          { style: styles.messageAsk },
          h("div", { style: styles.messageLabel }, "我 → GPT"),
          h(MessageBody, { text: turn.prompt || "(空)" }),
        ),
        h(
          "div",
          { style: styles.messageReply },
          h("div", { style: styles.messageLabel }, "GPT → 我"),
          h(MessageBody, { text: turn.reply || "(空)" }),
        ),
      );
    }

    /**
     * 只列「在 Codex 里继续、桥不知道」的那些轮次。
     * 桥已经记过的问答不再重复展示——否则同一段内容会在这里出现第二遍。
     */
    function CodexTimeline({ timeline }) {
      const [expanded, setExpanded] = useState(false);
      const external = (timeline && timeline.messages ? timeline.messages : []).filter(
        (message) => message.external,
      );
      if (external.length === 0) return null;

      const COLLAPSED = 2;
      const shown = expanded ? external : external.slice(-COLLAPSED);

      return h(
        "div",
        { style: styles.externalBlock },
        h(
          "div",
          { style: styles.rowBetween },
          h("div", { style: styles.externalTitle }, `在 Codex 里继续的 ${external.length} 条`),
          external.length > COLLAPSED
            ? h(
                "button",
                { type: "button", style: styles.linkBtn, onClick: () => setExpanded(!expanded) },
                expanded ? "收起" : "展开全部",
              )
            : null,
        ),
        shown.map((message, index) =>
          h(
            "div",
            { key: index, style: styles.externalItem },
            h(
              "div",
              { style: styles.messageLabel },
              message.role === "user" ? "你（Codex 侧）" : "GPT（Codex 侧）",
            ),
            h(MessageBody, { text: message.text || "(空)" }),
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
      const [promoteNote, setPromoteNote] = useState({});

      /** 按需把某段会话标记成 Codex App 可见（改完要重启 App 才会出现）。 */
      const promoteToApp = async (item, threadId) => {
        try {
          const response = await fetch(`${ROUTE}/promote`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ threadId }),
          });
          let body = null;
          try {
            body = await response.json();
          } catch {
            body = null;
          }
          if (!response.ok) throw new Error(body?.error || `HTTP ${response.status}`);
          setPromoteNote((prev) => ({
            ...prev,
            [item.id]: "已标记为 Codex 可见，重启 Codex App 后可在那边继续这条对话",
          }));
        } catch (err) {
          setPromoteNote((prev) => ({
            ...prev,
            [item.id]: `标记失败：${String(err?.message ?? err)}`,
          }));
        }
      };

      return h(
        "div",
        { style: styles.list },
        conversations.map((item) => {
          const isOpen = item.id === selected;
          return h(
            "div",
            {
              key: item.id,
              className: "cbh-card",
              style: { ...styles.card, ...(isOpen ? styles.cardActive : null) },
            },
            /* 只有头部负责展开/收起。详情里的按钮不冒泡到这里，否则点「展开全文」会把卡片收起来。 */
            h(
              "div",
              {
                style: styles.cardHead,
                role: "button",
                tabIndex: 0,
                "aria-expanded": isOpen,
                onClick: () => onSelect(isOpen ? "" : item.id),
                onKeyDown: (event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onSelect(isOpen ? "" : item.id);
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
              h("span", { style: styles.chevron }, isOpen ? "▾" : "▸"),
            ),
            isOpen
              ? h(
                  "div",
                  { style: styles.cardBody },
                  detailLoading ? h("div", { style: styles.empty }, "载入中…") : null,
                  detailError ? h("div", { style: styles.error }, detailError) : null,
                  detail
                    ? h(
                        "div",
                        null,
                        detail.threadId
                          ? h(
                              "div",
                              { style: styles.threadRow },
                              h("span", { style: styles.threadText }, `Codex 会话 ${detail.threadId}`),
                              h(
                                "button",
                                {
                                  type: "button",
                                  style: styles.linkBtn,
                                  title: "把这条会话标记成 Codex App 可见（之后重启 App 就能在那边继续）",
                                  onClick: (event) => {
                                    event.stopPropagation();
                                    void promoteToApp(item, detail.threadId);
                                  },
                                },
                                "转移到 Codex",
                              ),
                            )
                          : null,
                        promoteNote[item.id]
                          ? h("div", { style: styles.okNote }, promoteNote[item.id])
                          : null,
                        (detail.turns || []).map((turn, index) =>
                          h(TurnBlock, { key: turn.id, turn, index }),
                        ),
                        h(CodexTimeline, { timeline: detail.codexTimeline }),
                      )
                    : null,
                )
              : null,
          );
        }),
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
    /**
     * 左侧栏「GPT 对话」图标对应的主面板：点进来就直接在右侧栏打开对话，
     * 中间只留一句提示，避免同一份列表在两个地方各画一遍。
     */
    function BridgePanel() {
      useEffect(() => {
        bridgeOpeners.open();
      }, []);

      return h(
        "div",
        { style: styles.root },
        h(
          "div",
          { style: { ...styles.empty, padding: "28px 20px", fontSize: 13 } },
          "GPT 对话已在右侧栏打开。",
          h("br"),
          h("br"),
          "如果右侧没看到，点右侧栏里「开始」旁边的「GPT 对话」标签，",
          h("br"),
          "或用会话标题栏的对话气泡按钮再打开一次。",
        ),
      );
    }

    // ── 右侧抽屉 ─────────────────────────────────────────────────────
    /** 侧栏 tab 与抽屉共用的内容体。onClose 为空表示宿主自己有关闭控件（右侧栏 tab）。 */
    function BridgeContent({ onClose }) {
      const { data, error, reload } = useConversationList(15000);
      const [selected, setSelected] = useState("");
      const { detail, error: detailError, loading } = useConversationDetail(selected);
      const conversations = data?.conversations ?? [];
      const activeConversation = conversations.find((item) => item.id === selected) || null;

      return h(
        "div",
        { style: styles.content },
        h(
          "div",
          { style: styles.head },
          h(
            "div",
            null,
            h("div", { style: styles.headTitle }, "GPT 对话"),
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
            onClose
              ? h(
                  "button",
                  {
                    type: "button",
                    style: styles.iconBtn,
                    title: "关闭 (Esc)",
                    "aria-label": "关闭",
                    onClick: onClose,
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
                )
              : null,
          ),
        ),
        h(
          "div",
          { style: styles.body, className: "cbh-scroll" },
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

    /** 右侧栏 tab 的 body。宿主提供标题与关闭，这里只画内容。 */
    function BridgeTab() {
      return h(BridgeContent, {});
    }

    function BridgeDrawer() {
      const open = useDrawerOpen();

      // 宽度可拖拽，记在 localStorage，下次打开沿用。
      const [width, setWidth] = useState(() => {
        try {
          const saved = Number(window.localStorage.getItem(DRAWER_WIDTH_KEY));
          if (Number.isFinite(saved) && saved >= 320 && saved <= 960) return saved;
        } catch {
          /* 隐私模式读不到 localStorage */
        }
        return DRAWER_WIDTH;
      });

      useEffect(() => {
        try {
          window.localStorage.setItem(DRAWER_WIDTH_KEY, String(width));
        } catch {
          /* 忽略写入失败 */
        }
      }, [width]);

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
        { style: { ...styles.drawer, width }, role: "dialog", "aria-label": "GPT 对话" },
        h("div", {
          style: styles.resizeHandle,
          title: "拖动调整宽度",
          onMouseDown: (event) => {
            event.preventDefault();
            const startX = event.clientX;
            const startWidth = width;
            const onMove = (moveEvent) => {
              const next = Math.min(960, Math.max(320, startWidth + (startX - moveEvent.clientX)));
              setWidth(next);
            };
            const onUp = () => {
              document.removeEventListener("mousemove", onMove);
              document.removeEventListener("mouseup", onUp);
              document.body.style.cursor = "";
            };
            document.body.style.cursor = "col-resize";
            document.addEventListener("mousemove", onMove);
            document.addEventListener("mouseup", onUp);
          },
        }),
        h(BridgeContent, { onClose: () => setDrawerOpen(false) }),
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


    /** 会话头部按钮：打开 GPT 对话（优先激活右侧栏 tab）。 */
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
          title: "打开 GPT 对话",
          "aria-label": "GPT 对话",
          onClick: () => bridgeOpeners.open(),
        },
        h(BridgeGlyph, { size: 16 }),
      );
    }

    return {
      // 注意：Cordis 的 Client 插件必须在这里声明要用的服务，否则 ctx.<service> 不可见。
      // sidebarRightTabs / sidebarRight 由 @deepseek-ai/dsh-client-ui-sidebar-right 提供。
      inject: ["slots", "sidebarRight", "sidebarRightTabs"],
      apply(ctx) {
        // 局部样式：hover 与滚动条是伪类，内联样式写不了。
        ctx.effect(() => {
          const style = document.createElement("style");
          style.dataset.plugin = "dsh-codex-handoff";
          style.textContent = [
            ".cbh-card{transition:background .15s ease,border-color .15s ease}",
            ".cbh-card:hover{background:rgba(127,127,127,.10)}",
            ".cbh-scroll{scrollbar-width:thin;scrollbar-color:rgba(127,127,127,.35) transparent}",
            ".cbh-scroll::-webkit-scrollbar{width:9px;height:9px}",
            ".cbh-scroll::-webkit-scrollbar-thumb{background:rgba(127,127,127,.32);border-radius:5px}",
            ".cbh-scroll::-webkit-scrollbar-thumb:hover{background:rgba(127,127,127,.5)}",
            ".cbh-scroll::-webkit-scrollbar-track{background:transparent}",
          ].join("\n");
          document.head.append(style);
          return () => style.remove();
        }, "codex-bridge: local styles");

        // 1) 侧栏面板入口 + 主面板（最先注册，保证即使右侧栏服务异常也不影响这里）
        ctx.slots.inject("sidebar.panellist", () =>
          ctx.slots.register(
            { name: "sidebar.panellist", id: "codex-bridge", order: 30, label: "GPT 对话" },
            BridgePanelIcon,
          ),
        );
        ctx.slots.inject("main", () =>
          ctx.slots.register({ name: "main", key: "codex-bridge" }, BridgePanel),
        );

        // 3) 会话头部按钮 + 抽屉（抽屉是右侧栏服务缺席时的回退）
        ctx.slots.inject("conversation.session.header.utilities", () =>
          ctx.slots.register(
            { name: "conversation.session.header.utilities", id: "codex-bridge-toggle", order: 2 },
            BridgeToggle,
          ),
        );
        ctx.slots.inject("shell.overlay", () =>
          ctx.slots.register({ name: "shell.overlay", id: "codex-bridge.drawer", order: 40 }, BridgeDrawer),
        );

        // 3) 右侧栏 tab。宿主服务未就绪或抛错时，上面的入口仍然可用。
        //    sidebarRightTabs / sidebarRight 由 @deepseek-ai/dsh-client-ui-sidebar-right 提供，
        //    激活顺序不保证，所以短轮询等待；访问未知服务可能抛错，全部包在 try 里。
        const registerSidebarTab = (remaining) => {
          let rightTabs;
          let rightPane;
          try {
            rightTabs =
              ctx.sidebarRightTabs ||
              (typeof ctx.get === "function" ? ctx.get("sidebarRightTabs") : undefined);
            rightPane =
              ctx.sidebarRight || (typeof ctx.get === "function" ? ctx.get("sidebarRight") : undefined);
          } catch {
            rightTabs = undefined;
            rightPane = undefined;
          }

          if (rightTabs && rightPane) {
            try {
              ctx.effect(
                () =>
                  rightTabs.register({
                    id: TAB_ID,
                    kind: "codex-bridge",
                    keepMounted: true,
                    patterns: ["dsh-resource://codex-bridge/**"],
                    title: () => "GPT 对话",
                  }),
                "codex-bridge: sidebar-right tab",
              );
              ctx.slots.inject("sidebar.right.pane.tab", () =>
                ctx.slots.register({ name: "sidebar.right.pane.tab", key: TAB_ID }, BridgeTab),
              );
              bridgeOpeners.open = () => {
                try {
                  rightPane.openResource(TAB_RESOURCE);
                } catch (error) {
                  console.error("[codex-bridge] 打开右侧栏失败，回退抽屉", error);
                  setDrawerOpen(true);
                }
              };
              console.info("[codex-bridge] 已注册右侧栏 tab");
            } catch (error) {
              console.error("[codex-bridge] 注册右侧栏 tab 失败，保留浮层抽屉", error);
            }
            return;
          }

          if (remaining > 0) {
            setTimeout(() => registerSidebarTab(remaining - 1), 250);
          } else {
            console.warn("[codex-bridge] 右侧栏服务不可用，使用浮层抽屉作为回退");
          }
        };
        try {
          registerSidebarTab(24);
        } catch (error) {
          console.error("[codex-bridge] 注册右侧栏 tab 失败，保留浮层抽屉", error);
        }
      },
    };
  },
});
