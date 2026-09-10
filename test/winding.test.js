/* "反转" 什么时候是一次测量，什么时候只是一个假象？

   flippedTris 来自朝向传播：落在少数一方的被判定为反转。这以划分本身
   确实是唯一确定的为前提。一旦传播遇上矛盾，它就取决于遍历顺序 —
   那时任何数字都是编造的。

   在 Tripo 的斧头上，八条彼此不一致的边制造了 900 处矛盾，并由此得出
   55.487 个三角形中有 10.227 个属于 "少数"，也就是号称 18 % 的反转
   面。而在一个平坦的辅助平面上，得出的是 "50 % 反转"。两者都是胡说，
   两者在面板里看上去都像一次测量。

   朝向无法判定的教科书案例是莫比乌斯带：一个无法一致定向的曲面 —
   不是因为有缺陷，而是天生如此。谁把它报成 "一半的三角形是反的"，
   就不是在测量，而是把一个矛盾四舍五入成了一个数字。 */
var A = require("../lib/analyze.js");
var V = require("../lib/verdict.js").verdict;
var S = require("../lib/settings.js").settings;
var R = require("../lib/repair.js");

var pass = 0, fail = 0;
function t(n, c, g) { c ? (pass++, console.log("PASS  " + n)) : (fail++, console.log("FAIL  " + n + " :: " + g)); }

/* 一条由 n 段构成的带子，两端拧转之后接合在一起。 */
function moebius(n) {
  var pos = [], idx = [];
  for (var i = 0; i < n; i++) {
    var w = (i / n) * Math.PI * 2;
    var c = Math.cos(w), s = Math.sin(w);
    pos.push(c * 2, s * 2, -0.3);   /* a_i */
    pos.push(c * 2, s * 2, 0.3);    /* b_i */
  }
  for (var k = 0; k < n; k++) {
    var a0 = k * 2, b0 = k * 2 + 1;
    var naechste = (k + 1) % n;
    var a1 = naechste * 2, b1 = naechste * 2 + 1;
    /* 最后一段是拧转着接上的：a 碰上的是 b。 */
    if (k === n - 1) { var h = a1; a1 = b1; b1 = h; }
    idx.push(a0, b0, b1);
    idx.push(a0, b1, a1);
  }
  return { positions: new Float32Array(pos), indices: new Uint32Array(idx) };
}

/* 同一条带子，但不加拧转 — 一个普通的圆柱侧面。 */
function zylinder(n) {
  var pos = [], idx = [];
  for (var i = 0; i < n; i++) {
    var w = (i / n) * Math.PI * 2;
    pos.push(Math.cos(w) * 2, Math.sin(w) * 2, -0.3);
    pos.push(Math.cos(w) * 2, Math.sin(w) * 2, 0.3);
  }
  for (var k = 0; k < n; k++) {
    var a0 = k * 2, b0 = k * 2 + 1, m = (k + 1) % n, a1 = m * 2, b1 = m * 2 + 1;
    idx.push(a0, b0, b1);
    idx.push(a0, b1, a1);
  }
  return { positions: new Float32Array(pos), indices: new Uint32Array(idx) };
}

var band = moebius(16);
var anBand = A.buildAnalysis(band.positions, band.indices, { sliverQ: 0.05 });
var rohr = zylinder(16);
var anRohr = A.buildAnalysis(rohr.positions, rohr.indices, { sliverQ: 0.05 });

t("Moebiusband: Orientierung widerspricht sich", anBand.orientContradictions > 0, anBand.orientContradictions);
t("Moebiusband: als instabil gekennzeichnet", anBand.windingUnstable === true, anBand.windingUnstable);
t("Zylinder: keine Widersprueche", anRohr.orientContradictions === 0, anRohr.orientContradictions);
t("Zylinder: stabil", anRohr.windingUnstable === false, anRohr.windingUnstable);
t("Zylinder: nichts invertiert", anRohr.flippedTris === 0, anRohr.flippedTris);

/* 判定结果不得说出一个编造的三角形数目。 */
var vBand = V.decide(anBand, { hasGLTF: false }, S.DEFAULTS);
var textBand = JSON.stringify(vBand);
t("Urteil nennt keine invertierten Dreiecke", !/inverted triangle/i.test(textBand), textBand.slice(0, 140));
/* 莫比乌斯带几乎全是边界，所以 verdict 理所当然地对开放边下判断，
   根本轮不到那句关于缠绕的话。那句话属于 "其余完好、但自相矛盾"
   这一情形 — 它在这里用一个闭合立方体来检验，该立方体的分析结果
   事后被标记为不稳定。这并不是为测试而硬造出来的构造：Tripo 的斧头
   正处于这种状况，只是旁边还有别的缺陷。 */
function wuerfel() {
  var p = [-1,-1,-1, 1,-1,-1, 1,1,-1, -1,1,-1, -1,-1,1, 1,-1,1, 1,1,1, -1,1,1];
  var i = [0,2,1, 0,3,2, 4,5,6, 4,6,7, 0,1,5, 0,5,4, 1,2,6, 1,6,5, 2,3,7, 2,7,6, 3,0,4, 3,4,7];
  return { positions: new Float32Array(p), indices: new Uint32Array(i) };
}
var w = wuerfel();
var anW = A.buildAnalysis(w.positions, w.indices, { sliverQ: 0.05 });
t("Wuerfel ist geschlossen und sauber", anW.holes === 0 && anW.flippedTris === 0 && !anW.windingUnstable,
  anW.holes + "/" + anW.flippedTris + "/" + anW.windingUnstable);

var anInstabil = Object.assign({}, anW, { windingUnstable: true, inconsistentEdges: 3, flippedTris: 5 });
var textInstabil = JSON.stringify(V.decide(anInstabil, { hasGLTF: false }, S.DEFAULTS));
t("Urteil benennt die widerspruechlichen Kanten", /contradict/i.test(textInstabil), textInstabil.slice(0, 160));
t("Urteil nennt dabei keine Dreieckszahl", !/inverted triangle/i.test(textInstabil), textInstabil.slice(0, 160));

var vRohr = V.decide(anRohr, { hasGLTF: false }, S.DEFAULTS);
t("sauberes Band bleibt sauber", !/contradict/i.test(JSON.stringify(vRohr)), JSON.stringify(vRohr).slice(0, 120));

/* 在这里修复，等于把随便哪一半镜像翻转过来。 */
function alsDatei(m, tris) {
  return { positions: m.positions, indices: m.indices,
    glb: { singleBin: true, decompressed: false, prims: [{ accessor: 0, triStart: 0, triCount: tris }] } };
}
var repBand = R.canRepair(alsDatei(band, band.indices.length / 3), anBand);
t("instabile Wicklung wird nicht repariert", repBand.ok === false, JSON.stringify(repBand));
t("und die Begruendung erklaert warum", /contradict|majority/i.test(repBand.why), repBand.why);

console.log("");
console.log(pass + " passed, " + fail + " failed");
process.exitCode = fail ? 1 : 0;
module.exports = { pass: pass, fail: fail };
