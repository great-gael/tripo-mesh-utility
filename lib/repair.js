/* 环绕方向（winding）修复。

   一个三角形朝向哪一面，完全由它三个索引的顺序决定，所以修好一个三角形无非
   是对索引缓冲做一次置换，别的什么都不是。这里就地改写那些字节，并逐字复用
   原来的 JSON 块，也就是说材质、UV、贴图、蒙皮和扩展都会和 Tripo 写下它们
   时一模一样地留下来。没有任何东西被重新编码。 */
(function (root) {
  "use strict";

  var SIZE = { 5121: 1, 5123: 2, 5125: 4 };

  function canRepair(mesh, an) {
    /* 没有这个分支，一个刚放进一份 FBX 的人得到的建议会是“把 .glb 保存
       下来再放进去” —— 可他刚刚做的正是这件事。 */
    if (mesh.format === "fbx") {
      return { ok: false, why: "Repair rewrites the original file, and this is an FBX. Export the model as .glb and drop that in to repair it." };
    }
    if (!mesh.glb) {
      return { ok: false, why: "Repair rewrites the original file, and this mesh was read out of the viewer rather than from one. Save the .glb and drop it in to repair it." };
    }
    if (!mesh.glb.singleBin) return { ok: false, why: "This .glb has more than one binary chunk." };
    /* 在 meshopt 的情况下，索引不在文件里，而在一块运行时解码出来的 Arena
       （连续缓冲区）里。按 Accessor 的偏移量写回去，在原文件中命中的是压缩
       过的字节，交付出来的会是一份被悄无声息毁掉的 .glb。检查可以，修复
       不行。 */
    /* 这里以前有一道封锁。只要修复交付的还是原来的 JSON 配上一个已解包的
       主体，这道封锁就是对的 —— 那样的结果会错误地描述它自己的字节。自从
       改写过的 JSON 也一起交付出去，输出就是一份有效的、未压缩的 .glb，
       该有的全都有：材质、UV、贴图、Node 树。它比原文件更大，因为压缩不会
       再回来 —— 换来的是任何工具都读得懂它。 */
    /* 修复翻转的是少数派。如果这个划分本身就是任意的，那它翻转的就是随便
       哪一半，结果不是让网格更一致，而是换一种方式不一致。 */
    if (an.windingUnstable) {
      return { ok: false, why: "This mesh contradicts itself about which way its faces point, so there is no majority to restore. Re-generating costs less than untangling it." };
    }
    if (!an.flippedTris && !an.insideOut) return { ok: false, why: "Winding is already consistent." };
    var loose = mesh.glb.prims.filter(function (p) { return p.accessor < 0; });
    if (loose.length === mesh.glb.prims.length) {
      return { ok: false, why: "This mesh draws without an index buffer, so there is no winding to permute." };
    }
    return { ok: true, partial: loose.length > 0 };
  }

  /* 一个三角形，只要它与一个正确的多数派一致，或者与一个已翻转的多数派不
     一致，它本身就已经是对的。所以要置换的集合是这两个标志的异或
     （exclusive-or），而不是并集 —— 在一个里外翻转的网格上把所有面都翻一
     遍，只会让那些局部翻转的面和一开始一样错。 */
  function repairWinding(mesh, flipped, flipAll) {
    var glb = mesh.glb;
    if (!glb) throw new Error("Repair needs the original .glb.");

    var bin = glb.bin.slice(0);           // 改的是副本，绝不动已加载的那个缓冲区
    var dv = new DataView(bin);
    var json = glb.json;
    var done = {};
    var patched = 0, skipped = 0;

    for (var p = 0; p < glb.prims.length; p++) {
      var prim = glb.prims[p];
      if (prim.accessor < 0) { skipped += prim.triCount; continue; }
      if (done[prim.accessor]) { skipped += prim.triCount; continue; }
      done[prim.accessor] = 1;

      var acc = json.accessors[prim.accessor];
      var bv = json.bufferViews[acc.bufferView];
      var elem = SIZE[acc.componentType];
      if (!elem) { skipped += prim.triCount; continue; }
      var base = (bv.byteOffset || 0) + (acc.byteOffset || 0);

      for (var lt = 0; lt < prim.triCount; lt++) {
        var isFlipped = !!flipped[prim.triStart + lt];
        if (isFlipped === !!flipAll) continue;
        var oB = base + (lt * 3 + 1) * elem;
        var oC = base + (lt * 3 + 2) * elem;
        var b, c;
        if (elem === 1) {
          b = dv.getUint8(oB); c = dv.getUint8(oC);
          dv.setUint8(oB, c); dv.setUint8(oC, b);
        } else if (elem === 2) {
          b = dv.getUint16(oB, true); c = dv.getUint16(oC, true);
          dv.setUint16(oB, c, true); dv.setUint16(oC, b, true);
        } else {
          b = dv.getUint32(oB, true); c = dv.getUint32(oC, true);
          dv.setUint32(oB, c, true); dv.setUint32(oC, b, true);
        }
        patched++;
      }
    }

    /* 对一份已解包的文件来说，jsonBytes 描述的是解包之前的状态。这时必须
       把改写过的 json 一起带上，否则那些偏移量会指向空处，而文件还宣称有
       一种早已不在的压缩。 */
    var kopf = glb.decompressed ? kodiereJSON(json) : glb.jsonBytes;
    return { buffer: assemble(kopf, bin), patched: patched, skipped: skipped };
  }

  /* 一份 GLB 的 JSON 部分必须按四字节对齐，而且要用空格来填充，不是用零
     字节 —— 填充由 assemble 完成，这里只产生字节序列。 */
  function kodiereJSON(json) {
    var text = JSON.stringify(json);
    if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(text);
    var u = new Uint8Array(text.length);
    for (var i = 0; i < text.length; i++) u[i] = text.charCodeAt(i) & 0xff;
    return u;
  }

  function assemble(jsonBytes, bin) {
    var jsonLen = jsonBytes.byteLength;
    var jsonPad = (4 - (jsonLen % 4)) % 4;
    var binLen = bin.byteLength;
    var binPad = (4 - (binLen % 4)) % 4;
    var total = 12 + 8 + jsonLen + jsonPad + 8 + binLen + binPad;

    var out = new ArrayBuffer(total);
    var u8 = new Uint8Array(out);
    var dv = new DataView(out);

    dv.setUint32(0, 0x46546C67, true);   // "glTF"
    dv.setUint32(4, 2, true);
    dv.setUint32(8, total, true);

    var o = 12;
    dv.setUint32(o, jsonLen + jsonPad, true);
    dv.setUint32(o + 4, 0x4E4F534A, true);
    u8.set(new Uint8Array(jsonBytes), o + 8);
    for (var i = 0; i < jsonPad; i++) u8[o + 8 + jsonLen + i] = 0x20;   // 空格
    o += 8 + jsonLen + jsonPad;

    dv.setUint32(o, binLen + binPad, true);
    dv.setUint32(o + 4, 0x004E4942, true);
    u8.set(new Uint8Array(bin), o + 8);
    // BIN 的填充保持为零

    return out;
  }

  root.canRepair = canRepair;
  root.repairWinding = repairWinding;
})(typeof self !== "undefined" ? (self.T3D = self.T3D || {}) : (module.exports = {}));
