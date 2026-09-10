/* 在 Chrome 里作为 service worker 加载，在 Firefox 里作为事件页加载 ——
   manifest 同时声明了两个键，每个浏览器都会忽略自己用不上的那一个。
   要假定随时可能被回收：监听器都写在顶层，这里不保存任何状态。 */
(function () {
  "use strict";
  var api = (typeof browser !== "undefined") ? browser : chrome;

  api.action.onClicked.addListener(function (tab) {
    if (!tab || tab.id == null) return;
    var sent = api.tabs.sendMessage(tab.id, { kind: "toggle" });
    // 落到一个没有内容脚本的标签页上是预料之中的事，不是错误。
    if (sent && typeof sent.catch === "function") sent.catch(function () {});
  });

  api.runtime.onMessage.addListener(function (msg) {
    if (msg && msg.kind === "options") api.runtime.openOptionsPage();
  });
})();
