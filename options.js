(function () {
  "use strict";
  var S = self.T3D.settings;
  var NUM = ["minHoleEdges","rerollHoles","rerollHoleEdges","rerollFlipPercent","rerollOpenPercent","rerollNonManifoldPercent","warnUVCoverage","sliverQ"];
  var BOOL = ["failNonManifold","warnStrayIslands","warnNoUV","autoCheck","badgeCards"];

  function fill(cfg) {
    NUM.forEach(function (k) { var e = document.getElementById(k); if (e) e.value = cfg[k]; });
    BOOL.forEach(function (k) { var e = document.getElementById(k); if (e) e.checked = !!cfg[k]; });
  }

  function collect() {
    var out = {};
    NUM.forEach(function (k) {
      var e = document.getElementById(k);
      var v = parseFloat(e.value);
      out[k] = isNaN(v) ? S.DEFAULTS[k] : v;
    });
    BOOL.forEach(function (k) { out[k] = !!document.getElementById(k).checked; });
    return out;
  }

  function flash(msg) {
    var s = document.getElementById("saved");
    s.textContent = msg;
    setTimeout(function () { s.textContent = ""; }, 2200);
  }

  S.load().then(fill);
  document.getElementById("save").addEventListener("click", function () {
    S.save(collect()).then(function () { flash("Saved. New checks use these."); });
  });
  document.getElementById("reset").addEventListener("click", function () {
    fill(S.DEFAULTS);
    S.save(S.DEFAULTS).then(function () { flash("Back to defaults."); });
  });
})();
