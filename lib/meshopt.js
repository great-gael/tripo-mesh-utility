/* 用于 EXT_meshopt_compression 与 KHR_meshopt_compression 的 Meshopt 解码。

   取自 zeux/meshoptimizer 的 js/meshopt_decoder_reference.js（MIT，
   见下方许可证头），并为本项目移植到 ES5：const/let 改为 var，
   箭头函数改为 function，ESM 导出改为 module.exports 加上
   self.T3D。解码逻辑本身未作任何改动。

   一处有意的偏离：三处头部检查抛出的是一条带解释的消息，而不是
   光秃秃的 "Assertion failed"。参考解码器不认识旧的索引编解码器
   v0（0xe0/0xd0）；提交这样一个文件的人应该能读懂原因，而不是
   面对一句断言。无论测试文件还是 Tripo 的文件，都没有出现过 v0。

   已针对 21 个官方测试向量验证过：19 个能解码，带 v0 的那两个
   可以证明被干净地拒绝。参见 test/meshopt.test.js。 */
// This file is part of meshoptimizer library and is distributed under the terms of MIT License.
// Copyright (C) 2016-2026, by Arseny Kapoulkine (arseny.kapoulkine@gmail.com)

// 这是由 Jasper St. Pierre 编写的参考解码器实现。
// 它遵循解码器接口，应当可以直接替换 meshopt_decoder 模块中的实际解码器
// 它是出于教学价值提供的，因为未针对性能优化，不建议在生产环境中使用。

var MeshoptDecoder = {};
MeshoptDecoder.supported = true;
MeshoptDecoder.ready = Promise.resolve();

function assert(cond) {
	if (!cond) {
		throw new Error('Assertion failed');
	}
}

function dezig(v) {
	// 等价于 (v & 1) !== 0 ? ~(v >>> 1) : v >>> 1
	return (v >>> 1) ^ -(v & 1);
}

