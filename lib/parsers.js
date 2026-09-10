/* 网格解析器。返回合并后的世界坐标几何数据，外加一份 primitive map，
   这样修复结果可以逐字节写回原始文件。 */
(function (root) {
  "use strict";

  var COMP = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
  var NCOMP = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

  /* 两个名称都在流通：Tripo 提供 EXT_，所有公开的测试文件用 KHR_。
     识别是按 bufferView 逐个进行的，而不是通过 extensionsRequired -
     那里只写着是否存在一个 fallback（回退方案）。 */
  var MESHOPT_KEYS = ["EXT_meshopt_compression", "KHR_meshopt_compression"];

  function meshoptExt(bv) {
    if (!bv || !bv.extensions) return null;
    for (var i = 0; i < MESHOPT_KEYS.length; i++) {
      if (bv.extensions[MESHOPT_KEYS[i]]) return bv.extensions[MESHOPT_KEYS[i]];
    }
    return null;
  }

  /* lib 模块视运行环境而定，导出到 module.exports 或者导出到 self.T3D ——
     有几个测试会设置 global.self 来模拟浏览器，这时 module.exports 是空的。
     两条路都要检查，否则识别结果就取决于谁先被加载了。 */
  function fbxModul() {
    if (typeof self !== "undefined" && self.T3D && self.T3D.parseFBX) return self.T3D;
    if (typeof require !== "function") return null;
    try {
      var m = require("./fbx.js");
      if (m && m.parseFBX) return m;
    } catch (e) { return null; }
    if (typeof self !== "undefined" && self.T3D && self.T3D.parseFBX) return self.T3D;
    return null;
  }

  function meshoptDecoder() {
    if (typeof self !== "undefined" && self.T3D && self.T3D.MeshoptDecoder) return self.T3D.MeshoptDecoder;
    if (typeof require === "function") { try { return require("./meshopt.js"); } catch (e) { return null; } }
    return null;
  }

  /* Meshopt 把压缩后的字节放进 BIN 块，并让 bufferViews 指向第二个空的
     "Fallback" buffer，那个 buffer 只描述目标布局。这里没有把后面的每一个
     读取者都改造成 buffer 敏感的，而是一次性在所有 buffer 之上铺开一块平坦
     的 arena，把解码结果写到它该在的位置，再把 offset 改指到那里。此后
     解析器的其余部分重新只看到恰好一段字节序列，就像面对任何一个未压缩的
     文件一样 - byteStride、Node 变换以及 prims-Map 都原封不动。 */
  function decodeMeshopt(json, bin) {
    var views = json.bufferViews || [], i, any = false;
    for (i = 0; i < views.length; i++) if (meshoptExt(views[i])) { any = true; break; }
    if (!any) return { bin: bin, decompressed: false };

    var dec = meshoptDecoder();
    if (!dec) throw new Error("This mesh is meshopt-compressed but the decoder did not load.");

    var buffers = json.buffers || [{ byteLength: bin.byteLength }];
    var bases = [], total = 0, len;
    for (i = 0; i < buffers.length; i++) {
      bases.push(total);
      len = buffers[i].byteLength || 0;
      if (i === 0 && bin.byteLength > len) len = bin.byteLength;
      total += len;
    }
    var arena = new ArrayBuffer(total), bytes = new Uint8Array(arena);
    bytes.set(new Uint8Array(bin), bases[0]);

    for (i = 0; i < views.length; i++) {
      var bv = views[i], ext = meshoptExt(bv);
      if (!ext) continue;
      /* 规范里的硬性不变式。它若不成立，文件就是损坏的，而解码器否则会
         悄无声息地交出无意义的结果，而不是失败。 */
      if (bv.byteLength !== ext.count * ext.byteStride) {
        throw new Error("This .glb has an inconsistent compressed buffer view - the download is probably damaged.");
      }
      var src = new Uint8Array(arena, bases[ext.buffer] + (ext.byteOffset || 0), ext.byteLength);
      var target = new Uint8Array(ext.count * ext.byteStride);
      dec.decodeGltfBuffer(target, ext.count, ext.byteStride, src, ext.mode, ext.filter || "NONE");
      bytes.set(target, bases[bv.buffer] + (bv.byteOffset || 0));
    }

    for (i = 0; i < views.length; i++) {
      var v = views[i];
      v.byteOffset = bases[v.buffer || 0] + (v.byteOffset || 0);
      v.buffer = 0;
      if (v.extensions) {
        delete v.extensions[MESHOPT_KEYS[0]];
        delete v.extensions[MESHOPT_KEYS[1]];
      }
    }
    /* 解包之后，JSON 描述的是一个已经不再以这种形式存在的文件：它声明了一种
       曾被应用过的压缩，还声明了两个 buffer，而实际上只剩下一个。把这些清理
       干净不花任何代价，并且让结果成为一个有效的、未压缩的 glTF —— 正是修复
       稍后能够交付出去的东西。谁省掉这一步，写出的就是一个错误描述自己字节
       的文件。 */
    json.buffers = [{ byteLength: arena.byteLength }];
    ["extensionsUsed", "extensionsRequired"].forEach(function (feld) {
      if (!json[feld]) return;
      json[feld] = json[feld].filter(function (e) {
        return MESHOPT_KEYS.indexOf(e) === -1;
      });
      if (!json[feld].length) delete json[feld];
    });

    return { bin: arena, decompressed: true };
  }

  function mul(a, b) {
    var o = new Float32Array(16), c, r, k, s;
    for (c = 0; c < 4; c++) for (r = 0; r < 4; r++) {
      s = 0;
      for (k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      o[c * 4 + r] = s;
    }
    return o;
  }

  function trs(n) {
    if (n.matrix) return new Float32Array(n.matrix);
    var m = new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]);
    var t = n.translation || [0,0,0], r = n.rotation || [0,0,0,1], s = n.scale || [1,1,1];
    var x = r[0], y = r[1], z = r[2], w = r[3];
    var x2 = x+x, y2 = y+y, z2 = z+z;
    var xx = x*x2, xy = x*y2, xz = x*z2, yy = y*y2, yz = y*z2, zz = z*z2;
    var wx = w*x2, wy = w*y2, wz = w*z2;
    m[0] = (1-(yy+zz))*s[0]; m[1] = (xy+wz)*s[0];     m[2] = (xz-wy)*s[0];
    m[4] = (xy-wz)*s[1];     m[5] = (1-(xx+zz))*s[1]; m[6] = (yz+wx)*s[1];
    m[8] = (xz+wy)*s[2];     m[9] = (yz-wx)*s[2];     m[10] = (1-(xx+yy))*s[2];
    m[12] = t[0]; m[13] = t[1]; m[14] = t[2];
    return m;
  }

  function readAccessor(json, bin, idx) {
    var acc = json.accessors[idx];
    var n = NCOMP[acc.type];
    if (!n) throw new Error("Unsupported accessor type " + acc.type + ".");
    var isFloat = acc.componentType === 5126;
    var out = new (isFloat ? Float32Array : Uint32Array)(acc.count * n);
    if (acc.bufferView === undefined) return out;
    var bv = json.bufferViews[acc.bufferView];
    var base = (bv.byteOffset || 0) + (acc.byteOffset || 0);
    var elem = COMP[acc.componentType];
    if (!elem) throw new Error("Unsupported component type " + acc.componentType + ".");
    var stride = bv.byteStride || (elem * n);
    var dv = new DataView(bin);
    var i, c, o;
    for (i = 0; i < acc.count; i++) {
      for (c = 0; c < n; c++) {
        o = base + i * stride + c * elem;
        switch (acc.componentType) {
          case 5126: out[i*n+c] = dv.getFloat32(o, true); break;
          case 5125: out[i*n+c] = dv.getUint32(o, true); break;
          case 5123: out[i*n+c] = dv.getUint16(o, true); break;
          case 5122: out[i*n+c] = dv.getInt16(o, true); break;
          case 5121: out[i*n+c] = dv.getUint8(o); break;
          case 5120: out[i*n+c] = dv.getInt8(o); break;
        }
      }
    }
    return out;
  }

  /* 把一个 .glb 拆成它的 JSON 块、它的 BIN 块，以及重新把它拼回去所需要的
     填充（padding）布局。 */
  function splitGLB(arrayBuffer) {
    var dv = new DataView(arrayBuffer);
    if (arrayBuffer.byteLength < 12 || dv.getUint32(0, true) !== 0x46546C67) {
      throw new Error("That isn't a .glb — the file header doesn't match.");
    }
    var total = dv.getUint32(8, true);
    var off = 12, json = null, jsonBytes = null, bin = null, binCount = 0;
    while (off + 8 <= Math.min(total, arrayBuffer.byteLength)) {
      var len = dv.getUint32(off, true);
      var type = dv.getUint32(off + 4, true);
      var start = off + 8;
      if (type === 0x4E4F534A && !json) {
        jsonBytes = arrayBuffer.slice(start, start + len);
        try {
          json = JSON.parse(new TextDecoder().decode(new Uint8Array(jsonBytes)));
        } catch (e) {
          /* 一条带字符位置的原始 JSON 报错，对刚刚拖放了一个文件的人毫无
             帮助。几乎每一次，文件都只是根本没传完而已。 */
          throw new Error("The glTF data inside this .glb is incomplete or damaged — the file is probably a truncated download.");
        }
      } else if (type === 0x004E4942) {
        binCount++;
        if (!bin) bin = arrayBuffer.slice(start, start + len);
      }
      off = start + len;
      if (len % 4) off += 4 - (len % 4);
    }
    if (!json) throw new Error("No glTF data found inside that .glb.");
    return {
      json: json,
      jsonBytes: jsonBytes,
      bin: bin || new ArrayBuffer(0),
      binCount: binCount
    };
  }

  function parseGLB(arrayBuffer) {
    var split = splitGLB(arrayBuffer);
    var json = split.json;
    var unpacked = decodeMeshopt(json, split.bin);
    var bin = unpacked.bin;

    /* Meshopt 现在会被解码，量化则在下面按实际读取到的 accessor 来检查，
       而不是按扩展的名称来检查。Draco 仍然被拒绝：这里没有它的解码器。 */
    var req = json.extensionsRequired || [];
    var squashed = req.filter(function (e) { return /draco/i.test(e); });
    if (squashed.length) {
      throw new Error("This mesh is compressed (" + squashed.join(", ") +
        "). Re-export it without compression.");
    }
    if (json.buffers && json.buffers.length && json.buffers[0].uri) {
      throw new Error("This file keeps its data in a separate .bin. Export a single self-contained .glb.");
    }

    var positions = [], indices = [], prims = [], vbase = 0, tribase = 0;
    var nodes = json.nodes || [];
    var scene = json.scenes && json.scenes[json.scene || 0];
    var roots = scene && scene.nodes ? scene.nodes : nodes.map(function (_, i) { return i; });
    var ident = new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]);
    var visited = {};

    function walk(ni, parent) {
      if (visited[ni]) return;
      visited[ni] = 1;
      var node = nodes[ni];
      if (!node) return;
      var world = mul(parent, trs(node));

      if (node.mesh !== undefined && json.meshes && json.meshes[node.mesh]) {
        var list = json.meshes[node.mesh].primitives || [];
        for (var p = 0; p < list.length; p++) {
          var prim = list[p];
          if (prim.mode !== undefined && prim.mode !== 4) continue;
          if (!prim.attributes || prim.attributes.POSITION === undefined) continue;

          /* 在 accessor 上检查，而不是在扩展的名称上检查：决定性的是，
             这一批位置数据是否被量化了。readAccessor 会为非 Float 类型
             建立一个 Uint32Array，负值在那里会变成数十亿的数字，报告就会
             满是凭空捏造的洞 - 宁可干净地拒绝，也不要悄悄算错。 */
          var pacc = json.accessors[prim.attributes.POSITION];
          if (pacc && pacc.componentType !== 5126) {
            throw new Error("This mesh stores quantized positions (KHR_mesh_quantization), which this cannot read yet. Re-export it without quantization.");
          }
          var pos = readAccessor(json, bin, prim.attributes.POSITION);
          var count = pos.length / 3;
          for (var i = 0; i < count; i++) {
            var x = pos[i*3], y = pos[i*3+1], z = pos[i*3+2];
            positions.push(
              world[0]*x + world[4]*y + world[8]*z  + world[12],
              world[1]*x + world[5]*y + world[9]*z  + world[13],
              world[2]*x + world[6]*y + world[10]*z + world[14]
            );
          }

          var triCount;
          if (prim.indices !== undefined) {
            var idx = readAccessor(json, bin, prim.indices);
            for (var k = 0; k < idx.length; k++) indices.push(idx[k] + vbase);
            triCount = Math.floor(idx.length / 3);
          } else {
            for (var v = 0; v < count; v++) indices.push(v + vbase);
            triCount = Math.floor(count / 3);
          }

          prims.push({
            accessor: prim.indices !== undefined ? prim.indices : -1,
            triStart: tribase,
            triCount: triCount
          });
          vbase += count;
          tribase += triCount;
        }
      }
      var kids = node.children || [];
      for (var c = 0; c < kids.length; c++) walk(kids[c], world);
    }

    for (var r = 0; r < roots.length; r++) walk(roots[r], ident);
    if (!indices.length) throw new Error("No triangles found in that file.");

    return {
      positions: new Float32Array(positions),
      indices: new Uint32Array(indices),
      glb: {
        json: json,
        jsonBytes: split.jsonBytes,
        bin: bin,
        prims: prims,
        singleBin: split.binCount <= 1,
        decompressed: unpacked.decompressed
      }
    };
  }

  function parseOBJ(text) {
    var positions = [], indices = [];
    var lines = text.split(/\r?\n/);
    for (var li = 0; li < lines.length; li++) {
      var line = lines[li];
      if (line.charCodeAt(0) === 118 && line.charCodeAt(1) === 32) {
        var p = line.split(/\s+/);
        positions.push(parseFloat(p[1]), parseFloat(p[2]), parseFloat(p[3]));
      } else if (line.charCodeAt(0) === 102 && line.charCodeAt(1) === 32) {
        var f = line.trim().split(/\s+/), face = [];
        for (var i = 1; i < f.length; i++) {
          var v = parseInt(f[i].split('/')[0], 10);
          if (isNaN(v)) continue;
          face.push(v < 0 ? positions.length / 3 + v : v - 1);
        }
        for (var j = 1; j + 1 < face.length; j++) indices.push(face[0], face[j], face[j+1]);
      }
    }
    if (!indices.length) throw new Error("No faces found in that .obj.");
    return { positions: new Float32Array(positions), indices: new Uint32Array(indices), glb: null };
  }

  function parseSTL(arrayBuffer) {
    var dv = new DataView(arrayBuffer);
    var head = new TextDecoder().decode(new Uint8Array(arrayBuffer, 0, Math.min(80, arrayBuffer.byteLength)));
    var n = arrayBuffer.byteLength >= 84 ? dv.getUint32(80, true) : 0;
    if (/^\s*solid/i.test(head) && 84 + n * 50 !== arrayBuffer.byteLength) {
      return parseSTLAscii(new TextDecoder().decode(new Uint8Array(arrayBuffer)));
    }
    if (!n) throw new Error("No triangles found in that .stl.");
    var positions = new Float32Array(n * 9), indices = new Uint32Array(n * 3);
    for (var t = 0; t < n; t++) {
      var o = 84 + t * 50 + 12;
      for (var k = 0; k < 9; k++) positions[t*9+k] = dv.getFloat32(o + k * 4, true);
      indices[t*3] = t*3; indices[t*3+1] = t*3+1; indices[t*3+2] = t*3+2;
    }
    return { positions: positions, indices: indices, glb: null };
  }

  function parseSTLAscii(text) {
    var positions = [], indices = [], i = 0, m;
    var re = /vertex\s+([-\d.eE+]+)\s+([-\d.eE+]+)\s+([-\d.eE+]+)/g;
    while ((m = re.exec(text))) { positions.push(+m[1], +m[2], +m[3]); indices.push(i++); }
    if (!indices.length) throw new Error("No triangles found in that .stl.");
    return { positions: new Float32Array(positions), indices: new Uint32Array(indices), glb: null };
  }

  /* 我们能识别但读不了的格式。把它们的名字说出来，好过 "unrecognised"：
     Tripo 除了 GLB 之外还导出 FBX 和 OBJ，所以总会有人拖进来一个。 */
  function namedButUnreadable(arrayBuffer) {
    if (arrayBuffer.byteLength < 8) return null;
    var head = "";
    try {
      head = String.fromCharCode.apply(null, new Uint8Array(arrayBuffer, 0, Math.min(24, arrayBuffer.byteLength)));
    } catch (e) { return null; }

    if (head.indexOf("Kaydara FBX") === 0) return "FBX";
    if (/^;\s*FBX/.test(head)) return "FBX";
    if (head.indexOf("BLENDER") === 0) return "Blender";
    var u = new Uint8Array(arrayBuffer, 0, 4);
    if (u[0] === 0x50 && u[1] === 0x4B) return "a zip archive (a .usdz or a packed export?)";
    return null;
  }

  /* 嗅探一段其 URL 什么也没透露的缓冲区。 */
  function detectFormat(arrayBuffer, url) {
    var path = "";
    try { path = new URL(url, location.href).pathname.toLowerCase(); } catch (e) { path = String(url).toLowerCase(); }
    /* 内容胜过名称。文件头不会撒谎，扩展名会 —— Tripo 会以
       tripo_texture_<id>.fbx 这样的名字提供模型，而一个名字起错了的模型
       仍然应该被检查。只有那些文本格式没有 magic（魔数），因此依旧只能
       依赖扩展名。 */
    if (arrayBuffer.byteLength >= 4) {
      var dv = new DataView(arrayBuffer);
      if (dv.getUint32(0, true) === 0x46546C67) return "glb";
    }
    var fbxLeser = fbxModul();
    if (fbxLeser && fbxLeser.istFBX(new Uint8Array(arrayBuffer))) return "fbx";

    if (/\.glb$/.test(path)) return "glb";
    if (/\.obj$/.test(path)) return "obj";
    if (/\.stl$/.test(path)) return "stl";
    return null;
  }

  function parseAny(arrayBuffer, name) {
    var fmt = detectFormat(arrayBuffer, name || "");
    if (fmt === "glb") return parseGLB(arrayBuffer);
    if (fmt === "obj") return parseOBJ(new TextDecoder().decode(new Uint8Array(arrayBuffer)));
    if (fmt === "stl") return parseSTL(arrayBuffer);
    if (fmt === "fbx") return fbxModul().parseFBX(arrayBuffer);
    if (/\.gltf$/i.test(name || "")) {
      throw new Error("A bare .gltf points at external files. Export a single .glb instead.");
    }
    var known = namedButUnreadable(arrayBuffer);
    if (known) {
      throw new Error("That's " + known + ", which this can't read. Export the same model as .glb and drop it in again.");
    }
    throw new Error("Unrecognised format. This reads .glb, .obj and .stl.");
  }

  root.namedButUnreadable = namedButUnreadable;
  root.readAccessor = readAccessor;
  root.parseGLB = parseGLB;
  root.parseOBJ = parseOBJ;
  root.parseSTL = parseSTL;
  root.parseAny = parseAny;
  root.detectFormat = detectFormat;
  root.splitGLB = splitGLB;
  root.decodeMeshopt = decodeMeshopt;
})(typeof self !== "undefined" ? (self.T3D = self.T3D || {}) : (module.exports = {}));
