/* 单面视口。

   正面在开启背面剔除的情况下渲染为灰色。背面在第二遍中渲染为品红色，
   于是任何本不该被看见的东西都会自己暴露出来：轮廓线上的一个翻转
   三角形，或者透过缺口显露出来的内部。开放边缘在关闭深度测试的情况下
   用琥珀色描出，这样远侧的洞不用转过去看也能被察觉。

   法线来自屏幕空间导数，而不是存储的 NORMAL 属性，因为存储的法线恰恰
   就是那个可能在撒谎的东西。 */
(function (root) {
  "use strict";

  /* 每秒弧度。0.9 相当于大约七秒转一圈——快到足以让人看清一个形状，
     又不至于让人在看的时候头晕。 */
  var DREHUNG = 0.9;

  var VS2 = "#version 300 es\n" +
    "in vec3 aPos; uniform mat4 uMVP; out vec3 vP;\n" +
    "void main(){ vP=aPos; gl_Position=uMVP*vec4(aPos,1.0); }";
  var FS2 = "#version 300 es\n" +
    "precision highp float;\n" +
    "in vec3 vP; uniform vec3 uEye; uniform vec3 uColor; uniform int uFlat; out vec4 o;\n" +
    "void main(){\n" +
    "  vec3 n=normalize(cross(dFdx(vP),dFdy(vP)));\n" +
    "  vec3 v=normalize(uEye-vP);\n" +
    "  if(dot(n,v)<0.0) n=-n;\n" +
    "  if(uFlat==1){ float r=0.55+0.45*pow(1.0-abs(dot(n,v)),1.4); o=vec4(uColor*r,1.0); }\n" +
    "  else{ vec3 k=normalize(vec3(0.5,0.8,0.7)); vec3 f=normalize(vec3(-0.6,0.1,0.4));\n" +
    "    float d=0.62*max(dot(n,k),0.0)+0.26*max(dot(n,f),0.0)+0.20;\n" +
    "    float rim=pow(1.0-abs(dot(n,v)),3.0)*0.22; o=vec4(uColor*d+vec3(rim),1.0); }\n" +
    "}";
  var VS1 = "attribute vec3 aPos; uniform mat4 uMVP; varying vec3 vP;\n" +
    "void main(){ vP=aPos; gl_Position=uMVP*vec4(aPos,1.0); }";
  var FS1 = "#extension GL_OES_standard_derivatives : enable\n" +
    "precision highp float;\n" +
    "varying vec3 vP; uniform vec3 uEye; uniform vec3 uColor; uniform int uFlat;\n" +
    "void main(){\n" +
    "  vec3 n=normalize(cross(dFdx(vP),dFdy(vP)));\n" +
    "  vec3 v=normalize(uEye-vP);\n" +
    "  if(dot(n,v)<0.0) n=-n;\n" +
    "  if(uFlat==1){ float r=0.55+0.45*pow(1.0-abs(dot(n,v)),1.4); gl_FragColor=vec4(uColor*r,1.0); }\n" +
    "  else{ vec3 k=normalize(vec3(0.5,0.8,0.7)); vec3 f=normalize(vec3(-0.6,0.1,0.4));\n" +
    "    float d=0.62*max(dot(n,k),0.0)+0.26*max(dot(n,f),0.0)+0.20;\n" +
    "    float rim=pow(1.0-abs(dot(n,v)),3.0)*0.22; gl_FragColor=vec4(uColor*d+vec3(rim),1.0); }\n" +
    "}";

  function mul(a, b) {
    var o = new Float32Array(16), c, r, k, s;
    for (c = 0; c < 4; c++) for (r = 0; r < 4; r++) {
      s = 0; for (k = 0; k < 4; k++) s += a[k*4+r] * b[c*4+k];
      o[c*4+r] = s;
    }
    return o;
  }
  function perspective(fovy, aspect, near, far) {
    var f = 1 / Math.tan(fovy / 2);
    return new Float32Array([f/aspect,0,0,0, 0,f,0,0, 0,0,(far+near)/(near-far),-1, 0,0,2*far*near/(near-far),0]);
  }
  function lookAt(e, c, up) {
    var zx=e[0]-c[0], zy=e[1]-c[1], zz=e[2]-c[2];
    var l=Math.hypot(zx,zy,zz)||1; zx/=l; zy/=l; zz/=l;
    var xx=up[1]*zz-up[2]*zy, xy=up[2]*zx-up[0]*zz, xz=up[0]*zy-up[1]*zx;
    l=Math.hypot(xx,xy,xz)||1; xx/=l; xy/=l; xz/=l;
    var yx=zy*xz-zz*xy, yy=zz*xx-zx*xz, yz=zx*xy-zy*xx;
    return new Float32Array([xx,yx,zx,0, xy,yy,zy,0, xz,yz,zz,0,
      -(xx*e[0]+xy*e[1]+xz*e[2]), -(yx*e[0]+yy*e[1]+yz*e[2]), -(zx*e[0]+zy*e[1]+zz*e[2]), 1]);
  }

  function Viewer(canvas) {
    this.canvas = canvas;
    this.gl = canvas.getContext("webgl2", { antialias: true, alpha: false });
    this.v2 = !!this.gl;
    if (!this.gl) this.gl = canvas.getContext("webgl", { antialias: true, alpha: false });
    if (!this.gl) throw new Error("WebGL is unavailable in this tab.");
    this.showBack = true;
    this.showEdges = true;
    this.showAllHoles = false;
    this.lineCountSmall = 0;
    this.spin = false;
    this.has = false;
    this.view = { yaw: 0.6, pitch: 0.28, dist: 3, target: [0,0,0], diag: 1 };
    this._init();
    this._bind();
    this._loop();
  }

  Viewer.prototype._sh = function (src, type) {
    var gl = this.gl, s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  };

  Viewer.prototype._init = function () {
    var gl = this.gl;
    if (!this.v2) gl.getExtension("OES_standard_derivatives");
    var p = gl.createProgram();
    gl.attachShader(p, this._sh(this.v2 ? VS2 : VS1, gl.VERTEX_SHADER));
    gl.attachShader(p, this._sh(this.v2 ? FS2 : FS1, gl.FRAGMENT_SHADER));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    this.prog = p;
    gl.useProgram(p);
    this.loc = {
      aPos: gl.getAttribLocation(p, "aPos"),
      uMVP: gl.getUniformLocation(p, "uMVP"),
      uEye: gl.getUniformLocation(p, "uEye"),
      uColor: gl.getUniformLocation(p, "uColor"),
      uFlat: gl.getUniformLocation(p, "uFlat")
    };
    this.posBuf = gl.createBuffer();
    this.idxBuf = gl.createBuffer();
    this.lineBuf = gl.createBuffer();
    gl.enable(gl.DEPTH_TEST);
  };

  Viewer.prototype.setMesh = function (mesh, an) {
    var gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuf);
    gl.bufferData(gl.ARRAY_BUFFER, mesh.positions, gl.STATIC_DRAW);

    var big = mesh.positions.length / 3 > 65535;
    var canBig = this.v2 || gl.getExtension("OES_element_index_uint");
    var arr = (big && canBig) ? new Uint32Array(mesh.indices) : new Uint16Array(mesh.indices);
    this.idxType = (big && canBig) ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.idxBuf);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, arr, gl.STATIC_DRAW);
    this.idxCount = mesh.indices.length;

    /* 只取那些确实看得见的边界——与报告中相同阈值的结果。如果分析结果
       比较旧，就回退到完整的列表。 */
    /* 先是可见的边界，然后是那些极小的——两者放在同一个缓冲区里。
       之后的切换靠的是所绘制点的数量，而不是第二次 bufferData：这样
       切换完全不花代价。 */
    var wp = an.weldedPositions;
    var gross = an.boundaryEdgesBig || an.boundaryEdges;
    var klein = an.boundaryEdgesSmall || [];
    var lines = new Float32Array((gross.length + klein.length) * 3);
    var n = 0;
    function schreibe(liste) {
      for (var k = 0; k < liste.length; k++, n++) {
        lines[n*3]   = wp[liste[k]*3];
        lines[n*3+1] = wp[liste[k]*3+1];
        lines[n*3+2] = wp[liste[k]*3+2];
      }
    }
    schreibe(gross); schreibe(klein);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineBuf);
    gl.bufferData(gl.ARRAY_BUFFER, lines, gl.STATIC_DRAW);
    this.lineCount = gross.length;
    this.lineCountSmall = klein.length;

    var b = an.bbox;
    this.view.target = [(b.minx+b.maxx)/2, (b.miny+b.maxy)/2, (b.minz+b.maxz)/2];
    this.view.diag = b.diag;
    this.view.dist = b.diag * 1.55;
    this.view.yaw = 0.6;
    this.view.pitch = 0.28;
    /* 这个网格的取景适配，好让双击能把它取回来。重新计算也行，但那样
       公式就得写在两个地方，可能会各自跑偏。 */
    this.heim = {
      yaw: this.view.yaw, pitch: this.view.pitch, dist: this.view.dist,
      target: this.view.target.slice()
    };
    this.has = true;
  };

  Viewer.prototype.clear = function () { this.has = false; };

  Viewer.prototype.resetView = function () {
    if (!this.heim) return;
    this.view.yaw = this.heim.yaw;
    this.view.pitch = this.heim.pitch;
    this.view.dist = this.heim.dist;
    this.view.target = this.heim.target.slice();
  };

  /* 由 yaw 和 pitch 得出的像平面。视点位于
       target + dist * (cos p * sin y, sin p, cos p * cos y)，
     因此视线方向就是它的相反数。由此得到一个不依赖于俯仰角的右向量——
     平移时要的正是这一点，否则拖动时画面内容会朝侧面翻倒过去。 */
  function bildebene(yaw, pitch) {
    var cp = Math.cos(pitch), sp = Math.sin(pitch);
    var sy = Math.sin(yaw), cy = Math.cos(yaw);
    return {
      rechts: [cy, 0, -sy],
      hoch: [-sp * sy, cp, -sp * cy]
    };
  }

  /* 同一个滚轮上的同一格，在每个浏览器里报出的数字都不一样：Chrome 给出
     像素（deltaY 100），Firefox 给出行（deltaY 3），有些环境给出页。谁要是
     不加检查就把 deltaY 乘上一个系数，造出来的缩放就会在两个浏览器中的
     某一个里几乎不动——用 0.0012 时，在 Firefox 里每格只有 0.36 %，也就是
     说要大约 315 格才能得到三倍。所以先归一化成格数，然后再缩放。 */
  function radRasten(deltaY, deltaMode) {
    if (deltaMode === 1) return deltaY / 3;    // 行：每格三行
    if (deltaMode === 2) return deltaY;        // 页：每格一页
    return deltaY / 100;                       // 像素：每格一百像素
  }

  /* 触控板上的一次滑动可能给出三位数的值；没有上限的话，画面就会在
     一帧之内从近处窜到远处。 */
  var MAX_RASTEN = 4;
  /* 每格大约 22 %：八格差不多正好是五倍。 */
  var PRO_RASTUNG = 0.2;

  Viewer.prototype._bind = function () {
    var self = this, c = this.canvas, drag = false, schieben = false, lx = 0, ly = 0;

    /* 鼠标右键平移，和在任何 3D 工具里一样。中键做同样的事，因为这两种
       习惯都很普遍。左键仍然是旋转。 */
    c.addEventListener("contextmenu", function (e) { e.preventDefault(); });

    c.addEventListener("pointerdown", function (e) {
      drag = true;
      schieben = (e.button === 2 || e.button === 1 || e.shiftKey);
      lx = e.clientX; ly = e.clientY;
      try { c.setPointerCapture(e.pointerId); } catch (err) {}
      self.spin = false;
      e.preventDefault();
      e.stopPropagation();
    });

    c.addEventListener("pointermove", function (e) {
      if (!drag) return;
      var dx = e.clientX - lx, dy = e.clientY - ly;
      var v = self.view;

      if (schieben) {
        /* 在目标点处，一个像素正好对应这么长的世界距离。这样一来，指针
           底下的那个点在任何距离上都保持不动——固定系数在近距离缩放时
           跑得太快了。 */
        var hoehe = c.clientHeight || c.height || 1;
        var proPixel = 2 * v.dist * Math.tan(0.85 / 2) / hoehe;
        var e3 = bildebene(v.yaw, v.pitch);
        for (var i = 0; i < 3; i++) {
          v.target[i] += (-e3.rechts[i] * dx + e3.hoch[i] * dy) * proPixel;
        }
      } else {
        v.yaw -= dx * 0.009;
        v.pitch = Math.max(-1.5, Math.min(1.5, v.pitch + dy * 0.009));
      }

      lx = e.clientX; ly = e.clientY;
      e.stopPropagation();
    });

    function end() { drag = false; schieben = false; }
    c.addEventListener("pointerup", end);
    c.addEventListener("pointercancel", end);
    c.addEventListener("wheel", function (e) {
      e.preventDefault(); e.stopPropagation();
      var v = self.view;
      var rasten = radRasten(e.deltaY, e.deltaMode);
      rasten = Math.max(-MAX_RASTEN, Math.min(MAX_RASTEN, rasten));
      var neu = Math.max(v.diag * 0.02, Math.min(v.diag * 12,
                         v.dist * Math.exp(rasten * PRO_RASTUNG)));

      /* 朝着指针方向，而不是朝着画面中心。找到了一个洞的人想凑近去看，
         而不想在这过程中把它推出画面，然后还得再把画面挪回来。 */
      var r = c.getBoundingClientRect();
      if (r.width && r.height) {
        var hoch = 2 * v.dist * Math.tan(0.85 / 2);
        var breit = hoch * (r.width / r.height);
        /* 指针底下那个点在目标平面上的世界偏移。符号沿用上面的平移：
           屏幕向右是 +rechts，屏幕向下是 -hoch。 */
        var ox = ((e.clientX - r.left) / r.width  - 0.5) * breit;
        var oy = -((e.clientY - r.top) / r.height - 0.5) * hoch;
        var anteil = 1 - neu / v.dist;
        var e3 = bildebene(v.yaw, v.pitch);
        for (var i = 0; i < 3; i++) {
          v.target[i] += (e3.rechts[i] * ox + e3.hoch[i] * oy) * anteil;
        }
      }
      v.dist = neu;
      self.spin = false;
    }, { passive: false });

    /* 凑近看过之后也得能找回来。没有这条路，丢失的视点就只能靠重新
       加载来补救。 */
    c.addEventListener("dblclick", function (e) {
      e.preventDefault(); e.stopPropagation();
      self.resetView();
    });
  };

  Viewer.prototype._loop = function () {
    var self = this;
    function frame() {
      self.raf = requestAnimationFrame(frame);
      /* Tripo 在同一个页面上已经跑着一个 3D 查看器了。只要我们的 canvas
         是收起来的，它就没有理由占用 GPU。 */
      if (!self.canvas.clientWidth || !self.canvas.clientHeight) return;
      self.draw();
    }
    frame();
  };

  Viewer.prototype.destroy = function () {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.has = false;
  };

  Viewer.prototype.draw = function () {
    var gl = this.gl, c = this.canvas;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var w = Math.max(1, Math.floor(c.clientWidth * dpr));
    var h = Math.max(1, Math.floor(c.clientHeight * dpr));
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }

    gl.viewport(0, 0, c.width, c.height);
    gl.clearColor(0.055, 0.067, 0.086, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    if (!this.has) return;

    var v = this.view;
    /* 按时间旋转，而不是按帧。旧的每帧增量让旋转依赖于帧率——在一块
       144-Hz 屏幕上，同一行代码的速度是 60-Hz 屏幕上的 2.4 倍。DREHUNG
       现在是一个角速度：约七秒转一圈，与设备无关。

       时间步长有上限：标签页从后台回来时，两帧之间隔着好几秒，不加
       上限的话模型就会一下子横着蹦一圈。 */
    if (this.spin) {
      var jetzt = (typeof performance !== "undefined" && performance.now)
        ? performance.now() : Date.now();
      var dt = this._zuletzt ? Math.min(0.1, (jetzt - this._zuletzt) / 1000) : 0;
      this._zuletzt = jetzt;
      v.yaw += DREHUNG * dt;
    } else {
      this._zuletzt = 0;
    }
    var cp = Math.cos(v.pitch), sp = Math.sin(v.pitch);
    var eye = [
      v.target[0] + v.dist * cp * Math.sin(v.yaw),
      v.target[1] + v.dist * sp,
      v.target[2] + v.dist * cp * Math.cos(v.yaw)
    ];
    var near = Math.max(v.diag * 0.005, 1e-4), far = v.diag * 40;
    var mvp = mul(perspective(0.85, c.width / c.height, near, far), lookAt(eye, v.target, [0,1,0]));

    gl.useProgram(this.prog);
    gl.uniformMatrix4fv(this.loc.uMVP, false, mvp);
    gl.uniform3fv(this.loc.uEye, new Float32Array(eye));
    gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuf);
    gl.enableVertexAttribArray(this.loc.aPos);
    gl.vertexAttribPointer(this.loc.aPos, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.idxBuf);

    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.enable(gl.CULL_FACE);

    gl.cullFace(gl.BACK);
    gl.uniform1i(this.loc.uFlat, 0);
    /* 比以前 (0.74) 明显更暗。在浅灰底色上，任何中等亮度的标记颜色都会
       消失——开放边缘的青色几乎辨认不出来，尽管这个色调就是通常用的
       那一个。错的不是标记，而是底色太亮。 */
    gl.uniform3f(this.loc.uColor, 0.46, 0.48, 0.51);
    gl.drawElements(gl.TRIANGLES, this.idxCount, this.idxType, 0);

    if (this.showBack) {
      gl.cullFace(gl.FRONT);
      gl.uniform1i(this.loc.uFlat, 1);
      /* 来自设计稿的 finding-bad：oklch(0.69 0.22 25) = #FF5050。面板里的
         开关圆点用的是同一个颜色；要是舞台继续画成品红色，开关显示的
         就和画面里的不是一回事了。 */
      gl.uniform3f(this.loc.uColor, 1.0, 0.313, 0.314);
      gl.drawElements(gl.TRIANGLES, this.idxCount, this.idxType, 0);
    }
    gl.disable(gl.CULL_FACE);

    if (this.showEdges && this.lineCount) {
      gl.disable(gl.DEPTH_TEST);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.lineBuf);
      gl.vertexAttribPointer(this.loc.aPos, 3, gl.FLOAT, false, 0, 0);
      gl.uniform1i(this.loc.uFlat, 1);
      /* finding-edge：oklch(0.78 0.13 215) = #2CCCEB。 */
      gl.uniform3f(this.loc.uColor, 0.171, 0.799, 0.921);
      gl.drawArrays(gl.LINES, 0, this.lineCount);
      /* 发丝般的细小裂缝用一种更暗淡的色调放在后面：它们在那儿，但不会
         盖过真正要紧的那些洞。用同样的颜色不会有任何好处——那样看到的
         又只是“一大片青色”。 */
      if (this.showAllHoles && this.lineCountSmall) {
        gl.uniform3f(this.loc.uColor, 0.19, 0.47, 0.53);
        gl.drawArrays(gl.LINES, this.lineCount, this.lineCountSmall);
      }
      gl.enable(gl.DEPTH_TEST);
    }
  };

  root.Viewer = Viewer;
  /* 仅供测试：归一化纯粹是算术，而且正是缩放在两个浏览器之间跑偏的
     那个地方。 */
  root.radRasten = radRasten;
})(typeof self !== "undefined" ? (self.T3D = self.T3D || {}) : (module.exports = {}));
