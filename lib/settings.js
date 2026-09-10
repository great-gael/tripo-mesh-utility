/* 设置。

   阈值决定判定结果，而合适的阈值取决于这个网格是干什么用的 —— 摆在背景架子
   上的道具和主角资产不该用同一条标准。这些值可以在选项页里修改，并保存在
   sync storage 中。 */
(function (root) {
  "use strict";

  var DEFAULTS = {
    minHoleEdges: 6,            // 低于此值的洞算作不可见，
                                //   既不计入报告也不计入判定
    rerollHoles: 6,             // 洞比这个数量还多就重新生成
    rerollHoleEdges: 40,        // ……或者单个洞有这么多条边
    rerollFlipPercent: 1.0,     // ……或者有这么多 % 的三角形被翻转
    rerollOpenPercent: 3.0,     // ……或者开放边占全部边的这个比例，以 % 计
    failNonManifold: true,      // non-manifold（非流形）边对网格不利……
    rerollNonManifoldPercent: 0.1, // ……但只有超过占全部边的这个比例时才算
                                // 把绝对的零当作阈值，在量纲上犯
                                // 的是和拿开放边去比三角形数一模
                                // 一样的错误：290 万条边里有两
                                // 条边有问题，那是舍入误差，不是
                                // 一次该扔掉的生成。低于这个阈值
                                // 它仍然只是一条警告，什么都不会
                                // 被隐瞒。
    warnStrayIslands: true,
    warnNoUV: true,
    warnUVCoverage: 35,         // 图集占用率低于这个 % 就是浪费
    sliverQ: 0.05,              // 三角形质量低于此值算作 sliver（针状三角形）
    panelWidth: 420,            // 由用户在左边缘拖动调整
    panelHeight: 0,             // 0 = 由内容决定高度；只有当有人在
                                //     上边缘拖动时才把它定下来
    showDetails: false,         // 结果下方的数字默认折叠起来
    autoCheck: true,            // 网格加载时就顺带检查
    badgeCards: true,           // 在素材库缩略图上用圆点标出判定结果
    showBackFaces: true,
    showOpenEdges: true,
    /* 纯粹是显示层面的事：把小于 minHoleEdges 的洞也显示出来。
       判定结果不受此影响。 */
    showAllHoles: false,
    turntable: false
  };

  function api() { return (typeof browser !== "undefined") ? browser : chrome; }

  function load() {
    return new Promise(function (resolve) {
      try {
        var st = api().storage.sync || api().storage.local;
        var p = st.get(DEFAULTS);
        if (p && typeof p.then === "function") {
          p.then(function (v) { resolve(Object.assign({}, DEFAULTS, v || {})); })
           .catch(function () { resolve(Object.assign({}, DEFAULTS)); });
        } else {
          st.get(DEFAULTS, function (v) { resolve(Object.assign({}, DEFAULTS, v || {})); });
        }
      } catch (e) { resolve(Object.assign({}, DEFAULTS)); }
    });
  }

  function save(patch) {
    return new Promise(function (resolve) {
      try {
        var st = api().storage.sync || api().storage.local;
        var p = st.set(patch);
        if (p && typeof p.then === "function") p.then(resolve).catch(resolve);
        else st.set(patch, resolve);
      } catch (e) { resolve(); }
    });
  }

  root.settings = { DEFAULTS: DEFAULTS, load: load, save: save };
})(typeof self !== "undefined" ? (self.T3D = self.T3D || {}) : (module.exports = {}));
