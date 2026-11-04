// 规则式“AI 诊断助手”（无 GPU 的内置版）。Kaggle 版会在 GPU 上跑真正的大语言模型，接口相同：POST /api/llm {report}
export function ruleAdvice(report: string): string {
  const r = report || "";
  const tips: string[] = [];
  const has = (re: RegExp) => re.test(r);
  if (!r.trim()) return "没有收到检测日志。请先在 3D 页面点「🩺 检测日志」，再点「🤖 AI 分析」。";
  if (has(/HTTP -1|connect timeout|连不上|无响应/)) tips.push("ESP32 或网页连不上服务器：确认服务器网址是 https，ESP32 与服务器之间没有被防火墙拦截；Kaggle 重启后网址会变（固件会通过汇合点自动读取）。");
  if (has(/401|API_KEY 不一致|bad key/)) tips.push("API_KEY 不一致：把 firmware/include/config.h 的 API_KEY 改成与服务器一致（默认 radar-key）。");
  if (has(/0 字节|没有任何串口数据/)) tips.push("串口 0 字节：换板子另一个 USB 口、关闭 PlatformIO 串口监视器、换数据线；然后重新 Upload 最新固件。");
  if (has(/下载模式|DOWNLOAD/)) tips.push("ESP32 处于下载模式：松开 BOOT 键，按一下 RESET。");
  if (has(/wifi.*timeout|WIFI_SSID|5GHz/i)) tips.push("WiFi 连接失败：SSID/密码是否正确，必须是 2.4GHz。");
  if (has(/CSI.*(未收到|等待|关闭)|csi=0|CSI 包 *0/)) tips.push("没有 CSI：固件 v5+ 必须填好 WIFI_SSID/WIFI_PASS 才能对路由器 ping 取 CSI；确认串口出现 RADARCSI 行。");
  if (has(/等待 ESP32/)) tips.push("页面仍在等待 ESP32：最快验证方式是点「🔌 USB 连接 ESP32」直连；或点「▶ 演示数据」确认 3D 引擎正常。");
  if (has(/绘制异常|ERR.*render/)) tips.push("3D 渲染出现异常：请把日志里 render 相关的行复制到 GitHub，便于定位。");
  if (!tips.length) tips.push("日志中没有发现明显故障。若 3D 里没有人体：先让房间安静约 10 秒建立基线，再在 ESP32↔路由器连线附近走动；单个 ESP32 只能判断存在/运动/呼吸，姿态是示意模型。");
  return "【规则诊断】\n" + tips.map((t, i) => `${i + 1}. ${t}`).join("\n");
}
