/* 二进制 FBX，只读到拓扑检查所需要的程度。

   读取的是顶点位置和多边形索引，并汇总到世界坐标中。不读材质、不读纹理、
   不读动画、不读骨骼 — 本项目不测量的东西，也就不必去理解它。

   有两个决定塑造了这个文件：

   惰性解压。节点读取器对每个数组只记住 offset、长度和编码，完全不碰有效
   载荷。最后真正解包出来的只有 Vertices 和 PolygonVertexIndex。在 Tripo 的
   5 MB 文件里这大约是 19 % 的字节；谁要是勤快地全部解压，就会为了这里根本
   没人看的法线和 UV，把 Tripo 的主线程阻塞半秒钟。

   通过 Magic 识别，绝不通过文件扩展名。robustness.test.js 要求：名为 .fbx
   的 GLB 字节仍然要被当作 GLB 读取 — 决定的是内容，不是名字。

   ASCII-FBX 是一种完全不同的格式，仍然拒绝。 */
(function (root) {
  "use strict";

  var MAGIC = "Kaydara FBX Binary";

  /* 标量 Property 类型及其固定宽度。 */
  var SKALAR = { Y: 2, C: 1, I: 4, F: 4, D: 8, L: 8 };
  /* 数组类型，以及单个元素的字节宽度。 */
  var STRIDE = { f: 4, d: 8, l: 8, i: 4, b: 1, c: 1 };

  function entpacker() {
    if (typeof self !== "undefined" && self.T3D && self.T3D.inflateZlib) return self.T3D.inflateZlib;
    if (typeof require === "function") {
      try { return require("./inflate.js").inflateZlib; } catch (e) { return null; }
    }
    return null;
  }

  function text(bytes, off, len) {
    var s = "";
    for (var i = 0; i < len; i++) s += String.fromCharCode(bytes[off + i]);
    return s;
  }

  /* ---- 节点读取器 ------------------------------------------------------ */

  /* 一个节点是 { name, props, kinder }。数组类型的 Property 只以描述的形式
     留下来：{ array: typ, len, enc, off, clen }。 */
  function leseKnoten(dv, bytes, pos, breit, grenze) {
    var kopf = breit ? 25 : 13;
    if (pos + kopf > grenze) return null;

    var endOffset, numProps, propLen;
    if (breit) {
      /* 把 64 位当作两个 32 位来读。High-Word 不为零就意味着一个超过四 GB
         的文件 — 那不是一份有效的输入，而是一份损坏的输入。 */
      if (dv.getUint32(pos + 4, true) || dv.getUint32(pos + 12, true) || dv.getUint32(pos + 20, true)) {
        throw new Error("This FBX declares offsets beyond 4 GB, so it is damaged.");
      }
      endOffset = dv.getUint32(pos, true);
      numProps = dv.getUint32(pos + 8, true);
      propLen = dv.getUint32(pos + 16, true);
      pos += 24;
    } else {
      endOffset = dv.getUint32(pos, true);
      numProps = dv.getUint32(pos + 4, true);
      propLen = dv.getUint32(pos + 8, true);
      pos += 12;
    }
    var nameLen = dv.getUint8(pos); pos += 1;

    /* 空记录（Null-Record）标志着一个节点列表的结束。 */
    if (endOffset === 0) return null;
    if (endOffset > grenze || endOffset <= pos) {
      throw new Error("This FBX has an inconsistent node offset, so it is damaged.");
    }
    if (pos + nameLen > grenze) {
      throw new Error("This FBX ends in the middle of a node name, so the download is incomplete.");
    }

    var name = text(bytes, pos, nameLen); pos += nameLen;
    var propsEnde = pos + propLen;
    if (propsEnde > grenze) {
      throw new Error("This FBX ends in the middle of a property block, so the download is incomplete.");
    }

    var props = [];
    for (var i = 0; i < numProps && pos < propsEnde; i++) {
      var typ = String.fromCharCode(dv.getUint8(pos)); pos += 1;

      if (SKALAR[typ] !== undefined) {
        if (typ === "Y") props.push(dv.getInt16(pos, true));
        else if (typ === "C") props.push((dv.getUint8(pos) & 1) === 1);
        else if (typ === "I") props.push(dv.getInt32(pos, true));
        else if (typ === "F") props.push(dv.getFloat32(pos, true));
        else if (typ === "D") props.push(dv.getFloat64(pos, true));
        else if (typ === "L") {
          /* 以字符串形式保存。这些值是对象标识符，必须能在 Connections 里
             重新找到；超过 2^53 之后，一个浮点数恰好会丢掉那些用来区分两个
             对象的比特位。 */
          var lo = dv.getUint32(pos, true), hi = dv.getUint32(pos + 4, true);
          props.push(hi.toString(16) + ":" + lo.toString(16));
        }
        pos += SKALAR[typ];
        continue;
      }

      if (typ === "S" || typ === "R") {
        var n = dv.getUint32(pos, true); pos += 4;
        if (pos + n > propsEnde) {
          throw new Error("This FBX has a string that runs past its own block, so it is damaged.");
        }
        props.push(typ === "S" ? text(bytes, pos, n) : null);
        pos += n;
        continue;
      }

      if (STRIDE[typ] !== undefined) {
        var len = dv.getUint32(pos, true);
        var enc = dv.getUint32(pos + 4, true);
        var clen = dv.getUint32(pos + 8, true);
        pos += 12;
        if (pos + clen > propsEnde) {
          throw new Error("This FBX has an array that runs past its own block, so it is damaged.");
        }
        props.push({ array: typ, len: len, enc: enc, off: pos, clen: clen });
        pos += clen;
        continue;
      }

      /* 未知类型：块的其余部分已经无法解读，但节点本身仍然可用。跳过，
         而不是抛出异常。 */
      pos = propsEnde;
      break;
    }
    pos = propsEnde;

    var kinder = [];
    while (pos < endOffset - (breit ? 25 : 13)) {
      var kind = leseKnoten(dv, bytes, pos, breit, endOffset);
      if (!kind) break;
      kinder.push(kind);
      pos = kind.ende;
    }

    return { name: name, props: props, kinder: kinder, ende: endOffset };
  }

  function istFBX(bytes) {
    if (!bytes || bytes.length < 27) return false;
    return text(bytes, 0, MAGIC.length) === MAGIC;
  }

  function leseBaum(arrayBuffer) {
    var bytes = new Uint8Array(arrayBuffer);
    if (!istFBX(bytes)) throw new Error("That isn't a binary FBX \u2014 the file header doesn't match.");

    var dv = new DataView(arrayBuffer);
    var version = dv.getUint32(23, true);
    if (version < 7100) {
      throw new Error("This FBX is version " + version + ", which is too old to read. Re-export it from a current tool.");
    }
    var breit = version >= 7500;

    var wurzel = [], pos = 27;
    while (pos < bytes.length - (breit ? 25 : 13)) {
      var k = leseKnoten(dv, bytes, pos, breit, bytes.length);
      if (!k) break;
      wurzel.push(k);
      pos = k.ende;
    }
    return { version: version, breit: breit, wurzel: wurzel, bytes: bytes };
  }

  function kind(knoten, name) {
    if (!knoten) return null;
    for (var i = 0; i < knoten.kinder.length; i++) {
      if (knoten.kinder[i].name === name) return knoten.kinder[i];
    }
    return null;
  }
  function obersterKnoten(baum, name) {
    for (var i = 0; i < baum.wurzel.length; i++) if (baum.wurzel[i].name === name) return baum.wurzel[i];
    return null;
  }

  /* 直到这里才真正去碰有效载荷。 */
  function leseArray(baum, beschr) {
    if (!beschr || !beschr.array) return null;
    var stride = STRIDE[beschr.array];
    var soll = beschr.len * stride;
    var roh;
    if (beschr.enc === 0) {
      if (beschr.clen !== soll) {
        throw new Error("This FBX has an array whose length doesn't match its contents, so it is damaged.");
      }
      roh = baum.bytes.subarray(beschr.off, beschr.off + beschr.clen);
    } else if (beschr.enc === 1) {
      var inflate = entpacker();
      if (!inflate) throw new Error("This FBX is compressed but the unpacker did not load.");
      roh = inflate(baum.bytes.subarray(beschr.off, beschr.off + beschr.clen), soll);
    } else {
      throw new Error("This FBX uses an array encoding this cannot read (" + beschr.enc + ").");
    }

    /* 放到一份自己的、对齐的副本上：subarray 会继承父缓冲区的 offset，而在
       其上建立 Float64Array 需要八字节对齐，那里没有人能保证这一点。 */
    var kopie = new Uint8Array(soll);
    kopie.set(roh.subarray ? roh.subarray(0, soll) : roh);
    var b = kopie.buffer;
    switch (beschr.array) {
      case "d": return new Float64Array(b, 0, beschr.len);
      case "f": return new Float32Array(b, 0, beschr.len);
      case "i": return new Int32Array(b, 0, beschr.len);
      case "l": return new Float64Array(0);   /* int64 数组不会出现在几何数据里 */
      default: return kopie;
    }
  }

  /* ---- 矩阵，按列存储，与 parsers.js 中一致 ---------------------------- */

  function ident() { return new Float64Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]); }

  function mul(a, b) {
    var o = new Float64Array(16), c, r, k, s;
    for (c = 0; c < 4; c++) for (r = 0; r < 4; r++) {
      s = 0;
      for (k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      o[c * 4 + r] = s;
    }
    return o;
  }
  function verschieben(t) {
    var m = ident(); m[12] = t[0]; m[13] = t[1]; m[14] = t[2]; return m;
  }
  function skalieren(s) {
    var m = ident(); m[0] = s[0]; m[5] = s[1]; m[10] = s[2]; return m;
  }
  function drehen(gradXYZ, ordnung) {
    var d = Math.PI / 180;
    var x = gradXYZ[0] * d, y = gradXYZ[1] * d, z = gradXYZ[2] * d;
    var cx = Math.cos(x), sx = Math.sin(x);
    var cy = Math.cos(y), sy = Math.sin(y);
    var cz = Math.cos(z), sz = Math.sin(z);
    var mx = ident(); mx[5] = cx; mx[6] = sx; mx[9] = -sx; mx[10] = cx;
    var my = ident(); my[0] = cy; my[2] = -sy; my[8] = sy; my[10] = cy;
    var mz = ident(); mz[0] = cz; mz[1] = sz; mz[4] = -sz; mz[5] = cz;
    /* FBX 用 0..5 表示 XYZ、XZY、YZX、YXZ、ZXY、ZYX。这个链条是这样构造的：
       最先提到的那个轴最后起作用。 */
    switch (ordnung) {
      case 1: return mul(mx, mul(mz, my));
      case 2: return mul(my, mul(mz, mx));
      case 3: return mul(my, mul(mx, mz));
      case 4: return mul(mz, mul(mx, my));
      case 5: return mul(mz, mul(my, mx));
      default: return mul(mx, mul(my, mz));
    }
  }
  function determinante3(m) {
    return m[0] * (m[5] * m[10] - m[6] * m[9])
         - m[4] * (m[1] * m[10] - m[2] * m[9])
         + m[8] * (m[1] * m[6] - m[2] * m[5]);
  }

  /* ---- 一个 Model 节点的属性 ------------------------------------------ */

  function eigenschaften(model) {
    var p70 = kind(model, "Properties70");
    var werte = {};
    if (!p70) return werte;
    for (var i = 0; i < p70.kinder.length; i++) {
      var p = p70.kinder[i];
      if (p.name !== "P" || !p.props.length) continue;
      var name = p.props[0];
      var zahlen = [];
      for (var j = 4; j < p.props.length; j++) {
        if (typeof p.props[j] === "number") zahlen.push(p.props[j]);
      }
      werte[name] = zahlen;
    }
    return werte;
  }

  function v3(werte, name, standard) {
    var a = werte[name];
    if (!a || a.length < 3) return standard;
    return [a[0], a[1], a[2]];
  }

  /* 按 FBX 定义的完整链条。Pivot 以及前旋转和后旋转都很少见，但每个也只花
     一次乘法 — 把它们省掉就意味着，恰恰在那些使用它们的文件上算错，而且
     这件事没有人会察觉。 */
  function lokaleMatrix(werte) {
    var t = v3(werte, "Lcl Translation", [0, 0, 0]);
    var r = v3(werte, "Lcl Rotation", [0, 0, 0]);
    var s = v3(werte, "Lcl Scaling", [1, 1, 1]);
    var rOff = v3(werte, "RotationOffset", [0, 0, 0]);
    var rPiv = v3(werte, "RotationPivot", [0, 0, 0]);
    var sOff = v3(werte, "ScalingOffset", [0, 0, 0]);
    var sPiv = v3(werte, "ScalingPivot", [0, 0, 0]);
    var pre = v3(werte, "PreRotation", [0, 0, 0]);
    var post = v3(werte, "PostRotation", [0, 0, 0]);
    var ordnung = (werte["RotationOrder"] && werte["RotationOrder"].length) ? werte["RotationOrder"][0] : 0;

    var m = verschieben(t);
    m = mul(m, verschieben(rOff));
    m = mul(m, verschieben(rPiv));
    m = mul(m, drehen(pre, 0));
    m = mul(m, drehen(r, ordnung));
    m = mul(m, drehen([-post[0], -post[1], -post[2]], 0));
    m = mul(m, verschieben([-rPiv[0], -rPiv[1], -rPiv[2]]));
    m = mul(m, verschieben(sOff));
    m = mul(m, verschieben(sPiv));
    m = mul(m, skalieren(s));
    m = mul(m, verschieben([-sPiv[0], -sPiv[1], -sPiv[2]]));
    return m;
  }

  /* 几何变换挂在 Mesh 上，并且不会被继承。 */
  function geometrischeMatrix(werte) {
    var t = v3(werte, "GeometricTranslation", [0, 0, 0]);
    var r = v3(werte, "GeometricRotation", [0, 0, 0]);
    var s = v3(werte, "GeometricScaling", [1, 1, 1]);
    return mul(verschieben(t), mul(drehen(r, 0), skalieren(s)));
  }

  /* ---- 几何 ----------------------------------------------------------- */

  function parseFBX(arrayBuffer) {
    var baum = leseBaum(arrayBuffer);
    var objekte = obersterKnoten(baum, "Objects");
    if (!objekte) throw new Error("This FBX has no object section, so there is nothing to check.");

    /* 标识符 -> 节点，以及从 Connections 得到的 子 -> 父。 */
    var nachId = {}, elternVon = {};
    for (var i = 0; i < objekte.kinder.length; i++) {
      var o = objekte.kinder[i];
      if (typeof o.props[0] === "string") nachId[o.props[0]] = o;
    }
    var conn = obersterKnoten(baum, "Connections");
    if (conn) {
      for (var c = 0; c < conn.kinder.length; c++) {
        var v = conn.kinder[c];
        if (v.name !== "C" || v.props.length < 3) continue;
        if (v.props[0] !== "OO") continue;
        var kindId = v.props[1], elternId = v.props[2];
        if (!elternVon[kindId]) elternVon[kindId] = [];
        elternVon[kindId].push(elternId);
      }
    }

    function modellFuer(geoId) {
      var eltern = elternVon[geoId] || [];
      for (var k = 0; k < eltern.length; k++) {
        var m = nachId[eltern[k]];
        if (m && m.name === "Model") return m;
      }
      return null;
    }

    function weltMatrix(model) {
      var m = ident(), tiefe = 0, aktuell = model;
      while (aktuell && tiefe < 64) {
        m = mul(lokaleMatrix(eigenschaften(aktuell)), m);
        var eltern = elternVon[aktuell.props[0]] || [];
        var naechste = null;
        for (var k = 0; k < eltern.length; k++) {
          var e = nachId[eltern[k]];
          if (e && e.name === "Model") { naechste = e; break; }
        }
        aktuell = naechste;
        tiefe++;
      }
      return m;
    }

    var positions = [], indices = [], vbase = 0, meshes = 0, offeneEcken = 0, entartet = 0;

    for (var g = 0; g < objekte.kinder.length; g++) {
      var geo = objekte.kinder[g];
      if (geo.name !== "Geometry") continue;
      /* 第三个 Property 给出类别；"Shape" 是 Morph 目标。 */
      if (geo.props.length >= 3 && geo.props[2] !== "Mesh") continue;

      var vKnoten = kind(geo, "Vertices");
      var iKnoten = kind(geo, "PolygonVertexIndex");
      if (!vKnoten || !iKnoten) continue;

      var verts = leseArray(baum, vKnoten.props[0]);
      var idx = leseArray(baum, iKnoten.props[0]);
      if (!verts || !idx || verts.length < 9 || idx.length < 3) continue;

      var model = modellFuer(geo.props[0]);
      var welt = model ? weltMatrix(model) : ident();
      if (model) welt = mul(welt, geometrischeMatrix(eigenschaften(model)));
      var gespiegelt = determinante3(welt) < 0;

      var anzahl = Math.floor(verts.length / 3);
      for (var p = 0; p < anzahl; p++) {
        var x = verts[p * 3], y = verts[p * 3 + 1], z = verts[p * 3 + 2];
        positions.push(
          welt[0] * x + welt[4] * y + welt[8] * z + welt[12],
          welt[1] * x + welt[5] * y + welt[9] * z + welt[13],
          welt[2] * x + welt[6] * y + welt[10] * z + welt[14]
        );
      }

      /* 每个多边形的最后一个角点是按位取反的。没有这个标记的多边形就是
         未闭合的 — 我们把它计数，而不是悄悄把剩下的部分吞掉。 */
      var polygon = [];
      for (var e = 0; e < idx.length; e++) {
        var wert = idx[e];
        var ende = wert < 0;
        var echt = ende ? (~wert) : wert;
        if (echt < 0 || echt >= anzahl) { entartet++; polygon.length = 0; continue; }
        polygon.push(echt);
        if (!ende) continue;

        if (polygon.length >= 3) {
          for (var f = 1; f + 1 < polygon.length; f++) {
            if (gespiegelt) {
              indices.push(vbase + polygon[0], vbase + polygon[f + 1], vbase + polygon[f]);
            } else {
              indices.push(vbase + polygon[0], vbase + polygon[f], vbase + polygon[f + 1]);
            }
          }
        } else entartet++;
        polygon.length = 0;
      }
      if (polygon.length) offeneEcken += polygon.length;

      vbase += anzahl;
      meshes++;
    }

    if (!indices.length) throw new Error("No triangles found in that FBX.");

    return {
      positions: new Float32Array(positions),
      indices: new Uint32Array(indices),
      format: "fbx",
      fbx: { version: baum.version, meshes: meshes, entartet: entartet, offeneEcken: offeneEcken },
      glb: null
    };
  }

  root.parseFBX = parseFBX;
  root.istFBX = istFBX;
  root.leseFBXBaum = leseBaum;
})(typeof self !== "undefined" ? (self.T3D = self.T3D || {}) : (module.exports = {}));
