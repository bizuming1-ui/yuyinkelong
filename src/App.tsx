import { useEffect, useState } from "react";
import RadarApp from "@/components/RadarApp";
import CodeBrowser from "@/components/CodeBrowser";

// 哈希路由：#/code = 复制代码界面；其它 = 3D 模拟器。
// 用哈希而不是路径，这样 dist/index.html 直接双击用 file:// 打开也能正常切换。
export default function App() {
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const on = () => setHash(window.location.hash);
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  // 3D 模拟器始终挂载（切到复制代码界面时只是隐藏），这样回来时连接/数据不中断、不重连
  const code = hash.startsWith("#/code");
  return (
    <>
      <div style={{ display: code ? "none" : "block" }}>
        <RadarApp />
      </div>
      {code && <CodeBrowser />}
    </>
  );
}
