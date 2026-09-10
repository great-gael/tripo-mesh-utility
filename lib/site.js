/* 站点适配器。

   关于 Tripo 页面标记的每一条假设都住在这个文件里，别处一条也没有。当他们的
   界面变了 —— 或者当你把真实的选择器粘进下面的 SELECTORS 时 —— 需要动的就只
   有这一个文件。

   在那之前，它按形状而不是按类名工作：靠元素包含什么、链接到哪里去找它们，而
   不是靠它们叫什么。类名是生成的，每次部署都会变；而一张包含缩略图并且链接到
   某个 task ID 的卡片是稳定的。每一次查找都返回空而不是抛出异常，所以一次落空
   只会把扩展降级成那个浮动面板，而不会把页面弄坏。 */
(function (root) {
  "use strict";

  /* 09.09.2026 移除：Tripo 药丸条里的样式色块、它的分隔线、那个浮动的
     替代开关，以及对这条工具条的查找。此后扩展不再往页面的 Viewer 里写
     任何东西；单面显示的视图住在 lib/viewer.js 里，在那儿碍不着任何人。
     留在这里的只做读取：找卡片、找 Canvas、读任务 ID、监听导航 —— 外加
     badgeCard，它是仅剩的一个写操作，而且它作用于素材库，不是 Viewer。 */

  /* 一旦知道了就把它们填进来；每一项在留空时都会回退到启发式查找。 */
  var SELECTORS = {
    libraryCard: "",      // 例如 "[data-testid='asset-card']"
    cardLink: "",         // 卡片内部那个带着 task id 的锚点
    cardThumb: "",        // 卡片内部的 img
    downloadButton: "",   // 模型页上的下载控件
    viewerCanvas: "",     // Tripo 自己的 canvas，用来把界面锚在它旁边
  };

  var UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
  var DOWNLOAD_TEXT = /^(download|export|下载|导出|télécharger|descargar|herunterladen)$/i;

  function all(sel, ctx) {
    if (!sel) return [];
    try { return Array.prototype.slice.call((ctx || document).querySelectorAll(sel)); }
    catch (e) { return []; }
  }

  /* ---- 任务 id ------------------------------------------------------ */

  function taskIdFrom(str) {
    if (!str) return null;
    var m = String(str).match(UUID);
    return m ? m[0].toLowerCase() : null;
  }

  function currentTaskId() {
    return taskIdFrom(location.pathname) || taskIdFrom(location.search) || null;
  }

  /* ---- 素材库卡片 --------------------------------------------------- */

  /* 一张卡片是同时装着缩略图和一条指向某个任务的链接的最小元素。从缩略图
     往上走就能找到它，用不着给任何东西起名字。 */
  function findCards() {
    if (SELECTORS.libraryCard) {
      return all(SELECTORS.libraryCard).map(function (el) {
        return { el: el, id: taskIdFrom(cardHref(el)) };
      }).filter(function (c) { return c.id; });
    }

    var out = [], seen = new Set();
    var imgs = all("img");
    for (var i = 0; i < imgs.length; i++) {
      var node = imgs[i], hops = 0, card = null, id = null;
      while (node && node !== document.body && hops < 6) {
        var href = cardHref(node);
        var found = taskIdFrom(href);
        if (found) { card = node; id = found; break; }
        node = node.parentElement;
        hops++;
      }
      if (card && id && !seen.has(card)) {
        seen.add(card);
        out.push({ el: card, id: id });
      }
    }
    return out;
  }

  function cardHref(el) {
    if (!el) return "";
    if (SELECTORS.cardLink) {
      var q = el.querySelector ? el.querySelector(SELECTORS.cardLink) : null;
      if (q) return q.getAttribute("href") || "";
    }
    if (el.tagName === "A" && el.getAttribute("href")) return el.getAttribute("href");
    var a = el.querySelector ? el.querySelector("a[href]") : null;
    if (a) return a.getAttribute("href") || "";
    var attrs = ["data-id", "data-task-id", "data-model-id", "id"];
    for (var i = 0; i < attrs.length; i++) {
      var v = el.getAttribute && el.getAttribute(attrs[i]);
      if (v && UUID.test(v)) return v;
    }
    return "";
  }

  /* ---- 下载控件 ----------------------------------------------------- */

  function findDownloadButton() {
    if (SELECTORS.downloadButton) {
      var direct = all(SELECTORS.downloadButton)[0];
      if (direct) return direct;
    }
    var cands = all("button, a[role='button'], [role='button']");
    for (var i = 0; i < cands.length; i++) {
      var txt = (cands[i].textContent || "").trim();
      var label = cands[i].getAttribute("aria-label") || "";
      if (DOWNLOAD_TEXT.test(txt) || DOWNLOAD_TEXT.test(label.trim())) return cands[i];
    }
    return null;
  }

  function findViewerCanvas() {
    if (SELECTORS.viewerCanvas) {
      var direct = all(SELECTORS.viewerCanvas)[0];
      if (direct) return direct;
    }
    // Tripo 自己的 viewer 是页面上最大的那块 canvas。
    var best = null, bestArea = 0;
    all("canvas").forEach(function (c) {
      var r = c.getBoundingClientRect();
      var area = r.width * r.height;
      if (area > bestArea && area > 40000) { bestArea = area; best = c; }
    });
    return best;
  }

  /* ---- 监听 --------------------------------------------------------- */

  /* Tripo 是个单页应用，所以卡片会在没有任何导航的情况下出现又消失。做了
     防抖，免得一个虚拟化列表把 CPU 空转起来。 */
  function watch(onChange) {
    var timer = null;
    function ping() {
      clearTimeout(timer);
      timer = setTimeout(function () {
        try { onChange(); } catch (e) { /* 绝不能把页面弄坏 */ }
      }, 260);
    }
    var mo = new MutationObserver(ping);
    var startObserving = function () {
      if (!document.body) { setTimeout(startObserving, 50); return; }
      mo.observe(document.body, { childList: true, subtree: true });
      ping();
    };
    startObserving();

    // history.pushState 不会触发 popstate；给它打个补丁，让路由变化也发出 ping
    var push = history.pushState, rep = history.replaceState;
    history.pushState = function () { var r = push.apply(this, arguments); ping(); return r; };
    history.replaceState = function () { var r = rep.apply(this, arguments); ping(); return r; };
    window.addEventListener("popstate", ping);

    return function stop() {
      mo.disconnect();
      history.pushState = push;
      history.replaceState = rep;
      window.removeEventListener("popstate", ping);
    };
  }

  /* ---- 标记点 -------------------------------------------------------- */

  /* 别在卡片上的一个判定圆点。它在卡片内部绝对定位，这样不管 Tripo 用的是
     什么布局它都能活下来；并且用一个 data 属性做了标记，免得重新渲染时叠
     出重复的来。 */
  function badgeCard(card, color, title) {
    if (!card || !card.el) return;
    var el = card.el;
    var existing = el.querySelector(":scope > [data-tripo-mesh-badge]");
    if (existing) {
      existing.style.background = color;
      existing.title = title;
      return existing;
    }
    var cs = window.getComputedStyle(el);
    if (cs.position === "static") el.style.position = "relative";

    var dot = document.createElement("div");
    dot.setAttribute("data-tripo-mesh-badge", "1");
    dot.title = title;
    dot.style.cssText = [
      "position:absolute", "top:6px", "left:6px", "width:10px", "height:10px",
      "border-radius:50%", "z-index:40", "pointer-events:none",
      "box-shadow:0 0 0 2px rgba(0,0,0,.45)", "background:" + color
    ].join(";");
    el.appendChild(dot);
    return dot;
  }

  /* 如果找不到那条工具条，这个功能仍然必须够得着，所以我们不放弃，而是让
     自己的小药丸浮在 viewer 正下方。 */
  function clearBadges() {
    all("[data-tripo-mesh-badge]").forEach(function (d) { d.remove(); });
  }

  root.site = {
    SELECTORS: SELECTORS,
    taskIdFrom: taskIdFrom,
    currentTaskId: currentTaskId,
    findCards: findCards,
    findDownloadButton: findDownloadButton,
    findViewerCanvas: findViewerCanvas,
    watch: watch,
    badgeCard: badgeCard,
    clearBadges: clearBadges
  };
})(typeof self !== "undefined" ? (self.T3D = self.T3D || {}) : (module.exports = {}));
