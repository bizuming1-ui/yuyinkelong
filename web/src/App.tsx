import { useEffect, useState } from "react";
import SimulatorShell from "@/components/SimulatorShell";
import CodeBrowser from "@/components/CodeBrowser";

// 极简 hash 路由：#/ = 浏览器模拟器，#/code = 复制代码界面（单文件 HTML，直接打开/放在 Kaggle 里都能用）
export default function App() {
  const [route, setRoute] = useState(() => window.location.hash);
  useEffect(() => {
    const on = () => {
      setRoute(window.location.hash);
      window.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return route.startsWith("#/code") ? <CodeBrowser /> : <SimulatorShell />;
}
