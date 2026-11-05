import { useEffect, useState } from "react";
import TriApp from "@/components/TriApp";
import RadarApp from "@/components/RadarApp";
import CodeBrowser from "@/components/CodeBrowser";

// 哈希路由（dist/index.html 直接双击用 file:// 打开也能正常切换）：
//   ""        → 三节点 3D 模拟器（主界面，始终挂载，切到复制代码界面时只是隐藏，连接/数据不中断）
//   #/code    → 复制代码界面
//   #/legacy  → 旧版双节点模拟器（原功能保留，按需挂载）
export default function App() {
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const on = () => setHash(window.location.hash);
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  const code = hash.startsWith("#/code");
  const legacy = hash.startsWith("#/legacy");
  return (
    <>
      <div style={{ display: code || legacy ? "none" : "block" }}>{!legacy && <TriApp />}</div>
      {legacy && (
        <>
          <button onClick={() => (window.location.hash = "")} className="fixed bottom-3 left-3 z-50 rounded-lg bg-cyan-400 px-3 py-2 text-sm font-bold text-slate-900 shadow-lg hover:bg-cyan-300">
            ← 返回三节点模拟器
          </button>
          <RadarApp />
        </>
      )}
      {code && <CodeBrowser />}
    </>
  );
}
