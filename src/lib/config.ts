// 全局常量：浏览器模拟器与固件(config.h)必须保持一致
export const DEFAULT_ROOT = "bzm-csi/s3r-7f3a9c2e"; // = firmware config.h 的 MQTT_ROOT

export interface BrokerDef {
  name: string;
  url: string; // 浏览器用 WebSocket(WSS)；ESP32 用同一服务器的 TCP 1883
  tcp: string;
}

// 浏览器会"同时"连接下面所有服务器，所以 ESP32 无论落在哪个服务器上都能被收到
export const BROKERS: BrokerDef[] = [
  { name: "HiveMQ", url: "wss://broker.hivemq.com:8884/mqtt", tcp: "broker.hivemq.com:1883" },
  { name: "EMQX", url: "wss://broker.emqx.io:8084/mqtt", tcp: "broker.emqx.io:1883" },
  { name: "Mosquitto", url: "wss://test.mosquitto.org:8081", tcp: "test.mosquitto.org:1883" },
];

export const GITHUB_REPO = "bizuming1-ui/yuyinkelong";
export const GITHUB_BRANCH = "main";
// 永久网址：推送到 GitHub 后由 .github/workflows/pages.yml 自动构建并发布（需在仓库 Settings → Pages → Source 选 GitHub Actions）
export const PAGES_URL = "https://bizuming1-ui.github.io/yuyinkelong/";

// 旧版（Kaggle + Vite 方案）遗留文件：GitHub API 被限流(403)时，复制代码界面用 raw 逐个探测它们是否还在仓库里。
export const OLD_FILE_HINTS: string[] = [
  "web/index.html",
  "web/package.json",
  "web/tsconfig.json",
  "web/scripts/build-kaggle.mjs",
  "web/src/App.tsx",
  "web/src/main.tsx",
  "web/src/index.css",
  "web/src/vite-env.d.ts",
  "web/src/utils/cn.ts",
  "web/src/lib/advisor.ts",
  "web/src/lib/diag.ts",
  "web/src/lib/radar.ts",
  "web/src/lib/useRadar.ts",
  "web/src/components/CodeBrowser.tsx",
  "web/src/components/DiagPanel.tsx",
  "web/src/components/Radar3D.tsx",
  "web/src/components/SimulatorShell.tsx",
  "src/lib/diag.ts",
  "src/lib/radar-store.ts",
  "tools/sim_esp32_csi.py",
  "tools/test_host.py",
  "tools/test_scene_server.py",
  "提示词",
  "检测日志",
];
