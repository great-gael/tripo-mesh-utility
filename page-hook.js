/* 运行在页面自身的 JavaScript 上下文中。

   Tripo 的查看器为了给你显示预览，本来就会下载网格。与其去猜测 DOM 结构
   ——每次他们重新设计时结构都会变——这里直接监视网络层本身，把一切看起来
   像网格的东西在它经过时复制一份。什么都不拦截、什么都不延迟：页面始终
   收到它原始的、未被触碰的响应，而我们只在一份副本上工作。

   因为它依据的是内容而不是标记，所以 Tripo 的重新设计不会破坏它。会破坏
   它的，是他们交付资源的方式发生改变。 */
(function () {
  "use strict";
  if (window.__tripoMeshHook) return;
  window.__tripoMeshHook = true;

  /* 没有这些计数器，就无法把“hook 没有生效”和“页面根本什么都没有下载”
     区分开。我们正是在这一点上白白损失了好几轮。最大的那几个响应会被
     一并记录下来，因为一个 15 MB 的 GLB 本该在它们中间——如果它不在那里，
     那它就不是通过本页面的 fetch 或 XHR 来的，而是来自 Cache Storage、
     IndexedDB，或者一个带有自身上下文的 Worker。 */
  var stats = { fetches: 0, xhrs: 0, sniffed: 0, glb: 0, reported: 0,
    idbReads: 0, idbCursor: 0, idbGLB: 0 };
  /* 每一个看到的请求，不只是大的那些。关于 GLB 来源途径的四个猜测先后
     被证明是错的；这个列表直接回答了这个问题，而不是再去猜一遍。它是
     所有诊断手段中最便宜的一种，本该一开始就摆在那里。 */
  var alleURLs = [];
  function notieren(art, url, ct, len) {
    if (alleURLs.length >= 60) return;
    var kurz = String(url);
    try { kurz = new URL(kurz, location.href).pathname; } catch (e) {}
    alleURLs.push(art + " " + kurz.slice(-70) + "  [" + (ct || "?") + (len ? ", " + len + " B" : "") + "]");
  }

  var idbProben = [];
  var idbDatenbanken = [];

  /* 哪个 store 提供哪一类的值。没有这个列表，就无法把 "idbGLB: 0" 和
     “我们看的地方不对”区分开。 */
  function probe(store, v) {
    if (idbProben.length >= 14) return;
    var art = "?", groesse = 0;
    try {
      if (v === null || v === undefined) art = String(v);
      else if (v instanceof ArrayBuffer) { art = "ArrayBuffer"; groesse = v.byteLength; }
      else if (ArrayBuffer.isView(v)) { art = "TypedArray"; groesse = v.byteLength; }
      else if (typeof Blob !== "undefined" && v instanceof Blob) { art = "Blob"; groesse = v.size; }
      else if (typeof v === "object") { art = "Object{" + Object.keys(v).slice(0, 8).join(",") + "}"; }
      else art = typeof v;
    } catch (e) { art = "unlesbar"; }
    idbProben.push({ store: store, kind: art, bytes: groesse });
  }

  try {
    if (window.indexedDB && typeof window.indexedDB.databases === "function") {
      window.indexedDB.databases().then(function (list) {
        idbDatenbanken = (list || []).map(function (d) { return d.name; });
      }).catch(function () {});
    }
  } catch (e) { /* 无所谓 */ }
  var groesste = [];
  function merken(url, ct, len) {
    if (!len || len < 512 * 1024) return;
    groesste.push({ url: String(url).slice(0, 140), type: ct || "?", bytes: len });
    groesste.sort(function (a, b) { return b.bytes - a.bytes; });
    if (groesste.length > 6) groesste.length = 6;
  }

  var MAX_BYTES = 260 * 1024 * 1024;
  var MESH_PATH = /\.(glb|obj|stl)(\?|$)/i;
  var MESH_TYPE = /(model\/gltf-binary|application\/octet-stream|model\/obj|model\/stl)/i;

  function looksLikeMesh(url, contentType) {
    var path;
    try { path = new URL(url, location.href).pathname; } catch (e) { path = String(url); }
    if (MESH_PATH.test(path)) return true;
    return !!(contentType && MESH_TYPE.test(contentType) && /tripo|asset|model|mesh|download/i.test(url));
  }

  /* 带签名的 CDN URL 往往既没有扩展名，content type 也很笼统，因此基于
     名字的过滤器会漏掉它们。凡是不明显属于文本、图像或代码，并且大到
     足以是一个模型的东西，都会被读取它的前四个字节；只有真正的 glTF
     文件头才会被保留。 */
  var NOT_A_MESH = /^(text\/|image\/|audio\/|video\/|font\/|application\/(json|javascript|xml|manifest|wasm))/i;

  function worthSniffing(url, contentType, length) {
    if (looksLikeMesh(url, contentType)) return true;
    if (contentType && NOT_A_MESH.test(contentType)) return false;
    if (length != null && (length < 20000 || length > MAX_BYTES)) return false;
    return true;
  }

  function isGLB(buf) {
    if (!buf || buf.byteLength < 12) return false;
    try { return new DataView(buf).getUint32(0, true) === 0x46546C67; } catch (e) { return false; }
  }

  /* 自从有了 lib/fbx.js 能够读取它，FBX 就不再是异物，而是第二种受支持
     的格式。识别它靠的是文件头，而不是扩展名——Tripo 把它的模型命名为
     tripo_texture_<id>.fbx，而一个名字并不是任何保证。 */
  function isFBX(buf) {
    if (!buf || buf.byteLength < 20) return false;
    try {
      var a = new Uint8Array(buf, 0, 18), t = "";
      for (var i = 0; i < 18; i++) t += String.fromCharCode(a[i]);
      return t === "Kaydara FBX Binary";
    } catch (e) { return false; }
  }

  /* 二进制 FBX 以 "Kaydara FBX Binary" 开头。解析器读不了 FBX，也不必去
     读——但它应该能够把它叫出名字来。 */
  function magie(buf) {
    try {
      var n = Math.min(24, buf.byteLength);
      var t = "", a = new Uint8Array(buf, 0, n);
      for (var i = 0; i < n; i++) t += (a[i] >= 32 && a[i] < 127) ? String.fromCharCode(a[i]) : ".";
      if (t.indexOf("Kaydara FBX") === 0) return "FBX";
      if (t.indexOf("glTF") === 0) return "glTF";
      if (t.indexOf("PK") === 0) return "ZIP";
      return t.slice(0, 8);
    } catch (e) { return "?"; }
  }

  /* 一个我们看过又丢弃掉的大块头，值得发一条消息。没有这条消息，“不受
     支持”从外面看起来就和“什么都没找到”一模一样，用户会坐在一个空面板
     前面，得不到任何关于原因的提示。 */
  function verworfen(url, buf) {
    try {
      if (!buf || buf.byteLength < 1024 * 1024) return;
      var name = "asset";
      try { name = decodeURIComponent(new URL(url, location.href).pathname.split("/").pop()) || name; } catch (e) {}
      window.postMessage({
        source: "tripo-mesh-tools", kind: "verworfen",
        name: name, bytes: buf.byteLength, magie: magie(buf)
      }, window.location.origin);
    } catch (e) { /* 绝不打扰页面 */ }
  }

  function emit(url, buffer) {
    if (!buffer || !buffer.byteLength || buffer.byteLength > MAX_BYTES) return;
    var name = "mesh.glb";
    try {
      var p = new URL(url, location.href).pathname.split("/").pop();
      if (p) name = decodeURIComponent(p);
    } catch (e) { /* 保留默认值 */ }
    if (!/\.(glb|obj|stl|fbx)$/i.test(name)) {
      name = name.replace(/[?#].*$/, "") + (isGLB(buffer) ? ".glb" : (isFBX(buffer) ? ".fbx" : ""));
    }

    // 复制，绝不转移——转移会让页面自己的 buffer 失效，
    // 并破坏我们正身处其中的 Tripo 查看器。
    stats.reported++;
    var copy = buffer.slice(0);
    window.postMessage({
      source: "tripo-mesh-tools",
      kind: "asset",
      url: String(url),
      name: name,
      bytes: copy.byteLength,
      buffer: copy
    }, window.location.origin, [copy]);
  }

  /* ---- 这个文件还可能从哪里来？ ----

     25 个 fetches 和 4 个 XHRs 经过这个 hook，那个 15 MB 的 GLB 从来不在
     它们中间——但在 HAR 里却确实存在。也就是说，它是在这个上下文之外被
     取来的。有三条途径需要考虑，而且这三条都可以在不改动它们的前提下被
     观察：一个 Worker 会带来自己的全局上下文，因而也带来一个自己的、未
     被打过补丁的 fetch；Cache Storage 和 IndexedDB 则根本绕开了网络。

     这里只做计数和转交。什么都不拦截，什么都不延迟——页面必须原封不动
     地继续运行。 */
  var wege = { worker: 0, workerURLs: [], sharedWorker: 0, serviceWorker: 0, cacheStorage: 0, indexedDB: 0 };

  try {
    var NativeWorker = window.Worker;
    if (typeof NativeWorker === "function") {
      window.Worker = function (url, opts) {
        wege.worker++;
        try { if (wege.workerURLs.length < 8) wege.workerURLs.push(String(url).slice(0, 120)); } catch (e) {}
        return new NativeWorker(url, opts);
      };
      window.Worker.prototype = NativeWorker.prototype;
    }
  } catch (e) { /* 绝不弄坏页面 */ }

  try {
    if (typeof window.SharedWorker === "function") {
      var NativeShared = window.SharedWorker;
      window.SharedWorker = function (url, opts) { wege.sharedWorker++; return new NativeShared(url, opts); };
      window.SharedWorker.prototype = NativeShared.prototype;
    }
  } catch (e) { /* 无所谓 */ }

  try {
    if (window.caches && typeof window.caches.match === "function") {
      var nativeMatch = window.caches.match.bind(window.caches);
      window.caches.match = function () { wege.cacheStorage++; return nativeMatch.apply(null, arguments); };
    }
    if (window.caches && typeof window.caches.open === "function") {
      var nativeOpen = window.caches.open.bind(window.caches);
      window.caches.open = function () { wege.cacheStorage++; return nativeOpen.apply(null, arguments); };
    }
  } catch (e) { /* 无所谓 */ }

  try {
    if (window.indexedDB && typeof window.indexedDB.open === "function") {
      var nativeIDB = window.indexedDB.open.bind(window.indexedDB);
      window.indexedDB.open = function () { wege.indexedDB++; return nativeIDB.apply(null, arguments); };
    }
  } catch (e) { /* 无所谓 */ }

  try {
    if (navigator.serviceWorker) {
      navigator.serviceWorker.getRegistrations().then(function (r) {
        wege.serviceWorker = r ? r.length : 0;
      }).catch(function () {});
    }
  } catch (e) { /* 无所谓 */ }

  /* ---- IndexedDB ----

     08.09.2026 测得：Tripo 在第一次下载之后把 GLB 放进 IndexedDB，之后
     就从那里播放它。在此后的每一次调用中，网络上完全不再发生任何事情
     ——22 个 fetches，没有任何一个响应超过 512 KB。一个网络 hook 在那里
     原则上什么也看不到。

     但 IndexedDB 和 fetch 一样也是一层数据层，同一套方法同样管用：只跟
     着读，绝不介入。值是在 success 事件时才被查看的，那时页面早就拿到
     了它；只有带 glTF 文件头的东西才会被复制。请求本身保持不被触碰。 */
  function sniffValue(v, quelle, tiefe) {
    if (!v) return;
    try {
      if (v instanceof ArrayBuffer) { if (isGLB(v) || isFBX(v)) { stats.idbGLB++; emit(quelle, v); } return; }
      if (ArrayBuffer.isView(v)) {
        var b = v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength);
        if (isGLB(b)) { stats.idbGLB++; emit(quelle, b); }
        return;
      }
      if (typeof Blob !== "undefined" && v instanceof Blob) {
        if (v.size < 1024 || v.size > MAX_BYTES) return;
        v.arrayBuffer().then(function (bb) {
          if (isGLB(bb)) { stats.idbGLB++; emit(quelle, bb); }
        }).catch(function () {});
        return;
      }
      /* 只往下深入一层，这样像 { id, data } 这样的外壳还能被找到，而我们
         又不必去挖掘别人的对象树。 */
      if ((tiefe || 0) < 1 && typeof v === "object") {
        var keys = Object.keys(v);
        for (var i = 0; i < keys.length && i < 24; i++) sniffValue(v[keys[i]], quelle, (tiefe || 0) + 1);
      }
    } catch (e) { /* 诊断绝不允许打扰页面 */ }
  }

  function quelleFuer(store) {
    return location.origin + "/indexeddb/" + store + ".glb";
  }

  /* get 和 getAll 覆盖简单的情形，openCursor 覆盖逐条遍历一批数据的情形
     ——在 5 个已打开的数据库、却只有 4 次 get 调用的情况下，缺的正是这条
     途径。IDBIndex 在自己的 prototype 上有同样的方法，因此一并带上。 */
  function hookLesen(proto, welche) {
    if (!proto) return;
    welche.forEach(function (name) {
      var orig = proto[name];
      if (typeof orig !== "function") return;
      proto[name] = function () {
        var req = orig.apply(this, arguments);
        var store = "unbekannt";
        try { store = this.name || (this.objectStore && this.objectStore.name) || "unbekannt"; } catch (e) {}
        var cursorArtig = name.indexOf("Cursor") !== -1;
        try {
          req.addEventListener("success", function () {
            try {
              var r = req.result;
              if (cursorArtig) {
                if (!r) return;
                stats.idbCursor++;
                probe(store + ":cursor", r.value);
                sniffValue(r.value, quelleFuer(store), 0);
                return;
              }
              stats.idbReads++;
              if (r && typeof r.length === "number" && typeof r !== "string" && r.push) {
                for (var i = 0; i < r.length && i < 20; i++) { probe(store + "[]", r[i]); sniffValue(r[i], quelleFuer(store), 0); }
              } else { probe(store, r); sniffValue(r, quelleFuer(store), 0); }
            } catch (e) { /* 绝不打扰页面 */ }
          });
        } catch (e) {}
        return req;
      };
    });
  }

  try {
    hookLesen(window.IDBObjectStore && window.IDBObjectStore.prototype,
      ["get", "getAll", "openCursor"]);
    hookLesen(window.IDBIndex && window.IDBIndex.prototype,
      ["get", "getAll", "openCursor"]);
  } catch (e) { /* 绝不弄坏页面 */ }

  /* ---- fetch ---- */
  var nativeFetch = window.fetch;
  if (typeof nativeFetch === "function") {
    window.fetch = function (input, init) {
      var url = (typeof input === "string") ? input : (input && input.url) || "";
      stats.fetches++;
      return nativeFetch.apply(this, arguments).then(function (res) {
        try {
          var h = res.headers;
          var ct = h && h.get ? h.get("content-type") : null;
          var lenHeader = h && h.get ? h.get("content-length") : null;
          var len = lenHeader ? parseInt(lenHeader, 10) : null;
          notieren("fetch", res.url || url, ct, len);
          merken(res.url || url, ct, len);
          if (res.ok && worthSniffing(url, ct, len)) {
            stats.sniffed++;
            // clone() 让页面的数据流完好无损
            res.clone().arrayBuffer().then(function (buf) {
              if (isGLB(buf) || isFBX(buf) || MESH_PATH.test(url)) { stats.glb++; emit(res.url || url, buf); }
              else verworfen(res.url || url, buf);
            }).catch(function () {});
          }
        } catch (e) { /* 绝不让 hook 破坏页面的请求 */ }
        return res;
      });
    };
  }

  /* ---- XMLHttpRequest ---- */
  var open = XMLHttpRequest.prototype.open;
  var send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__meshURL = url;
    return open.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    var xhr = this;
    stats.xhrs++;
    xhr.addEventListener("load", function () {
      try {
        var url = xhr.__meshURL || "";
        var ct = xhr.getResponseHeader && xhr.getResponseHeader("content-type");
        var lh = xhr.getResponseHeader && xhr.getResponseHeader("content-length");
        notieren("xhr", url, ct, lh ? parseInt(lh, 10) : null);
        if (!worthSniffing(url, ct, lh ? parseInt(lh, 10) : null)) return;
        if (xhr.responseType === "arraybuffer" && xhr.response) {
          if (isGLB(xhr.response) || isFBX(xhr.response) || MESH_PATH.test(url)) emit(url, xhr.response);
        } else if (xhr.responseType === "blob" && xhr.response && xhr.response.arrayBuffer) {
          xhr.response.arrayBuffer().then(function (b) { emit(url, b); }).catch(function () {});
        }
      } catch (e) { /* 吞掉 */ }
    });
    return send.apply(this, arguments);
  };

  window.postMessage({ source: "tripo-mesh-tools", kind: "ready" }, window.location.origin);

  /* 比面板里的闹钟稍晚一些，这样中间状态先摆在那里，
     而这份报告随后来解释它。 */
  setTimeout(function () {
    try {
      window.postMessage({
        source: "tripo-mesh-tools", kind: "hookstats",
        stats: stats, groesste: groesste, wege: wege,
        idbProben: idbProben, idbDatenbanken: idbDatenbanken,
        alleURLs: alleURLs
      }, window.location.origin);
    } catch (e) { /* 诊断绝不允许打扰页面 */ }
  }, 6500);
})();
