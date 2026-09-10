/* 解压器与 Node 的 zlib 对照检验。

   它是 FBX 的前提条件：FBX 的数字数组实际上总是以 zlib 压缩形式存放，在 Tripo 自己
   的文件里是五个中的五个。一个 inflate（解压）若在五个数组中的一个上出错，
   并不会抛出异常，而是从噪声里造出几何体 —— 而关于它的报告看上去就像一次
   真正的测量。因此这里对照一个独立的实现来检验，而不是对照它自己。

   三种 deflate 块类型必须全部出现：Stored 用于不可压缩的数据（level 0），
   Fixed-Huffman 用于非常短的输入，Dynamic-Huffman 用于其余的一切。 */
var I = require("../lib/inflate.js");
var zlib = require("zlib");

var pass = 0, fail = 0;
function t(n, c, g) { c ? (pass++, console.log("PASS  " + n)) : (fail++, console.log("FAIL  " + n + " :: " + g)); }

function gleich(a, b) {
  if (a.length !== b.length) return false;
  for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function runde(name, daten, level) {
  var komp = zlib.deflateSync(Buffer.from(daten), { level: level });
  var ist;
  try { ist = I.inflateZlib(new Uint8Array(komp), daten.length); }
  catch (e) { t(name, false, "Ausnahme: " + e.message); return; }
  t(name, gleich(new Uint8Array(daten), ist), "Bytes weichen ab");
}

/* 不可压缩 -> Stored 块 */
var zufall = new Uint8Array(40000), seed = 1;
for (var i = 0; i < zufall.length; i++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; zufall[i] = seed & 0xff; }

/* 高度可压缩 -> Dynamic-Huffman，带有很长的回溯引用 */
var konstant = new Uint8Array(40000);
for (var k = 0; k < konstant.length; k++) konstant[k] = k % 7;

var text = Buffer.from("Ein Pruefer, der ueber seinen eigenen Zustand luegt. ".repeat(600), "utf8");

runde("Stored: Zufallsdaten, level 0", zufall, 0);
runde("Dynamic: Zufallsdaten, level 9", zufall, 9);
runde("Dynamic: Muster, level 6", konstant, 6);
runde("Dynamic: Text, level 6", text, 6);
runde("Fixed: drei Bytes", new Uint8Array([7, 8, 9]), 6);
runde("Grenzfall: ein Byte", new Uint8Array([42]), 6);

/* 窗口溢出只有在数据长于回溯窗口的 32 KB、并且超出这个范围重复时，
   才会暴露出来。 */
var lang = new Uint8Array(200000);
for (var m = 0; m < lang.length; m++) lang[m] = (m * 31 + (m >> 8)) & 0xff;
runde("ueber das 32-KB-Fenster hinaus", lang, 6);

/* ---- 拒绝必须是别人真正用得上的东西 ---- */
function lehntAb(name, fn, muster) {
  var msg = null;
  try { fn(); } catch (e) { msg = e.message || String(e); }
  if (!msg) { t(name, false, "keine Ausnahme geworfen"); return; }
  t(name, muster.test(msg) && !/undefined|NaN|\[object/.test(msg), msg);
}

var gut = zlib.deflateSync(Buffer.from(konstant));

lehntAb("kein zlib-Kopf wird erklaert",
  function () { I.inflateZlib(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), 100); },
  /zlib|damaged|compression/i);

lehntAb("absurde Zielgroesse wird erklaert",
  function () { I.inflateZlib(new Uint8Array(gut), 1024 * 1024 * 1024); },
  /implausible|damaged/i);

lehntAb("abgeschnittene Daten werden erklaert",
  function () { I.inflateZlib(new Uint8Array(gut.slice(0, 24)), konstant.length); },
  /incomplete|damaged|unpack/i);

lehntAb("leere Eingabe wird erklaert",
  function () { I.inflateZlib(new Uint8Array(0), 10); },
  /short|damaged/i);

/* 一个给得过小的目标大小不允许溢出，而必须被察觉 —— 否则一个损坏的
   FBX 头部就会往虚无里写。 */
lehntAb("zu kleine Zielgroesse faellt auf",
  function () { I.inflateZlib(new Uint8Array(gut), 10); },
  /size|incomplete|damaged|unpack/i);

console.log("");
console.log(pass + " passed, " + fail + " failed");
process.exitCode = fail ? 1 : 0;
module.exports = { pass: pass, fail: fail };
