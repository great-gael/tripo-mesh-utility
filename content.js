/* 在扩展的隔离环境（isolated world）中与 Tripo 页面并行运行。

   拥有 overlay（位于一个 shadow root 内），接收由 page-hook.js 捕获的
   网格，运行分析，为素材库卡片打上判定角标，
   并交还修复后的 .glb。 */
(function () {
  "use strict";

  var api = (typeof browser !== "undefined") ? browser : chrome;

  /* 这个扩展关于自身所说的一切都带着这个前缀。如果没有一行带版本号的启
     动信息，从外面就无法区分究竟是旧版本在运行，还是新版本什么也没做——
     而恰恰是在这一点上，好几次诊断都失败了。 */
  var TAG = "[Tripo Mesh Utility]";
  function say() {
    try {
      var a = Array.prototype.slice.call(arguments);
      a.unshift(TAG);
      console.info.apply(console, a);
    } catch (e) { /* 诊断绝不允许干扰页面 */ }
  }
  try { say((api.runtime.getManifest() || {}).version + " ready"); } catch (e) { say("ready"); }

  /* 自检在三个内嵌文件上跑完整条链路：带 Inflate 的 FBX、带 Meshopt 的
     GLB、未压缩的 GLB。它只花几毫秒，却在启动时就回答了那个原本只能靠
     某人打开一个模型再来汇报才能弄清的问题。一旦失败，答案就明明白白
     写在那里，早于第一个用户察觉到任何异常。 */
  try {
    var mod = self.T3D;
    if (mod && mod.selbsttest) {
      var st = mod.selbsttest(mod);
      var schlecht = st.filter(function (e) { return !e.ok; });
      if (!schlecht.length) {
        say("self-test passed: " + st.map(function (e) { return e.schluessel; }).join(", "));
      } else {
        schlecht.forEach(function (e) { say("SELF-TEST FAILED - " + e.was + ": " + e.warum); });
      }
    }
  } catch (e) { say("the self-test itself failed: " + ((e && e.message) || e)); }
  var T3D = self.T3D;
  var site = T3D.site;

  var cfg = Object.assign({}, T3D.settings.DEFAULTS);
  var host = null, root = null, ui = {}, viewer = null;
  var state = { mesh: null, an: null, ins: null, v: null, name: "", raw: null, open: false };
  var history = [];              // { id, name, verdict, tris } — 仅限本次会话
  var byTask = Object.create(null); // task id -> 判定颜色，用于卡片角标

  /* ---- 页面钩子 -----------------------------------------------------
     这两个脚本运行在页面上下文里，而且必须在 Tripo 的 bundle 开始工作
     之前就到位：page-hook.js 要早于第一次 fetch，page-gl.js 要早于那个
     由它把几何数据递出来的场景的产生。

     以前它们是串起来的，每一个都等着前一个的 onload。page-hook.js 因此
     排在最后，要经过两轮完整的加载过程——在缓存已热的情况下就错过了模
     型的下载。面板于是停在 "No mesh yet"，而且没有任何东西提示原因。

     由脚本插入的 <script src> 默认是 async 的，会以任意顺序运行。设置
     async = false 后它们并行加载，却仍按插入顺序执行。所以钩子排在最
     前面，免得它错过下载。 */
  function injectPageScripts(paths) {
    var parent = document.head || document.documentElement;
    for (var i = 0; i < paths.length; i++) {
      try {
        var sc = document.createElement("script");
        sc.async = false;
        sc.src = api.runtime.getURL(paths[i]);
        sc.onload = function () { this.remove(); };
        parent.appendChild(sc);
      } catch (e) {
        console.warn("[Tripo Mesh Utility] could not inject " + paths[i], e);
      }
    }
  }
  injectPageScripts(["page-hook.js", "page-gl.js"]);

  /* ---- 分析，尽可能放在主线程之外 ----------------------------------- */
  var workerURL = null, workerTried = false;

  function ensureWorker() {
    if (workerTried) return Promise.resolve(workerURL);
    workerTried = true;
    return fetch(api.runtime.getURL("lib/analyze.js"))
      .then(function (r) { return r.text(); })
      .then(function (src) {
        var glue = src + "\nself.onmessage=function(e){try{" +
          "var a=self.T3D.buildAnalysis(new Float32Array(e.data.p),new Uint32Array(e.data.i),e.data.o);" +
          "self.postMessage({ok:true,a:a});}catch(err){self.postMessage({ok:false});}};";
        workerURL = URL.createObjectURL(new Blob([glue], { type: "text/javascript" }));
        return workerURL;
      })
      .catch(function () { return null; });
  }

  function analyse(mesh) {
    var opts = { sliverQ: cfg.sliverQ, minHoleEdges: cfg.minHoleEdges };
    return ensureWorker().then(function (url) {
      if (!url) return T3D.buildAnalysis(mesh.positions, mesh.indices, opts);
      return new Promise(function (resolve) {
        var w, done = false;
        function fall() {
          if (done) return;
          done = true;
          try { w && w.terminate(); } catch (e) {}
          resolve(T3D.buildAnalysis(mesh.positions, mesh.indices, opts));
        }
        try {
          w = new Worker(url);
          w.onerror = fall;
          w.onmessage = function (ev) {
            if (done) return;
            done = true;
            w.terminate();
            if (ev.data && ev.data.ok) resolve(ev.data.a); else fall();
          };
          /* 先做副本，好让用于渲染的缓冲区保持完好，然后把这些副本转交
             出去，而不是让它们再被克隆第二次。在 640k 三角形时这能省下
             约 15 MB。 */
          var pc = mesh.positions.buffer.slice(0), ic = mesh.indices.buffer.slice(0);
          w.postMessage({ p: pc, i: ic, o: opts }, [pc, ic]);
        } catch (e) { fall(); }
      });
    });
  }

  /* ---- dom 辅助函数 -------------------------------------------------- */
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  /* 固定语言，而不是跟随系统。在一台德语机器上，toLocaleString() 把
     93724 变成了字符串 "93.724" —— 挨着英文标签，那个点看起来像小数
     分隔符，而且同一个界面在不同机器上显示出不同的数字。 */
  function fmt(n) { return Number(n).toLocaleString("en-US"); }

  /* 长名字要从中间截断，而不是从末尾：在
     "tripo_rigging_00000000-1111-2222-3333-444444444444.fbx" 里，前面是
     种类、后面是扩展名，真正让两者可区分的是中间那段。完整名字保留在
     tooltip 里。 */
  function kuerzeMitte(text, max) {
    text = String(text || "");
    if (text.length <= max) return text;
    var kopf = Math.ceil((max - 1) / 2), fuss = Math.floor((max - 1) / 2);
    return text.slice(0, kopf) + "\u2026" + text.slice(text.length - fuss);
  }

  function setzeTitel(name) {
    if (!ui.barName) return;
    ui.barName.textContent = kuerzeMitte(name, 34);
    ui.barName.title = name;
  }
  function pct(x) { return Math.round(x * 100) + "%"; }
  function bytes(n) {
    if (n > 1048576) return (n / 1048576).toFixed(1) + " MB";
    if (n > 1024) return Math.round(n / 1024) + " KB";
    return n + " B";
  }

  /* ---- 构建 ---------------------------------------------------------- */
  /* 与选项页上完全相同的字段，只是放在面板里而不是单独一个标签页。新开
     一个标签页会把人从上下文里扯出来：想调一个阈值，正是因为眼前摆着一
     个判定，调完还要立刻看到它对判定的影响。

     这份列表有意放在这里而不是 options.html：它是源头，选项页留给经由
     about:addons 的那条路。谁要加一个字段，就得在两处都加——这一点会被
     注意到，因为两边的标签文字是逐字一致的。 */
  var FELDER = [
    { art: "gruppe", text: "When to re-roll" },
    { k: "minHoleEdges", text: "Ignore holes smaller than this many edges", schritt: 1 },
    { k: "rerollHoles", text: "More holes than", schritt: 1 },
    { k: "rerollHoleEdges", text: "A single hole reaches this many edges", schritt: 1 },
    { k: "rerollFlipPercent", text: "Inverted faces exceed this share", schritt: 0.1, einheit: "%" },
    { k: "rerollOpenPercent", text: "Open edges exceed this share of all edges", schritt: 0.1, einheit: "%" },
    { k: "failNonManifold", text: "Non-manifold edges count against a mesh", art: "schalter" },
    { k: "rerollNonManifoldPercent", text: "\u2026but only above this share of all edges", schritt: 0.01, einheit: "%" },
    { art: "gruppe", text: "What to warn about" },
    { k: "warnStrayIslands", text: "Stray fragments floating off the model", art: "schalter" },
    { k: "warnNoUV", text: "Missing UVs", art: "schalter" },
    { k: "warnUVCoverage", text: "UV atlas used less than", schritt: 1, einheit: "%" },
    { k: "sliverQ", text: "Triangle quality below this counts as a sliver", schritt: 0.01 },
    { art: "gruppe", text: "Behaviour" },
    { k: "autoCheck", text: "Check meshes as they load", art: "schalter" },
    { k: "badgeCards", text: "Dot library thumbnails with their verdict", art: "schalter" }
  ];

  function baueEinstellungen() {
    var wurzel = el("div", "preferences-view");
    ui.prefFelder = {};

    var kopf = el("div", "preferences-head");
    var zurueck = el("button", "back-button");
    zurueck.type = "button";
    zurueck.appendChild(svgIcon(ICON.chevronLeft, 16));
    zurueck.appendChild(document.createTextNode("Back"));
    zurueck.addEventListener("click", function () { zeigeEinstellungen(false); });
    kopf.appendChild(zurueck);
    kopf.appendChild(el("strong", null, "Preferences"));
    wurzel.appendChild(kopf);

    var rumpf = el("div", "preferences-scroll");
    var feldgruppe = null;
    FELDER.forEach(function (f) {
      if (f.art === "gruppe") {
        feldgruppe = document.createElement("fieldset");
        var legende = document.createElement("legend");
        legende.textContent = f.text;
        feldgruppe.appendChild(legende);
        rumpf.appendChild(feldgruppe);
        return;
      }
      if (!feldgruppe) return;
      var zeile = el("label");
      zeile.appendChild(el("span", null, f.text));
      var eingabe = document.createElement("input");
      if (f.art === "schalter") {
        eingabe.type = "checkbox";
      } else {
        eingabe.type = "number";
        eingabe.min = "0";
        eingabe.step = String(f.schritt);
      }
      zeile.appendChild(eingabe);
      ui.prefFelder[f.k] = { el: eingabe, art: f.art };
      feldgruppe.appendChild(zeile);
    });

    /* 设计稿在这里展示那些平时只在运行中才会出现的状态。它们有意留在这
       里：第一次打开这个扩展的人，能先看到等着他的是什么。 */
    var proben = el("div", "state-samples");
    proben.appendChild(el("strong", null, "Analysis states"));
    var p1 = el("p");
    p1.appendChild(el("span", "spinner"));
    p1.appendChild(el("span", null, "Checking a mesh as it loads"));
    var p2 = el("p");
    p2.appendChild(svgIcon(ICON.check, 14));
    p2.appendChild(el("span", null, "Waiting for a mesh"));
    var p3 = el("p");
    p3.appendChild(svgIcon(ICON.download, 14));
    p3.appendChild(el("span", null, "Unsupported file. Export a .glb, .fbx, .obj or .stl."));
    proben.appendChild(p1); proben.appendChild(p2); proben.appendChild(p3);
    rumpf.appendChild(proben);
    wurzel.appendChild(rumpf);

    var dock = el("footer", "preferences-dock");
    var bFertig = el("button", "action primary");
    bFertig.type = "button";
    bFertig.appendChild(svgIcon(ICON.check, 16));
    bFertig.appendChild(document.createTextNode("Done"));
    bFertig.addEventListener("click", function () {
      var patch = {};
      Object.keys(ui.prefFelder).forEach(function (k) {
        var f = ui.prefFelder[k];
        if (f.art === "schalter") patch[k] = !!f.el.checked;
        else {
          var v = parseFloat(f.el.value);
          patch[k] = isNaN(v) ? T3D.settings.DEFAULTS[k] : v;
        }
      });
      T3D.settings.save(patch);
      for (var k2 in patch) cfg[k2] = patch[k2];
      /* 立刻重新判定：这个视图的意义就在于，在眼前这个网格上看到某个阈
         值的效果，而不是等到下一个网格。 */
      if (state.an) { state.v = T3D.verdict.decide(state.an, state.ins || { hasGLTF: false }, cfg); report(); }
      zeigeEinstellungen(false);
    });
    var bReset = el("button", "action");
    bReset.type = "button";
    bReset.appendChild(svgIcon(ICON.rotate, 15));
    bReset.appendChild(document.createTextNode("Reset"));
    bReset.addEventListener("click", function () { fuelleEinstellungen(T3D.settings.DEFAULTS); });
    dock.appendChild(bFertig);
    dock.appendChild(bReset);
    wurzel.appendChild(dock);

    return wurzel;
  }

  function fuelleEinstellungen(werte) {
    Object.keys(ui.prefFelder || {}).forEach(function (k) {
      var f = ui.prefFelder[k];
      if (f.art === "schalter") f.el.checked = !!werte[k];
      else f.el.value = werte[k];
    });
  }

  function zeigeEinstellungen(an) {
    if (!ui.prefs) return;
    if (an) fuelleEinstellungen(cfg);
    /* .preferences-view 在网格中占据第 2 到第 4 行，因而同时顶替了主体区
       和操作栏。这是切换，不是遮盖。 */
    ui.prefs.style.display = an ? "grid" : "none";
    if (ui.body) ui.body.style.display = an ? "none" : "";
    if (ui.dock) ui.dock.style.display = an ? "none" : "";
  }

  /* 自己的 tooltip，采用页面的风格。

     浏览器原生的那些是灰的、方的，还带着将近一秒的延迟——挨着 Tripo 的
     深色小框，看上去就像来自另一个程序。

     诀窍在于：已有的 title 属性原地保留，直到第一次鼠标划过时才被搬到
     data-tip 上。这样代码里那许多处赋值一处都不用动，包括每次出报告时
     重新设置的那些——如果某个 title 之后又被重新设置，下一次鼠标划过时
     它就会再搬一次。 */
  function tooltipsEinrichten(panel) {
    var tip = el("div", "tip");
    tip.style.display = "none";
    panel.appendChild(tip);
    ui.tip = tip;

    function traeger(start) {
      var n = start;
      while (n && n !== panel) {
        if (n.getAttribute && (n.getAttribute("data-tip") || n.getAttribute("title"))) return n;
        n = n.parentNode;
      }
      return null;
    }

    function zeige(n) {
      var t = n.getAttribute("title");
      if (t) { n.setAttribute("data-tip", t); n.removeAttribute("title"); }
      var text = n.getAttribute("data-tip");
      if (!text) return;

      tip.textContent = text;
      tip.style.display = "block";
      tip.style.left = "0px";
      tip.style.top = "0px";

      var pr = panel.getBoundingClientRect();
      var nr = n.getBoundingClientRect();
      var tr = tip.getBoundingClientRect();

      /* 放在元素上方，若那里有地方；否则放在下方。 */
      var oben = nr.top - pr.top - tr.height - 8;
      if (oben < 4) oben = nr.bottom - pr.top + 8;

      var links = nr.left - pr.left + (nr.width - tr.width) / 2;
      links = Math.max(6, Math.min(pr.width - tr.width - 6, links));

      tip.style.left = Math.round(links) + "px";
      tip.style.top = Math.round(oben) + "px";
    }

    function verstecke() { tip.style.display = "none"; }

    panel.addEventListener("mouseover", function (e) {
      var n = traeger(e.target);
      if (n) zeige(n); else verstecke();
    });
    panel.addEventListener("mouseleave", verstecke);
    panel.addEventListener("focusin", function (e) {
      var n = traeger(e.target);
      if (n) zeige(n);
    });
    panel.addEventListener("focusout", verstecke);
    /* 一点击它就消失：一个悬在刚被按下的按钮上方不走的小框，会挡住这个
       按钮的效果。 */
    panel.addEventListener("click", verstecke);
  }

  /* ---- 构建 ------------------------------------------------------------

     结构和类名来自 Lovable 设计稿 "Mesh Guardian"，是有意原封不动照搬
     过来的。那边的 CSS 正是针对这些名字写的；谁去改动它们，就是在仿造
     这份设计稿而不是采用它，最后只会得到某种相似的东西。 */

  function svgIcon(pfade, groesse, klasse) {
    var s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    s.setAttribute("viewBox", "0 0 24 24");
    s.setAttribute("width", groesse || 15);
    s.setAttribute("height", groesse || 15);
    s.setAttribute("fill", "none");
    s.setAttribute("stroke", "currentColor");
    s.setAttribute("stroke-width", "2");
    s.setAttribute("stroke-linecap", "round");
    s.setAttribute("stroke-linejoin", "round");
    if (klasse) s.setAttribute("class", klasse);
    pfade.forEach(function (d) {
      var p = document.createElementNS("http://www.w3.org/2000/svg", "path");
      p.setAttribute("d", d);
      s.appendChild(p);
    });
    return s;
  }

  /* 照着设计稿所用的 lucide 描摹而来。内嵌，是因为一个扩展不该去加载外
     部的图标集。 */
  var ICON = {
    minimize: ["M8 3v3a2 2 0 0 1-2 2H3", "M21 8h-3a2 2 0 0 1-2-2V3", "M3 16h3a2 2 0 0 1 2 2v3", "M16 21v-3a2 2 0 0 1 2-2h3"],
    chevronDown: ["m6 9 6 6 6-6"],
    chevronLeft: ["m15 18-6-6 6-6"],
    check: ["M20 6 9 17l-5-5"],
    save: ["M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z", "M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7", "M7 3v4a1 1 0 0 0 1 1h7"],
    download: ["M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4", "M7 10l5 5 5-5", "M12 15V3"],
    settings: ["M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z", "M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6 1.65 1.65 0 0 0 10 3.09V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9c.14.36.4.66.73.86H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"],
    rotate: ["M3 12a9 9 0 1 0 3-6.7L3 8", "M3 3v5h5"],
    grip: ["M5 9h14", "M5 15h14"]
  };

  function tripoIcon() {
    var s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    s.setAttribute("class", "tripo-icon");
    s.setAttribute("viewBox", "0 0 24 24");
    s.setAttribute("role", "img");
    s.setAttribute("aria-label", "Tripo AI");
    var a = document.createElementNS("http://www.w3.org/2000/svg", "path");
    a.setAttribute("class", "tripo-icon-accent");
    a.setAttribute("d", "M12.661 4.752a.04.04 0 0 0-.013-.055.038.038 0 0 0-.02-.005H6.496a.19.19 0 0 1-.165-.092L4.245 1.052a.034.034 0 0 1 .014-.047A.038.038 0 0 1 4.275 1c5.492 0 10.733 0 15.721.002 2.089 0 3.699 1.54 4.003 3.598.008.062-.019.092-.08.092h-6.67a.204.204 0 0 0-.174.1c-1.414 2.41-2.82 4.803-4.218 7.178-.28.472-.92.62-1.373.342-.19-.116-.357-.304-.502-.561a37.917 37.917 0 0 0-.882-1.489c-.222-.356-.234-.707-.035-1.052a661.77 661.77 0 0 1 2.597-4.46v.002Z");
    var b = document.createElementNS("http://www.w3.org/2000/svg", "path");
    b.setAttribute("d", "M10.772 16.986c.57.972 1.935.916 2.489-.028L19 7.164a.127.127 0 0 1 .116-.067h4.23c.017 0 .03.014.028.03 0 .005-.001.01-.003.013-2.605 4.432-5.232 8.906-7.88 13.42-1.283 2.191-4.278 2.517-6.179.947-.308-.254-.665-.727-1.069-1.417C5.718 15.766 3.145 11.38.523 6.928-.54 5.125.099 2.981 1.713 1.728c.053-.041.095-.033.129.023 2.905 4.95 5.882 10.029 8.93 15.236Z");
    s.appendChild(a); s.appendChild(b);
    return s;
  }

  function build() {
    if (host) return;
    host = document.createElement("div");
    host.id = "tripo-mesh-tools-root";
    root = host.attachShadow({ mode: "open" });

    var css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = api.runtime.getURL("ui/overlay.css");
    root.appendChild(css);

    /* 最外层的壳承载位置、尺寸和折叠状态——在设计稿里那就是
       .mesh-panel。 */
    var wrap = el("div", "mesh-panel");
    if (cfg.panelWidth) wrap.style.setProperty("--panel-width", cfg.panelWidth + "px");
    if (cfg.panelHeight) wrap.style.height = cfg.panelHeight + "px";
    root.appendChild(wrap);
    ui.wrap = wrap;

    var grOben = el("div", "resize-handle resize-top");
    var grLinks = el("div", "resize-handle resize-left");
    wrap.appendChild(grOben);
    wrap.appendChild(grLinks);

    /* ---- 折叠状态的小方块 ---- */
    var chip = el("button", "collapsed-tile");
    chip.type = "button";
    chip.setAttribute("aria-label", "Open Mesh Verdict");
    ui.chipDot = el("span", "status-dot");
    var copy = el("span", "collapsed-copy");
    ui.chipTxt = el("strong", null, "Mesh tools");
    ui.chipSub = el("small", null, "");
    copy.appendChild(ui.chipTxt);
    copy.appendChild(ui.chipSub);
    chip.appendChild(ui.chipDot);
    chip.appendChild(copy);
    chip.appendChild(svgIcon(ICON.chevronLeft, 16));
    chip.addEventListener("click", function () { toggle(true); });
    wrap.appendChild(chip);
    ui.chip = chip;

    /* ---- 展开的面板 ---- */
    var panel = el("div", "panel-open");
    wrap.appendChild(panel);
    ui.panel = panel;

    var bar = el("header", "titlebar");
    var marke = el("div", "brand-lockup");
    marke.appendChild(tripoIcon());
    ui.barName = el("strong", "window-title", "Tripo Mesh Utility");
    marke.appendChild(ui.barName);
    bar.appendChild(marke);
    var griffZeichen = svgIcon(ICON.grip, 19, "drag-glyph");
    bar.appendChild(griffZeichen);
    var bClose = el("button", "icon-button");
    bClose.type = "button";
    bClose.title = "Collapse";
    bClose.appendChild(svgIcon(ICON.minimize, 15));
    bClose.addEventListener("click", function (e) { e.stopPropagation(); toggle(false); });
    bar.appendChild(bClose);
    panel.appendChild(bar);
    makeDraggable(bar, wrap);

    /* ---- 可滚动区域 ---- */
    var body = el("div", "panel-scroll");
    panel.appendChild(body);
    ui.body = body;

    /* 判定 */
    ui.verdict = el("section", "verdict");
    ui.banner = ui.verdict;
    var kicker = el("div", "verdict-kicker");
    ui.verdictDot = el("span", "status-dot");
    kicker.appendChild(ui.verdictDot);
    kicker.appendChild(document.createTextNode("Verdict"));
    ui.call = el("h1", null, "Waiting for a mesh");
    ui.why = el("p", null, "Open or generate a model and it gets checked as it loads. You can also drop a .glb, .obj, .stl or .fbx here.");
    ui.warnings = el("div", "warnings");
    ui.verdict.appendChild(kicker);
    ui.verdict.appendChild(ui.call);
    ui.verdict.appendChild(ui.why);
    ui.verdict.appendChild(ui.warnings);
    body.appendChild(ui.verdict);

    /* 舞台 */
    var stage = el("section", "viewer");
    ui.stage = stage;
    ui.canvas = document.createElement("canvas");
    ui.canvas.className = "mesh-canvas";
    stage.appendChild(ui.canvas);
    var vl = el("div", "viewer-label", "Inspection view ");
    vl.appendChild(el("span", null, "drag to orbit, right-drag to pan"));
    stage.appendChild(vl);

    ui.empty = el("div", "stage-empty");
    ui.emptyTitle = el("strong", null, WAIT_TITLE);
    ui.emptyHint = el("span", null, WAIT_HINT);
    ui.empty.appendChild(ui.emptyTitle);
    ui.empty.appendChild(ui.emptyHint);
    stage.appendChild(ui.empty);

    var tog = el("div", "viewer-controls");
    ui.tBack = toggleChip(tog, "Back faces", "bad", cfg.showBackFaces, function (v) {
      if (viewer) viewer.showBack = v;
      T3D.settings.save({ showBackFaces: v });
    });
    ui.tEdge = toggleChip(tog, "Open edges", "edge", cfg.showOpenEdges, function (v) {
      if (viewer) viewer.showEdges = v;
      T3D.settings.save({ showOpenEdges: v });
    });
    ui.tAll = toggleChip(tog, "All holes", "edge", cfg.showAllHoles, function (v) {
      if (viewer) viewer.showAllHoles = v;
      /* 没有边界边的话这个开关就毫无作用，看起来会像是个 bug。另一个开
         关会跟着一起明显地跳过去，所以这不是一个悄悄发生的副作用。 */
      if (v && ui.tEdge && !ui.tEdge.checked) {
        ui.tEdge.checked = true;
        if (viewer) viewer.showEdges = true;
        T3D.settings.save({ showOpenEdges: true });
      }
      T3D.settings.save({ showAllHoles: v });
      /* 报告里的数字跟着一起变——否则面板数出 18 个，而画面里亮着 35
         个。判定本身不受影响。 */
      if (state.an && state.v) report();
    });
    ui.tAll.title = "Also show the hairline holes below the threshold. They stay out of the verdict.";
    ui.tSpin = toggleChip(tog, "Turntable", "active", cfg.turntable, function (v) {
      if (viewer) viewer.spin = v;
      T3D.settings.save({ turntable: v });
    });
    stage.appendChild(tog);
    body.appendChild(stage);

    /* 检出项 */
    var sBef = el("section", "data-section");
    ui.bDetailsBef = el("button", "section-heading");
    ui.bDetailsBef.type = "button";
    var spanBef = el("span");
    spanBef.appendChild(el("strong", null, "Findings"));
    ui.befundZahl = el("small", null, "No mesh yet");
    spanBef.appendChild(ui.befundZahl);
    ui.bDetailsBef.appendChild(spanBef);
    ui.bDetailsBef.appendChild(svgIcon(ICON.chevronDown, 15));
    ui.rows = el("div", "finding-list");
    ui.bDetailsBef.addEventListener("click", function () {
      ui.rows.style.display = ui.rows.style.display === "none" ? "" : "none";
    });
    sBef.appendChild(ui.bDetailsBef);
    sBef.appendChild(ui.rows);
    body.appendChild(sBef);

    /* 事实数据 */
    var sFak = el("section", "data-section facts");
    ui.bDetails = el("button", "section-heading");
    ui.bDetails.type = "button";
    var spanFak = el("span");
    spanFak.appendChild(el("strong", null, "Mesh facts"));
    spanFak.appendChild(el("small", null, "Neutral measurements"));
    ui.bDetails.appendChild(spanFak);
    ui.bDetails.appendChild(svgIcon(ICON.chevronDown, 15));
    ui.details = el("div", "fact-list");
    ui.details.style.display = cfg.showDetails ? "" : "none";
    ui.bDetails.addEventListener("click", function () {
      var auf = ui.details.style.display === "none";
      ui.details.style.display = auf ? "" : "none";
      cfg.showDetails = auf;
      T3D.settings.save({ showDetails: auf });
    });
    sFak.appendChild(ui.bDetails);
    sFak.appendChild(ui.details);
    body.appendChild(sFak);

    ui.history = el("div", "history");
    body.appendChild(ui.history);

    /* ---- 操作栏 ---- */
    var dock = el("footer", "action-dock");
    ui.bSave = el("button", "action");
    ui.bSave.type = "button";
    ui.bSave.appendChild(svgIcon(ICON.save, 16));
    ui.bSave.appendChild(document.createTextNode("Save original"));
    ui.bSave.disabled = true;
    ui.bSave.addEventListener("click", doSave);

    ui.bFix = el("button", "action");
    ui.bFix.type = "button";
    ui.bFix.appendChild(svgIcon(ICON.download, 16));
    ui.bFix.appendChild(document.createTextNode("Download repaired .glb"));
    ui.bFix.disabled = true;
    ui.bFix.addEventListener("click", doRepair);

    dock.appendChild(ui.bSave);
    dock.appendChild(ui.bFix);

    ui.fixWhy = el("p");
    ui.fixWhy.style.display = "none";
    dock.appendChild(ui.fixWhy);

    ui.bPrefs = el("button", "preferences-link");
    ui.bPrefs.type = "button";
    ui.bPrefs.appendChild(svgIcon(ICON.settings, 14));
    ui.bPrefs.appendChild(document.createTextNode("Preferences"));
    ui.bPrefs.addEventListener("click", function () { zeigeEinstellungen(true); });
    dock.appendChild(ui.bPrefs);
    panel.appendChild(dock);
    ui.dock = dock;

    /* 读取场景的那个按钮仍然被创建出来，但不使用。 */
    ui.bGrab = el("button", "action");
    ui.bGrab.type = "button";
    ui.bGrab.disabled = true;
    ui.bGrab.addEventListener("click", function () { autoGriff = false; grabFromEngine(); });

    /* ---- 设置 ---- */
    ui.prefs = baueEinstellungen();
    ui.prefs.style.display = "none";
    panel.appendChild(ui.prefs);

    ui.fuss = dock;

    document.documentElement.appendChild(host);
    wireDrop(stage);
    tooltipsEinrichten(panel);
    griffMachen(grLinks, true, false);
    griffMachen(grOben, false, true);
    window.addEventListener("resize", klemmeHoehe);
    body.addEventListener("wheel", function (e) { e.stopPropagation(); }, { passive: true });

    toggle(false);
  }

  /* 在设计稿里这些开关是带 aria-pressed 的按钮，而在其余代码里却是复选
     框，其 .checked 被读取和设置——一共六处。与其把它们全都改一遍，不如
     给按钮加一个 checked 属性，由它顺带维护 aria-pressed。从外面看，一
     切照旧。 */
  function toggleChip(parent, label, tone, on, fn) {
    var b = el("button", "viewer-toggle");
    b.type = "button";
    var punkt = el("span", "toggle-dot" + (tone ? " " + tone : ""));
    punkt.setAttribute("aria-hidden", "true");
    b.appendChild(punkt);
    b.appendChild(el("span", null, label));

    var an = !!on;
    function setzen(v) {
      an = !!v;
      b.setAttribute("aria-pressed", an ? "true" : "false");
    }
    setzen(an);
    Object.defineProperty(b, "checked", {
      get: function () { return an; },
      set: function (v) { setzen(v); }
    });
    b.addEventListener("click", function () { setzen(!an); fn(an); });

    parent.appendChild(b);
    return b;
  }

  function doSave() {
    if (state.raw) download(state.raw, state.name || "mesh.glb");
  }

  /* 现在接收一个已存在的元素，因为在设计稿里这些拖拽手柄作为
     .resize-handle 已经出现在结构中了。 */
  function griffMachen(gr, waagerecht, senkrecht) {
    var wrap = ui.wrap;
    var zieht = false, sx = 0, sy = 0, sb = 0, sh = 0, sl = 0, so = 0;

    gr.addEventListener("pointerdown", function (e) {
      var r = wrap.getBoundingClientRect();
      zieht = true;
      sx = e.clientX; sy = e.clientY;
      sb = r.width; sh = r.height;
      sl = parseFloat(wrap.style.left) || 0;
      so = parseFloat(wrap.style.top) || 0;
      try { gr.setPointerCapture(e.pointerId); } catch (err) {}
      e.preventDefault(); e.stopPropagation();
    });

    gr.addEventListener("pointermove", function (e) {
      if (!zieht) return;
      if (waagerecht) {
        var breit = Math.max(340, Math.min(window.innerWidth - 40, sb + (sx - e.clientX)));
        wrap.style.setProperty("--panel-width", Math.round(breit) + "px");
        if (wrap.style.left) wrap.style.left = Math.max(4, Math.round(sl - (breit - sb))) + "px";
      }
      if (senkrecht) {
        var hoch = Math.max(280, Math.min(window.innerHeight - 40, sh + (sy - e.clientY)));
        wrap.style.height = Math.round(hoch) + "px";
        if (wrap.style.top) wrap.style.top = Math.max(4, Math.round(so - (hoch - sh))) + "px";
      }
      e.stopPropagation();
    });

    function fertig() {
      if (!zieht) return;
      zieht = false;
      var r = wrap.getBoundingClientRect();
      var patch = {};
      if (waagerecht) { cfg.panelWidth = Math.round(r.width); patch.panelWidth = cfg.panelWidth; }
      if (senkrecht) { cfg.panelHeight = Math.round(r.height); patch.panelHeight = cfg.panelHeight; }
      T3D.settings.save(patch);
    }
    gr.addEventListener("pointerup", fertig);
    gr.addEventListener("pointercancel", fertig);
  }


  /* 未被移动时面板挂在右下角，CSS 里针对 100vh 的高度钳制是对的。一旦
     有人拖着标题栏移动它，拖拽处理器就会设置 top 并清除 bottom——此后钳
     制仍按整个窗口高度计算，尽管实际可用的只剩新上边缘以下的那块地方。
     面板于是从下方溢出，而可滚动的主体区对此一无所知，因为它从来没有
     变得太小过。

     所以每拖动一次、每改变一次窗口大小，高度都要重新跟上。未被移动时，
     沿用 CSS 里的默认值。 */
  /* 关于面板不滚动这件事，三轮猜测什么也没换来。于是让它自己测量自己：
     它是不是比窗口还高，主体区是不是溢出了，overflow 到底有没有设成
     auto？一行输出把这三个问题全都回答了。 */
  function vermesseFenster() {
    try {
      var wrap = ui.panel && ui.panel.parentNode;
      if (!wrap || !ui.body) { say("panel metrics: panel not built yet"); return; }
      var wr = wrap.getBoundingClientRect();
      var pr = ui.panel.getBoundingClientRect();
      var br = ui.body.getBoundingClientRect();
      var cs = (window.getComputedStyle ? getComputedStyle(ui.body) : null);
      var ps = (window.getComputedStyle ? getComputedStyle(ui.panel) : null);
      say("panel metrics: window " + window.innerHeight +
        " | wrap top " + Math.round(wr.top) + " height " + Math.round(wr.height) +
        " (style.top " + (wrap.style.top || "-") + ", style.bottom " + (wrap.style.bottom || "-") + ")" +
        " | panel height " + Math.round(pr.height) +
        " maxHeight " + (ps ? ps.maxHeight : "?") +
        " display " + (ps ? ps.display : "?") +
        " | body height " + Math.round(br.height) +
        " scrollHeight " + ui.body.scrollHeight +
        " clientHeight " + ui.body.clientHeight +
        " overflowY " + (cs ? cs.overflowY : "?") +
        " minHeight " + (cs ? cs.minHeight : "?"));
    } catch (e) { say("panel metrics unreadable: " + ((e && e.message) || e)); }
  }

  function klemmeHoehe() {
    if (!ui.panel) return;
    var wrap = ui.panel.parentNode;
    if (!wrap || !wrap.style || !wrap.style.top) { ui.panel.style.maxHeight = ""; return; }
    var oben = parseFloat(wrap.style.top) || 0;
    ui.panel.style.maxHeight = Math.max(160, window.innerHeight - oben - 18) + "px";
  }

  function makeDraggable(handle, target) {
    var dx = 0, dy = 0, on = false;
    handle.addEventListener("pointerdown", function (e) {
      /* 不要去检查 tagName：自移植之后，标题栏的按钮里包含一个 <svg>，
         于是 e.target 就是这个 SVG，而不是按钮本身。守卫条件因此失效，
         标题栏开始拖动，并用 setPointerCapture 截走了指针——点击从来没
         能抵达按钮。closest() 问的是归属关系，而不是具体是哪个元素。 */
      if (e.target.closest && e.target.closest("button")) return;
      on = true;
      handle.classList.add("grabbing");
      var r = target.getBoundingClientRect();
      dx = e.clientX - r.left; dy = e.clientY - r.top;
      try { handle.setPointerCapture(e.pointerId); } catch (err) {}
    });
    handle.addEventListener("pointermove", function (e) {
      if (!on) return;
      target.style.left = Math.max(4, Math.min(window.innerWidth - 60, e.clientX - dx)) + "px";
      target.style.top = Math.max(4, Math.min(window.innerHeight - 40, e.clientY - dy)) + "px";
      target.style.right = "auto"; target.style.bottom = "auto";
      klemmeHoehe();
    });
    function stop() { on = false; handle.classList.remove("grabbing"); }
    handle.addEventListener("pointerup", stop);
    handle.addEventListener("pointercancel", stop);
  }

  function wireDrop(stage) {
    ["dragenter", "dragover"].forEach(function (t) {
      stage.addEventListener(t, function (e) {
        e.preventDefault(); e.stopPropagation();
        stage.classList.add("drop-target");
      });
    });
    ["dragleave", "drop"].forEach(function (t) {
      stage.addEventListener(t, function (e) {
        e.preventDefault(); e.stopPropagation();
        stage.classList.remove("drop-target");
      });
    });
    stage.addEventListener("drop", function (e) {
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) f.arrayBuffer().then(function (b) { ingest(b, f.name); });
    });
  }

  /* 折叠后的小方块该回到它原本所在的那个角落。

     有两件事挡着这一点。其一，移动面板会设置 left 和 top，并把 right 和
     bottom 切成 auto；缩小后的小方块此后就粘在原先面板左上角所在的位
     置。其二，行内高度会压过类规则 .is-collapsed { height: 56px }，于是
     小方块保留了面板的完整高度。

     所以折叠时会先把位置记下来，并把外壳复位到角落里；展开时再把它取
     回来。 */
  function toggle(open) {
    build();
    state.open = open;
    var w = ui.wrap;

    if (!open) {
      ui.gemerkt = {
        left: w.style.left, top: w.style.top,
        right: w.style.right, bottom: w.style.bottom,
        height: w.style.height
      };
      w.style.left = ""; w.style.top = "";
      w.style.right = ""; w.style.bottom = "";
      w.style.height = "";
    } else if (ui.gemerkt) {
      w.style.left = ui.gemerkt.left; w.style.top = ui.gemerkt.top;
      w.style.right = ui.gemerkt.right; w.style.bottom = ui.gemerkt.bottom;
      w.style.height = ui.gemerkt.height;
    }

    w.className = "mesh-panel" + (open ? "" : " is-collapsed");

    /* viewer 直到第一次打开时才被创建：一个 WebGL 上下文要占内存，而从
       不展开面板的人不该为它付这个代价。 */
    if (open && !viewer) {
      try {
        viewer = new T3D.Viewer(ui.canvas);
        viewer.showBack = ui.tBack.checked;
        viewer.showEdges = ui.tEdge.checked;
        viewer.showAllHoles = ui.tAll.checked;
        viewer.spin = ui.tSpin.checked;
        if (state.mesh && state.an) viewer.setMesh(state.mesh, state.an);
      } catch (err) { showError(err.message || String(err)); }
    }
    if (open) klemmeHoehe();
  }

  /* 消息落在面板里，调用栈落在控制台里。没有调用栈的话，遇到像
     "Permission denied to access property constructor" 这样的错误就看不
     出是哪一行引发的——而恰恰这类错误只在浏览器里出现，在 Node 测试套
     件里从不出现。 */
  /* Firefox 用 Xray 包装器把页面上下文和扩展上下文隔开。来自这条边界另
     一侧的缓冲区，并不总能直接套上一个类型化视图——这么试就会抛出
     "Permission denied to access property constructor"，而且是在解析器
     深处、谁也料想不到的地方抛出。所以在任何人查看它之前，缓冲区先在
     这里被复制进我们自己的上下文一次。这份副本的代价是把字节遍历一
     遍；在 5 MB 的量级上，相比让后面每一个读取者都不必再面对这个问题
     的好处，这不算什么。 */
  function eigenerPuffer(buf) {
    /* 跨越上下文边界的既定做法。structuredClone 在调用方的上下文里生成
       副本，正是为这种情形而造的——下面的其余一切只是后备方案，以防它
       在这里哪天不可用。 */
    try {
      if (typeof structuredClone === "function") return structuredClone(buf);
    } catch (e) {
      say("structuredClone refused (" + ((e && e.message) || e) + ")");
    }
    try {
      var quelle = new Uint8Array(buf);
      var ziel = new Uint8Array(quelle.length);
      ziel.set(quelle);
      return ziel.buffer;
    } catch (e) {
      say("buffer cannot be read directly (" + ((e && e.message) || e) + "), trying byte by byte");
    }
    /* 第二次尝试，不对这个外来对象使用类型化视图。 */
    try {
      var n = buf.byteLength, ziel2 = new Uint8Array(n);
      var dv = new DataView(buf);
      for (var i = 0; i < n; i++) ziel2[i] = dv.getUint8(i);
      return ziel2.buffer;
    } catch (e2) {
      say("not readable byte by byte either: " + ((e2 && e2.message) || e2));
      return buf;
    }
  }

  /* 那份详尽的诊断——计数器、来源路径、见到过的全部请求——支撑了整整一
     天的排错，并且应当随时都能重新用上。但每次运行都把它打印出来就是噪
     音，而且它还会顺带记录下每一个访问过的地址。所以它恰好在被需要的时
     候才出现：即在出报告的那一刻还没有任何文件被采集到。健康的一次运行
     保持安静，一次哑掉的运行则自己解释自己。 */
  function sagFallsStill() {
    if (lastKey || state.an) return false;
    return true;
  }

  function melden(wo, err) {
    try {
      say("error in " + wo + ": " + ((err && err.message) || err));
      if (err && err.stack) say(err.stack);
    } catch (e) { /* 诊断绝不允许干扰页面 */ }
  }

  function showError(msg) {
    build();
    var box = root.querySelector(".err");
    if (!box) {
      box = el("div", "err");
      /* 放在判定上方、可滚动区域内——人们最先看的就是那里。 */
      if (ui.body && ui.verdict && ui.verdict.parentNode === ui.body) {
        ui.body.insertBefore(box, ui.verdict);
      } else if (ui.body) {
        ui.body.appendChild(box);
      }
    }
    box.textContent = msg;
  }
  function clearError() {
    var box = root && root.querySelector(".err");
    if (box) box.remove();
  }

  /* ---- 采集（ingest） ------------------------------------------------ */
  var lastKey = "";
  var engineSeen = false;

  /* 自动去场景里抓取时，不能随手抓到什么就要什么。如果 Tripo 还在显示
     一张预览图，那场景里就只有辅助对象——当时量到的是 12 个三角形，包围
     盒为 0 x 3.1 x 2.2，也就是一个平面，而面板还心平气和地宣称
     “50% 的面是反的”。抓错比不抓更糟。所以低于这个阈值时
     会再等一等，等上几次，然后就放弃。按钮不受此影响：手动去抓的人，
     就是有意要抓。 */
  var AUTO_MIN_TRIS = 100;
  var autoGriff = false, autoVersuche = 0, AUTO_MAX = 6;

  /* 几秒钟之后就能定下来是哪条路走通了。

     没有引擎上报：按钮保持关闭，但至少说明为什么，而不是默默地灰在那
     里。

     引擎在，但没有下载到达：那就是网络钩子错过了这次下载——它可能装得
     太晚，文件也可能来自一个 worker 或来自缓存。几何数据无论如何都可见
     地摆在场景里，所以就从那里读取，而不是让用户对着一个空面板干坐着。
     此后标题写的是 "viewer scene (...)" 而不是文件名——两条路依旧可以
     区分，而且这一条无法进行修复。 */
  setTimeout(function () {
    if (sagFallsStill()) {
      say("status after 6s: engineSeen=" + engineSeen +
        ", download captured=" + !!lastKey + ", analysis done=" + !!state.an +
        ", autoCheck=" + !!cfg.autoCheck);
    }
    if (!engineSeen) {
      say("no three.js scene was announced - the button stays off");
      if (ui.bGrab) ui.bGrab.title = "No three.js scene was announced by this page, so there is nothing to read from.";
      return;
    }
    /* lastKey 在 ingest() 的最开头就被设置，也就是说，即便分析还在跑或
       者解析失败了，它也已经有值。一次被拒绝的下载不该被场景悄悄顶替
       掉——否则那条正在解释情况的拒绝说明就白白消失了。 */
    if (lastKey || state.an || !cfg.autoCheck) {
      say("no fallback needed or permitted");
      return;
    }
    say("no download captured - reading the scene from the viewer");
    autoGriff = true;
    grabFromEngine();
  }, 6000);

  function fingerprint(buffer) {
    try {
      var n = buffer.byteLength;
      if (n < 64) return "0";
      var probe = new Uint8Array(buffer, Math.floor(n / 2) - 16, 32);
      var h = 0;
      for (var i = 0; i < probe.length; i++) h = (h * 31 + probe[i]) | 0;
      return String(h);
    } catch (e) { return "0"; }
  }

  var WAIT_TITLE = "Waiting for a mesh";
  var WAIT_HINT = "Open or generate a model and it gets checked as it loads. You can also drop a .glb, .obj or .stl here.";

  /* 只要分析还在跑，空状态就在撒谎：它声称 "Waiting for a mesh"，而网格
     早就到了，正在被检查。在 180 万个三角形的规模下，这个过程长到足以
     看起来像卡死，而这个症状也正是这样被长期误读成“网络钩子没起作用”。
     一个在自己状态上撒谎的检查器，比一个慢的检查器更糟。 */
  function setEmpty(title, hint) {
    if (!ui.emptyTitle) return;
    ui.emptyTitle.textContent = title;
    ui.emptyHint.textContent = hint;
    /* 谁设置了空状态，就是想看到它。一旦真正的数字出现，report() 会把
       它隐藏起来。 */
    if (ui.empty) ui.empty.style.display = "";
  }

  function ingest(buffer, name) {
    build();
    /* 光有名字加大小还不够：Tripo 会用同一个文件名交付多次生成结果，其
       中两次有可能碰巧一样大。取中间的几个字节，才让这个键站得住。 */
    var key = name + ":" + buffer.byteLength + ":" + fingerprint(buffer);
    if (key === lastKey && state.an) return;
    lastKey = key;

    clearError();

    buffer = eigenerPuffer(buffer);
    state.name = name;
    state.raw = buffer;
    setzeTitel(name);
    setChip("", "Checking\u2026");
    setEmpty("Checking " + name,
      "Reading topology. On a dense mesh this takes a moment. The mesh is here, not missing.");

    /* 在一个 11.9 MB 的 GLB 上，“已采集”和“已检查”之间隔着好几秒的沉
       默——先解压到足足 34 MB，然后才是分析。可沉默是无法与卡死区分开
       的，而今天空状态恰恰就栽在这一点上。所以每一个阶段都要说出它什么
       时候完成的、花了多长时间。 */
    var t0 = Date.now();
    var mesh;
    try { mesh = T3D.parseAny(buffer, name); }
    catch (err) {
      melden("parseAny", err);
      setChip("", "Mesh tools");
      setEmpty(WAIT_TITLE, WAIT_HINT);
      showError(err.message || String(err));
      return;
    }

    say("parsed in " + (Date.now() - t0) + " ms: " + (mesh.indices.length / 3) +
      " triangles, analysing...");
    var t1 = Date.now();
    analyse(mesh).then(function (an) {
      var ins;
      try { ins = T3D.inspect(mesh, T3D.readAccessor); } catch (e) { ins = { hasGLTF: false }; }
      state.mesh = mesh; state.an = an; state.ins = ins;
      state.v = T3D.verdict.decide(an, ins, cfg);
      say("checked in " + (Date.now() - t1) + " ms: " + name + " - " + an.triCount + " triangles, " + an.holes + " holes, " +
        an.nonManifold + " non-manifold" + (an.windingUnstable ? ", winding contradicts itself" : "") +
        " -> " + state.v.call);
      if (viewer) viewer.setMesh(mesh, an);
      if (ui.empty) ui.empty.style.display = "none";
      report();
  
      remember();
      refreshCards();
    }).catch(function (err) {
      melden("analyse", err);
      setEmpty(WAIT_TITLE, WAIT_HINT);
      showError(err && err.message ? err.message : String(err));
    });
  }

  function remember() {
    var id = site.currentTaskId() || site.taskIdFrom(state.name) || state.name;
    byTask[id] = state.v.color;
    history = history.filter(function (h) { return h.id !== id; });
    history.unshift({ id: id, name: state.name, v: state.v, tris: state.an.triCount });
    history = history.slice(0, 8);
    renderHistory();
  }

  function renderHistory() {
    if (!ui.history || history.length < 2) { if (ui.history) ui.history.style.display = "none"; return; }
    ui.history.style.display = "flex";
    ui.history.innerHTML = "";
    ui.history.appendChild(el("span", "hlabel", "This session"));
    history.forEach(function (h, i) {
      var d = el("span", "hdot");
      d.style.background = h.v.color;
      d.title = h.v.chip + " \u2014 " + h.name + " (" + fmt(h.tris) + " tris)";
      if (i === 0) d.classList.add("current");
      ui.history.appendChild(d);
    });
  }

  function setChip(color, text, sub) {
    if (!ui.chipDot) return;
    /* 设计稿里的这个小方块带一个圆点、一行主文字和一行副文字——不再是
       拼接起来的一段文本片段。 */
    ui.chipDot.className = "status-dot" + (color ? " " + color : "");
    ui.chipTxt.textContent = text;
    ui.chipSub.textContent = sub || "";
  }

  /* 判定等级在这里变成圆点的 class。 */
  function stufeZuTon(level) {
    if (level === "reroll" || level === "flip") return "bad";
    if (level === "minor") return "warn";
    if (level === "clean") return "clean";
    return "";
  }


  function report() {
    var an = state.an, ins = state.ins, v = state.v;

    /* ---- 判定 ---- */
    var ton = stufeZuTon(v.level);
    ui.verdict.setAttribute("data-verdict", v.level);
    ui.verdictDot.className = "status-dot" + (ton ? " " + ton : "");
    ui.call.textContent = v.call;
    ui.why.textContent = v.why;

    ui.warnings.textContent = "";
    (v.warnings || []).forEach(function (w) {
      ui.warnings.appendChild(el("span", null, w));
    });

    setChip(ton, v.chip, fmt(an.triCount) + " tris");
    if (ui.empty) ui.empty.style.display = "none";

    /* ---- 检出项 ----
       每个检出项一行：数值、带解释的名称、严重程度。
       为零的那些，最后归并成一行。 */
    ui.rows.textContent = "";
    var befunde = [], heil = [];
    function messe(wert, name, detail, stufe) {
      if (wert) befunde.push({ wert: wert, name: name, detail: detail, stufe: stufe || "warn" });
      else heil.push(name);
    }

    /* 只算看得见的那些。极小的那些会被提及，但不计入——什么都没有被隐
       瞒，只是没有一起算进去。 */
    var loecherGross = (an.holesBig != null) ? an.holesBig : an.holes;
    var loecherKlein = an.holes - loecherGross;
    var alleZeigen = !!(ui.tAll && ui.tAll.checked);
    var loecherZahl = alleZeigen ? an.holes : loecherGross;
    var schwelle = (an.minHoleEdges != null) ? an.minHoleEdges : cfg.minHoleEdges;
    var zusatz = "";
    if (loecherKlein) {
      /* 打开开关后，极小的那些会一起被计数，但旁边会写明它们不进入判
         定——否则这个数字就会与上方的判定理由自相矛盾。 */
      zusatz = alleZeigen
        ? ", " + fmt(loecherKlein) + " under " + schwelle + " edges and not judged"
        : ", plus " + fmt(loecherKlein) + " hairline";
    }
    messe(loecherZahl, "Holes",
      loecherZahl ? "largest " + fmt(an.largestHole) + " edges" + zusatz : "", "warn");
    if (an.windingUnstable) {
      messe(an.inconsistentEdges, "Winding breaks", "faces contradict each other", "bad");
    } else {
      messe(an.flippedTris, "Inverted",
        an.insideOut ? "against an inside-out shell" : fmt(an.inconsistentEdges) + " winding breaks", "bad");
    }
    messe(an.nonManifold, "Non-manifold", "more than two faces sharing", "bad");
    messe(an.strayIslands, "Fragments", "loose pieces off the model", "warn");
    messe(an.slivers > an.triCount * 0.02 ? an.slivers : 0, "Slivers", "too thin to bake cleanly", "warn");
    messe(an.duplicateFaces, "Duplicates", "same three corners twice", "warn");
    messe(an.degenerate, "Zero-area", "collapsed to a line or point", "warn");
    if (ins && ins.hasGLTF && !ins.hasUV) messe(1, "No UVs", "nothing to texture onto", "warn");

    ui.befundZahl.textContent = befunde.length
      ? befunde.length + " type" + (befunde.length === 1 ? "" : "s") + " found"
      : "No defects";

    if (!befunde.length) {
      var leer = el("div", "empty-findings");
      leer.appendChild(svgIcon(ICON.check, 15));
      leer.appendChild(el("span", null, "No geometry defects found"));
      ui.rows.appendChild(leer);
    } else {
      befunde.forEach(function (b) {
        var zeile = el("div", "finding-row");
        zeile.setAttribute("data-severity", b.stufe);
        zeile.appendChild(el("strong", "finding-value", fmt(b.wert)));
        var kopie = el("span", "finding-copy");
        kopie.appendChild(el("b", null, b.name));
        if (b.detail) {
          var kl = el("small", null, b.detail);
          kl.title = b.detail;
          kopie.appendChild(kl);
        }
        zeile.appendChild(kopie);
        zeile.appendChild(el("span", "severity", b.stufe));
        ui.rows.appendChild(zeile);
      });
      if (heil.length) {
        var nz = el("div", "zero-row");
        nz.appendChild(svgIcon(ICON.check, 14));
        nz.appendChild(el("span", null, heil.join(", ")));
        nz.appendChild(el("strong", null, "0"));
        ui.rows.appendChild(nz);
      }
    }

    /* ---- 事实数据 ---- */
    ui.details.textContent = "";
    function fakt(name, wert, detail) {
      var zeile = el("div", "fact-row");
      var links = el("span");
      links.appendChild(el("b", null, name));
      if (detail) {
        var kl = el("small", null, detail);
        kl.title = detail;
        links.appendChild(kl);
      }
      zeile.appendChild(links);
      zeile.appendChild(el("strong", null, typeof wert === "number" ? fmt(wert) : wert));
      ui.details.appendChild(zeile);
    }

    fakt("Triangles", an.triCount, fmt(an.weldedCount) + " verts welded" +
      (an.unusedVerts ? ", " + fmt(an.unusedVerts) + " orphaned" : ""));
    fakt("Pieces", an.islands, an.islands === 1 ? "single connected shell" : "separate connected shells");
    if (ins && ins.hasGLTF) {
      if (ins.hasUV) {
        fakt("Atlas used", pct(ins.uvCoverage),
          ins.uvOverlap > 0.15 ? pct(ins.uvOverlap) + " of it overlapping" :
            (ins.uvOutOfRange ? "some UVs outside 0\u20131" : "no significant overlap"));
      }
      fakt("Textures", ins.images.length ? bytes(ins.textureBytes) : "0",
        ins.images.length ? ins.maxTexture + "px max" + (ins.hasNormalMap ? ", normal map present" : "") : "none embedded");
      fakt("Materials", ins.materials, ins.materialNames.slice(0, 2).join(", ") || "none");
    }
    fakt("Bounding box", an.dims.map(function (x) { return round(x); }).join(" \u00d7 "), "units as exported");
    fakt("Pivot", an.pivotOffset < 0.05 ? "centred" : round(an.pivotOffset * 100) + "%",
      an.restsOnGround ? "sits on the ground plane" : "floating off the ground");

    /* ---- 操作 ---- */
    ui.bSave.disabled = !state.raw;

    var can = T3D.canRepair(state.mesh, an);
    var reparaturMoeglich = can.ok;
    ui.bFix.disabled = !reparaturMoeglich;
    ui.bFix.className = "action" + (reparaturMoeglich ? " primary" : "");
    ui.bSave.className = "action" + ((!reparaturMoeglich && state.raw) ? " primary" : "");
    ui.bFix.title = reparaturMoeglich
      ? (state.mesh && state.mesh.glb && state.mesh.glb.decompressed
          ? "Rewrites index order only. Materials, UVs and textures untouched. Saved uncompressed, so the file gets bigger."
          : "Rewrites index order only. Materials, UVs and textures untouched.")
      : can.why;
    ui.fixWhy.textContent = reparaturMoeglich ? "" : can.why;
    ui.fixWhy.style.display = reparaturMoeglich ? "none" : "";

    refreshCards();
  }

  function round(x) {
    if (x >= 100) return Math.round(x);
    if (x >= 1) return Math.round(x * 10) / 10;
    return Math.round(x * 1000) / 1000;
  }

  function doRepair() {
    if (!state.mesh || !state.an) return;
    try {
      var out = T3D.repairWinding(state.mesh, state.an.flippedFlags, state.an.insideOut);
      var base = (state.name || "mesh.glb").replace(/\.glb$/i, "");
      download(out.buffer, base + ".fixed.glb");
      ui.why.textContent = "Rewrote " + fmt(out.patched) + " triangle" + (out.patched === 1 ? "" : "s") +
        (out.skipped ? ", skipped " + fmt(out.skipped) + " without an index buffer" : "") + ".";
    } catch (err) { showError(err.message || String(err)); }
  }

  function download(buffer, name) {
    var url = URL.createObjectURL(new Blob([buffer], { type: "model/gltf-binary" }));
    var a = document.createElement("a");
    a.href = url; a.download = name; a.style.display = "none";
    document.documentElement.appendChild(a);
    a.click();
    setTimeout(function () { a.remove(); URL.revokeObjectURL(url); }, 4000);
  }

  /* ---- 素材库卡片角标 ------------------------------------------------ */
  function refreshCards() {
    if (cfg.badgeCards) {
      var cards = site.findCards();
      for (var i = 0; i < cards.length; i++) {
        var colour = byTask[cards[i].id];
        if (colour) site.badgeCard(cards[i], colour, "Mesh check: already run on this one");
      }
    }
  }


  /* ---- 接线 ----------------------------------------------------------- */
  window.addEventListener("message", function (e) {
    if (e.source !== window) return;
    var d = e.data;
    if (!d || d.source !== "tripo-mesh-tools") return;
    if (d.kind === "asset" && d.buffer) {
      say("file captured: " + (d.name || "?") + ", " + d.bytes + " bytes" +
        (cfg.autoCheck ? "" : " - autoCheck is off, not checking it"));
      if (!cfg.autoCheck) return;
      build();
      ingest(d.buffer, d.name || "mesh.glb");
      return;
    }
    if (d.kind === "engine") {
      build();
      engineSeen = true;
      if (ui.bGrab) {
        ui.bGrab.disabled = !d.three;
        ui.bGrab.title = d.three
          ? "Reads the mesh out of Tripo's own viewer instead of waiting for a download"
          : "Tripo's viewer didn't announce a three.js scene, so there is nothing to read from.";
      }
      return;
    }
    if (d.kind === "verworfen") {
      say("looked at and discarded: " + d.name + ", " + d.bytes + " bytes, magic " + d.magie);
      /* 只在还没有更好的东西摆在那里时才做解释。一个被丢弃的旁枝末节，
         不允许覆盖掉一份已经完成的分析。 */
      if (!state.an && !lastKey) {
        build();
        setEmpty(d.magie === "FBX" ? "Tripo served this one as .fbx" : "Unrecognised asset",
          d.magie === "FBX"
            ? "This checks .glb, .obj and .stl. Export the model as .glb and drop it here, or use \u201cCheck what\u2019s on screen\u201d to read it out of the viewer."
            : "A " + Math.round(d.bytes / 1048576) + " MB asset went past that this cannot read (" + d.magie + ").");
      }
      return;
    }
    if (d.kind === "hookstats") {
      if (!sagFallsStill()) return;
      say("no file has arrived - here is what the hook saw:");
      say("hook counters:", d.stats);
      if (d.wege) say("other routes:", d.wege);
      if (d.idbDatenbanken && d.idbDatenbanken.length) say("IndexedDB databases:", d.idbDatenbanken);
      if (d.idbProben && d.idbProben.length) say("what was read there:", d.idbProben);
      if (d.alleURLs) say("all requests seen (" + d.alleURLs.length + "):\n" + d.alleURLs.join("\n"));
      if (d.groesste && d.groesste.length) say("largest responses:", d.groesste);
      else say("no response over 512 KB seen - the page does not load the model over fetch or XHR");
      return;
    }
    if (d.kind === "grabbed") {
      if (!d.ok) {
        if (autoGriff) { nochmalVersuchen("the scene is still empty"); return; }
        showError("Nothing readable in the viewer's scene right now. Try once the model is fully visible.");
        return;
      }
      if (autoGriff && d.indices && d.indices.byteLength / 4 / 3 < AUTO_MIN_TRIS) {
        nochmalVersuchen("only " + Math.round(d.indices.byteLength / 12) + " triangles in the scene");
        return;
      }
      ingestGeometry(new Float32Array(d.positions), new Uint32Array(d.indices), d.meshes, d.skipped);
    }
  });

  /* ---- 直接来自引擎 --------------------------------------------------
     网络钩子可能错过一次下载——被缓存了、由某个 worker 流式取得，或者
     在我们被注入之前就已 fetch 完成。无论哪种情况，几何数据都在屏幕
     上，所以改从那里读取。没有文件，也就没有修复：这条路只做检查，不
     做改写。 */
  function nochmalVersuchen(warum) {
    autoVersuche++;
    if (autoVersuche > AUTO_MAX) {
      say("giving up: " + warum + " - Tripo is probably only showing a preview image here");
      autoGriff = false;
      return;
    }
    say(warum + ", retrying in 4s (" + autoVersuche + "/" + AUTO_MAX + ")");
    setTimeout(function () {
      if (lastKey || state.an) { autoGriff = false; return; }
      grabFromEngine();
    }, 4000);
  }

  function grabFromEngine() {
    build();
    setChip("", "Reading viewer\u2026");
    try {
      window.postMessage({ source: "tripo-mesh-tools", kind: "grab" }, window.location.origin);
    } catch (e) { showError("Could not reach the page context."); }
  }

  function ingestGeometry(positions, indices, meshCount, skipped) {
    clearError();
    var mesh = { positions: positions, indices: indices, glb: null };
    /* 被剔除的背景布景应当写进标题。否则一份关于两个网格的报告看起来
       就和一份关于三个网格的一模一样，没人会察觉有东西被略去了。 */
    state.name = "viewer scene (" + (meshCount || 1) + " mesh" + (meshCount === 1 ? "" : "es") +
      (skipped ? ", " + skipped + " backdrop" + (skipped === 1 ? "" : "s") + " skipped" : "") + ")";
    state.raw = null;
    setzeTitel(state.name);
    analyse(mesh).then(function (an) {
      state.mesh = mesh; state.an = an; state.ins = { hasGLTF: false };
      state.v = T3D.verdict.decide(an, state.ins, cfg);
      if (viewer) viewer.setMesh(mesh, an);
      if (ui.empty) ui.empty.style.display = "none";
      report();
      remember();
    }).catch(function (err) { showError(err && err.message ? err.message : String(err)); });
  }

  if (api.runtime && api.runtime.onMessage) {
    api.runtime.onMessage.addListener(function (msg) {
      if (msg && msg.kind === "toggle") toggle(!state.open);
    });
  }

  T3D.settings.load().then(function (loaded) {
    cfg = loaded;
    build();
    setChip("", "Mesh tools");
    if (ui.tBack) { ui.tBack.checked = cfg.showBackFaces; }
    if (ui.tEdge) { ui.tEdge.checked = cfg.showOpenEdges; }
    if (ui.tAll) { ui.tAll.checked = cfg.showAllHoles; }
    if (ui.tSpin) { ui.tSpin.checked = cfg.turntable; }
    site.watch(refreshCards);
  });
})();
