/* node test/run.js —— 无依赖，无浏览器。

   收集器长期以来只检查子进程的退出码（Exit-Code）。可是测试文件虽然打印出自
   己的 FAIL 行，之后仍会正常跑完，也就是以状态 0 结束 —— 失败的断言从来没有
   传到收集器那里。只有当某个文件真的崩溃时，这一点才会被发现。于是
   "all suites passed" 的含义仅仅是"没有文件抛出异常"，而这正是本项目第一条
   规则所反对的那种谎言。

   现在有两条互相独立的判据：退出码，以及每个文件都会打印的结尾行
   "N passed, M failed"。第二条同时也能拦住将来忘记设置退出码的文件。 */
var fs = require("fs"), path = require("path"), cp = require("child_process");
var files = fs.readdirSync(__dirname).filter(function (f) { return /\.test\.js$/.test(f); });

var kaputteSuiten = 0, summeBestanden = 0, summeGescheitert = 0, ohneSchluss = [];

files.forEach(function (f) {
  console.log("\n── " + f);
  var r = cp.spawnSync(process.execPath, [path.join(__dirname, f)], { encoding: "utf8" });
  var aus = r.stdout || "";
  process.stdout.write(aus);
  if (r.stderr) process.stderr.write(r.stderr);

  var schluss = /(\d+) passed, (\d+) failed/.exec(aus);
  if (schluss) {
    summeBestanden += parseInt(schluss[1], 10);
    summeGescheitert += parseInt(schluss[2], 10);
  } else {
    /* 没有结尾行意味着：崩溃了，或者有人把它忘了写。
       两者都是一条发现，而不是一个通过的测试套件。 */
    ohneSchluss.push(f);
  }
  if (r.status !== 0 || (schluss && parseInt(schluss[2], 10) > 0)) kaputteSuiten++;
});

console.log("\n" + summeBestanden + " Assertions bestanden, " + summeGescheitert + " gescheitert" +
  " in " + files.length + " Dateien");
ohneSchluss.forEach(function (f) {
  console.log("  ohne Schlusszeile (abgestuerzt?): " + f);
});
console.log(kaputteSuiten || ohneSchluss.length
  ? "\n" + (kaputteSuiten + ohneSchluss.length) + " suite(s) failed"
  : "\nall suites passed");
process.exit((kaputteSuiten + ohneSchluss.length) ? 1 : 0);