MeshoptDecoder.decodeVertexBuffer = function (target, elementCount, byteStride, source, filter) {
	if (source[0] !== 0xa0 && source[0] !== 0xa1) {
		throw new Error("This mesh uses an unknown meshopt vertex format (0x" +
			source[0].toString(16) + "). Re-export it with a current gltfpack.");
	}
	var version = source[0] & 0x0f;

	var maxBlockElements = Math.min((0x2000 / byteStride) & ~0x000f, 0x100);

	var deltas = new Uint8Array(maxBlockElements * byteStride);

	var tailSize = version === 0 ? byteStride : byteStride + byteStride / 4;
	var tailDataOffs = source.length - tailSize;

	// deltas 是相对于它来存储的
	var tempData = source.slice(tailDataOffs, tailDataOffs + byteStride);

	// v1 的通道模式（channel modes）
	var channels = version === 0 ? null : source.slice(tailDataOffs + byteStride, tailDataOffs + tailSize);

	var srcOffs = 1; // 跳过头字节

	var headerModes = [
		[0, 2, 4, 8], // v0
		[0, 1, 2, 4], // v1，当 control 为 0 时
		[1, 2, 4, 8], // v1，当 control 为 1 时
	];

	// 属性块
	for (var dstElemBase = 0; dstElemBase < elementCount; dstElemBase += maxBlockElements) {
		var attrBlockElementCount = Math.min(elementCount - dstElemBase, maxBlockElements);
		var groupCount = ((attrBlockElementCount + 0x0f) & ~0x0f) >>> 4;
		var headerByteCount = ((groupCount + 0x03) & ~0x03) >>> 2;

		// v1 的控制模式（control modes）
		var controlBitsOffs = srcOffs;
		srcOffs += version === 0 ? 0 : byteStride / 4;

		// 将 deltas 清零以简化逻辑
		deltas.fill(0x00);

		// 数据块
		for (var byte = 0; byte < byteStride; byte++) {
			var deltaBase = byte * attrBlockElementCount;

			// v1 中当前字节的控制模式
			var controlMode = version === 0 ? 0 : (source[controlBitsOffs + (byte >>> 2)] >>> ((byte & 0x03) << 1)) & 0x03;

			if (controlMode === 2) {
				// 所有字节增量都为 0；该字节不存储任何数据
				continue;
			} else if (controlMode === 3) {
				// 字节增量以未压缩形式存储，没有头部位
				deltas.set(source.subarray(srcOffs, srcOffs + attrBlockElementCount), deltaBase);
				srcOffs += attrBlockElementCount;
				continue;
			}

			// v1 在使用控制模式 2/3 时会省略头部位
			var headerBitsOffs = srcOffs;
			srcOffs += headerByteCount;

			for (var group = 0; group < groupCount; group++) {
				var mode = (source[headerBitsOffs + (group >>> 2)] >>> ((group & 0x03) << 1)) & 0x03;
				var modeBits = headerModes[version === 0 ? 0 : controlMode + 1][mode];

				var deltaOffs = deltaBase + (group << 4);

				if (modeBits === 0) {
					// 全部 16 个字节增量都为 0；编码块的大小为 0 字节
				} else if (modeBits === 1) {
					// 增量使用 1 位哨兵编码；编码块的大小为 [2..18] 字节
					var srcBase = srcOffs;
					srcOffs += 0x02;
					for (var m = 0; m < 0x10; m++) {
						// 1 位编码时，各位从最低有效位向最高有效位存储
						var shift = m & 0x07;
						var delta = (source[srcBase + (m >>> 3)] >>> shift) & 0x01;
						if (delta === 1) delta = source[srcOffs++];
						deltas[deltaOffs + m] = delta;
					}
				} else if (modeBits === 2) {
					// 增量使用 2 位哨兵编码；编码块的大小为 [4..20] 字节
					var srcBase = srcOffs;
					srcOffs += 0x04;
					for (var m = 0; m < 0x10; m++) {
						// 0 = >>> 6, 1 = >>> 4, 2 = >>> 2, 3 = >>> 0
						var shift = 6 - ((m & 0x03) << 1);
						var delta = (source[srcBase + (m >>> 2)] >>> shift) & 0x03;
						if (delta === 3) delta = source[srcOffs++];
						deltas[deltaOffs + m] = delta;
					}
				} else if (modeBits === 4) {
					// 增量使用 4 位哨兵编码；编码块的大小为 [8..24] 字节
					var srcBase = srcOffs;
					srcOffs += 0x08;
					for (var m = 0; m < 0x10; m++) {
						// 0 = >>> 6, 1 = >>> 4, 2 = >>> 2, 3 = >>> 0
						var shift = 4 - ((m & 0x01) << 2);
						var delta = (source[srcBase + (m >>> 1)] >>> shift) & 0x0f;
						if (delta === 0xf) delta = source[srcOffs++];
						deltas[deltaOffs + m] = delta;
					}
				} else {
					// 全部 16 个字节增量按原样存储；编码块的大小为 16 字节
					deltas.set(source.subarray(srcOffs, srcOffs + 0x10), deltaOffs);
					srcOffs += 0x10;
				}
			}
		}

		// 遍历一遍，把增量应用到数据上
		for (var elem = 0; elem < attrBlockElementCount; elem++) {
			var dstElem = dstElemBase + elem;

			for (var byteGroup = 0; byteGroup < byteStride; byteGroup += 4) {
				var channelMode = version === 0 ? 0 : channels[byteGroup >>> 2] & 0x03;
				assert(channelMode !== 0x03);

				if (channelMode === 0) {
					// 通道 0（字节增量）：字节增量以 zigzag 编码的差值形式存储，即该元素的字节值与同一位置上前一个元素的字节值之差。
					for (var byte = byteGroup; byte < byteGroup + 4; byte++) {
						var delta = dezig(deltas[byte * attrBlockElementCount + elem]);
						var temp = (tempData[byte] + delta) & 0xff; // 回绕

						var dstOffs = dstElem * byteStride + byte;
						target[dstOffs] = tempData[byte] = temp;
					}
				} else if (channelMode === 1) {
					// 通道 1（2 字节增量）：2 字节增量按 zigzag 编码的差值计算，即该元素的 16 位值与同一位置上前一个元素的 16 位值之差。
					for (var byte = byteGroup; byte < byteGroup + 4; byte += 2) {
						var delta = dezig(deltas[byte * attrBlockElementCount + elem] + (deltas[(byte + 1) * attrBlockElementCount + elem] << 8));
						var temp = tempData[byte] + (tempData[byte + 1] << 8);

						temp = (temp + delta) & 0xffff; // 回绕

						var dstOffs = dstElem * byteStride + byte;
						target[dstOffs] = tempData[byte] = temp & 0xff;
						target[dstOffs + 1] = tempData[byte + 1] = temp >>> 8;
					}
				} else if (channelMode === 2) {
					// 通道 2（4 字节 XOR 增量）：4 字节增量按该元素的 32 位值与同一位置上前一个元素的 32 位值之间的 XOR 计算，并根据通道模式字节的高 4 位额外施加一次循环移位。
					var byte = byteGroup;
					var delta =
						deltas[byte * attrBlockElementCount + elem] +
						(deltas[(byte + 1) * attrBlockElementCount + elem] << 8) +
						(deltas[(byte + 2) * attrBlockElementCount + elem] << 16) +
						(deltas[(byte + 3) * attrBlockElementCount + elem] << 24);
					var temp = tempData[byte] + (tempData[byte + 1] << 8) + (tempData[byte + 2] << 16) + (tempData[byte + 3] << 24);

					var rot = channels[byteGroup >>> 2] >>> 4;
					temp = temp ^ ((delta >>> rot) | (delta << (32 - rot))); // 循环移位并 XOR

					var dstOffs = dstElem * byteStride + byte;
					target[dstOffs] = tempData[byte] = temp & 0xff;
					target[dstOffs + 1] = tempData[byte + 1] = (temp >>> 8) & 0xff;
					target[dstOffs + 2] = tempData[byte + 2] = (temp >>> 16) & 0xff;
					target[dstOffs + 3] = tempData[byte + 3] = temp >>> 24;
				}
			}
		}
	}

	var tailSizePadded = Math.max(tailSize, version === 0 ? 32 : 24);
	assert(srcOffs == source.length - tailSizePadded);

	// 过滤器 —— 仅当 filter 既不是 undefined 也不是 NONE 时才应用
	if (filter === 'OCTAHEDRAL') {
		assert(byteStride === 4 || byteStride === 8);

		var dst = new (byteStride === 4 ? Int8Array : Int16Array)(target.buffer, target.byteOffset, elementCount * 4);
		var maxInt = byteStride === 4 ? 127 : 32767;

		for (var i = 0; i < elementCount * 4; i += 4) {
			var x = dst[i + 0],
				y = dst[i + 1],
				one = dst[i + 2];
			x /= one;
			y /= one;
			var z = 1.0 - Math.abs(x) - Math.abs(y);
			var t = Math.max(-z, 0.0);
			x -= x >= 0 ? t : -t;
			y -= y >= 0 ? t : -t;
			var h = maxInt / Math.sqrt(x * x + y * y + z * z);
			dst[i + 0] = Math.round(x * h);
			dst[i + 1] = Math.round(y * h);
			dst[i + 2] = Math.round(z * h);
			// 保持 dst[i + 3] 原样不变
		}
	} else if (filter === 'QUATERNION') {
		assert(byteStride === 8);

		var dst = new Int16Array(target.buffer, target.byteOffset, elementCount * 4);

		for (var i = 0; i < elementCount * 4; i += 4) {
			var inputW = dst[i + 3];
			var maxComponent = inputW & 0x03;
			var s = Math.SQRT1_2 / (inputW | 0x03);
			var x = dst[i + 0] * s;
			var y = dst[i + 1] * s;
			var z = dst[i + 2] * s;
			var w = Math.sqrt(Math.max(0.0, 1.0 - x * x - y * y - z * z));
			dst[i + ((maxComponent + 1) % 4)] = Math.round(x * 32767);
			dst[i + ((maxComponent + 2) % 4)] = Math.round(y * 32767);
			dst[i + ((maxComponent + 3) % 4)] = Math.round(z * 32767);
			dst[i + ((maxComponent + 0) % 4)] = Math.round(w * 32767);
		}
	} else if (filter === 'EXPONENTIAL') {
		assert((byteStride & 0x03) === 0x00);

		var expBits = new Uint32Array(1);
		var expFloat = new Float32Array(expBits.buffer);

		var src = new Int32Array(target.buffer, target.byteOffset, elementCount * (byteStride / 4));
		var dst = new Float32Array(target.buffer, target.byteOffset, elementCount * (byteStride / 4));
		for (var i = 0; i < elementCount * (byteStride / 4); i++) {
			var v = src[i];
			var exp = v >> 24,
				mantissa = (v << 8) >> 8;
			expBits[0] = (exp + 127) << 23; // 等价于 2**exp
			dst[i] = expFloat[0] * mantissa;
		}
	} else if (filter === 'COLOR') {
		assert(byteStride === 4 || byteStride === 8);

		var maxInt = (1 << (byteStride * 2)) - 1;

		var data = new (byteStride === 4 ? Uint8Array : Uint16Array)(target.buffer, target.byteOffset, elementCount * 4);
		var dataSigned = new (byteStride === 4 ? Int8Array : Int16Array)(target.buffer, target.byteOffset, elementCount * 4);

		for (var i = 0; i < elementCount * 4; i += 4) {
			var y = data[i + 0];
			var co = dataSigned[i + 1];
			var cg = dataSigned[i + 2];
			var alphaInput = data[i + 3];

			// 从 alpha 的高位恢复缩放系数 —— 找到置位的最高位
			var alphaBit = 31 - Math.clz32(alphaInput);
			var as = (1 << (alphaBit + 1)) - 1;

			// YCoCg 到 RGB 的转换
			var r = y + co - cg;
			var g = y + cg;
			var b = y - co - cg;

			// 将 alpha 扩展一位，复制最后一位
			var a = alphaInput & (as >> 1);
			a = (a << 1) | (a & 1);

			// 缩放到完整取值范围
			var ss = maxInt / as;

			// 存储结果
			data[i + 0] = Math.round(r * ss);
			data[i + 1] = Math.round(g * ss);
			data[i + 2] = Math.round(b * ss);
			data[i + 3] = Math.round(a * ss);
		}
	}
};

