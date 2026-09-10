/* 浏览器里的自检。

   Node 测试套件把解析器、解码器和分析完整覆盖了 —— 但它并不在扩展真正干活的
   地方运行。Inflate、Meshopt 解码器和 FBX 读取器在浏览器里到底会不会跑起来，
   此前只能靠某个人打开一个模型、再报告发生了什么来弄清楚。这花掉了整整一天。

   所以这里嵌入了三个极小的文件，加起来只有几千字节，每个走一条自己的路
   径。启动时整条链路会完整跑一遍，并往控制台写一行。要是有什么失败了，那里
   会写明是哪条路径以及为什么 —— 早在第一个用户察觉之前。

   由 test/../scratchpad/build_selftest.js 从 test/fixtures/ 下的测试固件生成。
   谁改动了这些测试固件，就重新生成这个文件。 */
(function (root) {
  "use strict";

  var PROBEN = [
    { schluessel: "fbx", was: "FBX plus Inflate", tris: 12,
      daten: "S2F5ZGFyYSBGQlggQmluYXJ5ICAAGgDoHAAAYwAAAAAAAAAAAAAAEkZCWEhlYWRlckV4dGVuc2lvblYAAAABAAAABQAAAApGQlhWZXJzaW9uSegcAAAAAAAAAAAAAAAAAAAApAEAAAAAAAAAAAAAB09iamVjdHNjAQAAAwAAACUAAAAIR2VvbWV0cnlM6QMAAAAAAABTDgAAAEN1YmUAAUdlb21ldHJ5UwQAAABNZXNo8QAAAAEAAAArAAAACFZlcnRpY2VzZBgAAAABAAAAHgAAAHicY2AAgQf7GbDT9gTECckTMhddHbo4QXUAmrwg6VYBAAABAAAARgAAABJQb2x5Z29uVmVydGV4SW5kZXhpGAAAAAEAAAA5AAAAeJwty1kKgEAQA9E346j3v60LGGnofIVUCjZMfEkWdhy4ksDo7U0y+lv8STLbP3EnqV5Z7f/+0RgBAAAAAAAAAAAAAAAAAJcBAAADAAAAIgAAAAVNb2RlbEzRBwAAAAAAAFMLAAAAQ3ViZQABTW9kZWxTBAAAAE1lc2gAAAAAAAAAAAAAAAAAFwIAAAAAAAAAAAAAC0Nvbm5lY3Rpb25z4wEAAAMAAAAZAAAAAUNTAgAAAE9PTOkDAAAAAAAATNEHAAAAAAAACgIAAAMAAAAZAAAAAUNTAgAAAE9PTNEHAAAAAAAATAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
    { schluessel: "meshopt", was: "GLB plus Meshopt", tris: 12,
      daten: "Z2xURgIAAADcBAAAFAQAAEpTT057ImFzc2V0Ijp7InZlcnNpb24iOiIyLjAiLCJnZW5lcmF0b3IiOiJNZXNob3B0Q3ViZVRlc3Qgc2xpY2UgKENDMC0xLjApIn0sImV4dGVuc2lvbnNVc2VkIjpbIktIUl9tZXNob3B0X2NvbXByZXNzaW9uIl0sImV4dGVuc2lvbnNSZXF1aXJlZCI6WyJLSFJfbWVzaG9wdF9jb21wcmVzc2lvbiJdLCJzY2VuZSI6MCwic2NlbmVzIjpbeyJub2RlcyI6WzBdfV0sIm5vZGVzIjpbeyJtZXNoIjowfV0sIm1lc2hlcyI6W3sicHJpbWl0aXZlcyI6W3siYXR0cmlidXRlcyI6eyJQT1NJVElPTiI6MH0sImluZGljZXMiOjEsIm1vZGUiOjR9XX1dLCJhY2Nlc3NvcnMiOlt7ImJ1ZmZlclZpZXciOjAsImJ5dGVPZmZzZXQiOjAsImNvbXBvbmVudFR5cGUiOjUxMjYsImNvdW50IjoyNCwidHlwZSI6IlZFQzMiLCJtaW4iOlstMC41LC0wLjUsLTAuNV0sIm1heCI6WzAuNSwwLjUsMC41XX0seyJidWZmZXJWaWV3IjoxLCJieXRlT2Zmc2V0IjowLCJjb21wb25lbnRUeXBlIjo1MTIzLCJjb3VudCI6MzYsInR5cGUiOiJTQ0FMQVIifV0sImJ1ZmZlclZpZXdzIjpbeyJidWZmZXIiOjEsImJ5dGVPZmZzZXQiOjAsImJ5dGVMZW5ndGgiOjQ4MCwiYnl0ZVN0cmlkZSI6MjAsInRhcmdldCI6MzQ5NjIsImV4dGVuc2lvbnMiOnsiS0hSX21lc2hvcHRfY29tcHJlc3Npb24iOnsiYnVmZmVyIjowLCJieXRlT2Zmc2V0IjowLCJieXRlTGVuZ3RoIjoxMTUsImJ5dGVTdHJpZGUiOjIwLCJjb3VudCI6MjQsIm1vZGUiOiJBVFRSSUJVVEVTIn19fSx7ImJ1ZmZlciI6MSwiYnl0ZU9mZnNldCI6NDgwLCJieXRlTGVuZ3RoIjo3MiwidGFyZ2V0IjozNDk2MywiZXh0ZW5zaW9ucyI6eyJLSFJfbWVzaG9wdF9jb21wcmVzc2lvbiI6eyJidWZmZXIiOjAsImJ5dGVPZmZzZXQiOjExNiwiYnl0ZUxlbmd0aCI6NTYsImJ5dGVTdHJpZGUiOjIsImNvdW50IjozNiwibW9kZSI6IlRSSUFOR0xFUyJ9fX1dLCJidWZmZXJzIjpbeyJieXRlTGVuZ3RoIjoxNzJ9LHsiYnl0ZUxlbmd0aCI6NTUyLCJleHRlbnNpb25zIjp7IktIUl9tZXNob3B0X2NvbXByZXNzaW9uIjp7ImZhbGxiYWNrIjp0cnVlfX19XX2sAAAAQklOAKFqamqEhQAQqv//////uwD///////8AVBD/////VAD///8AukX//////////xEA//8BEAEE/gAAEf4EAQD+BBEA/gQAABH9/hEA/f4AEAD+EQD9/gEQEf79/gAAAD8AAAC/AAAAv38AAAD/gID/AAAAAAAA4f4u/y//L/8v/y//L/AE/wIEAQT/AgQBBP8CBAEE/wIEAQT/AgQBBAB2h1ZneKmGZYlomAFpAAA=" },
    { schluessel: "glb", was: "GLB uncompressed", tris: 10,
      daten: "Z2xURgIAAAD4AwAAOAIAAEpTT057ImFzc2V0Ijp7InZlcnNpb24iOiIyLjAifSwic2NlbmUiOjAsInNjZW5lcyI6W3sibm9kZXMiOlswXX1dLCJub2RlcyI6W3siY2hpbGRyZW4iOlsxXSwic2NhbGUiOlsyLDIsMl19LHsibWVzaCI6MCwicm90YXRpb24iOlswLjcwNzEwNjc4MTE4NjU0NzYsMCwwLDAuNzA3MTA2NzgxMTg2NTQ3Nl0sInRyYW5zbGF0aW9uIjpbNSwwLDBdfV0sIm1lc2hlcyI6W3sicHJpbWl0aXZlcyI6W3siYXR0cmlidXRlcyI6eyJQT1NJVElPTiI6MH0sImluZGljZXMiOjEsIm1vZGUiOjR9XX1dLCJhY2Nlc3NvcnMiOlt7ImJ1ZmZlclZpZXciOjAsImNvbXBvbmVudFR5cGUiOjUxMjYsImNvdW50IjozMCwidHlwZSI6IlZFQzMifSx7ImJ1ZmZlclZpZXciOjEsImNvbXBvbmVudFR5cGUiOjUxMjMsImNvdW50IjozMCwidHlwZSI6IlNDQUxBUiJ9XSwiYnVmZmVyVmlld3MiOlt7ImJ1ZmZlciI6MCwiYnl0ZU9mZnNldCI6MCwiYnl0ZUxlbmd0aCI6MzYwLCJieXRlU3RyaWRlIjoxMn0seyJidWZmZXIiOjAsImJ5dGVPZmZzZXQiOjM2MCwiYnl0ZUxlbmd0aCI6NjB9XSwiYnVmZmVycyI6W3siYnl0ZUxlbmd0aCI6NDIwfV19pAEAAEJJTgAAAAAAAAAAAAAAgD8AAIA/AACAPwAAgD8AAIA/AAAAAAAAgD8AAAAAAAAAAAAAgD8AAIA/AACAPwAAgD8AAAAAAACAPwAAgD8AAIA/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAPwAAAAAAAIA/AAAAAAAAAAAAAAAAAACAPwAAAAAAAIA/AACAPwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgD8AAAAAAACAPwAAgD8AAAAAAAAAAAAAAAAAAAAAAACAPwAAgD8AAAAAAACAPwAAAAAAAIA/AAAAAAAAgD8AAIA/AAAAAAAAAAAAAIA/AACAPwAAAAAAAIA/AAAAAAAAgD8AAIA/AACAPwAAAAAAAIA/AACAPwAAgD8AAAAAAAAAAAAAAAAAAIA/AAAAAAAAAAAAAIA/AAAAAAAAgD8AAAAAAAAAAAAAAAAAAIA/AAAAAAAAgD8AAAAAAAAAAAAAgD8AAAEAAgADAAQABQAGAAcACAAJAAoACwAMAA0ADgAPABAAEQASABMAFAAVABYAFwAYABkAGgAbABwAHQA=" }
  ];

  function entbase64(s) {
    var roh = atob(s), n = roh.length, u = new Uint8Array(n);
    for (var i = 0; i < n; i++) u[i] = roh.charCodeAt(i);
    return u.buffer;
  }

  /* 返回一个由 { schluessel, ok, warum } 组成的列表。从不抛出异常：一个把
     扩展一起拖垮的自检，比根本没有自检还糟。 */
  function selbsttest(T3D) {
    var ergebnis = [];
    for (var i = 0; i < PROBEN.length; i++) {
      var p = PROBEN[i], eintrag = { schluessel: p.schluessel, was: p.was, ok: false, warum: "" };
      try {
        var m = T3D.parseAny(entbase64(p.daten), p.schluessel + ".bin");
        var tris = m.indices.length / 3;
        if (tris !== p.tris) {
          eintrag.warum = tris + " triangles instead of " + p.tris;
        } else {
          var an = T3D.buildAnalysis(m.positions, m.indices, { sliverQ: 0.05 });
          if (!an || typeof an.triCount !== "number") eintrag.warum = "analysis returned nothing";
          else if (an.triCount !== p.tris) eintrag.warum = "analysis counts " + an.triCount;
          else eintrag.ok = true;
        }
      } catch (e) {
        eintrag.warum = (e && e.message) || String(e);
      }
      ergebnis.push(eintrag);
    }
    return ergebnis;
  }

  root.selbsttest = selbsttest;
})(typeof self !== "undefined" ? (self.T3D = self.T3D || {}) : (module.exports = {}));
