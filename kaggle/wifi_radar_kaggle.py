#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
WiFi 雷达 · Kaggle 单文件服务端 v3（ESP32-S3 -> Kaggle T4x2 GPU -> 全屏 3D 网站）
=============================================================================
用法（Kaggle Notebook：右侧 Settings -> Accelerator 选 GPU T4 x2，Internet 选 On）：
    1) 新建 Code Cell，把本文件【全部内容】粘贴进去，运行。
    2) 等待输出：
         🌐 全屏 3D 网站： https://xxxx.trycloudflare.com
         #define SERVER_URL "https://xxxx.trycloudflare.com"
    3) 用电脑 Chrome/Edge 打开该网址 -> 页面里点【🔌 USB 连接 ESP32】(最稳，ESP32 不需要联网)，
       或者把网址填进 PlatformIO 的 firmware/include/config.h 的 SERVER_URL，烧录后按 RESET。
    Cell 必须保持运行；停止 Cell = 关闭网站。

内置功能：
    - 3D 网站零依赖（自带 Canvas 3D 引擎，不再依赖任何 CDN / WebGL）。
    - /api/ingest 接收 ESP32 (WiFi 直传 或 网页 USB 转发)，/api/frames 网页轮询。
    - 多 GPU：>=2 个 ESP32 节点同时看到同一个 AP 时，用 PyTorch 在 *所有* GPU 上分片并行做三边定位（2048 起点并行优化）。
    - GPU 运动检测：把所有 AP 的 RSSI 时间序列堆成矩阵，在 GPU 上计算环境扰动指数。
    - 资源预算：显存（每卡 <=RADAR_VRAM_GB，默认 12GiB 内按需）、内存（RSSI 历史 <=RADAR_RAM_GB，默认 20GiB 上限）、
      磁盘（历史记录 JSONL 写到 /kaggle/temp，<=RADAR_DISK_GB，默认 45GiB，自动滚动删除最旧文件）。
    - 隧道：cloudflared 自动重试 + 公网自检；可选 ngrok（环境变量 NGROK_TOKEN）。
    - /api/geo：beaconDB WiFi 定位 + OpenStreetMap 真实街区（建筑/道路）。
    - 全能检测：/api/diag(JSON) 与 /api/diag.txt(纯文本，可直接复制到 GitHub “检测日志”)；
      网页端日志经 /api/clientlog 汇总到这里，同时写入 /kaggle/working/radar_diag.log（可在 Kaggle Output 下载）。