function readfifo(fifo, n) {
	return fifo[(fifo.offset - 1 - n) & (fifo.length - 1)];
}

function pushfifo(fifo, n) {
	var offset = fifo.offset;
	fifo[offset] = n;
	fifo.offset = (offset + 1) & (fifo.length - 1);
}

MeshoptDecoder.decodeIndexBuffer = function (target, count, byteStride, source) {
	if (source[0] !== 0xe1) {
		throw new Error("This mesh uses the old meshopt index format (v0). " +
			"Re-export it with a current gltfpack.");
	}
	assert(count % 3 === 0);
	assert(byteStride === 2 || byteStride === 4);

	var dst;
	if (byteStride === 2) dst = new Uint16Array(target.buffer);
	else dst = new Uint32Array(target.buffer);

	var triCount = count / 3;

	var codeOffs = 0x01;
	var dataOffs = codeOffs + triCount;
	var codeauxOffs = source.length - 0x10;

	function readLEB128() {
		var n = 0;
		for (var i = 0; ; i += 7) {
			var b = source[dataOffs++];
			n |= (b & 0x7f) << i;

			if (b < 0x80) return n;
		}
	}

	var next = 0,
		last = 0;
	var edgefifo = new Uint32Array(32);
	var vertexfifo = new Uint32Array(16);
	edgefifo.offset = 0;
	vertexfifo.offset = 0;

	function decodeIndex(v) {
		return (last += dezig(v));
	}

	var dstOffs = 0;
	for (var i = 0; i < triCount; i++) {
		var code = source[codeOffs++];
		var b0 = code >>> 4,
			b1 = code & 0x0f;

		if (b0 < 0x0f) {
			var a = readfifo(edgefifo, (b0 << 1) + 0),
				b = readfifo(edgefifo, (b0 << 1) + 1);
			var c = -1;

			if (b1 === 0x00) {
				c = next++;
				pushfifo(vertexfifo, c);
			} else if (b1 < 0x0d) {
				c = readfifo(vertexfifo, b1);
			} else if (b1 === 0x0d) {
				c = --last;
				pushfifo(vertexfifo, c);
			} else if (b1 === 0x0e) {
				c = ++last;
				pushfifo(vertexfifo, c);
			} else if (b1 === 0x0f) {
				var v = readLEB128();
				c = decodeIndex(v);
				pushfifo(vertexfifo, c);
			}

			// fifo 的入栈顺序是反向的
			pushfifo(edgefifo, b);
			pushfifo(edgefifo, c);
			pushfifo(edgefifo, c);
			pushfifo(edgefifo, a);

			dst[dstOffs++] = a;
			dst[dstOffs++] = b;
			dst[dstOffs++] = c;
		} else {
			// b0 === 0x0F
			var a = -1,
				b = -1,
				c = -1;

			if (b1 < 0x0e) {
				var e = source[codeauxOffs + b1];
				var z = e >>> 4,
					w = e & 0x0f;

				a = next++;

				if (z === 0x00) b = next++;
				else b = readfifo(vertexfifo, z - 1);

				if (w === 0x00) c = next++;
				else c = readfifo(vertexfifo, w - 1);

				pushfifo(vertexfifo, a);
				if (z === 0x00) pushfifo(vertexfifo, b);
				if (w === 0x00) pushfifo(vertexfifo, c);
			} else {
				var e = source[dataOffs++];
				if (e === 0x00) next = 0;

				var z = e >>> 4,
					w = e & 0x0f;

				if (b1 === 0x0e) a = next++;
				else a = decodeIndex(readLEB128());

				if (z === 0x00) b = next++;
				else if (z === 0x0f) b = decodeIndex(readLEB128());
				else b = readfifo(vertexfifo, z - 1);

				if (w === 0x00) c = next++;
				else if (w === 0x0f) c = decodeIndex(readLEB128());
				else c = readfifo(vertexfifo, w - 1);

				pushfifo(vertexfifo, a);
				if (z === 0x00 || z === 0x0f) pushfifo(vertexfifo, b);
				if (w === 0x00 || w === 0x0f) pushfifo(vertexfifo, c);
			}

			pushfifo(edgefifo, a);
			pushfifo(edgefifo, b);
			pushfifo(edgefifo, b);
			pushfifo(edgefifo, c);
			pushfifo(edgefifo, c);
			pushfifo(edgefifo, a);

			dst[dstOffs++] = a;
			dst[dstOffs++] = b;
			dst[dstOffs++] = c;
		}
	}
};

