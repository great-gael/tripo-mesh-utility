/* 内嵌的自检，走的是与浏览器里完全相同的那条链路。

   lib/selftest.js 把三个 fixture 以 base64 的形式带在自己身上，并在扩展启动
   时运行。没有这里的这个测试，它会不知不觉地烂掉：谁换掉了一个 fixture 或者
   忘了跑生成器，否则就只能等到浏览器里冒出一条谁也没料到的提示时才发现。 */
global.self = global;
if (typeof atob !== "function") {
  global.atob = function (s) { return Buffer.from(s, "base64").toString("binary"); };
}
require("../lib/inflate.js");
require("../lib/meshopt.js");
require("../lib/fbx.js");
require("../lib/parsers.js");
require("../lib/analyze.js");
require("../lib/selftest.js");

var pass = 0, fail = 0;
function t(n, c, g) { c ? (pass++, console.log("PASS  " + n)) : (fail++, console.log("FAIL  " + n + " :: " + g)); }

var r = self.T3D.selbsttest(self.T3D);
t("drei Wege werden geprueft", r.length === 3, r.length);
r.forEach(function (e) {
  t("Selbsttest " + e.schluessel + " (" + e.was + ")", e.ok === true, e.warum);
});
t("jeder Eintrag nennt seinen Zweck", r.every(function (e) { return !!e.was; }), JSON.stringify(r));

console.log("");
console.log(pass + " passed, " + fail + " failed");
process.exitCode = fail ? 1 : 0;
module.exports = { pass: pass, fail: fail };
