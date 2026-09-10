/* 最小化的二进制 FBX 写入器：只写几何读取器真正需要的那些东西。 */
var fs = require("fs"), zlib = require("zlib");

function W() { this.parts = []; this.len = 0; }
W.prototype.push = function (b) { this.parts.push(b); this.len += b.length; return this; };
W.prototype.u4 = function (v) { var b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0, 0); return this.push(b); };
W.prototype.u8 = function (v) { var b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v), 0); return this.push(b); };
W.prototype.u1 = function (v) { return this.push(Buffer.from([v & 255])); };
W.prototype.buf = function () { return Buffer.concat(this.parts); };

function propD(v) { var b = Buffer.alloc(9); b.write("D", 0, "binary"); b.writeDoubleLE(v, 1); return b; }
function propL(v) { var b = Buffer.alloc(9); b.write("L", 0, "binary"); b.writeBigInt64LE(BigInt(v), 1); return b; }
function propI(v) { var b = Buffer.alloc(5); b.write("I", 0, "binary"); b.writeInt32LE(v, 1); return b; }
function propS(s) { var d = Buffer.from(s, "binary"); var h = Buffer.alloc(5); h.write("S", 0, "binary"); h.writeUInt32LE(d.length, 1); return Buffer.concat([h, d]); }
function propArr(code, elems, write, stride, compress) {
  var raw = Buffer.alloc(elems.length * stride);
  elems.forEach(function (v, i) { write(raw, v, i * stride); });
  var payload = compress ? zlib.deflateSync(raw) : raw;
  var h = Buffer.alloc(13); h.write(code, 0, "binary");
  h.writeUInt32LE(elems.length, 1); h.writeUInt32LE(compress ? 1 : 0, 5); h.writeUInt32LE(payload.length, 9);
  return Buffer.concat([h, payload]);
}
var propd = function (a, c) { return propArr("d", a, function (b, v, o) { b.writeDoubleLE(v, o); }, 8, c); };
var propi = function (a, c) { return propArr("i", a, function (b, v, o) { b.writeInt32LE(v, o); }, 4, c); };

function node(name, props, kids) { return { name: name, props: props || [], kids: kids || [] }; }

function encode(n, offset, big) {
  var propBuf = Buffer.concat(n.props);
  var meta = big ? 24 : 12;
  var nameBuf = Buffer.from(n.name, "binary");
  var sentinel = big ? 25 : 13;
  var head = meta + 1 + nameBuf.length;
  var kidStart = offset + head + propBuf.length;
  var kidBufs = [], o = kidStart;
  n.kids.forEach(function (k) { var e = encode(k, o, big); kidBufs.push(e); o += e.length; });
  if (n.kids.length) o += sentinel;
  var end = o;
  var w = new W();
  if (big) { w.u8(end); w.u8(n.props.length); w.u8(propBuf.length); }
  else { w.u4(end); w.u4(n.props.length); w.u4(propBuf.length); }
  w.u1(nameBuf.length); w.push(nameBuf); w.push(propBuf);
  kidBufs.forEach(function (k) { w.push(k); });
  if (n.kids.length) w.push(Buffer.alloc(sentinel));
  var out = w.buf();
  if (out.length !== end - offset) throw new Error("offset mismatch " + n.name + " " + out.length + " != " + (end - offset));
  return out;
}

function build(version, compress, verts, idx, translation) {
  var big = version >= 7500;
  var root = [
    node("FBXHeaderExtension", [], [node("FBXVersion", [propI(version)])]),
    node("Objects", [], [
      node("Geometry", [propL(1001), propS("Cube\u0000\u0001Geometry"), propS("Mesh")], [
        node("Vertices", [propd(verts, compress)]),
        node("PolygonVertexIndex", [propi(idx, compress)])
      ]),
      node("Model", [propL(2001), propS("Cube\u0000\u0001Model"), propS("Mesh")],
        translation ? [node("Properties70", [], [
          node("P", [propS("Lcl Translation"), propS("Lcl Translation"), propS(""), propS("A"),
            propD(translation[0]), propD(translation[1]), propD(translation[2])])
        ])] : [])
    ]),
    node("Connections", [], [
      node("C", [propS("OO"), propL(1001), propL(2001)]),
      node("C", [propS("OO"), propL(2001), propL(0)])
    ])
  ];
  var head = Buffer.alloc(27);
  head.write("Kaydara FBX Binary  \u0000", 0, "binary");
  head[21] = 0x1a; head[22] = 0x00; head.writeUInt32LE(version, 23);
  var parts = [head], off = 27;
  root.forEach(function (n) { var e = encode(n, off, big); parts.push(e); off += e.length; });
  parts.push(Buffer.alloc(big ? 25 : 13));                 // Null-Record：顶层列表的结束
  parts.push(Buffer.alloc(16));                            // Footer 占位符
  return Buffer.concat(parts);
}

/* 单位立方体，8 个顶点（Vertices），6 个四边形（每个多边形的最后一个索引是 ~i） */
var V = [-0.5,-0.5,-0.5, 0.5,-0.5,-0.5, 0.5,0.5,-0.5, -0.5,0.5,-0.5,
         -0.5,-0.5, 0.5, 0.5,-0.5, 0.5, 0.5,0.5, 0.5, -0.5,0.5, 0.5];
var quads = [[0,3,2,1],[4,5,6,7],[0,1,5,4],[1,2,6,5],[2,3,7,6],[3,0,4,7]];
var I = [];
quads.forEach(function (q) { I.push(q[0], q[1], q[2], ~q[3]); });

[["fbx-7400-plain.fbx",7400,false,null],
 ["fbx-7400-deflate.fbx",7400,true,null],
 ["fbx-7500-plain.fbx",7500,false,null],
 ["fbx-7500-deflate.fbx",7500,true,null],
 ["fbx-7100-plain.fbx",7100,false,null],
 ["fbx-7400-moved.fbx",7400,true,[10,0,0]]].forEach(function (c) {
  var b = build(c[1], c[2], V, I, c[3]);
  fs.writeFileSync(c[0], b);
  console.log(c[0].padEnd(24) + b.length + " bytes");
});