MeshoptDecoder.decodeIndexSequence = function (target, count, byteStride, source) {
	if (source[0] !== 0xd1) {
		throw new Error("This mesh uses the old meshopt index-sequence format (v0). " +
			"Re-export it with a current gltfpack.");
	}
	assert(byteStride === 2 || byteStride === 4);

	var dst;
	if (byteStride === 2) dst = new Uint16Array(target.buffer);
	else dst = new Uint32Array(target.buffer);

	var dataOffs = 0x01;

	function readLEB128() {
		var n = 0;
		for (var i = 0; ; i += 7) {
			var b = source[dataOffs++];
			n |= (b & 0x7f) << i;

			if (b < 0x80) return n;
		}
	}

	var last = new Uint32Array(2);

	for (var i = 0; i < count; i++) {
		var v = readLEB128();
		var b = v & 0x01;
		var delta = dezig(v >>> 1);
		dst[i] = last[b] += delta;
	}
};

MeshoptDecoder.decodeGltfBuffer = function (target, count, size, source, mode, filter) {
	var table = {
		ATTRIBUTES: MeshoptDecoder.decodeVertexBuffer,
		TRIANGLES: MeshoptDecoder.decodeIndexBuffer,
		INDICES: MeshoptDecoder.decodeIndexSequence,
	};
	assert(table[mode] !== undefined);
	table[mode](target, count, size, source, filter);
};

MeshoptDecoder.decodeGltfBufferAsync = function (count, size, source, mode, filter) {
	var target = new Uint8Array(count * size);
	MeshoptDecoder.decodeGltfBuffer(target, count, size, source, mode, filter);
	return Promise.resolve(target);
};

// node.js 接口：
// for (var k in MeshoptDecoder) exports[k] = MeshoptDecoder[k];

if (typeof module !== "undefined" && module.exports) { module.exports = MeshoptDecoder; }
if (typeof self !== "undefined") { self.T3D = self.T3D || {}; self.T3D.MeshoptDecoder = MeshoptDecoder; }
