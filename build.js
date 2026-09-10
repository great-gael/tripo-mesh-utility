#!/usr/bin/env node
/* node build.js
 *
 * 一棵源码树，一条命令，一个归档。manifest.json 落在归档的根目录里，这
 * 是 AMO 和 Chrome Web Store 共同的要求 —— 从来就没有过做两个不同包的
 * 理由。
 *
 * 打包之前先校验：manifest 能解析，其中引用的每个文件都存在，选项页不加
 * 载缺失的脚本，并且每个随包发布的 .js 文件语法都有效。一个不
 * 做校验的构建，只是把拼写错误挪进了浏览器而已。
 *
 * ZIP 由手工写出，而不是经由某个第三方包，好让这个项目保持零依赖，并且
 * 在 Windows 上跑得和别处一模一样。
 */
"use strict";

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const cp = require("child_process");

const ROOT = __dirname;
const OUT_DIR = path.join(ROOT, "dist");

/* 只排除开发时的累贅；其余的一切都属于发布包。

   按形状排除，而不是按名字。逐个列举名字有两个毛病：下一个新增的工
   具文件会惄惄地被打进包里（.gitattributes 刚刚就是这样），而且
   这份名单本身也会透露开发环境里装了什么。两条规则就能盖住：
   任意层级上以点开头的路径段，以及根目录下的说明文档。浏览器
   不需要它们中的任何一个。 */
const SKIP = [
  /(^|\/)\.[^/]+(\/|$)/,        // 任意层级的点文件与点目录
  /^[^/]+\.md$/,                // 根目录下的说明文档
  /^dist(\/|$)/, /^node_modules(\/|$)/,
  /^test(\/|$)/, /^web-ext-artifacts(\/|$)/,
  /^build\.js$/,
  /\.zip$/, /\.xpi$/
];

function walk(dir, base) {
  base = base || "";
  let out = [];
  for (const name of fs.readdirSync(dir)) {
    const rel = base ? base + "/" + name : name;
    if (SKIP.some((r) => r.test(rel))) continue;
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) out = out.concat(walk(full, rel));
    else out.push(rel);
  }
  return out;
}

/* ---------------------------------------------------------------- 校验 */

function validate(files) {
  const problems = [];

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
  } catch (e) {
    return { problems: ["manifest.json lässt sich nicht parsen: " + e.message] };
  }

  const referenced = [];
  const push = (v) => { if (typeof v === "string") referenced.push(v); };

  if (manifest.background) {
    push(manifest.background.service_worker);
    (manifest.background.scripts || []).forEach(push);
  }
  (manifest.content_scripts || []).forEach((cs) => {
    (cs.js || []).forEach(push);
    (cs.css || []).forEach(push);
  });
  (manifest.web_accessible_resources || []).forEach((w) => (w.resources || []).forEach(push));
  Object.values(manifest.icons || {}).forEach(push);
  Object.values((manifest.action && manifest.action.default_icon) || {}).forEach(push);
  if (manifest.options_ui) push(manifest.options_ui.page);

  /* 两个 store 都把 name 限制在 45 个字符、description 限制在 132 个字符。
     超出不会在本地报错，只会在上传时被退回——那时已经绕了一大圈。
     这份描述曾有 170 个字符，而没有任何东西提醒过。 */
  const GRENZEN = { name: 45, description: 132, short_name: 12 };
  Object.keys(GRENZEN).forEach((feld) => {
    const wert = manifest[feld];
    if (typeof wert === "string" && wert.length > GRENZEN[feld]) {
      problems.push("manifest." + feld + " ist " + wert.length + " Zeichen lang, " +
        "erlaubt sind " + GRENZEN[feld] + " \u2014 beide Stores lehnen das ab");
    }
  });

  const have = new Set(files);
  for (const ref of referenced) {
    if (!have.has(ref)) problems.push("manifest verweist auf fehlende Datei: " + ref);
  }

  /* 选项页是用 <script src> 加载自己的脚本的，而不是经由 manifest ——
     否则它们会从每一道检查里漏过去。 */
  const optionsPage = manifest.options_ui && manifest.options_ui.page;
  if (optionsPage && have.has(optionsPage)) {
    const html = fs.readFileSync(path.join(ROOT, optionsPage), "utf8");
    const re = /<script[^>]+src=["']([^"']+)["']/g;
    let m;
    while ((m = re.exec(html))) {
      if (!/^https?:/.test(m[1]) && !have.has(m[1])) {
        problems.push(optionsPage + " lädt fehlende Datei: " + m[1]);
      }
    }
  }

  for (const f of files.filter((f) => f.endsWith(".js"))) {
    const r = cp.spawnSync(process.execPath, ["--check", path.join(ROOT, f)], { encoding: "utf8" });
    if (r.status !== 0) {
      const err = (r.stderr || "").split("\n").filter((l) => l.trim());
      /* node --check 把出错的位置和原因写在不同的行里：位置在带冒号行号
         的那一行，原因在写着 Error/Unexpected/Invalid 的那一行。 */
      const where = err.find((l) => /:\d+$/.test(l.trim())) || "";
      const why = err.find((l) => /Error|Unexpected|Invalid/.test(l)) || err[0] || "";
      problems.push("Syntaxfehler in " + f + " " + where.trim() + " \u2014 " + why.trim());
    }
  }

  return { problems, manifest, referenced: referenced.length };
}

/* ------------------------------------------------------------------- zip */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function dosTime(d) {
  return {
    time: ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() / 2)) & 0xFFFF,
    date: (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xFFFF
  };
}

function writeZip(files, outPath) {
  const stamp = dosTime(new Date());
  const locals = [];
  const central = [];
  let offset = 0;

  for (const name of files) {
    const raw = fs.readFileSync(path.join(ROOT, name));
    const deflated = zlib.deflateRawSync(raw, { level: 9 });
    /* 如果压缩没有带来好处，就以未压缩的方式存放。 */
    const useDeflate = deflated.length < raw.length;
    const body = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;
    const nameBuf = Buffer.from(name, "utf8");
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(stamp.time, 10);
    local.writeUInt16LE(stamp.date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, body);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(stamp.time, 12);
    cd.writeUInt16LE(stamp.date, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(0, 36);          // 外部属性
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);

    offset += local.length + nameBuf.length + body.length;
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, Buffer.concat([...locals, centralBuf, end]));
}

/* ------------------------------------------------------------------ 主程序 */

const files = walk(ROOT).sort();
const { problems, manifest } = validate(files);

if (problems.length) {
  console.error("Build abgebrochen:\n");
  problems.forEach((p) => console.error("  " + p));
  process.exit(1);
}

const out = path.join(OUT_DIR, "tripo-mesh-utility-" + manifest.version + ".zip");
writeZip(files, out);

const kb = (fs.statSync(out).size / 1024).toFixed(1);
console.log("v" + manifest.version + "  " + files.length + " Dateien  " + kb + " KB");
console.log(path.relative(ROOT, out));
console.log("\nLädt in Chrome und Firefox, und lässt sich bei beiden Stores hochladen.");
