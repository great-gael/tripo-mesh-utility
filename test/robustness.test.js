/* 遇到垃圾数据会怎样？一个运行在别人页面上的扩展，无论收到什么输入都不许
   抛出异常 —— 它只许干净利落地拒绝。 */
global.self = global;
var path = require("path");
["analyze","parsers","inspect","repair","settings","verdict"].forEach(function (f) {
  require(path.join(__dirname, "..", "lib", f + ".js"));
});
var T = global.T3D, fs = require("fs");
var pass = 0, fail = 0;
function t(n, c, g) { c ? (pass++, console.log("PASS  " + n)) : (fail++, console.log("FAIL  " + n + " :: " + g)); }

function rejects(name, fn, wantPattern) {
  try {
    fn();
    t(name, false, "hat nicht abgelehnt");
  } catch (e) {
    var msg = e && e.message ? e.message : String(e);
    var ok = !wantPattern || wantPattern.test(msg);
    t(name, ok, msg);
    if (ok) console.log("      \"" + msg + "\"");
  }
}

var good = fs.readFileSync(path.join(__dirname, "fixtures", "textured.glb"));
var ab = good.buffer.slice(good.byteOffset, good.byteOffset + good.byteLength);

rejects("leerer Puffer", function () { T.parseAny(new ArrayBuffer(0), "x.glb"); });
rejects("zu kurz für einen Header", function () { T.parseAny(new ArrayBuffer(6), "x.glb"); });
rejects("falsche Magic Bytes", function () {
  var b = new ArrayBuffer(64); new Uint8Array(b).fill(65);
  T.parseAny(b, "x.glb");
}, /glb|header/i);
rejects("mitten drin abgeschnitten", function () { T.parseAny(ab.slice(0, 40), "x.glb"); });
/* 内容优先于扩展名：带着错误名字的 GLB 字节照样会被正确读出来。想要触发
   拒绝，就得拿真正不是 GLB 的字节。 */
var notGLB = new ArrayBuffer(128);
new Uint8Array(notGLB).fill(0x41);
rejects("unbekannte Endung", function () { T.parseAny(notGLB, "modell.xyz"); }, /format|glb|obj|stl/i);
rejects("gltf mit externer bin", function () { T.parseAny(notGLB, "szene.gltf"); }, /gltf|glb|external|separate/i);
t("GLB-Bytes unter falschem Namen werden gelesen", T.parseAny(ab, "modell.fbx").indices.length > 0, null);

/* 真正的 FBX 字节必须被指名道姓地说出来，而不只是被拒绝 */
function ascii(str, len) {
  var b = new ArrayBuffer(len || 64), u = new Uint8Array(b);
  for (var i = 0; i < str.length; i++) u[i] = str.charCodeAt(i);
  return b;
}
rejects("binaeres FBX wird benannt", function () { T.parseAny(ascii("Kaydara FBX Binary  \u0000"), "m.fbx"); }, /FBX/);
rejects("Blender-Datei wird benannt", function () { T.parseAny(ascii("BLENDER-v304"), "m.blend"); }, /Blender/);
rejects("zip \u2014 etwa usdz", function () { T.parseAny(ascii("PK\u0003\u0004xx"), "m.usdz"); }, /zip|usdz/i);
rejects("obj ohne Flächen", function () { T.parseOBJ("v 0 0 0\nv 1 0 0\n"); }, /face/i);
rejects("stl ohne Dreiecke", function () { T.parseSTL(new ArrayBuffer(84)); }, /triangle/i);

/* bufferView 指向了缓冲区末尾之外 —— 不许抛出异常 */
var m = T.parseGLB(ab);
var broken = {
  glb: {
    json: {
      images: [{ bufferView: 0, mimeType: "image/png" }],
      bufferViews: [{ buffer: 0, byteOffset: m.glb.bin.byteLength - 8, byteLength: 999999 }],
      materials: [], meshes: []
    },
    bin: m.glb.bin
  }
};
var threw = null;
try { var out = T.inspect(broken, T.readAccessor); } catch (e) { threw = e; }
t("bufferView über Pufferende wirft nicht", threw === null, threw && threw.message);
t("und liefert trotzdem ein Ergebnis", !threw && out && out.hasGLTF === true, null);

/* 用退化的输入做分析 */
var empty = T.buildAnalysis(new Float32Array(0), new Uint32Array(0));
t("leere Geometrie liefert Nullen", empty.triCount === 0 && empty.holes === 0 && empty.islands === 0, JSON.stringify(empty.triCount));

var single = T.buildAnalysis(new Float32Array([0,0,0, 1,0,0, 0,1,0]), new Uint32Array([0,1,2]));
t("ein einzelnes Dreieck", single.triCount === 1 && single.holes === 1 && single.largestHole === 3, JSON.stringify({h:single.holes,l:single.largestHole}));

var allSame = T.buildAnalysis(new Float32Array([0,0,0, 0,0,0, 0,0,0]), new Uint32Array([0,1,2]));
t("drei identische Punkte sind entartet", allSame.degenerate === 1 && allSame.triCount === 1, JSON.stringify(allSame.degenerate));

/* 判定（verdict）必须能应付不完整的输入 */
var v = T.verdict.decide(empty, null, T.settings.DEFAULTS);
t("Verdikt ohne inspect-Daten", !!(v && v.call && v.color), JSON.stringify(v));

var vi = T.verdict.decide(single, { hasGLTF: true, primitives: 1, hasUV: false, images: [], materialNames: [] }, T.settings.DEFAULTS);
t("Verdikt meldet fehlende UVs", vi.warnings.some(function (w) { return /UV/.test(w); }), JSON.stringify(vi.warnings));

/* 修复要拒绝，而不是抛出异常 */
var can = T.canRepair({ glb: null }, single);
t("canRepair lehnt Szenen-Geometrie sauber ab", can.ok === false && /viewer/i.test(can.why), can.why);

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
process.exitCode = fail ? 1 : 0;
