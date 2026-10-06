/* ============================================================================
   mp_Tools bridge — 把已定案的 UI 接上真正的 Python 後端。

   載入方式：mptools/web/server.py 在 index.html 送出前注入這支腳本。
   這支腳本**不改動 UI 的長相**（那份設計已經定案），只做三件事：

     1. 修正行動按鈕：讓「重設 / 中斷 / 清除」各自對應到正確的動作
        （原型把三個都接到同一個 handler）
     2. 用真實的序列埠清單取代假的板子
     3. 把「連線」接到 POST /api/connect，而不是假的 setTimeout 動畫

   為什麼不用 build step：這份 UI 零依賴、單一檔案，直接由 Python 服務送出最單純。
   ========================================================================= */
(function () {
  "use strict";
  if (window.__MPT_BRIDGE__) return;
  window.__MPT_BRIDGE__ = true;

  var log = function () {
    console.log.apply(console, ["[mpt]"].concat([].slice.call(arguments)));
  };

  /* ── HTTP 小工具 ───────────────────────────────────────────────────── */
  function api(path, options) {
    return fetch(path, Object.assign({ headers: { "Content-Type": "application/json" } }, options || {}))
      .then(function (response) {
        return response.json().then(function (body) {
          return { status: response.status, ok: response.ok, body: body };
        });
      });
  }

  /* ── 1. 修正三個被混在一起的控制按鈕 ─────────────────────────────────
     原型裡「中斷 / 軟重置 / 清除」都走 data-act="interrupt"，因為它們在
     假資料的世界裡沒差別。接上真裝置後差別很大。                            */
  function labelOf(button) {
    var text = (button.textContent || "").trim();
    if (/中斷/.test(text)) return "interrupt";
    if (/重置/.test(text)) return "reset";
    if (/清除/.test(text)) return "clear";
    return null;
  }

  function installButtonFixes() {
    var panel = document.querySelector(".panel-head");
    if (!panel) return;
    [].forEach.call(panel.querySelectorAll("[data-act]"), function (button) {
      var kind = labelOf(button);
      if (!kind) return;
      button.dataset.act = "repl-" + kind;
      button.dataset.mptFixed = "1";
    });
  }

  /* ── 2. 用真序列埠取代假板子 ─────────────────────────────────────── */
  var lastPorts = [];

  function renderPortList(ports) {
    var slot = document.getElementById("strip-slot");
    if (!slot) return;
    if (!ports.length) {
      slot.innerHTML =
        '<span class="label" style="color:var(--bench-400)">' +
        "找不到序列埠 · 請確認 USB 線與驅動（<code>mpt ports</code>）" +
        "</span>";
      return;
    }
    var usable = ports.filter(function (p) {
      return !p.busy;
    });
    slot.innerHTML = ports
      .map(function (port) {
        var state = port.busy ? "error" : port.vid ? "idle" : "off";
        var note = port.busy ? "被佔用" : port.usbId || "無 VID";
        return (
          '<button class="empty-slot" data-mpt-port="' +
          port.device +
          '"' +
          (port.busy ? " disabled" : "") +
          ' title="' +
          (port.busyReason || port.boardLabel) +
          " · " +
          port.device +
          '">' +
          '<span class="led" data-state="' +
          state +
          '"></span>' +
          '<span class="name" style="font-size:12px">' +
          port.device +
          "</span>" +
          '<span class="meta">' +
          port.boardLabel +
          " · " +
          note +
          "</span>" +
          "</button>"
        );
      })
      .join("");
    if (!usable.length) {
      slot.innerHTML +=
        '<span class="label" style="color:var(--amber)">全部都不可用</span>';
    }
  }

  function refreshPorts() {
    return api("/api/ports").then(function (result) {
      lastPorts = (result.body && result.body.ports) || [];
      renderPortList(lastPorts);
      log("找到", lastPorts.length, "個序列埠");
      var busy = lastPorts.filter(function (p) {
        return p.busy;
      });
      if (busy.length && busy[0].busyHint) {
        console.warn("[mpt] 埠被佔用：\n" + busy[0].busyHint);
      }
      return lastPorts;
    });
  }

  /* ── 3. 真正的連線流程 ───────────────────────────────────────────── */
  var realConnected = false;

  function setStripConnecting(device) {
    var slot = document.getElementById("strip-slot");
    if (!slot) return;
    slot.innerHTML =
      '<div class="ticket" data-active="true">' +
      '<span class="led" data-state="connecting"></span>' +
      '<span class="name">連線中…</span>' +
      '<span class="meta">' +
      device +
      "</span></div>" +
      '<span class="label" style="color:var(--bench-400)">偵測固件與檔案系統…</span>';
  }

  function setStripConnected(device, info) {
    var slot = document.getElementById("strip-slot");
    if (!slot) return;
    var version = (info && info.version) || "";
    slot.innerHTML =
      '<div class="ticket" data-active="true" title="作用中的裝置">' +
      '<span class="led" data-state="idle"></span>' +
      '<span class="name">' +
      device +
      "</span>" +
      '<span class="meta">' +
      (info && info.platform ? info.platform : "micro-python") +
      (version ? " · " + version : "") +
      "</span></div>" +
      '<button class="btn sm" data-mpt-disconnect="1">中斷</button>';

    var chip = document.getElementById("st-chip");
    if (chip) {
      chip.textContent =
        (info && info.uname ? info.uname : device) + (version ? " · " + version : "");
    }
    var fs = document.getElementById("st-fs");
    if (fs && info && info.files) {
      fs.textContent = "檔案系統：" + info.files;
    }
    var state = document.getElementById("repl-state");
    if (state) state.innerHTML = '<span class="chip led">就緒</span>';
  }

  async function realConnect(device, baudrate) {
    setStripConnecting(device);
    setStatus("connecting", "連線中…");
    var response = await api("/api/connect", {
      method: "POST",
      body: JSON.stringify({ device: device, baudrate: baudrate || 115200 }),
    });
    if (!response.ok) {
      var message = (response.body && response.body.error) || "連線失敗";
      var hint = (response.body && response.body.hint) || "";
      setStatus("error", "連線失敗");
      toast("err", message, hint, true);
      console.error("[mpt] 連線失敗", response.body);
      refreshPorts();
      return false;
    }
    realConnected = true;
    setStatus("idle", "已連線");
    setStripConnected(device, response.body.info);
    toast(
      "ok",
      "已連線 " + device,
      (response.body.info && response.body.info.version) || ""
    );
    // 讓 UI 進入「有裝置」的狀態（原本是假 connect() 在做這件事）
    if (typeof S !== "undefined") {
      S.connected = true;
      S.board.name = device;
      if (response.body.info) {
        S.board.fw = response.body.info.version || S.board.fw;
        if (response.body.info.uname) S.board.chip = response.body.info.uname;
      }
      try {
        renderSide();
        renderCanvas();
        renderTerm();
      } catch (error) {
        log("UI 重繪失敗（不影響連線）", error);
      }
    }
    return true;
  }

  async function realDisconnect() {
    await api("/api/disconnect", { method: "POST", body: "{}" });
    realConnected = false;
    setStatus("off", "未連線");
    if (typeof S !== "undefined") {
      S.connected = false;
    }
    var state = document.getElementById("repl-state");
    if (state) state.innerHTML = "";
    try {
      renderSide();
      renderCanvas();
      renderTerm();
    } catch (error) {
      log("UI 重繪失敗", error);
    }
    await refreshPorts();
    toast("warn", "已中斷連線", "裝置已釋放。");
  }

  /* ── REPL 控制 ───────────────────────────────────────────────────── */
  async function interruptDevice() {
    if (!realConnected) return toast("warn", "尚未連線裝置");
    var response = await api("/api/exec", {
      method: "POST",
      body: JSON.stringify({ code: "pass", timeout: 2 }),
    });
    if (response.ok && typeof termLine === "function") {
      termLine('<span class="amber">KeyboardInterrupt</span>');
    }
    toast("warn", "已送出中斷");
  }

  async function resetDevice() {
    if (!realConnected) return toast("warn", "尚未連線裝置");
    if (!window.confirm("要在裝置上執行 machine.reset() 嗎？裝置會重新啟動。")) return;
    await api("/api/exec", {
      method: "POST",
      body: JSON.stringify({ code: "import machine\nmachine.reset()\n", timeout: 2 }),
    });
    toast("ok", "裝置已重置", "重新連線中…");
  }

  /* ── 事件接管 ────────────────────────────────────────────────────── */
  document.addEventListener(
    "click",
    function (event) {
      var portButton = event.target.closest("[data-mpt-port]");
      if (portButton) {
        event.preventDefault();
        event.stopImmediatePropagation();
        realConnect(portButton.dataset.mptPort, 115200);
        return;
      }
      if (event.target.closest("[data-mpt-disconnect]")) {
        event.preventDefault();
        event.stopImmediatePropagation();
        realDisconnect();
        return;
      }
      var action = event.target.closest("[data-act]");
      if (!action) return;
      var act = action.dataset.act;
      if (act === "repl-interrupt") {
        event.preventDefault();
        event.stopImmediatePropagation();
        interruptDevice();
      } else if (act === "repl-reset") {
        event.preventDefault();
        event.stopImmediatePropagation();
        resetDevice();
      } else if (act === "repl-clear") {
        event.preventDefault();
        event.stopImmediatePropagation();
        var term = document.getElementById("term");
        if (term) term.innerHTML = "";
      } else if (act === "connect") {
        // 攔截假的 connect()，改走真實流程
        event.preventDefault();
        event.stopImmediatePropagation();
        refreshPorts().then(function (ports) {
          var usable = ports.filter(function (p) {
            return !p.busy;
          });
          if (!usable.length) {
            toast("err", "沒有可用的序列埠", "用 `mpt ports` 看是哪個程式佔用了它。", true);
            return;
          }
          if (usable.length === 1) {
            realConnect(usable[0].device, 115200);
            return;
          }
          // 多個可用埠時，讓使用者從 Board Strip 上挑
          toast("warn", "請選擇序列埠", "上方已列出 " + usable.length + " 個可用的埠。");
        });
      }
    },
    true // capture：必須在原型自己的 handler 之前攔到
  );

  /* ── WebSocket：即時事件 ─────────────────────────────────────────── */
  function connectSocket() {
    var protocol = location.protocol === "https:" ? "wss:" : "ws:";
    var socket = new WebSocket(protocol + "//" + location.host + "/ws");
    socket.onmessage = function (event) {
      var payload;
      try {
        payload = JSON.parse(event.data);
      } catch (error) {
        return;
      }
      if (payload.type === "error") toast("err", payload.message, "", true);
      else if (payload.type === "connected") log("裝置已連線", payload.device);
      else if (payload.type === "disconnected") log("裝置已中斷");
    };
    socket.onclose = function () {
      setTimeout(connectSocket, 2000);
    };
  }

  /* ── 修正殘留的假文案（原型是設計稿，文案是為了展示而寫的）─────────── */
  function fixCopy() {
    var hint = document.querySelector(".empty .hint");
    if (hint) {
      hint.innerHTML =
        "由 Python 啟動器提供序列埠存取，不需要瀏覽器權限對話框，<br>" +
        "Firefox / Safari 也能用。找不到裝置請跑 <code>mpt ports</code>。";
    }
    var cta = document.querySelector('.empty [data-act="connect"]');
    if (cta) cta.textContent = "重新掃描序列埠";
  }

  // 原型會在載入後彈一個「原型已載入」的提示 —— 這裡不需要它。
  // 攔截 alert/toast 太侵入，所以直接等它出現再移除。
  function dropPrototypeToast() {
    var timers = [500, 1200, 2500];
    timers.forEach(function (delay) {
      setTimeout(function () {
        var toasts = document.querySelectorAll("#toasts .toast");
        [].forEach.call(toasts, function (node) {
          if (/原型已載入/.test(node.textContent || "")) node.remove();
        });
      }, delay);
    });
  }

  /* ── 啟動 ────────────────────────────────────────────────────────── */
  function boot() {
    installButtonFixes();
    fixCopy();
    dropPrototypeToast();
    var banner = document.getElementById("st-conn");
    if (banner) banner.textContent = "未連線";
    refreshPorts().then(function (ports) {
      var usable = ports.filter(function (p) {
        return !p.busy;
      });
      if (ports.length && !usable.length) {
        toast(
          "err",
          "所有序列埠都被佔用",
          "請關掉佔用的程式（多半是 VS Code 的 Serial Monitor）。",
          true
        );
      }
    });

    var hint = document.getElementById("st-hint");
    if (hint) {
      hint.innerHTML = "Python 啟動器 · <kbd>Ctrl K</kbd> 命令面板";
    }
    connectSocket();
    log("bridge 已載入");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
