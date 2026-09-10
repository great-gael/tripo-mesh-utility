/* 同步 inflate（解压缩）。

   二进制 FBX 需要它：FBX 的数字数组实际上几乎总是以 zlib 压缩
   形式存放 —— 在 Tripo 自己的文件里是五个中的五个。浏览器没有
   任何同步的手段：DecompressionStream 是基于流的，因而是异步
   的；而 parseAny() 是同步的，并且无论从 content.js 还是从测试
   中都是被同步调用的。同样的考量在 Meshopt 解码器那里就已经否
   决了 WASM 变体。

   取自 tiny-inflate（MIT, Devon Govett），它本身又移植自 Joergen
   Ibsen 的 tinf。这份代码已经是 ES5 且不依赖 DOM，因此可以原封
   不动地放进本项目；补充的是四处针对被截断输入的边界检查，好让
   一个损坏的文件被干净地拒绝，而不是发生溢出 —— 参见
   robustness.test.js。

   MIT License, Copyright (c) 2016 Devon Govett. 完整的许可证文本位于
   https://github.com/foliojs/tiny-inflate/blob/master/LICENSE

   tinf_uncompress 期待的是未经封装的原始 deflate 数据。RFC 1950
   规定的外壳，连同它的两个头字节和 Adler-32 校验和，由
   inflateZlib() 剥除；输出大小在 FBX 中事先就是确定的，因为数组
   头部给出了它。 */