"""
import os, sys, re, json, math, time, threading, subprocess, shutil, urllib.request, collections, random, glob
from urllib.parse import urlparse

API_KEY = os.environ.get("RADAR_KEY", "radar-key")        # 必须与 ESP32 config.h 里的 API_KEY 一致
PORT = int(os.environ.get("RADAR_PORT", "8000"))
USE_TUNNEL = os.environ.get("RADAR_NO_TUNNEL", "") != "1"
NGROK_TOKEN = os.environ.get("NGROK_TOKEN", "")
VRAM_GB = float(os.environ.get("RADAR_VRAM_GB", "12"))     # 每张 GPU 允许求解器使用的显存上限（T4 共 15GiB）
RAM_GB = float(os.environ.get("RADAR_RAM_GB", "20"))       # 历史时间序列允许占用的内存上限（Kaggle 共 30GiB）
DISK_GB = float(os.environ.get("RADAR_DISK_GB", "45"))     # 历史记录磁盘上限（Kaggle 共 57.6GiB）
RESTARTS = int(os.environ.get("RADAR_RESTARTS", "2048"))   # 每个 AP 的并行起点数
UA = {"User-Agent": "wifi-radar-esp32s3/2.0 (personal project)"}
PATH_N, PATH_TX = 2.8, -40.0
HIST_DIR = "/kaggle/temp/wifi_radar_history" if os.path.isdir("/kaggle/temp") else "/tmp/wifi_radar_history"


VERSION = "3.0"
EVENTS = collections.deque(maxlen=4000)
EVT_FILE = "/kaggle/working/radar_diag.log" if os.path.isdir("/kaggle/working") else "/tmp/radar_diag.log"
_ECHO = {}
_EVT_N = [0]
TUNNEL = {"state": "未启动", "url": "", "attempts": 0, "probe": ""}


def evt(level, cat, msg, echo=False, t=None):
    """记录一条检测事件：内存环形缓冲 + 磁盘日志文件；echo=True 时同时打印到 Notebook 输出。"""
    e = {"t": round(t or time.time(), 3), "lv": level, "c": cat, "m": str(msg)[:700]}
    EVENTS.append(e)
    line = "%s %s [%s] %s" % (time.strftime("%H:%M:%S", time.localtime(e["t"])), level, cat, e["m"])
    try:
        _EVT_N[0] += 1
        if _EVT_N[0] % 500 == 0 and os.path.exists(EVT_FILE) and os.path.getsize(EVT_FILE) > 64 * 1024 ** 2:
            open(EVT_FILE, "w").close()
        with open(EVT_FILE, "a", encoding="utf8") as fh:
            fh.write(line + "\n")
    except Exception:
        pass
    if echo:
        print(line, flush=True)


def evt_rate(key, secs, level, cat, msg, echo=True):
    now = time.time()
    if now - _ECHO.get(key, 0) < secs:
        return
    _ECHO[key] = now
    evt(level, cat, msg, echo=echo)


def _ensure(mod, pip=None):
    try:
        __import__(mod)
    except ImportError:
        subprocess.check_call([sys.executable, "-m", "pip", "install", "-q", pip or mod])


_ensure("flask")
_ensure("requests")
import requests
from flask import Flask, request, jsonify, Response

HTML = r'''<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<title>WiFi RADAR · 3D 真实世界</title>
<style>
:root{--bg:#02060d;--pn:rgba(7,16,28,.86);--bd:rgba(80,200,255,.18);--tx:#d6ecf8;--dim:#7f9db3;--ac:#2ee6a6;--cy:#4cc9f0}
*{box-sizing:border-box}
html,body{margin:0;height:100%;overflow:hidden;background:var(--bg);color:var(--tx);font:13px/1.45 "Segoe UI","Microsoft YaHei","PingFang SC",system-ui,sans-serif}
#c{position:fixed;inset:0;width:100%;height:100%;display:block;cursor:grab;touch-action:none}
#c.drag{cursor:grabbing}
.panel{position:fixed;background:var(--pn);border:1px solid var(--bd);border-radius:14px;backdrop-filter:blur(8px);padding:12px 14px;z-index:5}
button{font:inherit;color:var(--tx);background:#10243a;border:1px solid var(--bd);border-radius:9px;padding:6px 11px;cursor:pointer}
button:hover{background:#17314d}
button.pri{background:var(--ac);color:#02140d;border-color:var(--ac);font-weight:700}
button.pri:hover{filter:brightness(1.1)}
#hud{left:14px;top:14px;width:340px}
#hud h1{margin:0 0 6px;font-size:17px}
#hud h1 b{color:var(--ac)}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px}
.chip{border:1px solid var(--bd);border-radius:99px;padding:1px 10px;font-size:12px;color:var(--dim)}
.chip.ok{color:var(--ac);border-color:rgba(46,230,166,.5)}
.chip.bad{color:#ff6b81;border-color:rgba(255,77,109,.5)}
.chip.warn{color:#ffd23f;border-color:rgba(255,210,63,.5)}
.stats{display:flex;gap:16px}
.stats div{font-size:22px;font-weight:700;line-height:1.1}
.stats span{display:block;font-size:11px;font-weight:400;color:var(--dim)}
#gpu{margin-top:7px;font-size:11.5px;color:var(--dim)}
#ctl{left:14px;bottom:14px;width:370px;max-height:calc(100% - 230px);overflow:auto}
.row2{display:flex;align-items:center;gap:8px;margin:3px 0}
.row2 label{flex:0 0 112px;color:var(--dim)}
.row2 input[type=range]{flex:1}
.row2 output{width:44px;text-align:right;font-weight:600}
.checks{display:flex;flex-wrap:wrap;gap:4px 14px;margin:6px 0}
.checks label{cursor:pointer;white-space:nowrap}
.btns{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}
.hint{margin-top:7px;color:var(--dim);font-size:11.5px}
#side{right:14px;top:14px;bottom:14px;width:330px;display:flex;flex-direction:column;padding:10px}
#q{width:100%;background:#0a1626;border:1px solid var(--bd);border-radius:9px;color:var(--tx);padding:7px 10px;font:inherit;outline:0}
#list{flex:1;overflow:auto;margin-top:8px}
.item{display:flex;gap:8px;align-items:center;padding:6px 6px;border-radius:8px;cursor:pointer;border:1px solid transparent}
.item:hover{background:rgba(76,201,240,.08)}
.item.on{border-color:var(--cy);background:rgba(76,201,240,.12)}
.dot{width:10px;height:10px;border-radius:50%;flex:none}
.item .nm{flex:1;min-width:0}
.item .nm b{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:600}
.item .nm i{font-style:normal;color:var(--dim);font-size:11px}
.item .rs{text-align:right;font-variant-numeric:tabular-nums;font-size:12px}
.item .rs i{display:block;font-style:normal;color:var(--dim);font-size:11px}
#detail{border-top:1px solid var(--bd);margin-top:8px;padding-top:8px;font-size:12px;display:none}
#detail b{color:var(--cy)}
#legend{left:50%;bottom:14px;transform:translateX(-60%);display:flex;gap:14px;padding:7px 16px;font-size:12px;border-radius:99px;white-space:nowrap}
#legend i{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:5px}
#actbox{right:360px;bottom:14px;width:300px;padding:8px 12px}
#actbox .t{display:flex;justify-content:space-between;color:var(--dim);font-size:12px}
#actC{width:100%;height:44px;display:block}
#wait{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);width:min(560px,92vw);text-align:center;z-index:6;padding:22px 26px}
#wait h2{margin:10px 0 6px;font-size:19px}
#wait p{margin:4px 0;color:#a9c4d6}
#wait code{background:#0c1a2c;padding:1px 6px;border-radius:5px;color:var(--cy)}
.spin{width:44px;height:44px;margin:0 auto;border-radius:50%;border:3px solid #123;border-top-color:var(--ac);animation:sp 1s linear infinite}
@keyframes sp{to{transform:rotate(360deg)}}
.diag{text-align:left;margin:10px auto 4px;width:fit-content;font-size:12.5px;color:#a9c4d6}
.diag div{margin:2px 0}
#toast{position:fixed;left:50%;top:18px;transform:translateX(-50%);background:#0d2236;border:1px solid var(--cy);padding:8px 16px;border-radius:10px;z-index:20;display:none;max-width:80vw}
#err{position:fixed;inset:0;display:none;align-items:center;justify-content:center;background:#02060d;z-index:30;text-align:center}
@media(max-width:900px){#side{display:none}#actbox{right:14px}#hud{width:300px}#legend{display:none}}

#dgp{display:none;position:fixed;right:360px;top:14px;bottom:14px;width:min(560px,60vw);z-index:40;flex-direction:column;padding:10px}
#dgp h3{margin:0 0 6px;font-size:14px;display:flex;align-items:center;gap:6px}
#dgp h3 span{flex:1}
.dgsum{padding:6px 9px;border-radius:8px;font-size:12.5px;margin-bottom:6px;border:1px solid var(--bd);background:#0a1626;word-break:break-all}
.dgsum.ok{border-color:rgba(46,230,166,.5);color:var(--ac)}.dgsum.wait{color:var(--cy)}.dgsum.warn{border-color:rgba(255,210,63,.5);color:#ffd23f}.dgsum.bad{border-color:rgba(255,77,109,.6);color:#ff8fa0}
#dgChecks{max-height:34%;overflow:auto;font-size:12px}
.ck{padding:3px 6px;border-left:3px solid #345;margin:2px 0;background:rgba(255,255,255,.02)}
.ck b{display:block}.ck span{color:#b6cddc;word-break:break-all}.ck i{display:block;color:#ffd23f;font-style:normal;word-break:break-all}
.ck.ok{border-color:#2ee6a6}.ck.warn{border-color:#ffd23f}.ck.bad{border-color:#ff4d6d}.ck.wait{border-color:#4cc9f0}
#dgLog{flex:1;overflow:auto;margin-top:6px;background:#050b14;border-radius:8px;padding:6px;font:11px/1.45 Consolas,Menlo,monospace}
#dgLog .l{white-space:pre-wrap;word-break:break-all}#dgLog u{text-decoration:none;color:#58708a}#dgLog em{font-style:normal;color:#4cc9f0}
#dgLog .ERR{color:#ff8fa0}#dgLog .WARN{color:#ffd23f}#dgLog .OK{color:#2ee6a6}#dgLog .INFO{color:#b6cddc}
@media(max-width:900px){#dgp{right:14px;width:calc(100% - 28px)}}
</style>
</head>
<body>
<canvas id="c"></canvas>

<div id="hud" class="panel">
  <h1>📡 WiFi <b>RADAR</b> · 3D 真实世界</h1>
  <div class="chips"><span class="chip" id="chConn">等待 ESP32</span><span class="chip" id="chNode">—</span><span class="chip" id="chSrv">服务器检测中</span></div>
  <div class="stats">
    <div id="nAP">0<span>热点 AP</span></div>
    <div id="nST">0<span>周围设备</span></div>
    <div id="nND">0<span>节点</span></div>
    <div id="nAct">0%<span>环境扰动</span></div>
  </div>
  <div id="gpu">GPU: 检测中…</div>
</div>

<div id="ctl" class="panel">
  <div class="row2"><label>路径损耗指数 n</label><input id="sN" type="range" min="1.6" max="4.5" step="0.05"><output id="oN"></output></div>
  <div class="row2"><label>1 米参考功率 dBm</label><input id="sT" type="range" min="-70" max="-20" step="1"><output id="oT"></output></div>
  <div class="checks">
    <label><input type="checkbox" id="cLab"> 标签</label>
    <label><input type="checkbox" id="cSwp"> 扫描波</label>
    <label><input type="checkbox" id="cSta"> 设备</label>
    <label><input type="checkbox" id="cBld"> 街区底图</label>
    <label><input type="checkbox" id="cHeat"> 信号热力</label>
    <label><input type="checkbox" id="cRot"> 自动旋转</label>
  </div>
  <div class="btns">
    <button id="bSerial" class="pri">🔌 USB 连接 ESP32</button>
    <button id="bRst">🔁 复位 ESP32</button>
    <button id="bDiag">🩺 检测日志</button>
    <button id="bGeo">🌍 定位真实世界</button>
    <button id="bReset">复位视角 (R)</button>
    <button id="bFS">全屏 (F)</button>
    <button id="bClr">清除手动方位</button>
    <button id="bDemo2">演示数据</button>
  </div>
  <div class="btns" id="nudge" style="display:none"><span style="color:var(--dim)">底图对齐：</span><button data-d="-1,0">◀</button><button data-d="1,0">▶</button><button data-d="0,1">▲</button><button data-d="0,-1">▼</button></div>
  <div class="hint">左键旋转 · 右键平移 · 滚轮缩放 · 点击 AP 看详情 · Shift+拖动 AP 校准方位 · R 复位 · F 全屏 · L 标签</div>
</div>

<div id="legend" class="panel">
  <span><i style="background:#ff4d6d"></i>开放</span><span><i style="background:#ff9f1c"></i>WEP</span><span><i style="background:#ffd23f"></i>WPA</span><span><i style="background:#2ee6a6"></i>WPA2/3</span><span><i style="background:#4cc9f0"></i>企业</span><span><i style="background:#ff5dd0"></i>设备</span>
</div>

<div id="actbox" class="panel"><div class="t"><span>环境扰动 (RSSI 波动)</span><span id="actV">0%</span></div><canvas id="actC" width="300" height="44"></canvas></div>

<div id="side" class="panel">
  <input id="q" placeholder="搜索 SSID / BSSID …">
  <div id="list"><div style="color:var(--dim);padding:10px">暂无数据</div></div>
  <div id="detail"></div>
</div>

<div id="wait" class="panel">
  <div class="spin"></div>
  <h2 id="wT">等待 ESP32 上传数据…</h2>
  <p id="wM">按一下 ESP32 的 <code>RESET</code> 键。网页已用 <b>自带 3D 引擎</b> 渲染（不依赖任何 CDN）。</p>
  <div class="diag" id="diag"></div>
  <div class="btns" style="justify-content:center"><button class="pri" id="bSerial2">🔌 USB 直连 ESP32（最稳）</button><button id="bDemo">▶ 启动演示数据</button><button id="bRst2">🔁 复位 ESP32</button><button id="bDiag2">🩺 检测日志</button></div>
</div>
<div id="dgp" class="panel">
  <h3><span>🩺 全能检测系统 · 实时日志</span><button id="dgCopy" class="pri">📋 复制日志</button><button id="dgDl">⬇ 下载</button><button id="dgClr">清空</button><button id="dgX">✕</button></h3>
  <div id="dgSum" class="dgsum">检测中…</div>
  <div id="dgChecks"></div>
  <div id="dgLog"></div>
</div>
<div id="toast"></div>
<div id="err"><div><h2>⚠ 浏览器不支持 Canvas</h2><p id="errMsg"></p></div></div>

<script>
(function () {
'use strict';
var Q = new URLSearchParams(location.search);
var SIM = Q.get('sim') === '1';
var $ = function (id) { return document.getElementById(id); };
var clamp = function (v, a, b) { return Math.max(a, Math.min(b, v)); };
var esc = function (s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
var now = function () { return Date.now() / 1000; };
function lsGet(k, d) { try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } }
function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }

/* ================= 全能检测系统 (DIAG) ================= */
var DG = {
  log: [], seq: 0, t0: Date.now(), pending: [], lastKey: {},
  ser: { supported: ('serial' in navigator), open: false, bytes: 0, lines: 0, badChars: 0, jsonOK: 0, jsonBad: 0, hb: 0, other: 0, hello: null, helloAt: 0, hbInfo: null, hbAt: 0,
    lastLine: '', lastRaw: '', firstAt: 0, openedAt: 0, lastJsonAt: 0, resets: 0, vid: 0, pid: 0, chip: '', mode: '', rstReason: '', lastErr: '', dtrOn: false, reconnects: 0, lastApCount: -1 },
  srv: { ok: null, ms: null, err: '', info: null, at: 0, diag: null, diagAt: 0, postOK: 0, postFail: 0, lastPost: '', pollErr: '', pollOK: 0 },
  r: { fps: 0, err: 0, lastErr: '', last: 0, n: 0 }
};
var INFRAME = (function () { try { return window.parent !== window; } catch (e) { return true; } })();
function safeJson(x) { try { return typeof x === 'string' ? x : JSON.stringify(x); } catch (e) { return String(x); } }
function p2(n) { return (n < 10 ? '0' : '') + n; }
function fmtT(t) { var d = new Date(t); return p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds()) + '.' + ('00' + d.getMilliseconds()).slice(-3); }
function dlog(lv, cat, msg, x) {
  var e = { n: ++DG.seq, t: Date.now(), lv: lv, c: cat, m: String(msg) + (x !== undefined ? ' ' + safeJson(x) : '') };
  DG.log.push(e); if (DG.log.length > 1500) DG.log.shift();
  DG.pending.push(e); if (DG.pending.length > 400) DG.pending.shift();
  try { if (INFRAME) window.parent.postMessage({ type: 'wradar-log', e: e }, '*'); } catch (err) {}
  try { if (lv === 'ERR' && window.console) console.error('[radar]', cat, e.m); } catch (err2) {}
  return e;
}
function dlogRate(key, ms, lv, cat, msg, x) { var t = Date.now(); if (DG.lastKey[key] && t - DG.lastKey[key] < ms) return; DG.lastKey[key] = t; dlog(lv, cat, msg, x); }
window.addEventListener('error', function (e) { dlogRate('jserr' + (e.message || ''), 3000, 'ERR', 'js', (e.message || 'error') + ' @' + String(e.filename || '').split('/').pop() + ':' + e.lineno); });
window.addEventListener('unhandledrejection', function (e) { dlogRate('rej', 3000, 'ERR', 'js', '未处理的 Promise 错误：' + (e.reason && e.reason.message || e.reason)); });
setInterval(function () {      // 浏览器日志同步到服务器（Kaggle 输出里也能看到）
  if (SIM || !DG.pending.length) return;
  var batch = DG.pending.splice(0, 80);
  fetch('api/clientlog', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ page: String(location.href).slice(0, 140), entries: batch.map(function (e) { return { t: e.t, lv: e.lv, c: e.c, m: e.m }; }) }) })
    .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); })
    .catch(function () { DG.pending = batch.concat(DG.pending).slice(-300); });
}, 3000);

function envInfo() {
  var gl = 'WebGL✗'; try { var c0 = document.createElement('canvas'); if (c0.getContext('webgl') || c0.getContext('experimental-webgl')) gl = 'WebGL✓'; } catch (e) {}
  var pol = ''; try { var fp = document.featurePolicy || document.permissionsPolicy; if (fp && fp.allowsFeature) pol = fp.allowsFeature('serial') ? 'serial 权限=允许' : 'serial 权限=被禁止'; } catch (e2) {}
  return { ua: navigator.userAgent, secure: !!window.isSecureContext, serial: 'serial' in navigator, iframe: INFRAME, gl: gl, policy: pol, screen: (window.innerWidth || 0) + 'x' + (window.innerHeight || 0) + '@' + (window.devicePixelRatio || 1), url: String(location.href).slice(0, 160), lang: navigator.language };
}
var WLST = { 0: '空闲', 1: '找不到SSID', 3: '已连接', 4: '连接失败', 5: '连接丢失', 6: '已断开' };
function diagChecks() {
  var tn = Date.now(), C = [], s = DG.ser, v = DG.srv, env = envInfo();
  function add(id, name, st, msg, hint) { C.push({ id: id, name: name, st: st, msg: msg, hint: hint || '' }); }
  // 1 浏览器
  if (!g) add('env', '浏览器/页面', 'bad', 'Canvas 2D 不可用');
  else if (!env.secure && location.hostname !== 'localhost' && !SIM) add('env', '浏览器/页面', 'warn', '非 https 页面，Web Serial 会被浏览器禁用（' + env.screen + '）', '请用 Kaggle 给出的 https://….trycloudflare.com 网址打开');
  else add('env', '浏览器/页面', 'ok', (INFRAME ? '内嵌页(iframe) · ' : '独立页 · ') + env.gl + ' · ' + env.screen + (env.policy ? ' · ' + env.policy : ''));
  // 2 渲染
  var since = (tn - DG.r.last) / 1000;
  if (DG.r.err > 0 && since < 3) add('render', '3D 渲染引擎', 'warn', '运行中 ' + DG.r.fps + ' FPS，但出现过 ' + DG.r.err + ' 次绘制异常（已自动恢复）：' + DG.r.lastErr);
  else if (DG.r.last && since < 3) add('render', '3D 渲染引擎', 'ok', DG.r.fps + ' FPS · 相机 ' + Math.round(cam.dist) + ' m');
  else add('render', '3D 渲染引擎', DG.r.n > 0 ? 'bad' : 'wait', DG.r.n > 0 ? '渲染停滞 ' + since.toFixed(0) + ' 秒（标签页在后台时属正常）' : '启动中…');
  // 3 服务器
  if (SIM) add('srv', '后端服务器', 'ok', '浏览器模拟器模式（无需后端）');
  else if (v.ok === null) add('srv', '后端服务器', 'wait', '检测中…');
  else if (v.ok) add('srv', '后端服务器', 'ok', '/api/health 正常 ' + (v.ms != null ? v.ms + 'ms' : '') + (v.info ? ' · 已收 ' + (v.info.frames || 0) + ' 帧 · 运行 ' + (v.info.uptime || 0) + 's' : ''));
  else add('srv', '后端服务器', 'bad', '/api/health 无响应：' + v.err, '确认 Kaggle 的 Cell 还在运行；网址是否是最新一次运行输出的');
  // 4 USB 串口
  var serMsg;
  if (SIM) add('ser', 'USB 串口', 'ok', '模拟器：虚拟串口');
  else if (!s.supported) add('ser', 'USB 串口', 'warn', '此浏览器没有 Web Serial', '请用电脑版 Chrome / Edge；或改用 ESP32 自己联网上传(WiFi)');
  else if (!s.open) add('ser', 'USB 串口', 'wait', '未连接' + (s.lastErr ? '（上次错误：' + s.lastErr + '）' : '') + (jsonCount() > 0 ? '' : ' → 点「🔌 USB 连接 ESP32」，选择板子的串口'));
  else {
    var age = (tn - s.openedAt) / 1000;
    if (s.bytes === 0) add('ser', 'USB 串口', age < 3.5 ? 'wait' : 'bad', '已打开 ' + age.toFixed(0) + ' 秒，收到 0 字节', '① 换板子上另一个 USB 口再连一次（USB 口/UART 口各试一次）② 关闭 PlatformIO 串口监视器等占用程序 ③ 确认烧录的是本项目新版固件，烧录后按 RESET ④ 换一根能传数据的 USB 线');
    else if (s.mode === 'download') add('ser', 'USB 串口', 'bad', 'ESP32 停在下载模式（ROM 提示 waiting for download）', '松开 BOOT 键，按一下 RESET；或点「🔁 复位 ESP32」');
    else if (s.hb + s.jsonOK === 0 && !s.hello && s.badChars > s.bytes * 0.3) add('ser', 'USB 串口', 'bad', '收到 ' + s.bytes + ' 字节但大多是乱码', '端口/波特率不对：换另一个口；固件 monitor_speed 与 SERIAL_BAUD 都应为 115200');
    else if (s.jsonOK > 0) {
      var st = (tn - s.lastJsonAt) / 1000;
      if (st > 10) add('ser', 'USB 串口', 'bad', '数据中断 ' + st.toFixed(0) + ' 秒（已收 ' + s.jsonOK + ' 帧）', '检查 USB 线/供电；固件是否重启（见下方“ESP32 固件”）');
      else add('ser', 'USB 串口', s.jsonBad > s.jsonOK * 0.2 ? 'warn' : 'ok', '已收 ' + s.jsonOK + ' 帧 · ' + s.bytes + ' 字节' + (s.jsonBad ? ' · 解析失败 ' + s.jsonBad : ''));
    } else if (s.hb > 0 || s.hello) {
      var hs = s.hbInfo ? s.hbInfo.st : '?';
      add('ser', 'USB 串口', age > 12 ? 'bad' : 'wait', '固件在线（状态 ' + hs + '），等待第一轮扫描结果' + (age > 12 ? ' —— 已超过 12 秒' : ''), age > 12 ? '固件卡在 “' + hs + '”：scan=扫描异常；sniff=嗅探；wifi=连 WiFi（可把 config.h 的 WIFI_SSID 留空）' : '');
    } else add('ser', 'USB 串口', 'bad', '收到 ' + s.bytes + ' 字节，但没有 RADAR 协议行', '多半烧录的是旧版/别的固件：用 PlatformIO 重新 Upload 本项目 firmware，再按 RESET。最近一行：' + (s.lastLine || s.lastRaw || '(无)'));
  }
  // 5 固件
  if (SIM) add('fw', 'ESP32 固件', 'ok', '虚拟 ESP32-S3');
  else if (s.hello || s.hbInfo) {
    var h = s.hello || {}, b = s.hbInfo || {}, rst = h.rst || s.rstReason || '?', bad = /PANIC|WDT|BROWNOUT/.test(rst);
    var low = b.heap && b.heap < 40000;
    add('fw', 'ESP32 固件', bad || low ? 'warn' : 'ok', 'v' + (h.fw || b.fw || '?') + ' · ' + (b.node || h.node || '') + ' · ' + (h.chip || 'ESP32') + (h.rev != null ? ' r' + h.rev : '') + ' · 复位原因 ' + rst + ' · 运行 ' + (b.up != null ? b.up : '?') + 's · 状态 ' + (b.st || '?') + ' · 空闲堆 ' + (b.heap || '?') + ' · 输出口 USB=' + (h.usb ? '✓' : '✗') + ' UART=' + (h.mirror ? '✓' : '✗'),
      bad ? '芯片异常重启（' + rst + '）：检查供电/USB 线；BROWNOUT=供电不足' : '');
  } else if (s.open && s.bytes > 0 && s.jsonOK > 0) add('fw', 'ESP32 固件', 'warn', '旧版固件（无 HELLO/心跳），数据可用', '建议用 PlatformIO 重新 Upload 新版固件，获得完整诊断')
  else if (s.open && s.bytes > 0) add('fw', 'ESP32 固件', 'bad', '未识别到本项目新版固件', '用 PlatformIO 重新 Upload');
  else add('fw', 'ESP32 固件', 'wait', '尚未收到固件信息');
  // 6 ESP32 WiFi 上传
  var nodes = SERVER && SERVER.nodes ? SERVER.nodes : null, b2 = s.hbInfo || {}, h2 = s.hello || {};
  if (SIM) add('wifi', 'ESP32 WiFi 上传', 'ok', '模拟器：模拟上传 HTTP 200');
  else if (nodes && Object.keys(nodes).length) {
    var pick = Object.keys(nodes).filter(function (k) { return nodes[k].ip; }), txt = Object.keys(nodes).map(function (k) { return k + ' 来自 ' + (nodes[k].ip || '?') + ' ' + nodes[k].age + 's 前(' + nodes[k].frames + '帧)'; }).join('；');
    add('wifi', 'ESP32 WiFi 上传', 'ok', '服务器已收到：' + txt);
  } else if (h2.ssid === '' && s.hello) add('wifi', 'ESP32 WiFi 上传', 'ok', '固件未配置 WiFi：仅 USB 直连模式（正常，无需联网）');
  else if (s.hello && (b2.ok || 0) > 0) add('wifi', 'ESP32 WiFi 上传', 'ok', '固件上传成功 ' + b2.ok + ' 次');
  else if (s.hello && (b2.fail || 0) > 0) add('wifi', 'ESP32 WiFi 上传', 'warn', '固件上传失败 ' + b2.fail + ' 次，最近 HTTP ' + b2.http + ' · WiFi ' + (WLST[b2.wifi] || b2.wifi), 'HTTP -1=网址错/Cell 已停/ESP32 没联网；401=API_KEY 不一致；WiFi 必须是 2.4GHz');
  else if (s.hello && h2.ssid) add('wifi', 'ESP32 WiFi 上传', 'wait', '固件已配置 WiFi「' + h2.ssid + '」：' + (WLST[b2.wifi] || b2.wifi) + '（不影响 USB 直连）');
  else add('wifi', 'ESP32 WiFi 上传', 'wait', '服务器尚无 ESP32 节点（USB 直连模式可忽略）');
  // 7 页面转发到服务器
  if (!SIM && jsonCount() > 0) add('relay', 'USB → 服务器转发', v.postFail > 0 && v.postOK === 0 ? 'warn' : 'ok', '成功 ' + v.postOK + ' · 失败 ' + v.postFail + (v.lastPost ? ' · 最近 ' + v.lastPost : ''), v.postFail > 0 && v.postOK === 0 ? '本地 3D 不受影响；多节点三边定位/GPU 需要服务器收到数据' : '');
  // 8 数据
  var nl = 0; APS.forEach(function (a) { if (a.live) nl++; });
  if (frameCount === 0) add('data', '扫描数据', 'wait', '还没有任何数据帧');
  else { var fa = (tn / 1000 - lastFrameAt); add('data', '扫描数据', fa > 10 ? 'bad' : (nl === 0 ? 'warn' : 'ok'), '共 ' + frameCount + ' 帧 · 实时 AP ' + nl + ' · 设备 ' + STAS.size + ' · 最近一帧 ' + fa.toFixed(1) + 's 前' + (mode === 'demo' ? ' · (演示数据)' : ''), nl === 0 ? 'ESP32 扫到 0 个 AP：天线/位置/扫描是否异常' : ''); }
  // 9 GPU
  if (SIM) add('gpu', 'Kaggle GPU', 'wait', '模拟器无 GPU');
  else if (SERVER) add('gpu', 'Kaggle GPU', SERVER.gpu && SERVER.gpu.length ? 'ok' : 'warn', (SERVER.gpu && SERVER.gpu.length ? SERVER.gpu.join(' + ') : '无 GPU（CPU 模式）') + (SERVER.res ? ' · ' + SERVER.res : ''), SERVER.gpu && SERVER.gpu.length ? '' : 'Kaggle: Settings → Accelerator 选 GPU T4 x2');
  else add('gpu', 'Kaggle GPU', 'wait', '等待服务器状态');
  var rank = { ok: 0, wait: 1, warn: 2, bad: 3 }, lv = 'ok', first = null;
  C.forEach(function (c) { if (rank[c.st] > rank[lv]) lv = c.st; if (!first && c.st === 'bad') first = c; });
  if (!first) C.forEach(function (c) { if (!first && c.st === 'warn') first = c; });
  if (!first) C.forEach(function (c) { if (!first && c.st === 'wait' && c.id !== 'gpu' && c.id !== 'wifi') first = c; });
  // GPU 提示不影响“数据链路是否正常”的总体结论
  var gpuC = C.filter(function (c) { return c.id === 'gpu'; })[0];
  lv = 'ok'; C.forEach(function (c) { if (c.id === 'gpu' && c.st !== 'bad') return; if (c.id === 'wifi' && c.st === 'wait') return; if (rank[c.st] > rank[lv]) lv = c.st; });
  if (first && first.id === 'gpu') first = null;
  var summary = first ? first.name + '：' + first.msg : '数据链路全部正常' + (gpuC && gpuC.st === 'warn' ? '（提示：' + gpuC.msg.split(' · ')[0] + '）' : '');
  return { checks: C, level: lv, summary: summary, advice: first ? first.hint : (gpuC && gpuC.st === 'warn' ? gpuC.hint : '') };
}
function jsonCount() { return DG.ser.jsonOK; }
function buildReport() {
  var d = diagChecks(), env = envInfo(), s = DG.ser, L = [], ic = { ok: '[OK]  ', wait: '[WAIT]', warn: '[WARN]', bad: '[BAD] ' };
  L.push('===== WiFi RADAR 检测日志 =====');
  L.push('生成时间: ' + new Date().toISOString() + '  页面运行: ' + Math.round((Date.now() - DG.t0) / 1000) + 's');
  L.push('页面: ' + env.url);
  L.push('浏览器: ' + env.ua);
  L.push('环境: secure=' + env.secure + ' webSerial=' + env.serial + ' iframe=' + env.iframe + ' ' + env.gl + ' ' + env.screen + ' ' + env.policy);
  L.push('总体: ' + d.level.toUpperCase() + ' —— ' + d.summary + (d.advice ? '\n建议: ' + d.advice : ''));
  L.push('');
  L.push('--- 检测项 ---');
  d.checks.forEach(function (c) { L.push(ic[c.st] + ' ' + c.name + ' : ' + c.msg + (c.hint && c.st !== 'ok' ? '\n         ↳ ' + c.hint : '')); });
  L.push('');
  L.push('--- 串口统计 ---');
  L.push('open=' + s.open + ' bytes=' + s.bytes + ' lines=' + s.lines + ' badChars=' + s.badChars + ' jsonOK=' + s.jsonOK + ' jsonBad=' + s.jsonBad + ' hb=' + s.hb + ' other=' + s.other + ' resets=' + s.resets + ' reconnects=' + s.reconnects + ' dtr=' + s.dtrOn + ' mode=' + (s.mode || '-'));
  L.push('端口: ' + (s.chip || '-') + ' vid=0x' + (s.vid || 0).toString(16) + ' pid=0x' + (s.pid || 0).toString(16));
  L.push('最近一行: ' + (s.lastLine || '-'));
  L.push('最近原始: ' + (s.lastRaw || '-'));
  if (s.hello) L.push('HELLO: ' + safeJson(s.hello));
  if (s.hbInfo) L.push('HB: ' + safeJson(s.hbInfo));
  L.push('');
  L.push('--- 服务器 ---');
  L.push('health=' + safeJson({ ok: DG.srv.ok, ms: DG.srv.ms, err: DG.srv.err, info: DG.srv.info }));
  L.push('转发: ok=' + DG.srv.postOK + ' fail=' + DG.srv.postFail + ' last=' + DG.srv.lastPost + ' poll=' + (DG.srv.pollErr || 'ok'));
  if (SERVER) L.push('status=' + safeJson(SERVER));
  if (DG.srv.diag) L.push('server-diag=' + safeJson(DG.srv.diag).slice(0, 3000));
  L.push('');
  L.push('--- 最近事件 (最多 220 条) ---');
  DG.log.slice(-220).forEach(function (e) { L.push(fmtT(e.t) + ' ' + e.lv + ' [' + e.c + '] ' + e.m); });
  return L.join('\n');
}
function copyTextPlain(text) {
  function fb() { try { var ta = document.createElement('textarea'); ta.value = text; ta.style.cssText = 'position:fixed;opacity:0'; document.body.appendChild(ta); ta.select(); var ok = document.execCommand('copy'); ta.remove(); return ok; } catch (e) { return false; } }
  if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text).then(function () { return true; }, function () { return fb(); });
  return Promise.resolve(fb());
}
function downloadText(name, text) { var a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' })); a.download = name; document.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500); }
var ICN = { ok: '✅', wait: '⏳', warn: '⚠️', bad: '❌' };
function renderChecksHtml(d) { return d.checks.map(function (c) { return '<div class="ck ' + c.st + '"><b>' + ICN[c.st] + ' ' + esc(c.name) + '</b><span>' + esc(c.msg) + '</span>' + (c.hint && c.st !== 'ok' ? '<i>↳ ' + esc(c.hint) + '</i>' : '') + '</div>'; }).join(''); }
function renderDiagPanel() {
  var d = diagChecks();
  $('dgSum').className = 'dgsum ' + d.level; $('dgSum').textContent = ICN[d.level] + ' ' + d.summary + (d.advice ? '  ↳ ' + d.advice : '');
  $('dgChecks').innerHTML = renderChecksHtml(d);
  var box = $('dgLog'), stick = box.scrollTop + box.clientHeight >= box.scrollHeight - 30;
  box.innerHTML = DG.log.slice(-160).map(function (e) { return '<div class="l ' + e.lv + '"><u>' + fmtT(e.t) + '</u> <em>' + esc(e.c) + '</em> ' + esc(e.m) + '</div>'; }).join('');
  if (stick) box.scrollTop = box.scrollHeight;
}
var dgOpen = false;
function toggleDiag(v) { dgOpen = v === undefined ? !dgOpen : v; $('dgp').style.display = dgOpen ? 'flex' : 'none'; if (dgOpen) renderDiagPanel(); }
setInterval(function () { if (dgOpen) renderDiagPanel(); }, 1000);
setInterval(function () {      // 每 2 秒把检测结果发给外层“浏览器模拟器”，由它显示在右上角
  if (!INFRAME) return;
  var d = diagChecks();
  try { window.parent.postMessage({ type: 'wradar-diag', level: d.level, summary: d.summary, advice: d.advice, checks: d.checks, report: buildReport(), frames: frameCount, aps: APS.size }, '*'); } catch (e) {}
}, 2000);
window.addEventListener('message', function (ev) {
  var m = ev.data; if (!m || m.type !== 'wradar-cmd') return;
  if (m.cmd === 'serialConnect') serialConnect(false); else if (m.cmd === 'serialReset') serialReset('外层面板'); else if (m.cmd === 'demo') startDemo();
});
dlog('INFO', 'page', '页面启动', envInfo());

/* ================= 设置 ================= */
var S = Object.assign({ n: 2.8, tx: -40, labels: true, sweep: true, stations: true, buildings: true, heat: true, rotate: false }, lsGet('wradar2.settings', {}));
var OVR = lsGet('wradar2.bearing', {});
function saveS() { lsSet('wradar2.settings', S); }

/* ================= 数据模型 ================= */
var NODES = new Map(), APS = new Map(), STAS = new Map(), SEEN = new Map();
var SOLVED = {}, SERVER = null, lastFrameAt = 0, frameCount = 0, mode = SIM ? 'sim' : 'live';
var GEO = null, GEOFF = { x: 0, y: 0 }, DEMO_WORLD = null, serialOn = false, lastSerial = '', srvOK = null, srvErr = '';
var selected = null;

function Kalman(z) { this.x = z; this.p = 4; }
Kalman.prototype.update = function (z) { this.p += 0.35; var k = this.p / (this.p + 5); this.x += k * (z - this.x); this.p *= 1 - k; return this.x; };
function rssiToDist(rssi, ch) { return clamp(Math.pow(10, ((S.tx - (ch > 14 ? 7 : 0)) - rssi) / (10 * S.n)), 0.5, 150); }
function fnv(str) { var h = 2166136261; for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0) / 4294967296; }
function groupKey(b) { var p = b.split(':'); p[0] = (parseInt(p[0], 16) & 0xfd).toString(16); return p.slice(0, 5).join(':'); }
function hashAngle(b) { return fnv(groupKey(b)) * Math.PI * 2 + (parseInt(b.slice(-2), 16) / 255 - 0.5) * 0.16; }
var AUTH = { 0: ['开放', '#ff4d6d'], 1: ['WEP', '#ff9f1c'], 2: ['WPA', '#ffd23f'], 3: ['WPA2', '#2ee6a6'], 4: ['WPA/WPA2', '#2ee6a6'], 5: ['WPA2 企业', '#4cc9f0'], 6: ['WPA3', '#2ee6a6'], 7: ['WPA2/WPA3', '#2ee6a6'], 8: ['WAPI', '#4cc9f0'], 9: ['OWE', '#2ee6a6'], 10: ['WPA3 企业', '#4cc9f0'] };
function authInfo(a) { return AUTH[a] || ['未知', '#99aabb']; }

function ingest(f, src) {
  try { ingest2(f, src); } catch (e) { dlogRate('ingest', 2000, 'ERR', 'data', '处理数据帧出错：' + e.message + ' @' + String((e.stack || '').split('\n')[1] || '').trim()); }
}
function ingest2(f, src) {
  if (!f || !Array.isArray(f.aps)) return;
  var t = now(), id = f.node || 'node';
  if (src === 'poll' && typeof f.age === 'number' && f.age > 20) return;   // 服务器缓存的旧帧不当作实时数据
  if (src === 'poll' && f.seq != null) { var k = id + ':' + f.seq; if (SEEN.has(k) && t - SEEN.get(k) < 60) return; }
  if (src === 'usb' && f.seq != null) SEEN.set(id + ':' + f.seq, t);
  if (SEEN.size > 800) { SEEN.forEach(function (v, k2) { if (t - v > 60) SEEN.delete(k2); }); }
  var nd = NODES.get(id);
  if (!nd) { nd = { id: id, x: 0, y: 0, frames: 0 }; NODES.set(id, nd); dlog('INFO', 'data', '新节点：' + id + '（来源 ' + (src || 'wifi') + '）'); }
  nd.x = +f.x || 0; nd.y = +f.y || 0; nd.last = t; nd.fw = f.fw; nd.frames++; nd.src = src || 'wifi';
  var good = 0;
  f.aps.forEach(function (a) {
    if (!a || !a.b) return;
    var r = +a.r; if (!isFinite(r)) return;
    a.r = r; a.c = +a.c || 0; a.a = +a.a || 0;
    var b = String(a.b).toUpperCase(), ap = APS.get(b);
    if (!ap) { ap = { bssid: b, ssid: '', obs: new Map(), pulse: 0, hit: 0, first: t, live: false }; APS.set(b, ap); }
    if (a.s) ap.ssid = a.s;
    ap.ch = a.c; ap.auth = a.a; ap.last = t;
    if (typeof a.ang === 'number') ap.fixedAngle = a.ang;
    var o = ap.obs.get(id);
    if (!o) { o = { k: new Kalman(r), raw: [], last: 0 }; ap.obs.set(id, o); }
    o.raw.push(r); if (o.raw.length > 16) o.raw.shift();
    o.rssi = o.k.update(r); o.last = t; o.lastRaw = r;
    ap.pulse = 1; good++;
  });
  if (!good && frameCount < 3) dlogRate('zeroap', 5000, 'WARN', 'data', '这一帧没有可用 AP（ESP32 扫描到 0 个热点' + (f.err ? '，错误码 ' + f.err : '') + '）');
  if (Array.isArray(f.st)) {
    f.st.forEach(function (s2) {
      if (!s2 || !s2.m) return;
      var m = String(s2.m).toUpperCase(), st = STAS.get(m);
      if (!st) { st = { mac: m, rssi: +s2.r || -80, first: t }; STAS.set(m, st); }
      st.rssi = st.rssi * 0.5 + (+s2.r || -80) * 0.5; st.ch = s2.c; st.cnt = s2.n; st.bssid = s2.b ? String(s2.b).toUpperCase() : st.bssid; st.last = t; st.node = id;
    });
  }
  lastFrameAt = t; frameCount++; heatDirty = true;
  if (frameCount === 1) dlog('OK', 'data', '🎉 3D 世界已收到第一帧：AP ' + good + ' 个，来源 ' + (src || 'wifi'));
  $('wait').style.display = 'none';
}

function recompute(ap, t) {
  var best = null;
  ap.obs.forEach(function (o, nid) { if (t - o.last > 25) return; if (!best || o.rssi > best.o.rssi) best = { nid: nid, o: o }; });
  if (!best) { ap.live = false; return; }
  ap.live = true; ap.rssi = best.o.rssi; ap.node = NODES.get(best.nid) || { x: 0, y: 0 };
  ap.dist = rssiToDist(ap.rssi, ap.ch);
  var r = best.o.raw;
  if (r.length >= 5) { var m = r.reduce(function (a, b) { return a + b; }, 0) / r.length; ap.sigma = Math.sqrt(r.reduce(function (a, b) { return a + (b - m) * (b - m); }, 0) / r.length); } else ap.sigma = 0;
  var sol = SOLVED[ap.bssid];
  if (sol) { ap.tx = sol.x; ap.ty = sol.y; ap.src = '多节点三边定位(GPU)'; ap.ang = Math.atan2(sol.y - ap.node.y, sol.x - ap.node.x); }
  else {
    var ang, src;
    if (OVR[ap.bssid] != null) { ang = OVR[ap.bssid]; src = '手动校准'; }
    else if (ap.fixedAngle != null) { ang = ap.fixedAngle; src = '外部给定'; }
    else { ang = hashAngle(ap.bssid); src = '方位未知(估计)'; }
    ap.ang = ang; ap.src = src;
    ap.tx = ap.node.x + ap.dist * Math.cos(ang); ap.ty = ap.node.y + ap.dist * Math.sin(ang);
  }
  ap.h = clamp((ap.rssi + 100) * 0.5, 1.5, 30);
}

/* ---- 环境扰动指数 ---- */
var actShort = 0, actBase = null, act = 0, srvMotion = null, actT0 = 0; var actHist = [];
setInterval(function () {
  var v = []; APS.forEach(function (ap) { if (ap.live && ap.rssi > -85 && ap.sigma > 0) v.push(ap.sigma); });
  if (v.length < 2) { act *= 0.9; } else {
    var m = v.reduce(function (a, b) { return a + b; }, 0) / v.length;
    actShort = actShort ? actShort * 0.6 + m * 0.4 : m;
    actBase = actBase == null ? actShort : actBase + (actShort > actBase ? 0.004 : 0.06) * (actShort - actBase);
    if (!actT0) actT0 = now();
    if (now() - actT0 < 20) { actBase = actShort; act = 0; }   // 预热期：先建立基线，避免误报
    else act = clamp((actShort - actBase) / 1.6, 0, 1);
  }
  var shown = srvMotion != null ? Math.max(act, srvMotion) : act;
  actHist.push(shown); if (actHist.length > 120) actHist.shift();
  var p = Math.round(shown * 100) + '%'; $('actV').textContent = p; $('nAct').firstChild.nodeValue = p;
  drawAct(shown);
}, 500);
function drawAct(cur) {
  var c = $('actC'), g2 = c.getContext('2d'); g2.clearRect(0, 0, c.width, c.height);
  g2.strokeStyle = 'rgba(80,200,255,.15)'; g2.beginPath(); g2.moveTo(0, c.height - 1); g2.lineTo(c.width, c.height - 1); g2.stroke();
  g2.beginPath(); actHist.forEach(function (a, i) { var x = (i / 119) * c.width, y = c.height - 4 - a * (c.height - 10); if (i) g2.lineTo(x, y); else g2.moveTo(x, y); });
  g2.strokeStyle = cur > 0.5 ? '#ff4d6d' : '#2ee6a6'; g2.lineWidth = 2; g2.stroke();
}

/* ================= 自研 3D 引擎 (Canvas 2D, 零依赖) ================= */
var cv = $('c'), g = cv.getContext('2d');
if (!g) { $('err').style.display = 'flex'; $('errMsg').textContent = '无法创建 2D 绘图上下文'; return; }
var W = 0, H = 0, DPR = 1, F = 1, FOV = 58 * Math.PI / 180, NEAR = 0.4, dirty = true;
var HOME = { yaw: 0.55, pitch: 0.8, dist: 150, tx: 0, ty: 0, tz: 0 };
var cam = Object.assign({}, HOME), camGoal = null, B = {};
var RMAX = 150;
function resize() {
  DPR = Math.min(window.devicePixelRatio || 1, 2); W = window.innerWidth || 800; H = window.innerHeight || 600;
  cv.width = Math.round(W * DPR); cv.height = Math.round(H * DPR); F = (H / 2) / Math.tan(FOV / 2); dirty = true;
}
window.addEventListener('resize', resize); resize();
function setupCam() {
  var cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch), cy = Math.cos(cam.yaw), sy = Math.sin(cam.yaw);
  B.cx = cam.tx + cam.dist * cp * sy; B.cy = cam.ty - cam.dist * cp * cy; B.cz = cam.tz + cam.dist * sp;
  B.fx = -cp * sy; B.fy = cp * cy; B.fz = -sp; B.rx = cy; B.ry = sy; B.rz = 0;
  B.ux = -sy * sp; B.uy = cy * sp; B.uz = cp;
}
function V(x, y, z) {
  var dx = x - B.cx, dy = y - B.cy, dz = z - B.cz;
  return [dx * B.rx + dy * B.ry, dx * B.ux + dy * B.uy + dz * B.uz, dx * B.fx + dy * B.fy + dz * B.fz];
}
function SC(v) { return [W / 2 + F * v[0] / v[2], H / 2 - F * v[1] / v[2]]; }
function P(x, y, z) { var v = V(x, y, z); return v[2] < NEAR ? null : SC(v); }
function clipNear(vs) {
  var out = [];
  for (var i = 0; i < vs.length; i++) {
    var a = vs[i], b = vs[(i + 1) % vs.length], ia = a[2] >= NEAR, ib = b[2] >= NEAR;
    if (ia) out.push(a);
    if (ia !== ib) { var t = (NEAR - a[2]) / (b[2] - a[2]); out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, NEAR]); }
  }
  return out;
}
function polyScr(pts) { var vs = pts.map(function (p) { return V(p[0], p[1], p[2]); }); var c = vs.length > 2 ? clipNear(vs) : vs; return c.length < 3 ? null : c.map(SC); }
function fillPoly(pts, fill, stroke, lw) {
  var s = polyScr(pts); if (!s) return;
  g.beginPath(); g.moveTo(s[0][0], s[0][1]); for (var i = 1; i < s.length; i++) g.lineTo(s[i][0], s[i][1]); g.closePath();
  if (fill) { g.fillStyle = fill; g.fill(); }
  if (stroke) { g.strokeStyle = stroke; g.lineWidth = lw || 1; g.stroke(); }
}
function seg(ax, ay, az, bx, by, bz) {
  var a = V(ax, ay, az), b = V(bx, by, bz);
  if (a[2] < NEAR && b[2] < NEAR) return;
  if (a[2] < NEAR) { var t = (NEAR - a[2]) / (b[2] - a[2]); a = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, NEAR]; }
  else if (b[2] < NEAR) { var t2 = (NEAR - b[2]) / (a[2] - b[2]); b = [b[0] + (a[0] - b[0]) * t2, b[1] + (a[1] - b[1]) * t2, NEAR]; }
  var sa = SC(a), sb = SC(b); g.moveTo(sa[0], sa[1]); g.lineTo(sb[0], sb[1]);
}
function ring3(cx, cy, z, r, n, dash) {
  g.beginPath(); for (var i = 0; i < n; i++) { var a1 = i / n * 6.2832, a2 = (i + 1) / n * 6.2832; if (dash && i % 2) continue; seg(cx + Math.cos(a1) * r, cy + Math.sin(a1) * r, z, cx + Math.cos(a2) * r, cy + Math.sin(a2) * r, z); }
  g.stroke();
}
function rgba(hex, a) { var n = parseInt(hex.slice(1), 16); return 'rgba(' + (n >> 16) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')'; }

/* 标签：屏幕空间防重叠 */
var LB = [];
function label(x, y, text, color, sub, prio) {
  g.font = '12px "Microsoft YaHei","Segoe UI",sans-serif';
  var w = Math.max(g.measureText(text).width, sub ? g.measureText(sub).width : 0) + 12, h = sub ? 32 : 19;
  var bx = x - w / 2, by = y - h;
  if (!prio) { for (var i = 0; i < LB.length; i++) { var r = LB[i]; if (bx < r[0] + r[2] && bx + w > r[0] && by < r[1] + r[3] && by + h > r[1]) return; } }
  LB.push([bx, by, w, h]);
  g.fillStyle = 'rgba(4,12,22,.78)'; g.strokeStyle = color; g.lineWidth = 1; g.beginPath();
  if (g.roundRect) g.roundRect(bx, by, w, h, 6); else g.rect(bx, by, w, h); g.fill(); g.stroke();
  g.textAlign = 'center'; g.fillStyle = '#fff'; g.fillText(text, x, by + 13);
  if (sub) { g.fillStyle = color; g.font = '11px "Microsoft YaHei","Segoe UI",sans-serif'; g.fillText(sub, x, by + 26); }
}
function dotAt(sp, vz, r0, color, glow) {
  var r = clamp(F * r0 / vz, 2.5, 16);
  if (glow) { g.fillStyle = rgba(color, 0.25); g.beginPath(); g.arc(sp[0], sp[1], r * 2.2, 0, 6.2832); g.fill(); }
  g.fillStyle = color; g.beginPath(); g.arc(sp[0], sp[1], r, 0, 6.2832); g.fill();
  g.strokeStyle = 'rgba(255,255,255,.85)'; g.lineWidth = 1; g.stroke();
}

/* ---- 信号热力 (客户端 IDW) ---- */
var HN = 34, heat = new Float32Array(HN * HN), heatDirty = true, HR = 90;
function buildHeat() {
  heatDirty = false; var arr = [];
  APS.forEach(function (ap) { if (ap.live) arr.push([ap.tx, ap.ty, clamp((ap.rssi + 95) / 55, 0.05, 1), 8 + ap.dist * 0.18]); });
  HR = clamp(RMAX_VIEW(), 40, 150);
  for (var i = 0; i < HN; i++) for (var j = 0; j < HN; j++) {
    var x = (i + 0.5) / HN * 2 * HR - HR, y = (j + 0.5) / HN * 2 * HR - HR, v = 0;
    for (var k = 0; k < arr.length; k++) { var a = arr[k], dx = x - a[0], dy = y - a[1]; v += a[2] * Math.exp(-(dx * dx + dy * dy) / (2 * a[3] * a[3])); }
    heat[j * HN + i] = Math.min(v, 1.4);
  }
}
function RMAX_VIEW() { var m = 60; APS.forEach(function (ap) { if (ap.live) m = Math.max(m, ap.dist * 1.15); }); return Math.min(m, 150); }
function drawHeat() {
  if (heatDirty) buildHeat();
  var cs = 2 * HR / HN;
  for (var i = 0; i < HN; i++) for (var j = 0; j < HN; j++) {
    var v = heat[j * HN + i]; if (v < 0.06) continue;
    var x0 = i * cs - HR, y0 = j * cs - HR;
    var col = v > 0.8 ? '255,93,208' : v > 0.45 ? '46,230,166' : '76,201,240';
    fillPoly([[x0, y0, 0.02], [x0 + cs, y0, 0.02], [x0 + cs, y0 + cs, 0.02], [x0, y0 + cs, 0.02]], 'rgba(' + col + ',' + (Math.min(v, 1) * 0.2).toFixed(3) + ')');
  }
}

/* ---- 场景绘制 ---- */
var sweepA = 0, lastT = performance.now(), PICK = [];
function drawGround() {
  var R = 160;
  g.lineWidth = 1; g.strokeStyle = 'rgba(40,130,170,.2)'; g.beginPath();
  for (var k = -R; k <= R; k += 10) { seg(k, -R, 0, k, R, 0); seg(-R, k, 0, R, k, 0); }
  g.stroke();
  g.strokeStyle = 'rgba(60,170,210,.28)'; g.beginPath(); for (var a = 0; a < 12; a++) { var t = a / 12 * 6.2832; seg(0, 0, 0.01, Math.cos(t) * 150, Math.sin(t) * 150, 0.01); } g.stroke();
  [5, 10, 20, 40, 80, 150].forEach(function (r) {
    g.strokeStyle = r <= 40 ? 'rgba(31,165,214,.7)' : 'rgba(31,165,214,.38)'; g.lineWidth = r <= 40 ? 1.6 : 1.2; ring3(0, 0, 0.02, r, 120);
    var p = P(r * 0.7071, r * 0.7071, 0.2); if (p) { g.fillStyle = '#58c6ee'; g.font = 'bold 11px "Segoe UI",sans-serif'; g.textAlign = 'center'; g.fillText(r + ' m', p[0], p[1]); }
  });
  [['N 北', 0, 1], ['E 东', 1, 0], ['S 南', 0, -1], ['W 西', -1, 0]].forEach(function (d) {
    var p = P(d[1] * 158, d[2] * 158, 0.5); if (p) { g.fillStyle = d[0][0] === 'N' ? '#ff6b81' : '#7fb4d0'; g.font = 'bold 14px "Microsoft YaHei",sans-serif'; g.textAlign = 'center'; g.fillText(d[0], p[0], p[1]); }
  });
}
function drawWorld() {
  var bl = [], rd = [], offx = GEOFF.x, offy = GEOFF.y, world = GEO || DEMO_WORLD;
  if (!world || !S.buildings) return;
  g.lineWidth = 1.2; g.strokeStyle = 'rgba(255,196,80,.35)'; g.beginPath();
  (world.roads || []).forEach(function (r) { for (var i = 0; i + 1 < r.length; i++) seg(r[i][0] + offx, r[i][1] + offy, 0.03, r[i + 1][0] + offx, r[i + 1][1] + offy, 0.03); });
  g.stroke();
  (world.buildings || []).forEach(function (b) {
    var c = b.pts, sx = 0, sy = 0; for (var i = 0; i < c.length; i++) { sx += c[i][0]; sy += c[i][1]; }
    var cx = sx / c.length + offx, cy2 = sy / c.length + offy, d = Math.hypot(cx - B.cx, cy2 - B.cy);
    if (d > 520) return; bl.push([d, b, cx, cy2]);
  });
  bl.sort(function (a, b) { return b[0] - a[0]; });
  if (bl.length > 1400) bl = bl.slice(bl.length - 1400);
  bl.forEach(function (e) {
    var b = e[1], pts = b.pts, n = pts.length; if (n < 3) return; if (pts[0][0] === pts[n - 1][0] && pts[0][1] === pts[n - 1][1]) n--;
    if (n < 3) return;
    var area = 0; for (var i = 0; i < n; i++) { var p = pts[i], q = pts[(i + 1) % n]; area += p[0] * q[1] - q[0] * p[1]; }
    var ccw = area > 0, h = b.h || 8, walls = [];
    for (var j = 0; j < n; j++) {
      var p1 = pts[j], p2 = pts[(j + 1) % n], ex = p2[0] - p1[0], ey = p2[1] - p1[1], nx = ccw ? ey : -ey, ny = ccw ? -ex : ex, nl = Math.hypot(nx, ny) || 1; nx /= nl; ny /= nl;
      var mx = (p1[0] + p2[0]) / 2 + offx, my = (p1[1] + p2[1]) / 2 + offy;
      if (nx * (B.cx - mx) + ny * (B.cy - my) <= 0) continue;
      walls.push([Math.hypot(mx - B.cx, my - B.cy), p1, p2, 0.45 + 0.55 * Math.max(0, nx * 0.5 + ny * 0.85)]);
    }
    walls.sort(function (a, b2) { return b2[0] - a[0]; });
    walls.forEach(function (w) {
      var l = w[3], x1 = w[1][0] + offx, y1 = w[1][1] + offy, x2 = w[2][0] + offx, y2 = w[2][1] + offy;
      fillPoly([[x1, y1, 0], [x2, y2, 0], [x2, y2, h], [x1, y1, h]], 'rgba(' + Math.round(22 + 40 * l) + ',' + Math.round(60 + 70 * l) + ',' + Math.round(95 + 80 * l) + ',.5)', 'rgba(110,210,255,.3)', 0.8);
    });
    fillPoly(pts.slice(0, n).map(function (p) { return [p[0] + offx, p[1] + offy, h]; }), 'rgba(40,100,140,.55)', 'rgba(150,230,255,.5)', 1);
  });
}
function drawSweep(dt, t) {
  if (!S.sweep) return;
  var prev = sweepA; sweepA = (sweepA + dt * 1.1) % 6.2832;
  var Rs = clamp(RMAX_VIEW(), 40, 150), K = 26, dA = 0.045;
  NODES.forEach(function (nd) {
    if (t - nd.last > 30) return;
    for (var k = 0; k < K; k++) {
      var a1 = sweepA - k * dA, a0 = a1 - dA, al = 0.25 * Math.pow(1 - k / K, 1.6);
      fillPoly([[nd.x, nd.y, 0.04], [nd.x + Math.cos(a1) * Rs, nd.y + Math.sin(a1) * Rs, 0.04], [nd.x + Math.cos(a0) * Rs, nd.y + Math.sin(a0) * Rs, 0.04]], 'rgba(46,230,166,' + al.toFixed(3) + ')');
    }
    g.strokeStyle = 'rgba(120,255,210,.9)'; g.lineWidth = 1.6; g.beginPath(); seg(nd.x, nd.y, 0.05, nd.x + Math.cos(sweepA) * Rs, nd.y + Math.sin(sweepA) * Rs, 0.05); g.stroke();
  });
  APS.forEach(function (ap) {
    if (!ap.live) return;
    var a = Math.atan2(ap.ty - ap.node.y, ap.tx - ap.node.x), d = (sweepA - a + 12.5664) % 6.2832, dp = (prev - a + 12.5664) % 6.2832;
    if (d < dp) ap.hit = 1;
  });
}
function drawNodes(t) {
  NODES.forEach(function (nd) {
    var live = t - nd.last < 30, col = live ? '#4cc9f0' : '#557788', ph = (t * 0.8) % 1;
    g.lineWidth = 1.4; g.strokeStyle = rgba(col, 0.9 * (1 - ph)); ring3(nd.x, nd.y, 0.05, 1.5 + ph * 7, 40);
    g.strokeStyle = col; g.lineWidth = 3; g.beginPath(); seg(nd.x, nd.y, 0, nd.x, nd.y, 6); g.stroke();
    var p = V(nd.x, nd.y, 6); if (p[2] > NEAR) { var s = SC(p); dotAt(s, p[2], 0.9, col, true); label(s[0], s[1] - 12, 'ESP32 ' + nd.id, col, '观测点 (' + nd.x.toFixed(0) + ',' + nd.y.toFixed(0) + ')', true); }
  });
  if (!NODES.size) { var p2 = V(0, 0, 4); if (p2[2] > NEAR) { var s2 = SC(p2); dotAt(s2, p2[2], 0.9, '#4cc9f0', true); } }
}
function drawAPs(dt, t) {
  PICK = []; var arr = [];
  APS.forEach(function (ap) { if (ap.live) arr.push(ap); });
  arr.forEach(function (ap) { ap.cd = Math.hypot(ap.tx - B.cx, ap.ty - B.cy); });
  arr.sort(function (a, b) { return b.cd - a.cd; });
  arr.forEach(function (ap) {
    var col = authInfo(ap.auth)[1], isSel = selected === ap.bssid;
    ap.pulse *= Math.pow(0.4, dt); ap.hit *= Math.pow(0.35, dt);
    g.strokeStyle = rgba(col, isSel ? 0.55 : 0.14); g.lineWidth = 1; g.beginPath(); seg(ap.node.x, ap.node.y, 0.03, ap.tx, ap.ty, 0.03); g.stroke();
    if (isSel) { g.strokeStyle = rgba(col, 0.7); g.lineWidth = 1.4; ring3(ap.node.x, ap.node.y, 0.04, ap.dist, 110, true); }
    var base = V(ap.tx, ap.ty, 0), top = V(ap.tx, ap.ty, ap.h);
    g.strokeStyle = rgba(col, 0.5 + ap.hit * 0.4); g.lineWidth = 1.2; ring3(ap.tx, ap.ty, 0.05, 1.6 + ap.hit * 2 + ap.pulse * 1.5, 22);
    g.fillStyle = rgba(col, 0.18 + ap.hit * 0.25);
    fillPoly([[ap.tx - 1.3, ap.ty - 1.3, 0.05], [ap.tx + 1.3, ap.ty - 1.3, 0.05], [ap.tx + 1.3, ap.ty + 1.3, 0.05], [ap.tx - 1.3, ap.ty + 1.3, 0.05]], g.fillStyle);
    var sg = g.createLinearGradient(0, 0, 0, 1);
    if (base[2] > NEAR || top[2] > NEAR) {
      g.strokeStyle = rgba(col, 0.85); g.lineWidth = isSel ? 3.2 : 2.2; g.beginPath(); seg(ap.tx, ap.ty, 0.05, ap.tx, ap.ty, ap.h); g.stroke();
    }
    if (top[2] > NEAR) {
      var s = SC(top); dotAt(s, top[2], 0.85 + ap.hit * 0.4, col, isSel || ap.hit > 0.3);
      PICK.push({ b: ap.bssid, x: s[0], y: s[1], z: top[2], kind: 'ap' });
      if (S.labels || isSel) label(s[0], s[1] - 10, ap.ssid || '(隐藏)', col, Math.round(ap.rssi) + ' dBm · ' + ap.dist.toFixed(1) + ' m', isSel);
    }
    void sg;
  });
}
function drawStations(t) {
  if (!S.stations) return;
  STAS.forEach(function (st, mac) {
    if (t - st.last > 40) return;
    var nd = NODES.get(st.node) || { x: 0, y: 0 }, d = rssiToDist(st.rssi, st.ch || 6), ang = fnv('st' + mac) * 6.2832;
    var x = nd.x + d * Math.cos(ang), y = nd.y + d * Math.sin(ang), col = '#ff5dd0';
    g.strokeStyle = rgba(col, 0.75); g.lineWidth = 1.5; g.beginPath(); seg(x, y, 0, x, y, 3.2); g.stroke();
    var tp = V(x, y, 3.6);
    if (tp[2] > NEAR) {
      var s = SC(tp), r = clamp(F * 0.9 / tp[2], 3, 12);
      g.fillStyle = col; g.beginPath(); g.moveTo(s[0], s[1] - r); g.lineTo(s[0] + r, s[1]); g.lineTo(s[0], s[1] + r); g.lineTo(s[0] - r, s[1]); g.closePath(); g.fill();
      if (S.labels) label(s[0], s[1] - r - 3, '设备 ' + mac.slice(-5), col, Math.round(st.rssi) + ' dBm');
    }
  });
}
function frameBody(tn) {
  g.globalAlpha = 1; g.setLineDash && g.setLineDash([]);
  var dt = Math.min(0.1, (tn - lastT) / 1000); lastT = tn; var t = now();
  if (camGoal) {
    var k = 1 - Math.pow(0.001, dt);
    ['yaw', 'pitch', 'dist', 'tx', 'ty', 'tz'].forEach(function (key) { cam[key] += (camGoal[key] - cam[key]) * k; });
    if (Math.abs(camGoal.dist - cam.dist) < 0.05 && Math.abs(camGoal.tx - cam.tx) < 0.05 && Math.abs(camGoal.ty - cam.ty) < 0.05) camGoal = null;
  }
  if (S.rotate) cam.yaw += dt * 0.12;
  APS.forEach(function (ap) { recompute(ap, t); });
  setupCam(); LB = [];
  g.setTransform(DPR, 0, 0, DPR, 0, 0);
  var bg = g.createLinearGradient(0, 0, 0, H); bg.addColorStop(0, '#02060d'); bg.addColorStop(0.55, '#04101c'); bg.addColorStop(1, '#030a13');
  g.fillStyle = bg; g.fillRect(0, 0, W, H);
  drawGround();
  if (S.heat) drawHeat();
  drawWorld();
  drawSweep(dt, t);
  drawNodes(t);
  drawStations(t);
  drawAPs(dt, t);
}
var fpsN = 0;
function frame(tn) {
  requestAnimationFrame(frame);          // 先排下一帧：任何绘制异常都不会让画面冻结
  try { frameBody(tn); DG.r.last = Date.now(); DG.r.n++; fpsN++; }
  catch (e) { DG.r.err++; DG.r.lastErr = e.message; dlogRate('render', 3000, 'ERR', 'render', '绘制异常（已自动恢复）：' + e.message + ' @' + String((e.stack || '').split('\n')[1] || '').trim()); }
}
setInterval(function () { DG.r.fps = fpsN; fpsN = 0; }, 1000);
requestAnimationFrame(frame);

/* ================= 交互 ================= */
var ptrs = new Map(), moved = 0, dragAP = null, downAt = null, lastPinch = 0;
function ray(sx, sy) {
  var dx = B.fx + (sx - W / 2) / F * B.rx - (sy - H / 2) / F * B.ux, dy = B.fy + (sx - W / 2) / F * B.ry - (sy - H / 2) / F * B.uy, dz = B.fz - (sy - H / 2) / F * B.uz;
  if (dz > -1e-4) return null; var t = -B.cz / dz; return [B.cx + dx * t, B.cy + dy * t];
}
function pickAt(x, y) { var best = null, bd = 18; PICK.forEach(function (p) { var d = Math.hypot(p.x - x, p.y - y); if (d < bd) { bd = d; best = p; } }); return best; }
cv.addEventListener('contextmenu', function (e) { e.preventDefault(); });
cv.addEventListener('pointerdown', function (e) {
  cv.setPointerCapture(e.pointerId); ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY, btn: e.button }); moved = 0; camGoal = null; cv.classList.add('drag');
  downAt = { x: e.clientX, y: e.clientY };
  if (e.shiftKey && e.button === 0) { var p = pickAt(e.clientX, e.clientY); if (p) dragAP = p.b; }
});
cv.addEventListener('pointermove', function (e) {
  var p = ptrs.get(e.pointerId); if (!p) return;
  var dx = e.clientX - p.x, dy = e.clientY - p.y; p.x = e.clientX; p.y = e.clientY; moved += Math.abs(dx) + Math.abs(dy);
  if (dragAP) { var h = ray(e.clientX, e.clientY), ap = APS.get(dragAP); if (h && ap && ap.node) { OVR[dragAP] = Math.atan2(h[1] - ap.node.y, h[0] - ap.node.x); lsSet('wradar2.bearing', OVR); } return; }
  if (ptrs.size === 2) {
    var a = Array.from(ptrs.values()), d = Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y);
    if (lastPinch) cam.dist = clamp(cam.dist * lastPinch / d, 3, 420); lastPinch = d; return;
  }
  if (p.btn === 2 || p.btn === 1) {
    var k = cam.dist / F, kx = k, ky = k / Math.max(Math.sin(cam.pitch), 0.25);
    cam.tx += -B.rx * dx * kx + (-Math.sin(cam.yaw)) * dy * ky; cam.ty += -B.ry * dx * kx + Math.cos(cam.yaw) * dy * ky;
  } else { cam.yaw += dx * 0.0065; cam.pitch = clamp(cam.pitch + dy * 0.005, 0.04, 1.52); }
});
function up(e) {
  ptrs.delete(e.pointerId); lastPinch = 0; cv.classList.remove('drag');
  if (!ptrs.size) {
    if (!dragAP && moved < 5 && downAt) { var p = pickAt(e.clientX, e.clientY); selected = p ? p.b : null; if (p) focusAP(p.b, true); showDetail(); }
    dragAP = null;
  }
}
cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
cv.addEventListener('wheel', function (e) { e.preventDefault(); camGoal = null; cam.dist = clamp(cam.dist * Math.exp(e.deltaY * 0.0013), 3, 420); }, { passive: false });
function focusAP(b, soft) { var ap = APS.get(b); if (!ap) return; camGoal = { yaw: cam.yaw, pitch: cam.pitch, dist: soft ? cam.dist : Math.min(cam.dist, 45), tx: ap.tx, ty: ap.ty, tz: 0 }; }
function resetView() { camGoal = Object.assign({}, HOME); }
function toggleFS() { if (document.fullscreenElement) document.exitFullscreen(); else if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen(); }
window.addEventListener('keydown', function (e) {
  if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') || e.ctrlKey || e.metaKey) return;
  var k = e.key.toLowerCase();
  if (k === 'r') resetView(); else if (k === 'f') toggleFS(); else if (k === 'l') { S.labels = !S.labels; sync(); saveS(); }
});

/* ================= UI ================= */
function toast(m, ms) { var t = $('toast'); t.textContent = m; t.style.display = 'block'; clearTimeout(toast.h); toast.h = setTimeout(function () { t.style.display = 'none'; }, ms || 4500); }
function sync() {
  $('sN').value = S.n; $('oN').textContent = (+S.n).toFixed(2); $('sT').value = S.tx; $('oT').textContent = S.tx;
  $('cLab').checked = S.labels; $('cSwp').checked = S.sweep; $('cSta').checked = S.stations; $('cBld').checked = S.buildings; $('cHeat').checked = S.heat; $('cRot').checked = S.rotate;
}
$('sN').oninput = function () { S.n = +this.value; heatDirty = true; sync(); saveS(); };
$('sT').oninput = function () { S.tx = +this.value; heatDirty = true; sync(); saveS(); };
[['cLab', 'labels'], ['cSwp', 'sweep'], ['cSta', 'stations'], ['cBld', 'buildings'], ['cHeat', 'heat'], ['cRot', 'rotate']].forEach(function (p) { $(p[0]).onchange = function () { S[p[1]] = this.checked; saveS(); }; });
$('bReset').onclick = resetView; $('bFS').onclick = toggleFS;
$('bClr').onclick = function () { OVR = {}; lsSet('wradar2.bearing', OVR); toast('已清除手动方位'); };
$('bDemo').onclick = startDemo; $('bDemo2').onclick = startDemo;
$('bSerial').onclick = serialToggle; $('bSerial2').onclick = serialToggle;
$('bRst').onclick = function () { serialReset('手动'); }; $('bRst2').onclick = function () { serialReset('手动'); };
$('bDiag').onclick = function () { toggleDiag(); }; $('bDiag2').onclick = function () { toggleDiag(true); }; $('dgX').onclick = function () { toggleDiag(false); };
$('dgCopy').onclick = function () { copyTextPlain(buildReport()).then(function (ok) { toast(ok ? '✅ 检测日志已复制（可粘贴到 GitHub 的“检测日志”文件）' : '复制失败，请点“下载”'); }); };
$('dgDl').onclick = function () { downloadText('wifi-radar-检测日志-' + Date.now() + '.txt', buildReport()); };
$('dgClr').onclick = function () { DG.log = []; dlog('INFO', 'page', '日志已清空'); renderDiagPanel(); };
$('bGeo').onclick = function () { loadGeo(); };
Array.prototype.forEach.call(document.querySelectorAll('#nudge button'), function (b) { b.onclick = function () { var d = b.dataset.d.split(',').map(Number); GEOFF.x += d[0] * 5; GEOFF.y += d[1] * 5; }; });
$('q').oninput = function () { renderList(); };
$('list').onclick = function (e) { var it = e.target.closest ? e.target.closest('.item') : null; if (!it) return; selected = it.dataset.b; focusAP(selected); showDetail(); renderList(); };

function renderList() {
  var q = $('q').value.trim().toLowerCase(), arr = [];
  APS.forEach(function (ap) { if (!ap.live) return; if (q && (ap.ssid || '').toLowerCase().indexOf(q) < 0 && ap.bssid.toLowerCase().indexOf(q) < 0) return; arr.push(ap); });
  arr.sort(function (a, b) { return b.rssi - a.rssi; });
  if (!arr.length) { $('list').innerHTML = '<div style="color:var(--dim);padding:10px">暂无数据</div>'; return; }
  $('list').innerHTML = arr.slice(0, 120).map(function (ap) {
    var a = authInfo(ap.auth);
    return '<div class="item' + (selected === ap.bssid ? ' on' : '') + '" data-b="' + ap.bssid + '"><span class="dot" style="background:' + a[1] + '"></span><span class="nm"><b>' + esc(ap.ssid || '(隐藏)') + '</b><i>' + ap.bssid + ' · CH' + ap.ch + ' · ' + a[0] + '</i></span><span class="rs">' + Math.round(ap.rssi) + ' dBm<i>≈ ' + ap.dist.toFixed(1) + ' m</i></span></div>';
  }).join('');
}
function showDetail() {
  var d = $('detail'), ap = selected && APS.get(selected);
  if (!ap || !ap.live) { d.style.display = 'none'; return; }
  var a = authInfo(ap.auth); d.style.display = 'block';
  d.innerHTML = '<b>' + esc(ap.ssid || '(隐藏)') + '</b><br>BSSID ' + ap.bssid + '<br>信道 ' + ap.ch + ' · ' + a[0] + '<br>RSSI ' + ap.rssi.toFixed(1) + ' dBm（σ=' + (ap.sigma || 0).toFixed(1) + '）<br>估算距离 ' + ap.dist.toFixed(1) + ' m（±30~50%）<br>方位来源：' + ap.src + '，' + (((ap.ang * 180 / Math.PI) % 360 + 360) % 360).toFixed(0) + '°';
}
setInterval(function () {
  var t = now(), nap = 0; APS.forEach(function (ap) { if (ap.live) nap++; else if (t - ap.last > 180) APS.delete(ap.bssid); });
  var nst = 0; STAS.forEach(function (s, m) { if (t - s.last < 40) nst++; else if (t - s.last > 300) STAS.delete(m); });
  var nn = 0; NODES.forEach(function (n) { if (t - n.last < 30) nn++; });
  $('nAP').firstChild.nodeValue = nap; $('nST').firstChild.nodeValue = nst; $('nND').firstChild.nodeValue = nn;
  var c = $('chConn');
  if (mode === 'demo') { c.textContent = '演示数据'; c.className = 'chip warn'; }
  else if (frameCount === 0) { c.textContent = SIM ? '等待 RESET' : '等待 ESP32'; c.className = 'chip'; }
  else if (t - lastFrameAt < 8) { c.textContent = (serialOn ? 'USB 直连' : mode === 'sim' ? '模拟器' : 'ESP32 在线') + ' · ' + frameCount + ' 帧'; c.className = 'chip ok'; }
  else { c.textContent = '数据中断 ' + Math.round(t - lastFrameAt) + 's'; c.className = 'chip bad'; }
  var first = NODES.values().next().value; $('chNode').textContent = first ? first.id : '—';
  var sv = $('chSrv');
  if (SIM) { sv.textContent = '模拟模式'; sv.className = 'chip warn'; }
  else if (srvOK === true) { sv.textContent = '服务器在线'; sv.className = 'chip ok'; } else if (srvOK === false) { sv.textContent = '服务器无响应'; sv.className = 'chip bad'; }
  renderList(); showDetail();
  if (frameCount === 0 && !SIM) {
    var dd = diagChecks(), pick = null;
    dd.checks.forEach(function (c) { if (!pick && (c.st === 'bad')) pick = c; });
    $('diag').innerHTML = dd.checks.filter(function (c) { return c.id === 'env' || c.id === 'srv' || c.id === 'ser' || c.id === 'fw' || c.id === 'data'; }).map(function (c) { return '<div>' + ICN[c.st] + ' ' + esc(c.name) + '：' + esc(c.msg) + '</div>'; }).join('') + '<div style="color:#7f9db3">ESP32 联网困难时请点“USB 直连”，由电脑转发。完整诊断请点“🩺 检测日志”。</div>';
    if (pick) { $('wT').textContent = '卡住了：' + pick.name; $('wM').textContent = pick.msg + (pick.hint ? ' —— ' + pick.hint : ''); }
    else if (DG.ser.open) { $('wT').textContent = '等待 ESP32 上传数据…'; $('wM').textContent = DG.ser.hbInfo ? '固件在线（状态 ' + DG.ser.hbInfo.st + '），正在做第一轮扫描…' : '串口已打开，等待固件输出…'; }
  }
}, 500);

/* ================= 服务器轮询 / 地理 ================= */
var since = 0;
async function poll() {
  if (SIM || mode === 'demo') return;
  try {
    var r = await fetch('api/frames?since=' + since, { cache: 'no-store' }); if (!r.ok) throw new Error('HTTP ' + r.status);
    var j = await r.json(); DG.srv.pollErr = ''; DG.srv.pollOK++; since = j.seq || 0; SOLVED = j.solved || {}; SERVER = j.status || null;
    (j.frames || []).forEach(function (f) { ingest(f, 'poll'); });
    srvMotion = SERVER && typeof SERVER.motion === 'number' ? SERVER.motion : null;
    if (SERVER) {
      var gp = SERVER.gpu && SERVER.gpu.length ? SERVER.gpu.join(' + ') : '无 GPU(CPU)';
      var res = SERVER.res ? ' · ' + SERVER.res : '';
      $('gpu').textContent = 'GPU: ' + gp + ' · 已接收 ' + (SERVER.frames || 0) + ' 帧' + res;
    }
  } catch (e) { DG.srv.pollErr = String(e.message || e); dlogRate('poll', 8000, 'WARN', 'server', '轮询 /api/frames 失败：' + DG.srv.pollErr); }
}
async function health() {
  if (SIM) { $('gpu').textContent = '浏览器模拟器：固件由页面虚拟（数据为演示）'; return; }
  var t0 = performance.now();
  try {
    var r = await fetch('api/health', { cache: 'no-store' }); if (!r.ok) throw new Error('HTTP ' + r.status);
    var hj = null; try { hj = await r.json(); } catch (e0) {}
    if (srvOK !== true) dlog('OK', 'server', '后端 /api/health 正常', hj ? { frames: hj.frames, gpu: hj.gpu, uptime: hj.uptime } : undefined);
    srvOK = true; srvErr = ''; DG.srv.ok = true; DG.srv.ms = Math.round(performance.now() - t0); DG.srv.info = hj; DG.srv.err = '';
    if (Date.now() - DG.srv.diagAt > 10000) { DG.srv.diagAt = Date.now(); fetch('api/diag', { cache: 'no-store' }).then(function (x) { return x.json(); }).then(function (j) { DG.srv.diag = j; }).catch(function () {}); }
  } catch (e) {
    if (srvOK !== false) dlog('ERR', 'server', '后端 /api/health 失败：' + String(e.message || e));
    srvOK = false; srvErr = String(e.message || e); DG.srv.ok = false; DG.srv.err = srvErr;
  }
}
if (!SIM) { setInterval(poll, 1000); setInterval(health, 4000); health(); poll(); } else { $('gpu').textContent = '浏览器模拟器：固件由页面虚拟（数据为演示）'; }
async function loadGeo() {
  if (SIM) { loadDemoWorld(); toast('模拟器内显示的是演示街区；Kaggle 上会加载 OpenStreetMap 真实街区'); return; }
  var url = 'api/geo';
  try {
    toast('正在定位真实世界（beaconDB + OpenStreetMap）…', 8000);
    var j = await (await fetch(url, { cache: 'no-store' })).json();
    if (!j.ok) {
      var s = prompt(j.error + '\n\n手动输入当前位置 “纬度,经度”（例如 31.2304,121.4737）：', '');
      if (!s) { toast(j.error); return; }
      var m = s.split(/[,，\s]+/).map(Number); if (m.length < 2 || isNaN(m[0]) || isNaN(m[1])) { toast('格式不对'); return; }
      j = await (await fetch(url + '?lat=' + m[0] + '&lon=' + m[1])).json();
      if (!j.ok) { toast(j.error); return; }
    }
    GEO = j; GEOFF = { x: 0, y: 0 }; $('nudge').style.display = 'flex'; S.buildings = true; sync();
    toast('✅ ' + j.label + ' · ' + j.buildings.length + ' 栋建筑 · ' + j.roads.length + ' 条道路（定位精度约 ' + Math.round(j.accuracy || 0) + ' m，可用 ◀▶▲▼ 对齐）', 9000);
  } catch (e) { toast('定位失败：' + e); }
}

/* ================= USB (Web Serial) 直连 ================= */
function apiKey() { return lsGet('wradar2.key', 'radar-key'); }
var SP = { port: null, token: 0, want: false, timers: [], rcTimer: null };
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function vidName(v) {
  return v === 0x303A ? 'Espressif 原生 USB (USB-Serial/JTAG) → 板子上标 “USB” 的口' : v === 0x1A86 ? 'CH340/CH343 USB 转串口 → 板子上标 “UART/COM” 的口' : v === 0x10C4 ? 'CP210x USB 转串口 → 板子上标 “UART/COM” 的口' : v === 0x0403 ? 'FTDI 转串口' : v ? 'USB VID 0x' + v.toString(16) : '未知/虚拟串口';
}
async function postServer(f) {
  if (SIM) return;
  var t = performance.now();
  try {
    var r = await fetch('api/ingest', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Key': apiKey() }, body: JSON.stringify(f) });
    DG.srv.lastPost = 'HTTP ' + r.status + ' ' + Math.round(performance.now() - t) + 'ms';
    if (r.ok) { DG.srv.postOK++; if (DG.srv.postOK === 1) dlog('OK', 'relay', '第一帧已转发到服务器 (' + DG.srv.lastPost + ')'); }
    else { DG.srv.postFail++; dlogRate('post' + r.status, 6000, 'ERR', 'relay', '转发到服务器失败 HTTP ' + r.status + (r.status === 401 ? '（API_KEY 不一致）' : '') + '；本地 3D 仍正常显示'); }
  } catch (e) { DG.srv.postFail++; DG.srv.lastPost = '异常 ' + e.message; dlogRate('postx', 6000, 'ERR', 'relay', '转发异常：' + e.message + '；本地 3D 仍正常显示'); }
}
function classifyLine(l) {
  var s = DG.ser;
  if (/waiting for download|DOWNLOAD\(USB|download mode/i.test(l)) { s.mode = 'download'; dlog('ERR', 'esp32', 'ESP32 处于下载模式：' + l.slice(0, 120)); return; }
  var m = /rst:0x[0-9a-f]+ \(([A-Z_0-9]+)\)/i.exec(l); if (m) { s.rstReason = m[1]; if (s.mode === 'download') s.mode = ''; }
  if (/Brownout/i.test(l)) dlog('ERR', 'esp32', '检测到欠压(Brownout)：供电不足，换 USB 线/口：' + l.slice(0, 100));
  else if (/Guru Meditation|abort\(\)|Backtrace:|assert failed/i.test(l)) dlog('ERR', 'esp32', '固件崩溃：' + l.slice(0, 160));
  else if (/invalid header|flash read err|No bootable app/i.test(l)) dlog('ERR', 'esp32', '启动失败（固件/分区损坏）：' + l.slice(0, 120));
  else if (/\[wifi\]|\[upload\]|\[warn\]|\[info\]/.test(l)) dlog(/timeout|fail|HTTP (-1|4|5)/i.test(l) ? 'WARN' : 'INFO', 'esp32', l.slice(0, 200));
  else if (s.other < 400) dlog('INFO', 'esp32', l.slice(0, 200));
}
function onSerialLine(l) {
  var s = DG.ser, k;
  if (!l) return;
  s.lines++;
  if ((k = l.indexOf('RADARJSON:')) >= 0) {
    var f = null, txt = l.slice(k + 10);
    try { f = JSON.parse(txt); } catch (e) { s.jsonBad++; dlogRate('jbad', 2000, 'ERR', 'serial', '帧 JSON 解析失败：' + e.message + ' · 长度 ' + txt.length + ' · 开头 ' + txt.slice(0, 60) + ' · 结尾 ' + txt.slice(-40) + '（可能丢字节：换 USB 线/口）'); return; }
    if (!f || !Array.isArray(f.aps)) { s.jsonBad++; dlogRate('jbad2', 2000, 'ERR', 'serial', '帧缺少 aps 数组'); return; }
    f.node = f.node || 'S3-USB';
    s.jsonOK++; s.lastJsonAt = Date.now(); s.lastApCount = f.aps.length;
    if (s.jsonOK === 1) dlog('OK', 'serial', '✅ 收到第一帧扫描数据：' + f.aps.length + ' 个 AP · 设备 ' + (f.st ? f.st.length : 0) + ' · node=' + f.node + ' · fw=' + (f.fw || '?') + ' · 扫描耗时 ' + (f.ms || '?') + 'ms');
    else if (s.jsonOK % 10 === 0) dlog('INFO', 'serial', '帧 #' + f.seq + ' AP=' + f.aps.length + ' 设备=' + (f.st ? f.st.length : 0) + ' 累计 ' + s.jsonOK);
    if (f.err) dlogRate('scanerr', 5000, 'WARN', 'esp32', 'ESP32 扫描返回错误码 ' + f.err);
    ingest(f, 'usb'); postServer(f);
  } else if ((k = l.indexOf('RADARHB:')) >= 0) {
    try { var j = JSON.parse(l.slice(k + 8)); s.hbInfo = j; s.hbAt = Date.now(); s.hb++; if (s.hb === 1) dlog('OK', 'serial', '✅ 固件心跳已收到：fw=' + j.fw + ' node=' + j.node + ' 状态=' + j.st + ' 运行 ' + j.up + 's'); } catch (e2) { s.jsonBad++; }
  } else if ((k = l.indexOf('RADARHELLO:')) >= 0) {
    try { var h = JSON.parse(l.slice(k + 11)); var first = !s.hello; s.hello = h; s.helloAt = Date.now(); if (first) dlog('OK', 'serial', '✅ 固件自我介绍：v' + h.fw + ' ' + h.chip + ' r' + h.rev + ' · flash ' + Math.round((h.flash || 0) / 1048576) + 'MB · PSRAM ' + Math.round((h.psram || 0) / 1048576) + 'MB · 复位原因 ' + h.rst + ' · 输出口 USB=' + h.usb + ' UART=' + h.mirror + ' · WiFi配置=' + (h.ssid || '无')); } catch (e3) { s.jsonBad++; }
  } else { s.other++; s.lastLine = l.slice(0, 140); classifyLine(l); }
}
async function serialWrite(str) {
  if (!SP.port || !SP.port.writable) return false;
  try { var w = SP.port.writable.getWriter(); try { await w.write(new TextEncoder().encode(str)); } finally { w.releaseLock(); } return true; }
  catch (e) { dlogRate('wr', 4000, 'WARN', 'serial', '向 ESP32 写入失败：' + e.message); return false; }
}
async function sigs(p, o) { try { await p.setSignals(o); return true; } catch (e) { dlogRate('sig', 4000, 'WARN', 'serial', 'setSignals 失败/不支持：' + e.name + ' ' + e.message); return false; } }
async function serialReset(why) {
  if (!SP.port || !DG.ser.open) { toast('请先点「USB 连接 ESP32」'); return; }
  DG.ser.resets++; DG.ser.mode = '';
  dlog('INFO', 'serial', '复位 ESP32：RTS 低脉冲，DTR 始终为低（=正常启动，不进下载模式）· 原因：' + (why || '手动'));
  await sigs(SP.port, { dataTerminalReady: false, requestToSend: true }); await sleep(160);
  await sigs(SP.port, { dataTerminalReady: false, requestToSend: false });
}
function updateSerialBtn() {
  var t = DG.ser.open ? '⏏ 断开 USB' : '🔌 USB 连接 ESP32';
  $('bSerial').textContent = t; $('bSerial2').textContent = DG.ser.open ? '⏏ 断开 USB' : '🔌 USB 直连 ESP32（最稳）';
}
function startWatchdog(tok) {
  SP.timers.forEach(clearTimeout); SP.timers = [];
  function at(ms, fn) { SP.timers.push(setTimeout(function () { if (tok === SP.token && DG.ser.open) { try { fn(); } catch (e) { dlog('ERR', 'serial', '看门狗异常 ' + e.message); } } }, ms)); }
  at(3500, function () { if (!DG.ser.bytes) { dlog('WARN', 'serial', '3.5 秒仍 0 字节：再发一次 hello 并复位一次'); serialWrite('hello\n'); serialReset('看门狗 #1'); } });
  at(8000, function () {
    if (!DG.ser.bytes) { dlog('WARN', 'serial', '8 秒仍 0 字节：尝试兼容模式（拉高 DTR，部分 TinyUSB-CDC 固件需要），持续 3 秒'); sigs(SP.port, { dataTerminalReady: true, requestToSend: false }); serialWrite('hello\n'); }
  });
  at(11500, function () {
    if (!DG.ser.bytes) {
      sigs(SP.port, { dataTerminalReady: false, requestToSend: false });
      dlog('ERR', 'serial', '❌ 11 秒内串口没有任何数据。端口：' + (DG.ser.chip || '?') + '。请：换板子另一个 USB 口重连；关闭 PlatformIO 串口监视器；重新 Upload 新版固件；换数据线。');
    } else { DG.ser.dtrOn = true; dlog('OK', 'serial', '兼容模式生效：此板需要 DTR 才输出（已保持开启）'); }
  });
  at(12000, function () { var s = DG.ser; if (s.bytes && s.jsonOK === 0) dlog('ERR', 'serial', '有串口数据但 12 秒内没有扫描帧。固件状态=' + (s.hbInfo ? s.hbInfo.st : '未知') + '，最近一行：' + (s.lastLine || s.lastRaw)); });
}
async function readLoop(port, tok) {
  var dec = new TextDecoder('utf-8'), buf = '', s = DG.ser, fatal = false;
  while (port.readable && tok === SP.token && !fatal) {
    var reader = port.readable.getReader();
    try {
      for (;;) {
        var rr = await reader.read(); if (rr.done) { fatal = true; break; }
        var v = rr.value; if (!v || !v.length) continue;
        s.bytes += v.length; if (!s.firstAt) { s.firstAt = Date.now(); dlog('OK', 'serial', '✅ 收到第一批串口数据 ' + v.length + ' 字节（串口通路正常）'); }
        var chunk = dec.decode(v, { stream: true });
        var bc = (chunk.match(/\uFFFD/g) || []).length; s.badChars += bc;
        var vis = chunk.replace(/[\r\n]+/g, ' ').trim(); if (vis) s.lastRaw = vis.slice(-90);
        buf += chunk; var i;
        while ((i = buf.indexOf('\n')) >= 0) { var ln = buf.slice(0, i).replace(/\r$/, ''); buf = buf.slice(i + 1); try { onSerialLine(ln); } catch (e) { dlogRate('lnerr', 3000, 'ERR', 'serial', '处理串口行出错：' + e.message); } }
        if (buf.length > 65536) { dlog('WARN', 'serial', '单行超过 64KB（无换行），已丢弃'); buf = ''; }
      }
    } catch (e2) {
      s.lastErr = e2.name + ': ' + e2.message;
      if (e2.name === 'NetworkError') { fatal = true; dlog('ERR', 'serial', '设备已断开/被拔出：' + e2.message); }
      else dlogRate('rderr', 2000, 'WARN', 'serial', '读取错误（' + e2.name + '，可恢复）：' + e2.message);
    } finally { try { reader.releaseLock(); } catch (e3) {} }
  }
  if (tok === SP.token) serialLost('读取结束');
}
function serialLost(why) {
  var s = DG.ser, p = SP.port; s.open = false; serialOn = false; SP.timers.forEach(clearTimeout); SP.timers = [];
  try { if (p) p.close().catch(function () {}); } catch (e) {}
  updateSerialBtn();
  if (SP.want) { dlog('WARN', 'serial', '串口中断（' + why + '），将自动重连…'); scheduleReconnect(0); } else dlog('INFO', 'serial', '串口已关闭（' + why + '）');
}
function scheduleReconnect(n) {
  clearTimeout(SP.rcTimer);
  if (!SP.want || DG.ser.open || n > 15) { if (n > 15) dlog('ERR', 'serial', '自动重连失败：请重新点「USB 连接 ESP32」'); return; }
  SP.rcTimer = setTimeout(async function () {
    if (!SP.want || DG.ser.open) return;
    try {
      var ps = await navigator.serial.getPorts(), want = null;
      ps.forEach(function (p) { var i = p.getInfo ? p.getInfo() : {}; if (!want && i.usbVendorId === DG.ser.vid && i.usbProductId === DG.ser.pid) want = p; });
      want = want || ps[0];
      if (want) { DG.ser.reconnects++; var ok = await serialOpen(want, true); if (ok) return; }
    } catch (e) { /* 继续重试 */ }
    scheduleReconnect(n + 1);
  }, 900);
}
async function serialOpen(port, quiet) {
  var s = DG.ser, info = {}; try { info = port.getInfo ? port.getInfo() : {}; } catch (e) {}
  s.vid = info.usbVendorId || 0; s.pid = info.usbProductId || 0; s.chip = vidName(s.vid);
  dlog('INFO', 'serial', (quiet ? '重连' : '选中') + '串口：' + s.chip, { vid: '0x' + s.vid.toString(16), pid: '0x' + s.pid.toString(16) });
  try { await port.open({ baudRate: 115200, bufferSize: 65536 }); }
  catch (e2) {
    s.lastErr = e2.name + ': ' + e2.message;
    var why = e2.name === 'InvalidStateError' ? '该串口已被本页打开' : /busy|access|denied|NetworkError|Failed to open/i.test(e2.name + e2.message) ? '串口被别的程序占用（PlatformIO 串口监视器 / Arduino / 另一个浏览器标签）→ 先关掉它们' : '未知原因';
    dlog('ERR', 'serial', '打开串口失败：' + s.lastErr + ' —— ' + why); if (!quiet) toast('串口打开失败：' + e2.message + '（' + why + '）', 9000); return false;
  }
  s.open = true; s.bytes = 0; s.lines = 0; s.badChars = 0; s.jsonOK = quiet ? s.jsonOK : 0; s.jsonBad = 0; s.hb = 0; s.other = 0; s.firstAt = 0; s.mode = ''; s.openedAt = Date.now(); s.lastRaw = ''; s.lastLine = ''; s.hello = null; s.hbInfo = null; s.lastErr = '';
  serialOn = true; SP.port = port; SP.want = true; lsSet('wradar2.autoserial', true);
  mode = SIM ? 'sim' : 'live';
  var tok = ++SP.token;
  dlog('OK', 'serial', '串口已打开 115200 8N1');
  $('wT').textContent = '正在连接 ESP32…'; $('wM').textContent = '串口已打开，正在复位 ESP32 并等待第一帧（约 2~4 秒）…';
  updateSerialBtn();
  await sigs(port, { dataTerminalReady: false, requestToSend: false });
  readLoop(port, tok);
  await sleep(150);
  serialWrite('hello\n');
  await serialReset(quiet ? '重连后复位' : '连接后自动复位，让固件从头开始');
  startWatchdog(tok);
  return true;
}
async function serialConnect(auto) {
  if (DG.ser.open) { toast('USB 已连接'); return; }
  if (!DG.ser.supported) { dlog('ERR', 'serial', '此浏览器不支持 Web Serial（需电脑版 Chrome/Edge，https 或 localhost）'); toast('此浏览器不支持 Web Serial：请用电脑版 Chrome / Edge，并通过 https 或 localhost 打开本页', 8000); return; }
  var port = null;
  try {
    if (auto === true) { var ps = await navigator.serial.getPorts(); port = ps[0]; }
    if (!port) port = await navigator.serial.requestPort();
  } catch (e) {
    var msg = e.name + ': ' + e.message;
    if (e.name === 'NotFoundError') dlog('WARN', 'serial', '未选择串口（对话框里没有任何设备？确认 USB 已插好、驱动正常；或你点了取消）');
    else if (e.name === 'SecurityError') { dlog('ERR', 'serial', '被浏览器权限策略拒绝：' + msg + ' —— 若本页嵌在 iframe 里，外层必须给 iframe 加 allow="serial"；也可点“新标签打开”'); toast('Web Serial 被权限策略禁止：请点“新标签打开”后再连接', 9000); }
    else dlog('ERR', 'serial', '请求串口失败：' + msg);
    return;
  }
  await serialOpen(port, false);
}
async function serialDisconnect() {
  SP.want = false; lsSet('wradar2.autoserial', false); SP.token++; clearTimeout(SP.rcTimer);
  SP.timers.forEach(clearTimeout); SP.timers = [];
  var p = SP.port; DG.ser.open = false; serialOn = false;
  try { if (p) { if (p.readable && p.readable.locked) { /* reader 会在 token 变化后自然结束 */ } await p.close(); } } catch (e) { try { await sleep(200); await p.close(); } catch (e2) {} }
  dlog('INFO', 'serial', '已手动断开串口'); updateSerialBtn();
}
function serialToggle() { if (DG.ser.open) serialDisconnect(); else serialConnect(false); }
if ('serial' in navigator) {
  navigator.serial.addEventListener('disconnect', function () { dlog('WARN', 'serial', '浏览器报告：USB 设备已拔出/断开'); });
  navigator.serial.addEventListener('connect', function () { dlog('INFO', 'serial', '浏览器报告：检测到 USB 串口设备接入'); if (SP.want && !DG.ser.open) scheduleReconnect(0); });
  if (!SIM && lsGet('wradar2.autoserial', false)) setTimeout(function () { navigator.serial.getPorts().then(function (ps) { if (ps.length) { dlog('INFO', 'serial', '发现已授权的串口，自动连接…'); serialConnect(true); } }).catch(function () {}); }, 900);
}

/* ================= 演示数据 ================= */
function rng(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; var t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
var DEMO = null, demoSeq = 0, demoTimer = null;
function initDemo() {
  var r = rng(11), names = ['Home-5G', 'TP-LINK_A1B2', 'ChinaNet-8Qx2', 'Xiaomi_Router', 'HUAWEI-Office', 'CMCC-WiFi', 'Guest', 'Starbucks', 'iPhone 热点', 'NETGEAR72', 'ASUS_RT', 'CU_5588', 'Tenda_3F', 'DIRECT-Printer', 'MERCURY_9C', 'Lab-Enterprise'], auths = [3, 3, 4, 3, 5, 0, 3, 0, 7, 3, 6, 3, 2, 1, 3, 5];
  DEMO = { aps: [], sts: [] };
  names.forEach(function (n, i) {
    var d = 4 + Math.pow(r(), 1.3) * 72, mac = [0x3c, 0x46 + i, Math.floor(r() * 255), Math.floor(r() * 255), Math.floor(r() * 255), (i * 16) & 255].map(function (x) { return ('0' + (x & 255).toString(16)).slice(-2); }).join(':').toUpperCase();
    DEMO.aps.push({ b: mac, s: n, c: [1, 6, 11, 3, 8, 13][i % 6], a: auths[i], ang: r() * 6.2832, base: -40 - 10 * 2.8 * Math.log10(d), ph: r() * 6 });
  });
  for (var i = 0; i < 6; i++) DEMO.sts.push({ m: [0xa2 + i, 0x11, Math.floor(r() * 255), Math.floor(r() * 255), Math.floor(r() * 255), Math.floor(r() * 255)].map(function (x) { return ('0' + x.toString(16)).slice(-2); }).join(':').toUpperCase(), base: -45 - r() * 35, c: 1 + Math.floor(r() * 11), n: 5 + Math.floor(r() * 80) });
}
function demoFrame() {
  if (!DEMO) initDemo(); var t = now(), walk = Math.sin(t * 0.08) > 0.55 ? 3.2 : 0.9; demoSeq++;
  var f = { v: 1, node: 'S3-DEMO01', seq: demoSeq, up: Math.round(t % 100000), x: 0, y: 0, fw: 'demo', aps: [] };
  DEMO.aps.forEach(function (a) { f.aps.push({ b: a.b, s: a.s, r: Math.round(a.base + Math.sin(t * 0.7 + a.ph) * 0.8 * walk + (Math.random() - 0.5) * 2.4 * walk), c: a.c, a: a.a, ang: a.ang }); });
  if (demoSeq % 3 === 1) { f.st = DEMO.sts.map(function (s) { return { m: s.m, r: Math.round(s.base + (Math.random() - 0.5) * 6), c: s.c, n: s.n + demoSeq }; }); }
  return f;
}
function loadDemoWorld() {
  var r = rng(5), bs = [], rd = [];
  for (var k = -6; k <= 6; k++) { rd.push([[-260, 20 + 40 * k], [260, 20 + 40 * k]]); rd.push([[20 + 40 * k, -260], [20 + 40 * k, 260]]); }
  for (var i = -6; i <= 6; i++) for (var j = -6; j <= 6; j++) {
    if (!i && !j) continue; var cx = i * 40, cy = j * 40, n = 1 + Math.floor(r() * 2.6);
    for (var q = 0; q < n; q++) { var w = 8 + r() * 10, h = 8 + r() * 10, x = cx - 13 + r() * 10, y = cy - 13 + r() * 10, ht = 5 + Math.pow(r(), 2) * 24; bs.push({ h: Math.round(ht), pts: [[x, y], [x + w, y], [x + w, y + h], [x, y + h]] }); }
  }
  DEMO_WORLD = { buildings: bs, roads: rd }; S.buildings = true; sync();
}
function startDemo() {
  mode = SIM ? 'sim' : 'demo'; if (!DEMO_WORLD) loadDemoWorld(); clearInterval(demoTimer);
  var tick = function () { ingest(demoFrame(), 'demo'); }; tick(); demoTimer = setInterval(tick, 1500);
  if (SIM) mode = 'sim'; toast('演示数据已启动（模拟的 WiFi 环境，非真实扫描）');
}
function reset() {
  APS.clear(); STAS.clear(); NODES.clear(); SEEN.clear(); actT0 = 0; actBase = null; frameCount = 0; lastFrameAt = 0; actHist = []; clearInterval(demoTimer); $('wait').style.display = 'block';
}
function setWaiting(title, msg) { $('wT').textContent = title; $('wM').textContent = msg; $('wait').style.display = frameCount ? 'none' : 'block'; }

window.WifiRadar = { feedSerialLine: function (l) { onSerialLine(l); }, diag: function () { return diagChecks(); }, report: buildReport, log: dlog, ingest: function (f) { ingest(f, 'sim'); }, demoFrame: demoFrame, reset: reset, setWaiting: setWaiting, loadDemoWorld: loadDemoWorld, ready: true, frames: function () { return frameCount; }, aps: function () { return APS.size; } };
if (SIM) { $('bDemo').style.display = 'none'; $('bDemo2').style.display = 'none'; $('bSerial').style.display = 'none'; $('bSerial2').style.display = 'none'; $('bRst').style.display = 'none'; $('bRst2').style.display = 'none'; loadDemoWorld(); setWaiting('等待 ESP32 启动…', '在左侧虚拟开发板上按下 RESET 键（或按键盘 R）。'); }
if (Q.get('demo') === '1') startDemo();
sync(); window.__radarReady = true;
})();
</script>
</body>
</html>
'''

app = Flask(__name__)
LOCK = threading.Lock()
FRAMES = collections.deque(maxlen=400)
SEQ = 0
NODES = {}
SOLVED = {}
SERIES = {}            # bssid -> deque[(t, rssi)]
MOTION = {"v": 0.0, "base": None}
T0 = time.time()
PUBLIC_URL = ""
GPU_NAMES = []
RES_TEXT = ""
_last_solve = 0.0
HIST_Q = collections.deque(maxlen=20000)

try:
    import torch
    GPU_NAMES = [torch.cuda.get_device_name(i) for i in range(torch.cuda.device_count())]
except Exception:
    torch = None
NGPU = len(GPU_NAMES)
SERIES_MAXLEN = max(256, int(RAM_GB * 1024 ** 3 / 400 / 2000))   # 单 AP 历史点数上限（按 RAM 预算折算，最多 ~26000）
SERIES_MAXLEN = min(SERIES_MAXLEN, 26000)


@app.after_request
def _cors(r):
    r.headers["Access-Control-Allow-Origin"] = "*"
    r.headers["Access-Control-Allow-Headers"] = "*"
    r.headers["Cache-Control"] = "no-store"
    return r


@app.get("/")
@app.get("/radar.html")
def index():
    return Response(HTML, mimetype="text/html")


@app.get("/api/health")
def health():
    return jsonify(ok=True, version=VERSION, frames=SEQ, uptime=int(time.time() - T0), gpu=GPU_NAMES, res=RES_TEXT)


@app.route("/api/ingest", methods=["POST", "OPTIONS"])
def ingest():
    global SEQ
    if request.method == "OPTIONS":
        return ("", 204)
    key = request.headers.get("X-Key") or request.args.get("key")
    origin_host = urlparse(request.headers.get("Origin", "") or "").netloc
    same = request.headers.get("Sec-Fetch-Site") == "same-origin" or (origin_host != "" and origin_host == request.host)
    src = "网页USB转发" if same else "ESP32 WiFi直传"
    if key != API_KEY and not same:
        evt_rate("badkey", 5, "ERR", "ingest", "拒绝 %s 的上传：API_KEY 不一致（收到 %r，期望 %r）。请把 config.h 的 API_KEY 改成与本脚本一致" % (request.headers.get("CF-Connecting-IP") or request.remote_addr, key, API_KEY))
        return jsonify(ok=False, error="bad key"), 401
    f = request.get_json(force=True, silent=True)
    if not isinstance(f, dict) or not isinstance(f.get("aps"), list):
        evt_rate("badframe", 5, "ERR", "ingest", "收到格式错误的数据（%s，%d 字节）：缺少 aps 数组" % (src, len(request.get_data() or b"")))
        return jsonify(ok=False, error="bad frame"), 400
    t = time.time()
    with LOCK:
        SEQ += 1
        f["_seq"] = SEQ
        f["_t"] = t
        FRAMES.append(f)
        nid = str(f.get("node", "node"))
        n = NODES.setdefault(nid, {"frames": 0, "obs": {}})
        n["x"] = float(f.get("x") or 0)
        n["y"] = float(f.get("y") or 0)
        n["last"] = t
        n["frames"] += 1
        n["aps"] = len(f["aps"])
        n["ip"] = request.headers.get("CF-Connecting-IP") or request.remote_addr
        for a in f["aps"]:
            try:
                b = str(a["b"]).upper()
                r = float(a["r"])
                old = n["obs"].get(b)
                n["obs"][b] = {"r": r if old is None else old["r"] * 0.7 + r * 0.3, "c": int(a.get("c", 6)), "t": t}
                dq = SERIES.get(b)
                if dq is None:
                    dq = SERIES[b] = collections.deque(maxlen=SERIES_MAXLEN)
                dq.append((t, r))
            except Exception:
                continue
        seq = SEQ
        nframes = n["frames"]
    if nframes == 1 or nframes % 20 == 0:
        evt("OK", "ingest", "收到 %s 帧 #%d：node=%s 来自 %s · AP=%d · 设备=%d · 累计 %d 帧" % (src, seq, nid, n.get("ip"), len(f["aps"]), len(f.get("st") or []), nframes), echo=(nframes == 1 or nframes % 60 == 0))
    HIST_Q.append(json.dumps({"t": round(t, 2), "f": f}, ensure_ascii=False, separators=(",", ":")))
    threading.Thread(target=solve_positions, daemon=True).start()
    return jsonify(ok=True, seq=seq)


@app.get("/api/frames")
def frames():
    try:
        since = int(request.args.get("since", "0"))
    except ValueError:
        since = 0
    with LOCK:
        if since <= 0 or since > SEQ:
            last = {}
            for f in FRAMES:
                last[f.get("node")] = f
            out = list(last.values())
        else:
            out = [f for f in FRAMES if f["_seq"] > since][-60:]
        now_ = time.time()
        out = [dict(x, age=round(now_ - x.get("_t", now_), 1)) for x in out]
        status = {
            "gpu": GPU_NAMES, "frames": SEQ, "uptime": int(time.time() - T0), "public": PUBLIC_URL,
            "motion": round(MOTION["v"], 3), "res": RES_TEXT,
            "nodes": {k: {"frames": v["frames"], "aps": v.get("aps", 0), "ip": v.get("ip"), "age": round(time.time() - v.get("last", 0), 1)} for k, v in NODES.items()},
        }
        return jsonify(seq=SEQ, frames=out, solved=SOLVED, status=status)


def server_diag(n_events=80):
    now = time.time()
    d = {
        "version": VERSION, "time": time.strftime("%Y-%m-%d %H:%M:%S"), "python": sys.version.split()[0], "uptime": int(now - T0),
        "public_url": PUBLIC_URL, "tunnel": TUNNEL, "frames": SEQ, "gpu": GPU_NAMES, "res": RES_TEXT,
        "torch": getattr(torch, "__version__", None) if torch is not None else None,
        "cuda": bool(torch is not None and torch.cuda.is_available()),
        "budgets": {"vram_gb": VRAM_GB, "ram_gb": RAM_GB, "disk_gb": DISK_GB, "restarts": RESTARTS},
        "series": len(SERIES), "series_maxlen": SERIES_MAXLEN, "events_file": EVT_FILE, "hist_dir": HIST_DIR,
        "nodes": {k: {"frames": v["frames"], "aps": v.get("aps", 0), "ip": v.get("ip"), "age": round(now - v.get("last", 0), 1)} for k, v in list(NODES.items())},
        "solved": len(SOLVED), "motion": round(MOTION["v"], 3),
    }
    try:
        if torch is not None and NGPU:
            d["gpu_mem"] = []
            for i in range(NGPU):
                free, total = torch.cuda.mem_get_info(i)
                d["gpu_mem"].append({"gpu": i, "name": GPU_NAMES[i], "used_gb": round((total - free) / 1024 ** 3, 2), "total_gb": round(total / 1024 ** 3, 2)})
    except Exception as e:
        d["gpu_mem_err"] = str(e)
    d["recent"] = list(EVENTS)[-n_events:]
    return d


@app.get("/api/diag")
def diag():
    return jsonify(server_diag())


@app.get("/api/diag.txt")
def diag_txt():
    d = server_diag(400)
    L = ["===== WiFi RADAR 服务端检测日志 v%s =====" % d["version"], "时间: %s  运行 %ds  Python %s  torch=%s cuda=%s" % (d["time"], d["uptime"], d["python"], d["torch"], d["cuda"]),
         "公网地址: %s  隧道: %s" % (d["public_url"], json.dumps(d["tunnel"], ensure_ascii=False)), "GPU: %s  显存: %s" % (d["gpu"], json.dumps(d.get("gpu_mem"), ensure_ascii=False)), "资源: %s" % d["res"],
         "预算: %s" % json.dumps(d["budgets"]), "总帧数: %d  节点: %s" % (d["frames"], json.dumps(d["nodes"], ensure_ascii=False)), "", "--- 事件 ---"]
    for e in d["recent"]:
        L.append("%s %s [%s] %s" % (time.strftime("%H:%M:%S", time.localtime(e["t"])), e["lv"], e["c"], e["m"]))
    return Response("\n".join(L), mimetype="text/plain; charset=utf-8")


@app.route("/api/clientlog", methods=["POST", "OPTIONS"])
def clientlog():
    if request.method == "OPTIONS":
        return ("", 204)
    j = request.get_json(force=True, silent=True) or {}
    for e in (j.get("entries") or [])[:100]:
        try:
            lv = str(e.get("lv", "INFO"))[:5]
            m = str(e.get("m", ""))
            evt(lv, "web/" + str(e.get("c", ""))[:12], m, echo=False, t=float(e.get("t", 0)) / 1000.0 or None)
            if lv == "ERR":
                evt_rate("web:" + m[:50], 15, "ERR", "web", m[:300])
        except Exception:
            continue
    return jsonify(ok=True)


@app.route("/api/reset", methods=["POST", "OPTIONS"])
def reset_state():
    global SEQ, SOLVED
    if request.method == "OPTIONS":
        return ("", 204)
    with LOCK:
        FRAMES.clear()
        NODES.clear()
        SERIES.clear()
        SOLVED = {}
        SEQ = 0
    evt("INFO", "server", "已清空帧缓存/节点/历史序列（/api/reset）", echo=True)
    return jsonify(ok=True)


@app.get("/api/stats")
def stats():
    return jsonify(res=RES_TEXT, gpu=GPU_NAMES, series=len(SERIES), series_maxlen=SERIES_MAXLEN, hist_dir=HIST_DIR,
                   budgets={"vram_gb": VRAM_GB, "ram_gb": RAM_GB, "disk_gb": DISK_GB, "restarts": RESTARTS}, motion=MOTION["v"])


# ---------------------------------------------------------------- 多 GPU 三边定位
def _dist(rssi, ch):
    return min(150.0, max(0.5, 10 ** (((PATH_TX - (7 if ch > 14 else 0)) - rssi) / (10 * PATH_N))))


def _solve_chunk(items, dev, R):
    """在单个设备上批量求解一组 AP 的位置。items: [(bssid, [(x, y, d, w), ...])]"""
    N, K = len(items), max(len(v) for _, v in items)
    P = torch.zeros(N, K, 2)
    D = torch.zeros(N, K)
    W = torch.zeros(N, K)
    for i, (_, v) in enumerate(items):
        for j, (x, y, d, w) in enumerate(v):
            P[i, j, 0], P[i, j, 1], D[i, j], W[i, j] = x, y, d, w
    P, D, W = P.to(dev), D.to(dev), W.to(dev)
    cen = (P * W[..., None]).sum(1) / W.sum(1, keepdim=True).clamp(min=1e-6)
    scale = D.max(1).values.clamp(min=2.0)
    X = (cen[:, None, :] + torch.randn(N, R, 2, device=dev) * scale[:, None, None]).requires_grad_(True)
    opt = torch.optim.Adam([X], lr=0.6)

    def loss_fn():
        dist = torch.sqrt(((X[:, :, None, :] - P[:, None, :, :]) ** 2).sum(-1) + 1e-6)
        return (W[:, None, :] * (dist - D[:, None, :]) ** 2).sum(-1)

    for _ in range(150):
        opt.zero_grad()
        loss_fn().sum().backward()
        opt.step()
    with torch.no_grad():
        L = loss_fn()
        best = L.argmin(1)
        idx = torch.arange(N, device=dev)
        pos = X[idx, best].cpu().tolist()
        res = (L[idx, best] / W.sum(1).clamp(min=1e-6)).sqrt().cpu().tolist()
    return pos, res


def multilaterate(items):
    out = {}
    if torch is None:
        for b, v in items:
            ws = sum(w for _, _, _, w in v)
            out[b] = {"x": sum(x * w for x, _, _, w in v) / ws, "y": sum(y * w for _, y, _, w in v) / ws, "n": len(v), "res": -1}
        return out
    devs = [torch.device("cuda:%d" % i) for i in range(NGPU)] or [torch.device("cpu")]
    K = max(len(v) for _, v in items)
    # 每个起点约占 (K*2 + 2) 个 float，Adam+autograd 约 x8；按显存预算决定一批最多处理多少个 AP
    per_ap = RESTARTS * (K * 4 + 8) * 4 * 8
    chunk = max(1, int(VRAM_GB * 1024 ** 3 / per_ap))
    shards = [items[i::len(devs)] for i in range(len(devs))]
    results = [None] * len(devs)

    def work(i):
        its = shards[i]
        pos, res = [], []
        for s in range(0, len(its), chunk):
            p, r = _solve_chunk(its[s:s + chunk], devs[i], RESTARTS)
            pos += p
            res += r
        results[i] = (its, pos, res)

    th = [threading.Thread(target=work, args=(i,)) for i in range(len(devs)) if shards[i]]
    for t in th:
        t.start()
    for t in th:
        t.join()
    for r in results:
        if not r:
            continue
        its, pos, res = r
        for (b, v), p, rr in zip(its, pos, res):
            px, py = p
            uniq = {(round(x, 3), round(y, 3)) for x, y, _, _ in v}
            if len(uniq) == 2:   # 两个节点存在镜像歧义：固定解在 A->B 连线左侧，避免来回跳动
                (ax, ay), (bx, by) = sorted(uniq)
                dx, dy = bx - ax, by - ay
                if dx * (py - ay) - dy * (px - ax) < 0:
                    ln = math.hypot(dx, dy) or 1.0
                    ux, uy = dx / ln, dy / ln
                    tt = (px - ax) * ux + (py - ay) * uy
                    px, py = 2 * (ax + ux * tt) - px, 2 * (ay + uy * tt) - py
            out[b] = {"x": round(px, 2), "y": round(py, 2), "n": len(v), "res": round(rr, 2)}
    return out


def solve_positions():
    global SOLVED, _last_solve
    t = time.time()
    if t - _last_solve < 1.0:
        return
    with LOCK:
        fresh = {k: v for k, v in NODES.items() if t - v.get("last", 0) < 20}
        if len(fresh) < 2:
            SOLVED = {}
            return
        _last_solve = t
        per = {}
        for nid, n in fresh.items():
            for b, o in n["obs"].items():
                if t - o["t"] < 20:
                    d = _dist(o["r"], o["c"])
                    per.setdefault(b, []).append((n["x"], n["y"], d, 1.0 / (1.0 + d / 5.0)))
    items = [(b, v) for b, v in per.items() if len(v) >= 2]
    if not items:
        return
    try:
        res = multilaterate(items)
        with LOCK:
            SOLVED = res
    except Exception as e:
        print("[solve] error:", e)


def selftest():
    """启动自检：随机 3 个节点 + 40 个 AP，在所有 GPU 上求解，打印中位数误差。"""
    try:
        rnd = random.Random(1)
        nodes = [(0, 0), (30, 0), (0, 30)]
        items, truth = [], {}
        for i in range(40):
            tx, ty = rnd.uniform(-40, 60), rnd.uniform(-40, 60)
            truth["AP%d" % i] = (tx, ty)
            items.append(("AP%d" % i, [(nx, ny, math.hypot(tx - nx, ty - ny) * rnd.uniform(0.95, 1.05), 1.0) for nx, ny in nodes]))
        t = time.time()
        res = multilaterate(items)
        errs = sorted(math.hypot(res[b]["x"] - truth[b][0], res[b]["y"] - truth[b][1]) for b in truth)
        print("[selftest] 三边定位 %d 个 AP, 设备=%s, 用时 %.2fs, 中位误差 %.2f m" % (len(items), (GPU_NAMES or ["CPU"]), time.time() - t, errs[len(errs) // 2]), flush=True)
    except Exception as e:
        print("[selftest] 失败:", e, flush=True)


# ---------------------------------------------------------------- GPU 运动检测 + 资源监控 + 磁盘历史
def motion_loop():
    T = 24
    while True:
        time.sleep(1.0)
        try:
            now = time.time()
            with LOCK:
                rows = [[r for (t, r) in list(dq)[-T:]] for dq in SERIES.values() if len(dq) >= T and now - dq[-1][0] < 15 and dq[-1][1] > -85]
            if len(rows) < 2:
                MOTION["v"] *= 0.9
                continue
            if torch is not None:
                dev = torch.device("cuda:0" if NGPU else "cpu")
                M = torch.tensor(rows, dtype=torch.float32, device=dev)
                short = M.std(dim=1).mean().item()
                diff = M.diff(dim=1).abs().mean().item()
                cur = 0.6 * short + 0.4 * diff
            else:
                import statistics
                cur = sum(statistics.pstdev(r) for r in rows) / len(rows)
            b = MOTION["base"]
            MOTION["base"] = cur if b is None else b + (0.004 if cur > b else 0.06) * (cur - b)
            MOTION["v"] = max(0.0, min(1.0, (cur - MOTION["base"]) / 1.6))
        except Exception:
            pass


def _meminfo():
    d = {}
    try:
        for l in open("/proc/meminfo"):
            k, v = l.split(":")
            d[k] = int(v.split()[0]) * 1024
    except Exception:
        pass
    return d


def res_loop():
    global RES_TEXT
    while True:
        try:
            parts = []
            if torch is not None and NGPU:
                v = []
                for i in range(NGPU):
                    free, total = torch.cuda.mem_get_info(i)
                    v.append("%.1f/%.0fG" % ((total - free) / 1024 ** 3, total / 1024 ** 3))
                parts.append("显存 " + " | ".join(v))
            m = _meminfo()
            if m:
                parts.append("内存 %.1f/%.0fG" % ((m["MemTotal"] - m.get("MemAvailable", 0)) / 1024 ** 3, m["MemTotal"] / 1024 ** 3))
            du = shutil.disk_usage(os.path.dirname(HIST_DIR))
            used = sum(os.path.getsize(f) for f in glob.glob(HIST_DIR + "/*.jsonl")) if os.path.isdir(HIST_DIR) else 0
            parts.append("磁盘 历史 %.2fG (余 %.0fG)" % (used / 1024 ** 3, du.free / 1024 ** 3))
            RES_TEXT = " · ".join(parts)
        except Exception:
            pass
        time.sleep(5)


def hist_writer():
    os.makedirs(HIST_DIR, exist_ok=True)
    cur, cur_size = None, 0
    while True:
        if not HIST_Q:
            time.sleep(0.5)
            continue
        try:
            if cur is None or cur_size > 256 * 1024 ** 2:
                if cur:
                    cur.close()
                cur = open(os.path.join(HIST_DIR, "frames_%d.jsonl" % int(time.time())), "a", encoding="utf8")
                cur_size = 0
                files = sorted(glob.glob(HIST_DIR + "/*.jsonl"))
                total = sum(os.path.getsize(f) for f in files)
                while total > DISK_GB * 1024 ** 3 and len(files) > 1:   # 超过磁盘预算：删除最旧的
                    total -= os.path.getsize(files[0])
                    os.remove(files.pop(0))
            n = 0
            while HIST_Q and n < 500:
                line = HIST_Q.popleft() + "\n"
                cur.write(line)
                cur_size += len(line)
                n += 1
            cur.flush()
        except Exception as e:
            print("[hist] error:", e)
            time.sleep(2)


# ---------------------------------------------------------------- 真实世界：beaconDB 定位 + OSM 建筑
GEO_CACHE = {}
OVERPASS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"]


def wifi_geolocate():
    with LOCK:
        best = {}
        for n in NODES.values():
            for b, o in n["obs"].items():
                if int(b[:2], 16) & 2:        # 本地管理(随机化)MAC 不在数据库里
                    continue
                if b not in best or o["r"] > best[b]["r"]:
                    best[b] = o
    aps = sorted(best.items(), key=lambda kv: -kv[1]["r"])[:20]
    if len(aps) < 2:
        raise RuntimeError("可用于定位的 AP 少于 2 个，请等 ESP32 上传数据后再试")
    body = {"considerIp": False, "fallbacks": {"lacf": False, "ipf": False},
            "wifiAccessPoints": [{"macAddress": b, "signalStrength": int(o["r"]), "channel": o["c"]} for b, o in aps]}
    r = requests.post("https://api.beacondb.net/v1/geolocate", json=body, headers=UA, timeout=15)
    if r.status_code != 200:
        raise RuntimeError("beaconDB 没有这些热点的位置记录(HTTP %d)，请手动输入经纬度" % r.status_code)
    j = r.json()
    return float(j["location"]["lat"]), float(j["location"]["lng"]), float(j.get("accuracy") or 100)


def osm_scene(lat, lon, radius=260):
    q = '[out:json][timeout:25];(way["building"](around:%d,%f,%f);way["highway"](around:%d,%f,%f););out geom 3000;' % (radius, lat, lon, radius, lat, lon)
    last = None
    for url in OVERPASS:
        try:
            r = requests.post(url, data={"data": q}, headers=UA, timeout=45)
            if r.status_code == 200:
                els = r.json().get("elements", [])
                break
            last = "HTTP %d" % r.status_code
        except Exception as e:
            last = str(e)
    else:
        raise RuntimeError("Overpass 不可用: %s" % last)
    kx, ky = 111320.0 * math.cos(math.radians(lat)), 110540.0
    buildings, roads = [], []
    for e in els:
        g = e.get("geometry")
        if not g or len(g) < 2:
            continue
        pts = [[round((p["lon"] - lon) * kx, 1), round((p["lat"] - lat) * ky, 1)] for p in g]
        tags = e.get("tags", {})
        if "building" in tags:
            try:
                h = float(str(tags.get("height", "")).split()[0])
            except Exception:
                try:
                    h = float(tags.get("building:levels")) * 3.2
                except Exception:
                    h = 6 + (e.get("id", 0) % 9) * 1.5
            buildings.append({"h": round(h, 1), "pts": pts})
        elif tags.get("highway") not in ("steps", "footway", "path", "corridor"):
            roads.append(pts)
    return buildings[:1800], roads[:1500]


@app.get("/api/geo")
def geo():
    try:
        if request.args.get("lat") and request.args.get("lon"):
            lat, lon, acc, how = float(request.args["lat"]), float(request.args["lon"]), 0, "手动坐标"
        else:
            lat, lon, acc = wifi_geolocate()
            how = "WiFi 定位(beaconDB)"
        key = (round(lat, 3), round(lon, 3))
        if key not in GEO_CACHE:
            GEO_CACHE[key] = osm_scene(lat, lon)
        b, r = GEO_CACHE[key]
        return jsonify(ok=True, lat=lat, lon=lon, accuracy=acc, buildings=b, roads=r, label="OpenStreetMap 真实街区 · " + how)
    except Exception as e:
        return jsonify(ok=False, error=str(e))


# ---------------------------------------------------------------- 隧道
def _banner(url):
    global PUBLIC_URL
    PUBLIC_URL = url
    TUNNEL["state"] = "已建立"
    TUNNEL["url"] = url
    evt("OK", "tunnel", "公网隧道已建立：" + url)
    line = "=" * 66
    print("\n" + line)
    print("🌐 全屏 3D 网站： " + url)
    print('📟 ESP32 config.h： #define SERVER_URL "%s"' % url)
    print("   或串口输入：     url %s" % url)
    print("🔌 最稳方案：     用电脑 Chrome/Edge 打开上面网址 -> 点【USB 连接 ESP32】")
    print("🔑 API_KEY：       %s" % API_KEY)
    print("🩺 检测日志：     网页里点【🩺 检测日志】，或打开 %s/api/diag.txt（也写入 %s）" % (url, EVT_FILE))
    print(line + "\n", flush=True)
    try:
        from IPython.display import display, HTML as _H
        display(_H('<a href="%s" target="_blank" style="font-size:18px">▶ 点此打开全屏 3D 世界</a>' % url))
    except Exception:
        pass
    threading.Thread(target=_probe, args=(url,), daemon=True).start()


def _probe(url):
    for i in range(15):
        try:
            r = requests.get(url + "/api/health", timeout=8, headers=UA)
            if r.status_code == 200:
                TUNNEL["probe"] = "通过"
                evt("OK", "tunnel", "公网自检通过：%s/api/health" % url, echo=True)
                return
        except Exception:
            pass
        time.sleep(4)
    TUNNEL["probe"] = "未通过"
    evt("WARN", "tunnel", "公网自检 15 次均未通过")
    print("[tunnel] ⚠ 公网自检未通过（隧道可能还在生效，或被网络拦截）。可稍后刷新，或设置 NGROK_TOKEN 改用 ngrok。", flush=True)


def start_cloudflared():
    exe = shutil.which("cloudflared") or "/tmp/cloudflared"
    if not os.path.exists(exe):
        print("[tunnel] 下载 cloudflared …")
        urllib.request.urlretrieve("https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64", exe)
        os.chmod(exe, 0o755)

    def runner():
        for attempt in range(1, 6):
            p = subprocess.Popen([exe, "tunnel", "--url", "http://127.0.0.1:%d" % PORT, "--no-autoupdate", "--protocol", "http2"],
                                 stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
            shown = False
            for line in p.stdout:
                m = re.search(r"https://[a-z0-9-]+\.trycloudflare\.com", line)
                if m and not shown:
                    shown = True
                    _banner(m.group(0))
            TUNNEL["state"] = "重试中"
            TUNNEL["attempts"] = attempt
            evt("WARN", "tunnel", "cloudflared 退出，第 %d 次重试…" % attempt, echo=True)
            time.sleep(3)

    threading.Thread(target=runner, daemon=True).start()


def start_ngrok():
    _ensure("pyngrok")
    from pyngrok import ngrok
    ngrok.set_auth_token(NGROK_TOKEN)
    _banner(ngrok.connect(PORT, "http").public_url.replace("http://", "https://"))


def main():
    from werkzeug.serving import make_server
    srv = make_server("0.0.0.0", PORT, app, threaded=True)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    print("[server] 监听 0.0.0.0:%d  GPU: %s" % (PORT, ", ".join(GPU_NAMES) or "无(CPU)"))
    print("[budget] 显存<=%.0fG/卡  内存<=%.0fG  磁盘<=%.0fG(%s)  起点数=%d" % (VRAM_GB, RAM_GB, DISK_GB, HIST_DIR, RESTARTS), flush=True)
    evt("INFO", "boot", "服务端 v%s 启动：python=%s torch=%s GPU=%s 日志文件=%s" % (VERSION, sys.version.split()[0], getattr(torch, "__version__", None) if torch is not None else "未安装", GPU_NAMES or "无", EVT_FILE), echo=True)
    for fn in (motion_loop, res_loop, hist_writer):
        threading.Thread(target=fn, daemon=True).start()
    threading.Thread(target=selftest, daemon=True).start()
    if USE_TUNNEL:
        if NGROK_TOKEN:
            start_ngrok()
        else:
            start_cloudflared()
    else:
        print("[server] 本地模式: http://127.0.0.1:%d" % PORT)
    try:
        while True:
            time.sleep(30)
            print("[status] frames=%d nodes=%s uptime=%ds | %s" % (SEQ, list(NODES.keys()), time.time() - T0, RES_TEXT), flush=True)
    except KeyboardInterrupt:
        print("stopped")


if __name__ == "__main__" or "ipykernel" in sys.modules:
    main()
