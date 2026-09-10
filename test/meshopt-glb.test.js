/* Meshopt 从文件一路走到几何体。

   meshopt.test.js 单独检验编解码器本身，逐位对照官方测试向量。这里关心的是
   彼此的配合：buffer arena（铺在所有 buffer 之上的一整片连续内存）、fallback buffer、被改写的
   bufferView 偏移量，以及最终得出的几何体是否与一个未压缩文件的相同。错误
   恰恰就坐在这中间：它不抛出异常，而是给出一份满是凭空捏造的洞的报告。

   三个小 fixture 是同一个单位立方体的三种编码：
     meshopt-v0.glb   ATTRIBUTES 0xa0 + INDICES   0xd1
     meshopt-v1.glb   ATTRIBUTES 0xa1 + TRIANGLES 0xe1
     meshopt-min.glb  与 v0 相同，另外还声明了 KHR_mesh_quantization
   来自 glTF-Sample-Assets 的 MeshoptCubeTest.glb 在 60 个 view 里混合了全部
   四种组合，从而抓住单独一条数据流永远显示不出来的问题。 */
var fs = require("fs");
var path = require("path");
var P = require("../lib/parsers.js");
var R = require("../lib/repair.js");

var pass = 0, fail = 0;
function t(n, c, g) { c ? (pass++, console.log("PASS  " + n)) : (fail++, console.log("FAIL  " + n + " :: " + g)); }

function laden(name) {
  var b = fs.readFileSync(path.join(__dirname, "fixtures", name));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
}
function grenzen(pos) {
  var mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (var i = 0; i < pos.length; i += 3) {
    for (var c = 0; c < 3; c++) {
      var v = pos[i + c];
      if (v < mn[c]) mn[c] = v;
      if (v > mx[c]) mx[c] = v;
    }
  }
  return { mn: mn, mx: mx };
}
function endlich(pos) {
  for (var i = 0; i < pos.length; i++) if (!isFinite(pos[i])) return false;
  return true;
}

/* ---- 三种编码下的同一个立方体 ---- */
["meshopt-v0.glb", "meshopt-v1.glb", "meshopt-min.glb"].forEach(function (name) {
  var m;
  try { m = P.parseAny(laden(name), name); }
  catch (e) { t(name + " parst", false, e.message); return; }

  t(name + " parst", true, null);
  t(name + " hat 12 Dreiecke", m.indices.length / 3 === 12, m.indices.length / 3);
  t(name + " hat 24 Vertices", m.positions.length / 3 === 24, m.positions.length / 3);
  t(name + " nur endliche Positionen", endlich(m.positions), null);

  var g = grenzen(m.positions);
  var rund = g.mn.concat(g.mx).every(function (v) { return Math.abs(Math.abs(v) - 0.5) < 1e-5; });
  t(name + " ist der Einheitswuerfel", rund, JSON.stringify(g));

  var maxI = 0;
  for (var k = 0; k < m.indices.length; k++) if (m.indices[k] > maxI) maxI = m.indices[k];
  t(name + " kein Index ausserhalb", maxI < m.positions.length / 3, maxI);

  t(name + " ist als dekomprimiert markiert", m.glb.decompressed === true, m.glb.decompressed);

  /* 自从输出会一并带上被改写的 JSON、因而是一个有效的未压缩 .glb 之后，
     修复就是被允许的。在此之前，它会把原始的 JSON 与一个已经解包的主体
     组合起来，从而错误地描述它自己的字节。 */
  var rep = R.canRepair(m, { flippedTris: 5, insideOut: false });
  t(name + " laesst sich reparieren", rep.ok === true, JSON.stringify(rep));
});

/* ---- 那个混合编码的文件 ---- */
var cube;
try { cube = P.parseAny(laden("MeshoptCubeTest.glb"), "MeshoptCubeTest.glb"); }
catch (e) { cube = null; t("MeshoptCubeTest parst", false, e.message); }
if (cube) {
  t("MeshoptCubeTest parst", true, null);
  t("MeshoptCubeTest hat 320 Dreiecke", cube.indices.length / 3 === 320, cube.indices.length / 3);
  t("MeshoptCubeTest nur endliche Positionen", endlich(cube.positions), null);
  t("MeshoptCubeTest ist dekomprimiert", cube.glb.decompressed === true, cube.glb.decompressed);
}

/* ---- 往返：先修复，再重新读入 ----

   这才是真正算数的那个测试。一个被修复的文件不仅必须能够产生出来，还
   必须能够被重新读入 —— 而且是在没有它已经不再包含的那种压缩的情况下。
   只检验有字节被产生出来的人，不会察觉这些字节把它们自己的结构描述
   错了。 */
var quelle = P.parseAny(laden("meshopt-v1.glb"), "meshopt-v1.glb");
var tris = quelle.indices.length / 3;

/* 把两个三角形标记为方向错误，其余的保持原样。 */
var marken = new Uint8Array(tris);
marken[0] = 1; marken[3] = 1;
var ergebnis = R.repairWinding(quelle, marken, false);
t("Reparatur patcht genau die markierten", ergebnis.patched === 2, ergebnis.patched);
t("Reparatur liefert Bytes", ergebnis.buffer && ergebnis.buffer.byteLength > 0, ergebnis.buffer && ergebnis.buffer.byteLength);

var zurueck;
try { zurueck = P.parseAny(ergebnis.buffer, "repariert.glb"); }
catch (e) { zurueck = null; t("reparierte Datei laesst sich lesen", false, e.message); }
if (zurueck) {
  t("reparierte Datei laesst sich lesen", true, null);
  t("gleiche Dreieckszahl", zurueck.indices.length / 3 === tris, zurueck.indices.length / 3);
  t("gleiche Vertexzahl", zurueck.positions.length === quelle.positions.length, zurueck.positions.length);
  t("ohne Kompression eingelesen", zurueck.glb.decompressed === false, zurueck.glb.decompressed);
  var req = zurueck.glb.json.extensionsRequired || [];
  t("meshopt steht nicht mehr in extensionsRequired",
    req.join(",").indexOf("meshopt") === -1, JSON.stringify(req));
  t("genau ein Buffer", (zurueck.glb.json.buffers || []).length === 1,
    JSON.stringify(zurueck.glb.json.buffers));

  /* 被标记的三角形必须交换了它们的第二个和第三个顶点，其他所有的
     则不允许。 */
  function dreieck(m, i) { return [m.indices[i*3], m.indices[i*3+1], m.indices[i*3+2]]; }
  var a0 = dreieck(quelle, 0), b0 = dreieck(zurueck, 0);
  t("markiertes Dreieck ist gedreht",
    b0[0] === a0[0] && b0[1] === a0[2] && b0[2] === a0[1], JSON.stringify([a0, b0]));
  var a1 = dreieck(quelle, 1), b1 = dreieck(zurueck, 1);
  t("unmarkiertes Dreieck bleibt", b1.join() === a1.join(), JSON.stringify([a1, b1]));
}

/* ---- 回归看守：未压缩的仍旧保持未压缩 ---- */
var alt = P.parseAny(laden("test.glb"), "test.glb");
t("unkomprimierte .glb bleibt unangetastet", alt.glb.decompressed === false, alt.glb.decompressed);
t("unkomprimierte .glb bleibt reparierbar",
  R.canRepair(alt, { flippedTris: 5, insideOut: false }).ok === true,
  JSON.stringify(R.canRepair(alt, { flippedTris: 5, insideOut: false })));

console.log("");
console.log(pass + " passed, " + fail + " failed");
process.exitCode = fail ? 1 : 0;
module.exports = { pass: pass, fail: fail };
