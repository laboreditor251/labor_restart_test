(function () {
  const STORAGE_KEY = "cya-news-game-v1";
  const OUT_DURATION = 320;
  const IN_DURATION = 560;
  const NOTE_DURATION = 2000;

  document.addEventListener("alpine:init", () => {
    Alpine.store("game", {
      story: null,
      storyNodes: {},
      currentNodeId: null,
      currentNode: null,
      state: {},
      history: [],
      snapshots: [],
      branchBaseline: null,
      showPath: false,
      fatalError: "",
      hasAcknowledgedWarning: false,
      showTriggerWarning: false,
      debugPanelOpen: false,
      debugNodeId: "pre_origin",
      bgmEnabled: true,
      bgmAudio: null,
      fullscreenSupported: false,
      isFullscreen: false,
      fullscreenBound: false,
      uiAudioCtx: null,
      uiClickBound: false,

      isTransitioning: false,
      transitionPhase: "idle",
      pending: null,
      lastEffects: null,
      effectNotes: [],
      transitionTimer: null,
      effectTimer: null,
      autoRouteTimer: null,
      autoRouting: false,

      displayMoney: 0,
      displayTrust: 0,
      rafMoney: null,
      rafTrust: null,

      async loadStory() {
        try {
          this.initBgm();
          this.initFullscreen();
          this.bindUiClickFx();
          let res = await fetch("./assets/story.json", { cache: "no-store" });
          if (!res.ok) {
            res = await fetch("/assets/story.json", { cache: "no-store" });
          }
          if (!res.ok) throw new Error("无法加载 story.json");

          const story = await res.json();
          const result = this.validateStory(story);
          if (!result.ok) {
            this.fatalError = result.errors.join("；");
            return;
          }

          this.story = story;
          this.storyNodes = story.nodes;
          // trigger warning / 导语确认仅在当前会话有效：刷新后回到首页重新显示
          this.hasAcknowledgedWarning = false;
          this.showTriggerWarning = false;
          this.debugNodeId = this.getDebugNodes()[0]?.id || story.start;

          if (!this.restore()) {
            this.restart();
          } else {
            this.currentNode = this.storyNodes[this.currentNodeId] || null;
            this.syncDisplays();
          }
        } catch (err) {
          console.error(err);
          this.fatalError = "故事加载失败，请检查 ./assets/story.json 是否存在且格式正确。";
        }
      },

      acknowledgeWarning() {
        if (!this.story?.trigger_warning) return;
        this.hasAcknowledgedWarning = true;
        this.showTriggerWarning = false;
        this.enterFullscreen();
        this.tryPlayBgm();
      },

      startRebirth() {
        if (!this.story) return;
        if (this.story?.trigger_warning) {
          this.showTriggerWarning = true;
          this.hasAcknowledgedWarning = false;
          return;
        }
        this.hasAcknowledgedWarning = true;
        this.enterFullscreen();
        this.tryPlayBgm();
      },

      warningToken() {
        const tw = String(this.story?.trigger_warning || "").trim();
        if (!tw) return "";
        // 使用内容本身作为版本签名；trigger warning 文案更新后会自动要求重新确认
        return tw;
      },

      goTo(nodeId, choiceMeta) {
        this.tryPlayBgm();
        if (!this.storyNodes[nodeId]) {
          console.warn("目标节点不存在:", nodeId);
          return;
        }

        if (this.isTransitioning) return;

        if (!choiceMeta) {
          this.currentNodeId = nodeId;
          this.currentNode = this.storyNodes[nodeId];
          this.persist();
          this.handleAutoRoute();
          return;
        }

        this.pending = { nodeId, choiceMeta };
        this.isTransitioning = true;
        this.transitionPhase = "out";
        this.lastEffects = null;
        this.effectNotes = [];

        const prevState = this.cloneState(this.state);

        this.clearTransitionTimer();
        this.transitionTimer = setTimeout(() => {
          this.snapshots.push({
            currentNodeId: this.currentNodeId,
            state: this.cloneState(this.state),
            historyLength: this.history.length
          });

          if (choiceMeta.effects) {
            this.applyEffects(choiceMeta.effects);
            this.lastEffects = this.cloneState(choiceMeta.effects);
            this.effectNotes = this.buildEffectNotes(choiceMeta.effects);
            this.startEffectAutoClear();
            if (Object.prototype.hasOwnProperty.call(choiceMeta.effects, "branch")) {
              this.branchBaseline = {
                nodeId,
                state: this.cloneState(this.state)
              };
            }
          }

          this.history.push({
            from: this.currentNodeId,
            choiceLabel: choiceMeta.label,
            to: nodeId,
            ts: Date.now()
          });

          this.currentNodeId = nodeId;
          this.currentNode = this.storyNodes[nodeId];

          this.transitionPhase = "in";
          this.animateStateCounters(prevState, this.state);

          this.clearTransitionTimer();
          this.transitionTimer = setTimeout(() => {
            this.transitionPhase = "idle";
            this.isTransitioning = false;
            this.pending = null;
            this.persist();
            this.handleAutoRoute();
          }, IN_DURATION);
        }, OUT_DURATION);
      },

      applyEffects(effects) {
        if (!effects || typeof effects !== "object") return;

        Object.entries(effects).forEach(([key, value]) => {
          const prev = this.state[key];

          if (typeof value === "number") {
            const base = typeof prev === "number" ? prev : 0;
            this.state[key] = base + value;
            return;
          }

          if (typeof value === "boolean") {
            this.state[key] = value;
            return;
          }

          if (typeof value === "string") {
            const randValue = this.parseRandomDirective(value);
            this.state[key] = randValue === null ? value : randValue;
            return;
          }

          console.warn("忽略不支持的 effect 类型:", key, value);
        });
      },

      parseRandomDirective(value) {
        const m = String(value).match(/^rand\((-?\d+),(-?\d+)\)$/i);
        if (!m) return null;

        const a = Number(m[1]);
        const b = Number(m[2]);
        if (!Number.isInteger(a) || !Number.isInteger(b)) return null;

        const min = Math.min(a, b);
        const max = Math.max(a, b);
        return Math.floor(Math.random() * (max - min + 1)) + min;
      },

      handleAutoRoute() {
        this.clearAutoRouteTimer();
        if (!this.currentNode || this.autoRouting || this.isTransitioning) return;

        const routes = Array.isArray(this.currentNode.auto_routes) ? this.currentNode.auto_routes : [];
        if (!routes.length) return;

        const route = routes.find((r) => this.checkCondition(r.condition));
        if (!route || !route.to) return;

        this.autoRouting = true;
        this.autoRouteTimer = setTimeout(() => {
          this.autoRouting = false;
          this.goTo(route.to, {
            label: route.label || "系统分流",
            effects: route.effects || {}
          });
        }, 120);
      },

      checkCondition(expr) {
        if (!expr || !String(expr).trim()) return true;

        try {
          const tokens = this.tokenize(expr);
          const rpn = this.toRPN(tokens);
          return this.evalRPN(rpn);
        } catch (err) {
          console.warn("条件表达式解析失败:", expr, err.message);
          return false;
        }
      },

      tokenize(input) {
        const src = input.trim();
        const tokens = [];
        let i = 0;

        const isSpace = (c) => /\s/.test(c);
        const isIdentStart = (c) => /[A-Za-z_]/.test(c);
        const isIdentPart = (c) => /[A-Za-z0-9_]/.test(c);
        const isDigit = (c) => /[0-9]/.test(c);

        while (i < src.length) {
          const ch = src[i];

          if (isSpace(ch)) {
            i += 1;
            continue;
          }

          const two = src.slice(i, i + 2);
          if (["==", "!=", ">=", "<="].includes(two)) {
            tokens.push({ type: "op", value: two });
            i += 2;
            continue;
          }

          if ([">", "<", "(", ")"].includes(ch)) {
            if (ch === "(" || ch === ")") {
              tokens.push({ type: "paren", value: ch });
            } else {
              tokens.push({ type: "op", value: ch });
            }
            i += 1;
            continue;
          }

          if (ch === "\"" || ch === "'") {
            const quote = ch;
            i += 1;
            let str = "";
            while (i < src.length && src[i] !== quote) {
              str += src[i++];
            }
            if (src[i] !== quote) throw new Error("字符串未闭合");
            i += 1;
            tokens.push({ type: "literal", value: str });
            continue;
          }

          if (isDigit(ch) || (ch === "-" && isDigit(src[i + 1]))) {
            let num = ch;
            i += 1;
            while (i < src.length && /[0-9.]/.test(src[i])) {
              num += src[i++];
            }
            const n = Number(num);
            if (Number.isNaN(n)) throw new Error("非法数字: " + num);
            tokens.push({ type: "literal", value: n });
            continue;
          }

          if (isIdentStart(ch)) {
            let ident = ch;
            i += 1;
            while (i < src.length && isIdentPart(src[i])) {
              ident += src[i++];
            }
            const up = ident.toUpperCase();
            if (["AND", "OR", "NOT"].includes(up)) {
              tokens.push({ type: "op", value: up });
            } else if (ident === "true" || ident === "false") {
              tokens.push({ type: "literal", value: ident === "true" });
            } else {
              tokens.push({ type: "ident", value: ident });
            }
            continue;
          }

          throw new Error("无法识别的字符: " + ch);
        }
        return tokens;
      },

      toRPN(tokens) {
        const output = [];
        const ops = [];
        const precedence = {
          NOT: 4,
          "==": 3,
          "!=": 3,
          ">": 3,
          ">=": 3,
          "<": 3,
          "<=": 3,
          AND: 2,
          OR: 1
        };
        const rightAssoc = { NOT: true };

        for (const token of tokens) {
          if (token.type === "literal" || token.type === "ident") {
            output.push(token);
            continue;
          }

          if (token.type === "op") {
            while (ops.length) {
              const top = ops[ops.length - 1];
              if (top.type !== "op") break;

              const p1 = precedence[token.value];
              const p2 = precedence[top.value];
              if (p2 === undefined) break;

              const shouldPop = rightAssoc[token.value] ? p1 < p2 : p1 <= p2;
              if (!shouldPop) break;
              output.push(ops.pop());
            }
            ops.push(token);
            continue;
          }

          if (token.type === "paren" && token.value === "(") {
            ops.push(token);
            continue;
          }

          if (token.type === "paren" && token.value === ")") {
            let foundLeft = false;
            while (ops.length) {
              const popped = ops.pop();
              if (popped.type === "paren" && popped.value === "(") {
                foundLeft = true;
                break;
              }
              output.push(popped);
            }
            if (!foundLeft) throw new Error("括号不匹配");
          }
        }

        while (ops.length) {
          const op = ops.pop();
          if (op.type === "paren") throw new Error("括号不匹配");
          output.push(op);
        }
        return output;
      },

      evalRPN(rpn) {
        const stack = [];
        const readValue = (token) => {
          if (token.type === "literal") return token.value;
          if (token.type === "ident") return this.state[token.value];
          return token;
        };

        for (const token of rpn) {
          if (token.type === "literal" || token.type === "ident") {
            stack.push(readValue(token));
            continue;
          }

          const op = token.value;
          if (op === "NOT") {
            const a = stack.pop();
            stack.push(!Boolean(a));
            continue;
          }

          const b = stack.pop();
          const a = stack.pop();

          switch (op) {
            case "AND":
              stack.push(Boolean(a) && Boolean(b));
              break;
            case "OR":
              stack.push(Boolean(a) || Boolean(b));
              break;
            case "==":
              stack.push(a == b);
              break;
            case "!=":
              stack.push(a != b);
              break;
            case ">":
              stack.push(a > b);
              break;
            case ">=":
              stack.push(a >= b);
              break;
            case "<":
              stack.push(a < b);
              break;
            case "<=":
              stack.push(a <= b);
              break;
            default:
              throw new Error("未知运算符: " + op);
          }
        }

        if (stack.length !== 1) throw new Error("表达式结构错误");
        return Boolean(stack[0]);
      },

      isChoiceAvailable(choice) {
        return this.checkCondition(choice.condition);
      },

      choiceClass(choice) {
        if (!this.isChoiceAvailable(choice)) {
          return "border-line bg-card2 text-white/75 cursor-not-allowed";
        }
        if (this.isTransitioning) {
          return "border-line bg-card2 text-white/75 cursor-wait";
        }
        return "border-line hover:border-accent/60";
      },

      undo() {
        if (!this.canUndo() || this.isTransitioning) return;

        this.resetTransitionState();

        const prev = this.snapshots.pop();
        this.currentNodeId = prev.currentNodeId;
        this.currentNode = this.storyNodes[this.currentNodeId];
        this.state = prev.state;
        this.history = this.history.slice(0, prev.historyLength);
        this.syncDisplays();
        this.persist();
      },

      canUndo() {
        return this.snapshots.length > 0;
      },

      restart(preserveWarning = false) {
        if (!this.story) return;

        localStorage.removeItem(STORAGE_KEY);
        this.resetTransitionState();
        this.showTriggerWarning = false;
        this.hasAcknowledgedWarning = preserveWarning && Boolean(this.story?.trigger_warning);
        this.state = this.cloneState(this.story.initial_state || {});
        this.history = [];
        this.snapshots = [];
        this.branchBaseline = null;
        this.showPath = false;
        this.currentNodeId = this.story.start;
        this.currentNode = this.storyNodes[this.currentNodeId] || null;
        this.syncDisplays();
        this.persist();
      },

      restartBranch() {
        if (!this.story) return;
        this.resetTransitionState();
        this.history = [];
        this.snapshots = [];
        this.lastEffects = null;
        this.effectNotes = [];

        if (this.branchBaseline && this.storyNodes[this.branchBaseline.nodeId]) {
          this.hasAcknowledgedWarning = Boolean(this.story?.trigger_warning);
          this.state = this.cloneState(this.branchBaseline.state || {});
          this.currentNodeId = this.branchBaseline.nodeId;
          this.currentNode = this.storyNodes[this.currentNodeId];
          this.syncDisplays();
          this.persist();
          return;
        }

        this.restart(true);
      },

      backToHome() {
        if (!this.story) return;
        this.restart(false);
        this.hasAcknowledgedWarning = false;
        this.showTriggerWarning = false;
        this.debugPanelOpen = false;
        if (typeof window !== "undefined") {
          window.scrollTo({ top: 0, behavior: "smooth" });
        }
      },

      restartAfterEnding() {
        if (!this.story) return;
        this.restart(Boolean(this.story?.trigger_warning));
        this.showTriggerWarning = false;
        this.debugPanelOpen = false;
        if (typeof window !== "undefined") {
          window.scrollTo({ top: 0, behavior: "smooth" });
        }
      },

      toggleDebugPanel() {
        this.debugPanelOpen = !this.debugPanelOpen;
      },

      bindUiClickFx() {
        if (this.uiClickBound || typeof document === "undefined") return;
        this.uiClickBound = true;
        document.addEventListener(
          "click",
          (evt) => {
            const btn = evt.target && evt.target.closest ? evt.target.closest("button") : null;
            if (!btn || btn.disabled) return;
            this.playUiClickFx();
          },
          true
        );
      },

      initUiAudio() {
        if (this.uiAudioCtx) return this.uiAudioCtx;
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return null;
        this.uiAudioCtx = new Ctx();
        return this.uiAudioCtx;
      },

      playUiClickFx() {
        const ctx = this.initUiAudio();
        if (!ctx) return;
        if (ctx.state === "suspended") {
          ctx.resume().catch(() => {});
        }

        const now = ctx.currentTime;
        const osc = ctx.createOscillator();
        const osc2 = ctx.createOscillator();
        const osc3 = ctx.createOscillator();
        const gain = ctx.createGain();
        const gain2 = ctx.createGain();
        const gain3 = ctx.createGain();
        const filter = ctx.createBiquadFilter();
        const filter2 = ctx.createBiquadFilter();
        const filter3 = ctx.createBiquadFilter();
        const noiseSource = ctx.createBufferSource();
        const noiseFilter = ctx.createBiquadFilter();
        const noiseGain = ctx.createGain();

        osc.type = "triangle";
        osc.frequency.setValueAtTime(270, now);
        osc.frequency.exponentialRampToValueAtTime(180, now + 0.06);

        // Slightly detuned overtone for a less synthetic, more tactile timbre.
        osc2.type = "sine";
        osc2.frequency.setValueAtTime(560, now);
        osc2.frequency.exponentialRampToValueAtTime(360, now + 0.05);

        // Short high-frequency attack for better phone speaker audibility.
        osc3.type = "square";
        osc3.frequency.setValueAtTime(1850, now);
        osc3.frequency.exponentialRampToValueAtTime(1250, now + 0.018);

        filter.type = "lowpass";
        filter.frequency.setValueAtTime(1700, now);

        filter2.type = "bandpass";
        filter2.frequency.setValueAtTime(760, now);
        filter2.Q.setValueAtTime(0.7, now);

        filter3.type = "highpass";
        filter3.frequency.setValueAtTime(1250, now);

        gain.gain.setValueAtTime(0.0001, now);
        gain.gain.exponentialRampToValueAtTime(0.2, now + 0.008);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.09);

        gain2.gain.setValueAtTime(0.0001, now);
        gain2.gain.exponentialRampToValueAtTime(0.08, now + 0.006);
        gain2.gain.exponentialRampToValueAtTime(0.0001, now + 0.06);

        gain3.gain.setValueAtTime(0.0001, now);
        gain3.gain.exponentialRampToValueAtTime(0.06, now + 0.0025);
        gain3.gain.exponentialRampToValueAtTime(0.0001, now + 0.02);

        const noiseBuffer = ctx.createBuffer(1, Math.max(1, Math.floor(ctx.sampleRate * 0.03)), ctx.sampleRate);
        const noiseData = noiseBuffer.getChannelData(0);
        for (let i = 0; i < noiseData.length; i += 1) {
          noiseData[i] = (Math.random() * 2 - 1) * 0.75;
        }
        noiseSource.buffer = noiseBuffer;

        noiseFilter.type = "highpass";
        noiseFilter.frequency.setValueAtTime(1600, now);

        noiseGain.gain.setValueAtTime(0.0001, now);
        noiseGain.gain.exponentialRampToValueAtTime(0.028, now + 0.0025);
        noiseGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.022);

        osc.connect(filter);
        filter.connect(gain);
        gain.connect(ctx.destination);
        osc2.connect(filter2);
        filter2.connect(gain2);
        gain2.connect(ctx.destination);
        osc3.connect(filter3);
        filter3.connect(gain3);
        gain3.connect(ctx.destination);
        noiseSource.connect(noiseFilter);
        noiseFilter.connect(noiseGain);
        noiseGain.connect(ctx.destination);

        osc.start(now);
        osc2.start(now);
        osc3.start(now);
        noiseSource.start(now);

        osc.stop(now + 0.095);
        osc2.stop(now + 0.07);
        osc3.stop(now + 0.024);
        noiseSource.stop(now + 0.03);
      },

      initBgm() {
        if (this.bgmAudio) return;
        const el = document.getElementById("bgm-player");
        if (!el) return;
        this.bgmAudio = el;
        this.bgmAudio.volume = 0.35;
      },

      tryPlayBgm() {
        if (!this.bgmEnabled || !this.bgmAudio) return;
        this.bgmAudio.play().catch((err) => {
          console.warn("背景音乐播放失败:", err?.message || err);
        });
      },

      toggleBgm() {
        this.initBgm();
        this.bgmEnabled = !this.bgmEnabled;
        if (!this.bgmAudio) return;

        if (this.bgmEnabled) {
          this.tryPlayBgm();
        } else {
          this.bgmAudio.pause();
        }
      },

      initFullscreen() {
        if (typeof document === "undefined") return;
        const root = document.documentElement;
        this.fullscreenSupported = Boolean(
          root.requestFullscreen || root.webkitRequestFullscreen || root.msRequestFullscreen
        );
        this.isFullscreen = this.getIsFullscreen();

        if (this.fullscreenBound) return;
        this.fullscreenBound = true;

        const sync = () => {
          this.isFullscreen = this.getIsFullscreen();
        };

        document.addEventListener("fullscreenchange", sync);
        document.addEventListener("webkitfullscreenchange", sync);
        document.addEventListener("MSFullscreenChange", sync);
      },

      getIsFullscreen() {
        if (typeof document === "undefined") return false;
        return Boolean(document.fullscreenElement || document.webkitFullscreenElement || document.msFullscreenElement);
      },

      toggleFullscreen() {
        if (!this.fullscreenSupported || typeof document === "undefined") return;

        const doc = document;
        const root = document.documentElement;
        const inFullscreen = this.getIsFullscreen();

        try {
          if (inFullscreen) {
            const exit = doc.exitFullscreen || doc.webkitExitFullscreen || doc.msExitFullscreen;
            if (exit) {
              const ret = exit.call(doc);
              if (ret && typeof ret.catch === "function") ret.catch(() => {});
            }
            return;
          }

          const request = root.requestFullscreen || root.webkitRequestFullscreen || root.msRequestFullscreen;
          if (request) {
            const ret = request.call(root);
            if (ret && typeof ret.catch === "function") ret.catch(() => {});
          }
        } catch (_err) {
          // Ignore fullscreen errors to avoid breaking interaction flow.
        }
      },

      enterFullscreen() {
        if (!this.fullscreenSupported || typeof document === "undefined") return;
        if (this.getIsFullscreen()) return;
        const root = document.documentElement;
        const request = root.requestFullscreen || root.webkitRequestFullscreen || root.msRequestFullscreen;
        if (!request) return;
        try {
          const ret = request.call(root);
          if (ret && typeof ret.catch === "function") ret.catch(() => {});
        } catch (_err) {
          // Ignore fullscreen errors to avoid breaking interaction flow.
        }
      },

      getDebugNodes() {
        const ids = Object.keys(this.storyNodes || {});
        const picked = ids.filter((id) => /^b\d+_(start|guard)$/.test(id)).sort((a, b) =>
          a.localeCompare(b, undefined, { numeric: true })
        );
        const ordered = ["pre_origin", ...picked.filter((id) => id !== "pre_origin")];
        return ordered
          .filter((id) => this.storyNodes[id])
          .map((id) => ({ id, label: `${id}${id.endsWith("_guard") ? "（入口提示）" : ""}` }));
      },

      debugJump() {
        if (!this.story || !this.storyNodes[this.debugNodeId]) return;

        this.resetTransitionState();
        this.state = this.cloneState(this.story.initial_state || {});
        this.history = [];
        this.snapshots = [];
        this.branchBaseline = null;
        this.currentNodeId = this.debugNodeId;
        this.currentNode = this.storyNodes[this.currentNodeId];
        this.hasAcknowledgedWarning = true;
        this.tryPlayBgm();
        this.syncDisplays();
        this.persist();
        this.handleAutoRoute();
      },

      resetTransitionState() {
        this.clearTransitionTimer();
        this.clearEffectTimer();
        this.clearAutoRouteTimer();
        this.stopCounterRaf("money");
        this.stopCounterRaf("trust");
        this.isTransitioning = false;
        this.transitionPhase = "idle";
        this.pending = null;
        this.lastEffects = null;
        this.effectNotes = [];
        this.autoRouting = false;
      },

      clearTransitionTimer() {
        if (this.transitionTimer) {
          clearTimeout(this.transitionTimer);
          this.transitionTimer = null;
        }
      },

      clearEffectTimer() {
        if (this.effectTimer) {
          clearTimeout(this.effectTimer);
          this.effectTimer = null;
        }
      },

      clearAutoRouteTimer() {
        if (this.autoRouteTimer) {
          clearTimeout(this.autoRouteTimer);
          this.autoRouteTimer = null;
        }
      },

      startEffectAutoClear() {
        this.clearEffectTimer();
        this.effectTimer = setTimeout(() => {
          this.lastEffects = null;
          this.effectNotes = [];
        }, NOTE_DURATION);
      },

      buildEffectNotes(effects) {
        const notes = [];
        Object.entries(effects || {}).forEach(([key, value]) => {
          if (typeof value === "number") {
            if (key === "money" || key === "trust") return;
            const sign = value >= 0 ? "+" : "";
            notes.push({ key, text: `${key} ${sign}${value}` });
            return;
          }

          if (typeof value === "boolean") {
            notes.push({ key, text: `${key}记录：${value ? "是" : "否"}` });
            return;
          }

          if (typeof value === "string") {
            notes.push({ key, text: `${key}: ${value}` });
          }
        });
        return notes;
      },

      animateStateCounters(prevState, nextState) {
        this.animateNumber("money", prevState.money || 0, nextState.money || 0, 460);
        this.animateNumber("trust", prevState.trust || 0, nextState.trust || 0, 360);
      },

      animateNumber(field, from, to, duration) {
        this.stopCounterRaf(field);
        if (from === to) {
          if (field === "money") this.displayMoney = to;
          if (field === "trust") this.displayTrust = to;
          return;
        }

        const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
        const start = performance.now();

        const step = (now) => {
          const t = Math.min(1, (now - start) / duration);
          const eased = easeOutCubic(t);
          const val = Math.round(from + (to - from) * eased);

          if (field === "money") this.displayMoney = val;
          if (field === "trust") this.displayTrust = val;

          if (t < 1) {
            const id = requestAnimationFrame(step);
            if (field === "money") this.rafMoney = id;
            if (field === "trust") this.rafTrust = id;
          }
        };

        const id = requestAnimationFrame(step);
        if (field === "money") this.rafMoney = id;
        if (field === "trust") this.rafTrust = id;
      },

      stopCounterRaf(field) {
        if (field === "money" && this.rafMoney) {
          cancelAnimationFrame(this.rafMoney);
          this.rafMoney = null;
        }
        if (field === "trust" && this.rafTrust) {
          cancelAnimationFrame(this.rafTrust);
          this.rafTrust = null;
        }
      },

      syncDisplays() {
        this.displayMoney = Number(this.state.money || 0);
        this.displayTrust = Number(this.state.trust || 0);
      },

      cloneState(obj) {
        try {
          return JSON.parse(JSON.stringify(obj || {}));
        } catch (err) {
          console.warn("状态拷贝失败，已回退为空对象", err);
          return {};
        }
      },

      persist() {
        const payload = {
          currentNodeId: this.currentNodeId,
          state: this.state,
          history: this.history,
          snapshots: this.snapshots,
          branchBaseline: this.branchBaseline
        };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
      },

      restore() {
        if (!this.story) return false;

        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return false;

        try {
          const data = JSON.parse(raw);
          if (!data || !this.storyNodes[data.currentNodeId]) return false;

          this.currentNodeId = data.currentNodeId;
          this.currentNode = this.storyNodes[this.currentNodeId];
          this.state = { ...(this.story.initial_state || {}), ...(data.state || {}) };
          this.history = Array.isArray(data.history) ? data.history : [];
          this.snapshots = Array.isArray(data.snapshots) ? data.snapshots : [];
          this.branchBaseline =
            data.branchBaseline &&
            typeof data.branchBaseline === "object" &&
            typeof data.branchBaseline.nodeId === "string"
              ? data.branchBaseline
              : null;
          return true;
        } catch (err) {
          console.warn("恢复进度失败，已忽略本地存档", err);
          return false;
        }
      },

      validateStory(story) {
        const errors = [];
        const warnings = [];

        if (!story || typeof story !== "object") {
          errors.push("story.json 不是有效对象");
          return { ok: false, errors, warnings };
        }

        if (!story.title) errors.push("缺少 story.title");
        if (!story.start) errors.push("缺少 story.start");
        if (story.intro !== undefined && typeof story.intro !== "string") warnings.push("story.intro 建议为 string");
        if (story.trigger_warning !== undefined && typeof story.trigger_warning !== "string") warnings.push("story.trigger_warning 建议为 string");
        if (!story.nodes || typeof story.nodes !== "object") {
          errors.push("缺少 story.nodes 或类型错误");
          return { ok: false, errors, warnings };
        }

        const nodeIds = Object.keys(story.nodes);
        if (nodeIds.length === 0) {
          errors.push("nodes 为空");
          return { ok: false, errors, warnings };
        }

        if (!story.nodes[story.start]) errors.push("start 节点不存在：" + story.start);

        for (const id of nodeIds) {
          const node = story.nodes[id];
          if (!node || typeof node !== "object") {
            errors.push(`节点 ${id} 无效`);
            continue;
          }

          if (typeof node.text !== "string") warnings.push(`节点 ${id} 缺少 text`);
          if (!Array.isArray(node.choices)) {
            warnings.push(`节点 ${id} 缺少 choices 数组`);
          } else {
            node.choices.forEach((ch, idx) => {
              if (!ch || typeof ch !== "object") {
                warnings.push(`节点 ${id} 的 choice[${idx}] 非对象`);
                return;
              }
              if (!ch.label) warnings.push(`节点 ${id} 的 choice[${idx}] 缺少 label`);
              if (!ch.to) warnings.push(`节点 ${id} 的 choice[${idx}] 缺少 to`);
              if (ch.to && !story.nodes[ch.to]) warnings.push(`节点 ${id} 的 choice[${idx}] 指向不存在节点: ${ch.to}`);
            });
          }

          if (node.auto_routes !== undefined && !Array.isArray(node.auto_routes)) {
            warnings.push(`节点 ${id} 的 auto_routes 不是数组`);
          } else if (Array.isArray(node.auto_routes)) {
            node.auto_routes.forEach((r, idx) => {
              if (!r || typeof r !== "object") {
                warnings.push(`节点 ${id} 的 auto_routes[${idx}] 非对象`);
                return;
              }
              if (!r.to) warnings.push(`节点 ${id} 的 auto_routes[${idx}] 缺少 to`);
              if (r.to && !story.nodes[r.to]) warnings.push(`节点 ${id} 的 auto_routes[${idx}] 指向不存在节点: ${r.to}`);
            });
          }
        }

        if (story.nodes[story.start]) {
          const reachable = new Set();
          const queue = [story.start];

          while (queue.length) {
            const curr = queue.shift();
            if (reachable.has(curr)) continue;
            reachable.add(curr);

            const node = story.nodes[curr];
            const choices = Array.isArray(node.choices) ? node.choices : [];
            choices.forEach((ch) => {
              if (ch.to && story.nodes[ch.to] && !reachable.has(ch.to)) queue.push(ch.to);
            });
            const autoRoutes = Array.isArray(node.auto_routes) ? node.auto_routes : [];
            autoRoutes.forEach((r) => {
              if (r.to && story.nodes[r.to] && !reachable.has(r.to)) queue.push(r.to);
            });
          }

          const unreachable = nodeIds.filter((id) => !reachable.has(id));
          if (unreachable.length) warnings.push("不可达节点: " + unreachable.join(", "));
        }

        warnings.forEach((w) => console.warn("[story warning]", w));
        if (errors.length) errors.forEach((e) => console.error("[story error]", e));

        return { ok: errors.length === 0, errors, warnings };
      },

      escapeHTML(str) {
        const map = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
        return String(str).replace(/[&<>"']/g, (m) => map[m]);
      },

      sanitizeUrl(url) {
        const u = String(url || "").trim();
        if (/^(https?:|mailto:)/i.test(u)) return u;
        return "#";
      },

      renderMarkdown(text) {
        const normalized = String(text || "").replace(/\\n/g, "\n");
        let s = this.escapeHTML(normalized);

        s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label, url) => {
          const safe = this.sanitizeUrl(url);
          const rel = safe === "#" ? "nofollow" : "noopener noreferrer nofollow";
          const target = safe === "#" ? "" : ' target="_blank"';
          const cls = safe === "#" ? "story-link story-link-disabled" : "story-link";
          const ariaDisabled = safe === "#" ? ' aria-disabled="true"' : "";
          return `<a class="${cls}" href="${safe}" rel="${rel}"${target}${ariaDisabled}>${label}</a>`;
        });

        s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
        s = s.replace(/\*([^*]+)\*/g, "<em>$1</em>");

        return s
          .split(/\n{2,}/)
          .map((p) => `<p>${p.replace(/\n/g, "<br>")}</p>`)
          .join("");
      },

      endingClass(type) {
        if (type === "good") return "ending-good border-line";
        if (type === "bad") return "ending-bad border-line";
        return "ending-neutral border-line";
      }
    });
  });
})();
