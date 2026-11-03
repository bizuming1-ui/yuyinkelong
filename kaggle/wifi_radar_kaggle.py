#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
WiFi 雷达 · Kaggle 单文件服务端 v2（ESP32-S3 -> Kaggle T4x2 GPU -> 全屏 3D 网站）
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
"""
import os, sys, re, json, math, time, threading, subprocess, shutil, urllib.request, collections, random, glob

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
  <div class="btns" style="justify-content:center"><button class="pri" id="bSerial2">🔌 USB 直连 ESP32（最稳）</button><button id="bDemo">▶ 启动演示数据</button></div>
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
  if (!f || !Array.isArray(f.aps)) return;
  var t = now(), id = f.node || 'node';
  if (src === 'poll' && f.seq != null) { var k = id + ':' + f.seq; if (SEEN.has(k) && t - SEEN.get(k) < 60) return; }
  if (src === 'usb' && f.seq != null) SEEN.set(id + ':' + f.seq, t);
  if (SEEN.size > 800) { SEEN.forEach(function (v, k2) { if (t - v > 60) SEEN.delete(k2); }); }
  var nd = NODES.get(id);
  if (!nd) { nd = { id: id, x: 0, y: 0, frames: 0 }; NODES.set(id, nd); }
  nd.x = +f.x || 0; nd.y = +f.y || 0; nd.last = t; nd.fw = f.fw; nd.frames++; nd.src = src || 'wifi';
  f.aps.forEach(function (a) {
    if (!a.b) return;
    var b = String(a.b).toUpperCase(), ap = APS.get(b);
    if (!ap) { ap = { bssid: b, ssid: '', obs: new Map(), pulse: 0, hit: 0, first: t, live: false }; APS.set(b, ap); }
    if (a.s) ap.ssid = a.s;
    ap.ch = a.c; ap.auth = a.a; ap.last = t;
    if (typeof a.ang === 'number') ap.fixedAngle = a.ang;
    var o = ap.obs.get(id);
    if (!o) { o = { k: new Kalman(a.r), raw: [], last: 0 }; ap.obs.set(id, o); }
    o.raw.push(a.r); if (o.raw.length > 16) o.raw.shift();
    o.rssi = o.k.update(a.r); o.last = t; o.lastRaw = a.r;
    ap.pulse = 1;
  });
  if (Array.isArray(f.st)) {
    f.st.forEach(function (s) {
      var m = String(s.m).toUpperCase(), st = STAS.get(m);
      if (!st) { st = { mac: m, rssi: s.r, first: t }; STAS.set(m, st); }
      st.rssi = st.rssi * 0.5 + s.r * 0.5; st.ch = s.c; st.cnt = s.n; st.bssid = s.b ? String(s.b).toUpperCase() : st.bssid; st.last = t; st.node = id;
    });
  }
  lastFrameAt = t; frameCount++; heatDirty = true;
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
function frame(tn) {
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
  requestAnimationFrame(frame);
}
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
$('bSerial').onclick = serialConnect; $('bSerial2').onclick = serialConnect;
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
  if (frameCount === 0) {
    $('diag').innerHTML = SIM ? '' : ('<div>' + (srvOK ? '✅' : '⏳') + ' ① 网页与 3D 引擎已加载</div><div>' + (srvOK === true ? '✅' : srvOK === false ? '❌' : '⏳') + ' ② 后端 /api/health ' + (srvOK === false ? '无响应：' + esc(srvErr) : '') + '</div><div>⏳ ③ 等待 ESP32 数据：已收 0 帧' + (lastSerial ? '（串口：' + esc(lastSerial) + '）' : '') + '</div><div style="color:#7f9db3">ESP32 联网困难时请点“USB 直连”，由电脑转发。</div>');
  }
}, 500);

/* ================= 服务器轮询 / 地理 ================= */
var since = 0;
async function poll() {
  if (SIM || mode === 'demo') return;
  try {
    var r = await fetch('api/frames?since=' + since, { cache: 'no-store' }); if (!r.ok) throw new Error('HTTP ' + r.status);
    var j = await r.json(); since = j.seq || 0; SOLVED = j.solved || {}; SERVER = j.status || null;
    (j.frames || []).forEach(function (f) { ingest(f, 'poll'); });
    srvMotion = SERVER && typeof SERVER.motion === 'number' ? SERVER.motion : null;
    if (SERVER) {
      var gp = SERVER.gpu && SERVER.gpu.length ? SERVER.gpu.join(' + ') : '无 GPU(CPU)';
      var res = SERVER.res ? ' · ' + SERVER.res : '';
      $('gpu').textContent = 'GPU: ' + gp + ' · 已接收 ' + (SERVER.frames || 0) + ' 帧' + res;
    }
  } catch (e) { /* 健康检查负责提示 */ }
}
async function health() {
  if (SIM) { $('gpu').textContent = '浏览器模拟器：固件由页面虚拟（数据为演示）'; return; }
  try { var r = await fetch('api/health', { cache: 'no-store' }); if (!r.ok) throw new Error('HTTP ' + r.status); srvOK = true; srvErr = ''; }
  catch (e) { srvOK = false; srvErr = String(e.message || e); }
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
async function postServer(f) {
  if (SIM) return;
  try {
    var r = await fetch('api/ingest', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Key': apiKey() }, body: JSON.stringify(f) });
    if (r.status === 401) { var k = prompt('服务器 API_KEY 不匹配，请输入 Kaggle 脚本里的 API_KEY：', apiKey()); if (k) lsSet('wradar2.key', k); }
  } catch (e) { /* 离线也能本地显示 */ }
}
function onSerialLine(l) {
  var k = l.indexOf('RADARJSON:');
  if (k >= 0) { try { var f = JSON.parse(l.slice(k + 10)); f.node = f.node || 'S3-USB'; ingest(f, 'usb'); postServer(f); } catch (e) {} }
  else if (l) lastSerial = l.slice(0, 90);
}
async function serialConnect() {
  if (!('serial' in navigator)) { toast('此浏览器不支持 Web Serial：请用电脑版 Chrome / Edge，并通过 https 或 localhost 打开本页', 8000); return; }
  var port; try { port = await navigator.serial.requestPort(); } catch (e) { return; }
  try { await port.open({ baudRate: 115200 }); } catch (e) { toast('串口打开失败：' + e.message + '（请关闭 PlatformIO 串口监视器等占用程序）', 8000); return; }
  serialOn = true; mode = SIM ? 'sim' : 'live'; toast('✅ 已连接 ESP32 串口，按一下 RESET 键开始'); $('wM').textContent = '已连接 USB，正在等待第一轮扫描结果（约 2~5 秒）…';
  var dec = new TextDecoder(), buf = '', reader = port.readable.getReader();
  try {
    for (;;) {
      var rr = await reader.read(); if (rr.done) break;
      buf += dec.decode(rr.value, { stream: true }); var i;
      while ((i = buf.indexOf('\n')) >= 0) { onSerialLine(buf.slice(0, i).trim()); buf = buf.slice(i + 1); }
      if (buf.length > 30000) buf = '';
    }
  } catch (e) { toast('串口断开：' + e.message); } finally { try { reader.releaseLock(); await port.close(); } catch (e2) {} serialOn = false; }
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

window.WifiRadar = { ingest: function (f) { ingest(f, 'sim'); }, demoFrame: demoFrame, reset: reset, setWaiting: setWaiting, loadDemoWorld: loadDemoWorld, ready: true, frames: function () { return frameCount; }, aps: function () { return APS.size; } };
if (SIM) { $('bDemo').style.display = 'none'; $('bDemo2').style.display = 'none'; $('bSerial').style.display = 'none'; $('bSerial2').style.display = 'none'; loadDemoWorld(); setWaiting('等待 ESP32 启动…', '在左侧虚拟开发板上按下 RESET 键（或按键盘 R）。'); }
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
    return jsonify(ok=True, frames=SEQ, uptime=int(time.time() - T0), gpu=GPU_NAMES, res=RES_TEXT)


@app.route("/api/ingest", methods=["POST", "OPTIONS"])
def ingest():
    global SEQ
    if request.method == "OPTIONS":
        return ("", 204)
    key = request.headers.get("X-Key") or request.args.get("key")
    if key != API_KEY:
        return jsonify(ok=False, error="bad key"), 401
    f = request.get_json(force=True, silent=True)
    if not isinstance(f, dict) or not isinstance(f.get("aps"), list):
        return jsonify(ok=False, error="bad frame"), 400
    t = time.time()
    with LOCK:
        SEQ += 1
        f["_seq"] = SEQ
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
        status = {
            "gpu": GPU_NAMES, "frames": SEQ, "uptime": int(time.time() - T0), "public": PUBLIC_URL,
            "motion": round(MOTION["v"], 3), "res": RES_TEXT,
            "nodes": {k: {"frames": v["frames"], "aps": v.get("aps", 0), "ip": v.get("ip"), "age": round(time.time() - v.get("last", 0), 1)} for k, v in NODES.items()},
        }
        return jsonify(seq=SEQ, frames=out, solved=SOLVED, status=status)


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
    line = "=" * 66
    print("\n" + line)
    print("🌐 全屏 3D 网站： " + url)
    print('📟 ESP32 config.h： #define SERVER_URL "%s"' % url)
    print("   或串口输入：     url %s" % url)
    print("🔌 最稳方案：     用电脑 Chrome/Edge 打开上面网址 -> 点【USB 连接 ESP32】")
    print("🔑 API_KEY：       %s" % API_KEY)
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
                print("[tunnel] ✅ 公网自检通过：%s/api/health" % url, flush=True)
                return
        except Exception:
            pass
        time.sleep(4)
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
            print("[tunnel] cloudflared 退出，第 %d 次重试…" % attempt, flush=True)
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