(function (root) {
  "use strict";

  var TINF_OK = 0;
  var TINF_DATA_ERROR = -3;

  function Tree() {
    this.table = new Uint16Array(16);   /* 码长计数表 */
    this.trans = new Uint16Array(288);  /* code -> symbol 的转换表 */
  }

  function Data(source, dest) {
    this.source = source;
    this.sourceIndex = 0;
    this.tag = 0;
    this.bitcount = 0;
    
    this.dest = dest;
    this.destLen = 0;
    
    this.ltree = new Tree();  /* 动态的 length/symbol 树 */
    this.dtree = new Tree();  /* 动态的 distance 树 */
  }

  /* ------------------------------------- *
   * -- 未初始化的全局数据（静态结构） -- *
   * ------------------------------------- */

  var sltree = new Tree();
  var sdtree = new Tree();

  /* length code（长度码）的附加位表和基值表 */
  var length_bits = new Uint8Array(30);
  var length_base = new Uint16Array(30);

  /* distance code（距离码）的附加位表和基值表 */
  var dist_bits = new Uint8Array(30);
  var dist_base = new Uint16Array(30);

  /* code length code（码长码）的特殊排列顺序 */
  var clcidx = new Uint8Array([
    16, 17, 18, 0, 8, 7, 9, 6,
    10, 5, 11, 4, 12, 3, 13, 2,
    14, 1, 15
  ]);

  /* 供 tinf_decode_trees 使用，避免每次调用都分配内存 */
  var code_tree = new Tree();
  var lengths = new Uint8Array(288 + 32);

  /* -------------- *
   * -- 辅助函数 -- *
   * -------------- */

  /* 构建附加位表和基值表 */
  function tinf_build_bits_base(bits, base, delta, first) {
    var i, sum;

    /* 构建 bits 表 */
    for (i = 0; i < delta; ++i) bits[i] = 0;
    for (i = 0; i < 30 - delta; ++i) bits[i + delta] = i / delta | 0;

    /* 构建 base 表 */
    for (sum = first, i = 0; i < 30; ++i) {
      base[i] = sum;
      sum += 1 << bits[i];
    }
  }

  /* 构建固定的 huffman 树 */
  function tinf_build_fixed_trees(lt, dt) {
    var i;

    /* 构建固定的 length 树 */
    for (i = 0; i < 7; ++i) lt.table[i] = 0;

    lt.table[7] = 24;
    lt.table[8] = 152;
    lt.table[9] = 112;

    for (i = 0; i < 24; ++i) lt.trans[i] = 256 + i;
    for (i = 0; i < 144; ++i) lt.trans[24 + i] = i;
    for (i = 0; i < 8; ++i) lt.trans[24 + 144 + i] = 280 + i;
    for (i = 0; i < 112; ++i) lt.trans[24 + 144 + 8 + i] = 144 + i;

    /* 构建固定的 distance 树 */
    for (i = 0; i < 5; ++i) dt.table[i] = 0;

    dt.table[5] = 32;

    for (i = 0; i < 32; ++i) dt.trans[i] = i;
  }

  /* 给定一个码长数组，构建一棵树 */
  var offs = new Uint16Array(16);

  function tinf_build_tree(t, lengths, off, num) {
    var i, sum;

    /* 清空码长计数表 */
    for (i = 0; i < 16; ++i) t.table[i] = 0;

    /* 扫描各 symbol 的码长，并累加码长计数 */
    for (i = 0; i < num; ++i) t.table[lengths[off + i]]++;

    t.table[0] = 0;

    /* 为分布排序计算偏移表 */
    for (sum = 0, i = 0; i < 16; ++i) {
      offs[i] = sum;
      sum += t.table[i];
    }

    /* 建立 code->symbol 转换表（symbol 按 code 排序） */
    for (i = 0; i < num; ++i) {
      if (lengths[off + i]) t.trans[offs[lengths[off + i]]++] = i;
    }
  }

  /* -------------- *
   * -- 解码函数 -- *
   * -------------- */

  /* 从源数据流中取出一个位 */
  function tinf_getbit(d) {
    /* 检查 tag 是否已空 */
    if (!d.bitcount--) {
      /* 载入下一个 tag */
      if (d.sourceIndex >= d.source.length) throw new Error("Data error");
      d.tag = d.source[d.sourceIndex++];
      d.bitcount = 7;
    }

    /* 把该位从 tag 中移出 */
    var bit = d.tag & 1;
    d.tag >>>= 1;

    return bit;
  }

  /* 从数据流中读取一个 num 位的值并加上 base */
  function tinf_read_bits(d, num, base) {
    if (!num)
      return base;

    while (d.bitcount < 24) {
      if (d.sourceIndex >= d.source.length) throw new Error("Data error");
      d.tag |= d.source[d.sourceIndex++] << d.bitcount;
      d.bitcount += 8;
    }

    var val = d.tag & (0xffff >>> (16 - num));
    d.tag >>>= num;
    d.bitcount -= num;
    return val + base;
  }

  /* 给定一个数据流和一棵树，解码出一个 symbol */
  function tinf_decode_symbol(d, t) {
    while (d.bitcount < 24) {
      if (d.sourceIndex >= d.source.length) throw new Error("Data error");
      d.tag |= d.source[d.sourceIndex++] << d.bitcount;
      d.bitcount += 8;
    }
    
    var sum = 0, cur = 0, len = 0;
    var tag = d.tag;

    /* 只要 code 的值高于 sum 就继续取位 */
    do {
      cur = 2 * cur + (tag & 1);
      tag >>>= 1;
      ++len;

      sum += t.table[len];
      cur -= t.table[len];
    } while (cur >= 0);
    
    d.tag = tag;
    d.bitcount -= len;

    return t.trans[sum + cur];
  }

  /* 给定一个数据流，从中解码出动态树 */
  function tinf_decode_trees(d, lt, dt) {
    var hlit, hdist, hclen;
    var i, num, length;

    /* 读取 5 位的 HLIT (257-286) */
    hlit = tinf_read_bits(d, 5, 257);

    /* 读取 5 位的 HDIST (1-32) */
    hdist = tinf_read_bits(d, 5, 1);

    /* 读取 4 位的 HCLEN (4-19) */
    hclen = tinf_read_bits(d, 4, 4);

    for (i = 0; i < 19; ++i) lengths[i] = 0;

    /* 读取码长字母表的各个码长 */
    for (i = 0; i < hclen; ++i) {
      /* 读取 3 位的码长 (0-7) */
      var clen = tinf_read_bits(d, 3, 0);
      lengths[clcidx[i]] = clen;
    }

    /* 构建码长树 */
    tinf_build_tree(code_tree, lengths, 0, 19);

    /* 解码出动态树的各个码长 */
    for (num = 0; num < hlit + hdist;) {
      var sym = tinf_decode_symbol(d, code_tree);

      switch (sym) {
        case 16:
          /* 把前一个码长复制 3-6 次（读 2 位） */
          var prev = lengths[num - 1];
          for (length = tinf_read_bits(d, 2, 3); length; --length) {
            lengths[num++] = prev;
          }
          break;
        case 17:
          /* 把码长 0 重复 3-10 次（读 3 位） */
          for (length = tinf_read_bits(d, 3, 3); length; --length) {
            lengths[num++] = 0;
          }
          break;
        case 18:
          /* 把码长 0 重复 11-138 次（读 7 位） */
          for (length = tinf_read_bits(d, 7, 11); length; --length) {
            lengths[num++] = 0;
          }
          break;
        default:
          /* 值 0-15 就是实际的码长 */
          lengths[num++] = sym;
          break;
      }
    }

    /* 构建动态树 */
    tinf_build_tree(lt, lengths, 0, hlit);
    tinf_build_tree(dt, lengths, hlit, hdist);
  }

  /* ---------------- *
   * -- 块解压函数 -- *
   * ---------------- */

  /* 给定一个数据流和两棵树，解压出一个数据块 */
  function tinf_inflate_block_data(d, lt, dt) {
    while (1) {
      if (d.destLen > d.dest.length) return TINF_DATA_ERROR;
      var sym = tinf_decode_symbol(d, lt);

      /* 检查是否到了块的末尾 */
      if (sym === 256) {
        return TINF_OK;
      }

      if (sym < 256) {
        d.dest[d.destLen++] = sym;
      } else {
        var length, dist, offs;
        var i;

        sym -= 257;

        /* 可能还要从 length code 里再取几位 */
        length = tinf_read_bits(d, length_bits[sym], length_base[sym]);

        dist = tinf_decode_symbol(d, dt);

        /* 可能还要从 distance code 里再取几位 */
        offs = d.destLen - tinf_read_bits(d, dist_bits[dist], dist_base[dist]);

        /* 复制匹配串 */
        for (i = offs; i < offs + length; ++i) {
          d.dest[d.destLen++] = d.dest[i];
        }
      }
    }
  }

  /* 处理一个未压缩的数据块 */
  function tinf_inflate_uncompressed_block(d) {
    var length, invlength;
    var i;
    
    /* 把位缓冲里多读的部分退回去 */
    while (d.bitcount > 8) {
      d.sourceIndex--;
      d.bitcount -= 8;
    }

    /* 读取长度 */
    length = d.source[d.sourceIndex + 1];
    length = 256 * length + d.source[d.sourceIndex];

    /* 读取长度的反码 */
    invlength = d.source[d.sourceIndex + 3];
    invlength = 256 * invlength + d.source[d.sourceIndex + 2];

    /* 校验长度 */
    if (length !== (~invlength & 0x0000ffff))
      return TINF_DATA_ERROR;

    d.sourceIndex += 4;

    /* 复制整块 */
    for (i = length; i; --i)
      d.dest[d.destLen++] = d.source[d.sourceIndex++];

    /* 确保下一个块从字节边界开始 */
    d.bitcount = 0;

    return TINF_OK;
  }

  /* 把数据流从 source 解压到 dest */
  function tinf_uncompress(source, dest) {
    var d = new Data(source, dest);
    var bfinal, btype, res;

    do {
      /* 读取“最后一个块”标志位 */
      bfinal = tinf_getbit(d);

      /* 读取块类型（2 位） */
      btype = tinf_read_bits(d, 2, 0);

      /* 解压该块 */
      switch (btype) {
        case 0:
          /* 解压未压缩的块 */
          res = tinf_inflate_uncompressed_block(d);
          break;
        case 1:
          /* 用固定 huffman 树解压该块 */
          res = tinf_inflate_block_data(d, sltree, sdtree);
          break;
        case 2:
          /* 用动态 huffman 树解压该块 */
          tinf_decode_trees(d, d.ltree, d.dtree);
          res = tinf_inflate_block_data(d, d.ltree, d.dtree);
          break;
        default:
          res = TINF_DATA_ERROR;
      }

      if (res !== TINF_OK)
        throw new Error('Data error');

    } while (!bfinal);

    if (d.destLen < d.dest.length) {
      if (typeof d.dest.slice === 'function')
        return d.dest.slice(0, d.destLen);
      else
        return d.dest.subarray(0, d.destLen);
    }
    
    return d.dest;
  }

  /* ------------ *
   * -- 初始化 -- *
   * ------------ */

  /* 构建固定 huffman 树 */
  tinf_build_fixed_trees(sltree, sdtree);

  /* 构建附加位表和基值表 */
  tinf_build_bits_base(length_bits, length_base, 4, 3);
  tinf_build_bits_base(dist_bits, dist_base, 2, 1);

  /* 修正一个特殊情况 */
  length_bits[28] = 0;
  length_base[28] = 258;

  /* ---- zlib 外壳 -------------------------------------------------------
     RFC 1950：两个头字节，接着是原始 deflate 数据，最后是
     Adler-32。头字节会被检查，好让 FBX 里一个错误的 encoding 值
     导致一次可用的拒绝，而不是对一堆无意义的数据发起解码尝试。
     输出长度必须由调用方知道 —— 在 FBX 中它写在数组头部里，而
     没有它的话，一个损坏的长度声明就等于是在邀请程序去申请一个
     GB 的内存。 */
  var MAX_AUSGABE = 64 * 1024 * 1024;

  function inflateZlib(bytes, erwartet) {
    if (!bytes || bytes.length < 6) {
      throw new Error("This file has a compressed block that is too short to be valid - the download is probably damaged.");
    }
    if (!(erwartet > 0) || erwartet > MAX_AUSGABE) {
      throw new Error("This file declares an implausible uncompressed size. It is probably damaged.");
    }
    var cmf = bytes[0], flg = bytes[1];
    if ((cmf & 0x0f) !== 8 || (((cmf << 8) | flg) % 31) !== 0) {
      throw new Error("This file has a compressed block that is not zlib data - it may be damaged or use a compression this cannot read.");
    }
    var out;
    try {
      out = tinf_uncompress(bytes.subarray(2), new Uint8Array(erwartet));
    } catch (e) {
      throw new Error("A compressed block in this file could not be unpacked - the download is probably incomplete.");
    }
    if (!out || out.length !== erwartet) {
      throw new Error("A compressed block in this file unpacked to the wrong size - the download is probably incomplete.");
    }
    return out;
  }

  root.inflateZlib = inflateZlib;
  root.inflateRaw = tinf_uncompress;
})(typeof self !== "undefined" ? (self.T3D = self.T3D || {}) : (module.exports = {}));
