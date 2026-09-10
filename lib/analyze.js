/* 拓扑与几何分析。

   纯粹且无依赖，因此在 content script、Worker 和 Node 中都能原样运行。
   这里的每一项指标之所以存在，都是因为它会改变 keep-or-re-roll（保留还是
   重新生成）的决定 —— 是可以据以行动的计数，而不是统计数字。 */
(function (root) {
  "use strict";

  function buildAnalysis(positions, indices, opts) {
    opts = opts || {};
    var SLIVER_Q = opts.sliverQ != null ? opts.sliverQ : 0.05;
    /* 一个洞要有多少条边界边才算作可见。0 表示全部计入。 */
    var MIN_LOCH = (opts && opts.minHoleEdges) || 0;

    var i, k, t, a, b, c;

    /* ---- 包围盒 ---- */
    var minx = Infinity, miny = Infinity, minz = Infinity;
    var maxx = -Infinity, maxy = -Infinity, maxz = -Infinity;
    for (i = 0; i < positions.length; i += 3) {
      var px = positions[i], py = positions[i+1], pz = positions[i+2];
      if (px < minx) minx = px; if (px > maxx) maxx = px;
      if (py < miny) miny = py; if (py > maxy) maxy = py;
      if (pz < minz) minz = pz; if (pz > maxz) maxz = pz;
    }
    var dims = [maxx - minx, maxy - miny, maxz - minz];
    var diag = Math.hypot(dims[0], dims[1], dims[2]) || 1;
    var center = [(minx+maxx)/2, (miny+maxy)/2, (minz+maxz)/2];
    var q = 1 / (diag * 1e-5);

    /* ---- 按量化后的位置进行 weld（顶点焊接）----
       导出时 UV 接缝会把顶点拆开。没有这一步，每一条接缝都会被读成一个洞，
       而这正是网格检查器对你说谎最常见的方式。 */
    var map = new Map();
    var vcount = positions.length / 3;
    var remap = new Uint32Array(vcount);
    var wPos = [];
    for (i = 0; i < vcount; i++) {
      var key = Math.round(positions[i*3]*q) + "|" + Math.round(positions[i*3+1]*q) + "|" + Math.round(positions[i*3+2]*q);
      var id = map.get(key);
      if (id === undefined) {
        id = wPos.length / 3;
        map.set(key, id);
        wPos.push(positions[i*3], positions[i*3+1], positions[i*3+2]);
      }
      remap[i] = id;
    }
    var weldedCount = wPos.length / 3;
    var W = new Uint32Array(indices.length);
    for (i = 0; i < indices.length; i++) W[i] = remap[indices[i]];

    var triCount = Math.floor(indices.length / 3);
    var alive = new Uint8Array(triCount);
    var degenerate = 0, slivers = 0;
    var used = new Uint8Array(vcount);

    var numericKeys = weldedCount < 2097152;
    var edges = new Map();
    var ROOT12 = 4 * Math.sqrt(3);

    for (t = 0; t < triCount; t++) {
      a = W[t*3]; b = W[t*3+1]; c = W[t*3+2];
      used[indices[t*3]] = 1; used[indices[t*3+1]] = 1; used[indices[t*3+2]] = 1;
      if (a === b || b === c || a === c) { degenerate++; continue; }
      alive[t] = 1;

      /* 三角形质量：1.0 为等边三角形，越是塌陷成一条直线就越趋近 0。
         细长三角形（sliver）能通过退化检测，却会毁掉烘焙和重拓扑。 */
      var ax = wPos[a*3], ay = wPos[a*3+1], az = wPos[a*3+2];
      var bx = wPos[b*3], by = wPos[b*3+1], bz = wPos[b*3+2];
      var cx = wPos[c*3], cy = wPos[c*3+1], cz = wPos[c*3+2];
      var e1x = bx-ax, e1y = by-ay, e1z = bz-az;
      var e2x = cx-ax, e2y = cy-ay, e2z = cz-az;
      var nx = e1y*e2z - e1z*e2y, ny = e1z*e2x - e1x*e2z, nz = e1x*e2y - e1y*e2x;
      var area2 = Math.hypot(nx, ny, nz);
      var sumSq = (e1x*e1x+e1y*e1y+e1z*e1z) + (e2x*e2x+e2y*e2y+e2z*e2z) +
                  ((cx-bx)*(cx-bx)+(cy-by)*(cy-by)+(cz-bz)*(cz-bz));
      if (sumSq > 0 && ROOT12 * (area2 * 0.5) / sumSq < SLIVER_Q) slivers++;

      for (k = 0; k < 3; k++) {
        var u = k === 0 ? a : k === 1 ? b : c;
        var v = k === 0 ? b : k === 1 ? c : a;
        var lo = u < v ? u : v, hi = u < v ? v : u, dir = u < v ? 1 : -1;
        var ek = numericKeys ? lo * 2097152 + hi : lo + ":" + hi;
        var r = edges.get(ek);
        if (!r) { r = { lo: lo, hi: hi, count: 0, balance: 0, t0: -1, t1: -1 }; edges.set(ek, r); }
        r.count++; r.balance += dir;
        if (r.t0 < 0) r.t0 = t; else if (r.t1 < 0) r.t1 = t;
      }
    }

    var unusedVerts = 0;
    for (i = 0; i < vcount; i++) if (!used[i]) unusedVerts++;

    /* ---- 重复面 ---- */
    var seenFace = new Set();
    var duplicateFaces = 0;
    for (t = 0; t < triCount; t++) {
      if (!alive[t]) continue;
      var s0 = W[t*3], s1 = W[t*3+1], s2 = W[t*3+2], tmp;
      if (s0 > s1) { tmp = s0; s0 = s1; s1 = tmp; }
      if (s1 > s2) { tmp = s1; s1 = s2; s2 = tmp; }
      if (s0 > s1) { tmp = s0; s0 = s1; s1 = tmp; }
      var fk = s0 + ":" + s1 + ":" + s2;
      if (seenFace.has(fk)) duplicateFaces++; else seenFace.add(fk);
    }
    seenFace = null;

    /* ---- 边界、non-manifold（非流形）、邻接图 ---- */
    var nonManifold = 0, inconsistentEdges = 0, totalEdges = edges.size;
    var boundary = [];
    var nbr = new Int32Array(triCount * 3).fill(-1);
    var nbrFlip = new Uint8Array(triCount * 3);
    var nbrCount = new Uint8Array(triCount);
    edges.forEach(function (r) {
      if (r.count === 1) { boundary.push(r.lo, r.hi); return; }
      if (r.count > 2) { nonManifold++; return; }
      if (r.balance !== 0) inconsistentEdges++;
      var flip = r.balance !== 0 ? 1 : 0;
      if (nbrCount[r.t0] < 3) { var i0 = r.t0*3 + nbrCount[r.t0]++; nbr[i0] = r.t1; nbrFlip[i0] = flip; }
      if (nbrCount[r.t1] < 3) { var i1 = r.t1*3 + nbrCount[r.t1]++; nbr[i1] = r.t0; nbrFlip[i1] = flip; }
    });
    edges = null;

    /* ---- 朝向传播：每个壳体中占少数的一方即为反转的 ----

       只有在归属本身是唯一的时候，这才成立。如果传播过程中遇到矛盾 ——
       一个已经定过朝向的三角形，经由这条边本该得到相反的符号 ——，那么
       多数与少数的划分就取决于遍历顺序，也就不再是一次测量。在 Tripo 的
       斧子上：八条彼此不一致的边产生了 900 处矛盾，并由此得出 55.487 个
       三角形中有 10.225 个属于“少数”。在一个平面上照此算出来的是
       “50 % 已反转”，这显然是胡说八道。

       因此这里把矛盾一并计数；使用这个结果的人必须知道它是否站得住脚。 */
    var orient = new Int8Array(triCount);
    var orientContradictions = 0;
    var flipped = new Uint8Array(triCount);
    var islandTris = [];
    var flippedTris = 0;
    var stack = [];
    for (var s = 0; s < triCount; s++) {
      if (!alive[s] || orient[s] !== 0) continue;
      orient[s] = 1;
      stack.length = 0; stack.push(s);
      var comp = [s], plus = 0, minus = 0;
      while (stack.length) {
        t = stack.pop();
        if (orient[t] === 1) plus++; else minus++;
        for (k = 0; k < 3; k++) {
          var n = nbr[t*3+k];
          if (n < 0) continue;
          var soll = nbrFlip[t*3+k] ? -orient[t] : orient[t];
          if (orient[n] !== 0) { if (orient[n] !== soll) orientContradictions++; continue; }
          orient[n] = soll;
          comp.push(n); stack.push(n);
        }
      }
      islandTris.push(comp.length);
      var bad = minus > plus ? 1 : -1;
      for (i = 0; i < comp.length; i++) if (orient[comp[i]] === bad) { flipped[comp[i]] = 1; flippedTris++; }
    }
    islandTris.sort(function (x, y) { return y - x; });

    /* ---- 在多数朝向下的有符号体积 ---- */
    var vol = 0;
    for (t = 0; t < triCount; t++) {
      if (!alive[t]) continue;
      a = indices[t*3]; b = indices[t*3+1]; c = indices[t*3+2];
      if (flipped[t]) { var sw = b; b = c; c = sw; }
      var Ax = positions[a*3], Ay = positions[a*3+1], Az = positions[a*3+2];
      var Bx = positions[b*3], By = positions[b*3+1], Bz = positions[b*3+2];
      var Cx = positions[c*3], Cy = positions[c*3+1], Cz = positions[c*3+2];
      vol += Ax*(By*Cz - Bz*Cy) - Ay*(Bx*Cz - Bz*Cx) + Az*(Bx*Cy - By*Cx);
    }

    /* ---- 带尺寸的边界环 ----
       三条边的针眼和两百条边的缺失肢体不是同一个问题，所以单单一个洞的
       数量并不是可以据以行动的东西。 */
    var adj = new Map();
    for (i = 0; i < boundary.length; i += 2) {
      var ba = boundary[i], bb = boundary[i+1];
      if (!adj.has(ba)) adj.set(ba, []);
      if (!adj.has(bb)) adj.set(bb, []);
      adj.get(ba).push(bb);
      adj.get(bb).push(ba);
    }
    var seen = new Set();
    var holeSizes = [];
    /* 某个顶点属于哪一个边界环。没有这个归属关系，之后就无法说出哪条边
       算到哪个洞上。 */
    var ringVon = new Map();
    adj.forEach(function (_, start) {
      if (seen.has(start)) return;
      var ring = holeSizes.length;
      var st = [start], size = 0;
      seen.add(start); ringVon.set(start, ring);
      while (st.length) {
        var nn = st.pop();
        size++;
        var list = adj.get(nn) || [];
        for (var j = 0; j < list.length; j++) {
          if (!seen.has(list[j])) { seen.add(list[j]); ringVon.set(list[j], ring); st.push(list[j]); }
        }
      }
      holeSizes.push(size);
    });
    /* 排序前先备份：排序之后索引就对不上了。 */
    var ringGroesse = holeSizes.slice();
    holeSizes.sort(function (x, y) { return y - x; });
    adj = null;

    /* 同一个阈值也用于边的显示。三条边的洞在 Viewer 里只是几个像素的斑点；
       三十个这样的斑点会盖过那唯一真正要紧的洞。想全部看到的人，把阈值
       设为零即可。 */
    var randGross = boundary, randKlein = [];
    if (MIN_LOCH > 0) {
      randGross = [];
      for (i = 0; i < boundary.length; i += 2) {
        var ziel = (ringGroesse[ringVon.get(boundary[i])] >= MIN_LOCH) ? randGross : randKlein;
        ziel.push(boundary[i], boundary[i + 1]);
      }
    }
    ringVon = null;

    var strayCut = Math.max(8, triCount * 0.005);
    return {
      triCount: triCount,
      vertCount: vcount,
      weldedCount: weldedCount,
      unusedVerts: unusedVerts,
      degenerate: degenerate,
      slivers: slivers,
      duplicateFaces: duplicateFaces,

      totalEdges: totalEdges,
      boundaryEdgeCount: boundary.length / 2,
      openRatio: totalEdges ? (boundary.length / 2) / totalEdges : 0,
      boundaryEdges: boundary,
      boundaryEdgesBig: randGross,
      /* 与之相对的另一半，好让 Viewer 把两个集合前后相接地放进同一个缓冲区
         并通过计数来切换 —— 无需重新计算，也不会把同一条边画两遍。 */
      boundaryEdgesSmall: randKlein,
      weldedPositions: new Float32Array(wPos),
      holes: holeSizes.length,
      holeSizes: holeSizes.slice(0, 12),
      /* 三条边的洞是文件里的一个缺陷，但不是谁看得见的那种。二十四条边
         的洞就是了。把两者同等计数的人，几乎在每个生成的网格上都会报
         出两位数，因此会被人无视。

         计数放在这里而不是放到后面，是因为 holeSizes 为了显示被截断到
         十二条 —— 在洞更多时，从中挑出来的一份选集根本就是错的。 */
      holesBig: holeSizes.filter(function (n) { return n >= MIN_LOCH; }).length,
      minHoleEdges: MIN_LOCH,
      largestHole: holeSizes.length ? holeSizes[0] : 0,

      nonManifold: nonManifold,
      inconsistentEdges: inconsistentEdges,
      orientContradictions: orientContradictions,
      /* 为真时表示“正确”与“反转”的划分取决于遍历顺序。此时 flippedTris
         就不是一个可以用来下判断、更不用说据以修复的数字。 */
      windingUnstable: orientContradictions > 0,
      flippedTris: flippedTris,
      flippedFlags: flipped,
      insideOut: boundary.length === 0 && vol < 0,

      islands: islandTris.length,
      islandTris: islandTris.slice(0, 12),
      strayIslands: islandTris.filter(function (n) { return n < strayCut; }).length,

      dims: dims,
      center: center,
      pivotOffset: Math.hypot(center[0], center[1], center[2]) / diag,
      restsOnGround: Math.abs(miny) < diag * 0.02,
      bbox: { minx: minx, miny: miny, minz: minz, maxx: maxx, maxy: maxy, maxz: maxz, diag: diag }
    };
  }

  root.buildAnalysis = buildAnalysis;
})(typeof self !== "undefined" ? (self.T3D = self.T3D || {}) : (module.exports = {}));
