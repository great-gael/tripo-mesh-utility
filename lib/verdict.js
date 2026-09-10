/* 判定。

   把一堆数字变成分拣时唯一真正想要的东西：留下它、修补它，还是再生成一次。
   每个分支都说出理由，因为一个不给理由的颜色，人早晚学会视而不见。 */
(function (root) {
  "use strict";

  /* 与设计稿中的 token 完全相同的值，换算成 sRGB：
       --finding-bad  oklch(0.69 0.22 25)  = #FF5050
       --finding-warn oklch(0.84 0.17 88)  = #F8C20D
       --success      oklch(0.74 0.15 155) = #4BC680
     这些颜色会走出本模块：它们给状态圆点以及 Tripo 素材库卡片上的标记着色。
     在旁边再放第二套调色板，就等于让同一个结论在两个地方看起来不一样。 */
  var GREEN = "#4BC680", AMBER = "#F8C20D", RED = "#FF5050";

  function decide(an, ins, cfg) {
    var reasons = [], warnings = [];
    /* 开放边是相对全部边的数量来衡量的，而不是相对三角形数量。边界边随
       洞的周长增长，三角形随面积增长，所以拿三角形作参照的比值在量纲上
       就是错的，而且在小网格上会失控。 */
    var openPct = (an.openRatio != null ? an.openRatio : 0) * 100;
    /* 朝向不稳定时，flippedTris 只是遍历顺序造成的假象。这时算数的是
       真正被测量到的那个缺陷：两个面互相矛盾的那些边。 */
    var flipPct = an.windingUnstable
      ? 0
      : (an.flippedTris / Math.max(1, an.triCount)) * 100;

    if (an.insideOut) {
      var extra = an.flippedTris
        ? " " + an.flippedTris + " face" + (an.flippedTris > 1 ? "s are" : " is") +
          " also flipped against it; the repair handles both in one pass."
        : "";
      return {
        level: "flip", color: RED, call: "Whole mesh is inside out",
        why: "Winding is consistent but faces inward. One global flip fixes it." + extra,
        chip: "Inside out", reasons: [], warnings: warnings
      };
    }

    /* 和开放边一样：一个没有参照量的数量说明不了任何事情。一个有 190 万个
       三角形、两条问题边的网格实际上是干净的，而一个立方体有两条就是坏的。
       低于阈值时只警告而不否决 —— 无论如何它都仍然是看得见的。 */
    var nmPct = (an.nonManifold / Math.max(1, an.totalEdges || 1)) * 100;
    if (cfg.failNonManifold && an.nonManifold > 0) {
      if (nmPct > (cfg.rerollNonManifoldPercent != null ? cfg.rerollNonManifoldPercent : 0.1)) {
        reasons.push(an.nonManifold + " non-manifold edges");
      } else {
        warnings.push(an.nonManifold + " non-manifold edge" + (an.nonManifold > 1 ? "s" : ""));
      }
    }
    /* 被计数的是那些看得见的洞。如果这个字段不存在 —— 比如来自旧版本的
       一次分析 —— 就沿用原来的总数。 */
    var loecher = (an.holesBig != null) ? an.holesBig : an.holes;
    if (loecher > cfg.rerollHoles) reasons.push(loecher + " holes");
    if (an.largestHole >= cfg.rerollHoleEdges) reasons.push("a " + an.largestHole + "-edge hole");
    if (flipPct > cfg.rerollFlipPercent) reasons.push(flipPct.toFixed(1) + "% of faces inverted");
    if (openPct > cfg.rerollOpenPercent) reasons.push(openPct.toFixed(1) + "% open edges");

    if (cfg.warnStrayIslands && an.strayIslands > 0) warnings.push(an.strayIslands + " stray fragment" + (an.strayIslands > 1 ? "s" : ""));
    if (an.duplicateFaces > 0) warnings.push(an.duplicateFaces + " duplicate faces");
    if (an.slivers > an.triCount * 0.02) warnings.push("sliver-heavy topology");
    if (an.degenerate > 0) warnings.push(an.degenerate + " zero-area triangles");
    if (ins && ins.hasGLTF) {
      if (cfg.warnNoUV && ins.primitives && !ins.hasUV) warnings.push("no UVs");
      else if (cfg.warnNoUV && ins.uvMissingPrims > 0) warnings.push(ins.uvMissingPrims + " parts without UVs");
      if (ins.uvCoverage != null && ins.uvCoverage * 100 < cfg.warnUVCoverage) {
        warnings.push("UV atlas only " + Math.round(ins.uvCoverage * 100) + "% used");
      }
      if (ins.uvOverlap != null && ins.uvOverlap > 0.15) warnings.push("overlapping UVs");
    }

    if (reasons.length) {
      return {
        level: "reroll", color: RED, call: "Re-roll this generation",
        why: cap(reasons) + ". Repairing costs more than generating again.",
        chip: "Re-roll", reasons: reasons, warnings: warnings
      };
    }
    var minor = loecher || an.flippedTris || an.windingUnstable || warnings.length;
    if (minor) {
      return {
        level: "minor", color: AMBER, call: "Small defects — patchable",
        why: cap(describeMinor(an, warnings)) + ".",
        chip: "Minor defects", reasons: [], warnings: warnings
      };
    }
    return {
      level: "clean", color: GREEN, call: "Clean — take it forward",
      why: "Closed, consistently wound, one piece" + (ins && ins.hasUV ? ", UVs present." : "."),
      chip: "Clean", reasons: [], warnings: warnings
    };
  }

  function describeMinor(an, warnings) {
    var bits = [];
    if (an.holes) bits.push(an.holes + " small hole" + (an.holes > 1 ? "s" : ""));
    if (an.windingUnstable) {
      bits.push("winding contradicts itself across " + an.inconsistentEdges +
        " edge" + (an.inconsistentEdges === 1 ? "" : "s"));
    } else if (an.flippedTris) {
      bits.push(an.flippedTris + " inverted triangle" + (an.flippedTris > 1 ? "s" : ""));
    }
    return bits.concat(warnings).slice(0, 3);
  }

  function cap(list) {
    if (!list.length) return "Localised problems";
    var s = list.slice(0, 3).join(", ");
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  root.verdict = { decide: decide };
})(typeof self !== "undefined" ? (self.T3D = self.T3D || {}) : (module.exports = {}));
