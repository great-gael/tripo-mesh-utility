/* glTF 层面的检查。

   拓扑告诉你这个表面是否完好。这里告诉你这份资产是否能用：它有没有 UV，UV 是
   不是在浪费图集，贴图究竟有多大。图像的尺寸是从文件头里读出来的，而不是解码
   出来的，所以检查一张 4K 贴图并不比检查一张 64px 的更费劲。 */
(function (root) {
  "use strict";

  var UV_GRID = 192;

  /* ---- 图像文件头 ---- */
  function pngSize(u8) {
    if (u8.length < 24) return null;
    if (u8[0] !== 0x89 || u8[1] !== 0x50 || u8[2] !== 0x4E || u8[3] !== 0x47) return null;
    var dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    if (dv.getUint32(12, false) !== 0x49484452) return null;   // "IHDR"
    return { w: dv.getUint32(16, false), h: dv.getUint32(20, false), kind: "png" };
  }

  function jpegSize(u8) {
    if (u8.length < 4 || u8[0] !== 0xFF || u8[1] !== 0xD8) return null;
    var dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    var o = 2;
    while (o + 4 < u8.length) {
      if (u8[o] !== 0xFF) { o++; continue; }
      var m = u8[o + 1];
      if (m === 0xD8 || m === 0x01 || (m >= 0xD0 && m <= 0xD7)) { o += 2; continue; }
      var len = dv.getUint16(o + 2, false);
      // SOF0..SOF15，不包括 huffman/arithmetic/DNL 这几个标记
      if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) {
        if (o + 9 > u8.length) return null;
        return { h: dv.getUint16(o + 5, false), w: dv.getUint16(o + 7, false), kind: "jpeg" };
      }
      o += 2 + len;
    }
    return null;
  }

  function webpSize(u8) {
    if (u8.length < 30) return null;
    if (u8[0] !== 0x52 || u8[1] !== 0x49 || u8[2] !== 0x46 || u8[3] !== 0x46) return null;   // RIFF
    if (u8[8] !== 0x57 || u8[9] !== 0x45 || u8[10] !== 0x42 || u8[11] !== 0x50) return null; // WEBP
    if (u8[12] === 0x56 && u8[13] === 0x50 && u8[14] === 0x38 && u8[15] === 0x58) {          // VP8X
      var w = 1 + (u8[24] | (u8[25] << 8) | (u8[26] << 16));
      var h = 1 + (u8[27] | (u8[28] << 8) | (u8[29] << 16));
      return { w: w, h: h, kind: "webp" };
    }
    return { w: 0, h: 0, kind: "webp" };
  }

  function imageSize(u8) {
    return pngSize(u8) || jpegSize(u8) || webpSize(u8) || null;
  }

  /* ---- UV 占用情况 ----
     把 UV 布局光栅化成一张粗网格。coverage 说明模型实际用掉了图集的多少；
     overlap 说明有多少格子里落进了不止一个三角形，而正是这一点会毁掉烘焙。 */
  function rasteriseUV(uv, idx, grid, counts) {
    var n = grid;
    for (var t = 0; t + 2 < idx.length; t += 3) {
      var a = idx[t], b = idx[t+1], c = idx[t+2];
      var ax = uv[a*2] * n, ay = uv[a*2+1] * n;
      var bx = uv[b*2] * n, by = uv[b*2+1] * n;
      var cx = uv[c*2] * n, cy = uv[c*2+1] * n;

      var x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx)));
      var x1 = Math.min(n - 1, Math.ceil(Math.max(ax, bx, cx)));
      var y0 = Math.max(0, Math.floor(Math.min(ay, by, cy)));
      var y1 = Math.min(n - 1, Math.ceil(Math.max(ay, by, cy)));
      if (x1 < x0 || y1 < y0) continue;

      var d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
      if (d === 0) continue;

      // 比一个格子还小的三角形照样占掉一个格子
      if (x1 === x0 && y1 === y0) {
        var one = y0 * n + x0;
        if (counts[one] < 65535) counts[one]++;
        continue;
      }
      for (var y = y0; y <= y1; y++) {
        for (var x = x0; x <= x1; x++) {
          var px = x + 0.5, py = y + 0.5;
          var l1 = ((by - cy) * (px - cx) + (cx - bx) * (py - cy)) / d;
          var l2 = ((cy - ay) * (px - cx) + (ax - cx) * (py - cy)) / d;
          var l3 = 1 - l1 - l2;
          if (l1 >= -0.001 && l2 >= -0.001 && l3 >= -0.001) {
            var o = y * n + x;
            if (counts[o] < 65535) counts[o]++;
          }
        }
      }
    }
  }

  function inspect(mesh, readAccessor) {
    var out = {
      hasGLTF: false,
      materials: 0,
      materialNames: [],
      images: [],
      textureBytes: 0,
      maxTexture: 0,
      hasNormalMap: false,
      hasUV: false,
      uvMissingPrims: 0,
      uvCoverage: null,
      uvOverlap: null,
      uvOutOfRange: 0,
      primitives: 0
    };
    if (!mesh.glb || !mesh.glb.json) return out;

    var json = mesh.glb.json, bin = mesh.glb.bin;
    out.hasGLTF = true;
    out.materials = (json.materials || []).length;
    out.materialNames = (json.materials || []).map(function (m, i) {
      return m.name || ("material " + i);
    }).slice(0, 8);

    out.hasNormalMap = (json.materials || []).some(function (m) { return !!m.normalTexture; });

    /* 贴图 */
    (json.images || []).forEach(function (img) {
      var rec = { mime: img.mimeType || "unknown", w: 0, h: 0, bytes: 0 };
      if (img.bufferView !== undefined && json.bufferViews[img.bufferView]) {
        var bv = json.bufferViews[img.bufferView];
        rec.bytes = bv.byteLength || 0;
        try {
          /* 在缓冲区末尾，一个过长的窗口会抛出异常，所以要按实际剩下的
             字节数把它夹住。 */
          var start = bv.byteOffset || 0;
          var span = Math.max(0, Math.min(rec.bytes, 4096, bin.byteLength - start));
          var u8 = new Uint8Array(bin, start, span);
          var sz = imageSize(u8);
          if (sz) { rec.w = sz.w; rec.h = sz.h; rec.mime = rec.mime === "unknown" ? sz.kind : rec.mime; }
        } catch (e) { /* 文件头读不出来，那就保持为零 */ }
      } else if (img.uri) {
        rec.mime = "external";
      }
      out.textureBytes += rec.bytes;
      out.maxTexture = Math.max(out.maxTexture, rec.w, rec.h);
      out.images.push(rec);
    });

    /* UV，遍历的是几何数据所来自的同一批 primitives */
    var counts = new Uint16Array(UV_GRID * UV_GRID);
    var anyUV = false, outOfRange = 0, uvTotal = 0;
    var meshes = json.meshes || [];
    for (var mi = 0; mi < meshes.length; mi++) {
      var list = meshes[mi].primitives || [];
      for (var pi = 0; pi < list.length; pi++) {
        var prim = list[pi];
        if (prim.mode !== undefined && prim.mode !== 4) continue;
        if (!prim.attributes || prim.attributes.POSITION === undefined) continue;
        out.primitives++;

        var tc = prim.attributes.TEXCOORD_0;
        if (tc === undefined) { out.uvMissingPrims++; continue; }
        anyUV = true;

        var uv, idx;
        try {
          uv = readAccessor(json, bin, tc);
          if (prim.indices !== undefined) {
            idx = readAccessor(json, bin, prim.indices);
          } else {
            idx = new Uint32Array(uv.length / 2);
            for (var q = 0; q < idx.length; q++) idx[q] = q;
          }
        } catch (e) { continue; }

        for (var u = 0; u < uv.length; u++) {
          uvTotal++;
          if (uv[u] < -0.001 || uv[u] > 1.001) outOfRange++;
        }
        rasteriseUV(uv, idx, UV_GRID, counts);
      }
    }

    out.hasUV = anyUV;
    if (anyUV) {
      var touched = 0, multi = 0;
      for (var i = 0; i < counts.length; i++) {
        if (counts[i] > 0) touched++;
        if (counts[i] > 1) multi++;
      }
      out.uvCoverage = touched / counts.length;
      out.uvOverlap = touched ? multi / touched : 0;
      out.uvOutOfRange = uvTotal ? outOfRange / uvTotal : 0;
    }
    return out;
  }

  root.inspect = inspect;
  root.imageSize = imageSize;
})(typeof self !== "undefined" ? (self.T3D = self.T3D || {}) : (module.exports = {}));
