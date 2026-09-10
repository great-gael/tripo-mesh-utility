/* 运行在页面自己的上下文里，早于 Tripo 的 bundle。

   两个钩子都挂在 WebGL 这一层，而不是引擎那一层，因此无论 Tripo 用的是
   three.js、Babylon 还是别的什么，它们都能工作：

   1. 可以强制打开背面剔除，这正是你真正想要的那种单面着色。他们的
      材质写的是双面；我们在绘制时覆盖 GL 状态，于是材质里写的是什
      么都无所谓。

   2. 片段着色器会被补上一个 gl_FrontFacing 分支，于是任何背朝观察者的
      表面都会在他们自己的视图风格里变成品红色。如果补写过的着色器编译
      失败，我们会悄悄恢复原来的那一份并重新编译，因此最坏的情况也不过
      是什么都没有改变。

   在面板提出要求之前，两者都是关闭的。如今面板不再提出要求：接进 Tripo
   视图风格栏里的那个开关已经移除。这里的机制保留下来，是为了以后可能
   还会用到。 */
(function () {
  "use strict";
  if (window.__tmtGL) return;

  /* 于 09.09.2026 移除：对他人片段着色器的改写，以及强制的背面
     剔除。两者都只为 Tripo 工具条里的那个色块服务，而它已经没有
     了 —— 在没有任何人能从中得到好处的情况下，去干预一个外部的
     WebGL 上下文，会比改动 DOM 更糟糕。留下来的是读取：把场景找
     出来，并把它的几何数据递出来，好让我们自己的 viewer 能显示
     它。 */
  window.__tmtGL = { };

  /* ---- 直接从引擎里把 mesh 读出来 ----------------------------------------
     如果网络钩子错过了那次下载，几何数据仍然还留在场景图里。遍历它
     并不需要 import three.js：这里用到的标志位和字段（isMesh、
     geometry.attributes.position、matrixWorld）都属于它对外公开的
     形态。 */
  /* Tripo 的场景里含有一层布景：一个没有名字、向内渲染的球
     体，8064 个三角形，side 为 BackSide，depthWrite 为 false。
     要是把它一起合并进来，报告描述的就是模型加布景 —— 而由于
     这个球体在每个页面上都是同一个，完全不同的模型算出来的
     bounding box 竟然一模一样。凡是不往深度缓冲里写的，就是
     装饰，而不是需要拿来检查孔洞的几何体。判断要遍历所有的材
     质，这样一个只带某个单独透明部件的模型，才不会被错误地当
     成布景。 */
  function isBackdrop(o) {
    var m = o.material;
    if (!m) return false;
    var list = (typeof m.length === "number" && m.push) ? m : [m];
    for (var i = 0; i < list.length; i++) {
      if (!list[i] || list[i].depthWrite !== false) return false;
    }
    return list.length > 0;
  }

  function captureScene() {
    var scene = window.__tmtGL.scene;
    if (!scene || typeof scene.traverse !== "function") return null;

    var positions = [], indices = [], base = 0, meshes = 0, skipped = 0;

    scene.traverse(function (o) {
      if (!o || !o.isMesh || o.visible === false) return;
      if (isBackdrop(o)) { skipped++; return; }
      var g = o.geometry;
      if (!g || !g.attributes || !g.attributes.position) return;
      var pos = g.attributes.position;

      /* 交错存放的属性把自己的数据放在下一层，藏在一个 stride 和一个
         offset 后面。 */
      var arr, stride, offset;
      if (pos.isInterleavedBufferAttribute && pos.data && pos.data.array) {
        arr = pos.data.array;
        stride = pos.data.stride;
        offset = pos.offset || 0;
      } else if (pos.array) {
        arr = pos.array;
        stride = pos.itemSize || 3;
        offset = 0;
      } else return;

      var n = pos.count != null ? pos.count : Math.floor(arr.length / stride);
      if (!n) return;

      var m = o.matrixWorld && o.matrixWorld.elements;
      for (var i = 0; i < n; i++) {
        var b = offset + i * stride;
        var x = arr[b], y = arr[b + 1], z = arr[b + 2];
        if (m) {
          positions.push(
            m[0]*x + m[4]*y + m[8]*z  + m[12],
            m[1]*x + m[5]*y + m[9]*z  + m[13],
            m[2]*x + m[6]*y + m[10]*z + m[14]
          );
        } else positions.push(x, y, z);
      }

      if (g.index && g.index.array) {
        var ia = g.index.array;
        for (var k = 0; k < ia.length; k++) indices.push(ia[k] + base);
      } else {
        for (var v = 0; v < n; v++) indices.push(v + base);
      }
      base += n;
      meshes++;
    });

    if (indices.length < 3) return null;
    return {
      positions: new Float32Array(positions),
      indices: new Uint32Array(indices),
      meshes: meshes,
      skipped: skipped
    };
  }

  window.__tmtGL.captureScene = captureScene;

  function announce() {
    window.postMessage({
      source: "tripo-mesh-tools", kind: "engine",
      three: !!(window.__tmtGL.scene || window.__tmtGL.renderer)
    }, window.location.origin);
  }

  /* 如果这个钩子在 bundle 加载时已经存在，three.js 就会把自己的 renderer
     和 scene 通报给它。碰上了就白得一份引擎访问权；碰不上就忽略。 */
  if (!window.__THREE_DEVTOOLS__) {
    try {
      var hook = new EventTarget();
      hook.addEventListener("observe", function (e) {
        var d = e.detail;
        if (!d) return;
        if (d.isScene) { window.__tmtGL.scene = d; announce(); }
        if (d.isWebGLRenderer) { window.__tmtGL.renderer = d; announce(); }
      });
      window.__THREE_DEVTOOLS__ = hook;
    } catch (e) { /* 较老的、EventTarget 不可构造的浏览器 */ }
  }

  /* 经由 __THREE_DEVTOOLS__ 的这条弯路，只有在 three.js 主动把场景注册
     到那里时才会通报出来 —— 这件事有时发生、有时不发生，于是面板里的兜
     底路径就落空了。因此还要额外主动去看：持续一分钟，每两秒一次，此后
     再也不看。这不花什么代价，并且让这条通报不再取决于是不是已经有别人
     挂上了那个钩子。 */
  (function () {
    var versuche = 0;
    var timer = setInterval(function () {
      versuche++;
      if (window.__tmtGL.scene || window.__tmtGL.renderer) { announce(); clearInterval(timer); return; }
      if (versuche >= 30) clearInterval(timer);
    }, 2000);
  })();

  window.addEventListener("message", function (e) {
    if (e.source !== window) return;
    var d = e.data;
    if (!d || d.source !== "tripo-mesh-tools") return;
    if (d.kind === "gl") window.__tmtGL.set(d.patch || {});
    if (d.kind === "grab") {
      var got = null;
      try { got = captureScene(); } catch (err) { got = null; }
      if (!got) {
        window.postMessage({ source: "tripo-mesh-tools", kind: "grabbed", ok: false }, window.location.origin);
        return;
      }
      var pb = got.positions.buffer, ib = got.indices.buffer;
      window.postMessage({
        source: "tripo-mesh-tools", kind: "grabbed", ok: true,
        positions: pb, indices: ib, meshes: got.meshes, skipped: got.skipped
      }, window.location.origin, [pb, ib]);
    }
  });
})();
