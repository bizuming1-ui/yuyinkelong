# ============================================================================
#  upload_retry.py —— PlatformIO 烧录“防掉线”脚本（和 platformio.ini 放在同一个文件夹里）
#
#  解决的问题：烧录写到一半，Windows 上的 COM 口突然消失（USB 重新枚举/供电抖动/接触不良），
#  esptool 报  "Cannot configure port ... OSError(22, '指定不存在的设备')"，
#  接着再点 Upload 又变成  "Please specify upload_port"。
#
#  做法：把 PlatformIO 默认的“只试一次”改成“最多 4 次，自动降速重试”：
#    第 1 次  platformio.ini 里的 upload_speed（默认 230400）
#    第 2 次  115200 + 标准烧录器(stub)
#    第 3 次  115200 + ROM 直写（不上传 stub，最保守）
#    第 4 次  115200 + ROM 直写，再次等待端口恢复
#  每次失败后自动等待 COM 口重新出现（最长 30 秒），然后用“新出现的那个口”继续，
#  不需要你手动再点 Upload，也不需要重新填端口。
#  这个脚本只改“烧录动作”，不影响编译结果；脚本自身出错时会自动退回 PlatformIO 默认烧录。
# ============================================================================
Import("env")  # noqa: F821  (PlatformIO/SCons 注入)

import subprocess
import sys
import time

WAIT_PORT_S = 30
KNOWN_VIDS = {0x303A: "ESP32-S3 原生 USB 口(标 USB)", 0x1A86: "CH340/CH343 串口桥(标 UART/COM)",
              0x10C4: "CP210x 串口桥(标 UART/COM)", 0x0403: "FTDI 串口桥"}


def _ports():
    try:
        from serial.tools import list_ports
        return [(p.device, p.vid) for p in list_ports.comports() if p.vid in KNOWN_VIDS]
    except Exception:
        return []


def _all_names():
    try:
        from serial.tools import list_ports
        return [p.device for p in list_ports.comports()]
    except Exception:
        return []


def _say(msg):
    text = "\n[upload_retry] " + msg + "\n"
    try:
        sys.stdout.write(text)
    except Exception:  # Windows GBK 控制台遇到不认识的字符时不要让烧录失败
        sys.stdout.write(text.encode("ascii", "replace").decode("ascii"))
    sys.stdout.flush()


def _wait_port(prefer, seconds):
    """等待一个可用端口出现；优先返回原来的端口名。"""
    end = time.time() + seconds
    shown = False
    while time.time() < end:
        found = _ports()
        names = [d for d, _ in found]
        if prefer and (prefer in names or prefer in _all_names()):
            return prefer
        if names:
            return names[0]
        if not shown:
            _say("COM 口暂时消失了（USB 重新枚举中），等待它回来……如果一直不出现：拔掉 USB 线重新插上。")
            shown = True
        time.sleep(0.5)
    return None


def _set_arg(args, key, value):
    if key in args:
        args[args.index(key) + 1] = value
    else:
        args[0:0] = [key, value]


def _build_args(source, target, port, baud, no_stub):
    flags = [str(env.subst(f, source=source, target=target)).strip('"') for f in env.get("UPLOADERFLAGS", [])]  # noqa: F821
    flags = [f for f in flags if f != ""]
    _set_arg(flags, "--port", port)
    _set_arg(flags, "--baud", str(baud))
    if no_stub and "--no-stub" not in flags:
        # --no-stub 是 esptool 的全局选项，必须放在子命令 write_flash 之前
        flags.insert(flags.index("write_flash"), "--no-stub")
    app_offset = str(env.subst("$ESP32_APP_OFFSET", source=source, target=target)).strip()  # noqa: F821
    py = str(env.subst("$PYTHONEXE"))  # noqa: F821
    uploader = str(env.subst("$UPLOADER"))  # noqa: F821
    return [py, uploader] + flags + [app_offset, str(source[0])]


def upload_with_retry(source, target, env):  # noqa: F811
    port = env.subst("$UPLOAD_PORT")
    try:
        base_baud = int(env.subst("$UPLOAD_SPEED") or 230400)
    except ValueError:
        base_baud = 230400
    plan = [
        (base_baud, False),
        (115200, False),
        (115200, True),
        (115200, True),
    ]
    found = _ports()
    if found:
        _say("检测到的 ESP32 串口： " + "； ".join("%s = %s" % (d, KNOWN_VIDS[v]) for d, v in found))
        if len(found) > 1:
            _say("注意：同时插着多块板子，PlatformIO 会自动选一个。烧录时只插当前要烧的那一块最保险。")
        if any(v == 0x303A for _, v in found):
            _say("提示：你现在用的是原生 USB 口，这个口在烧录中途最容易掉线；优先换成标 UART/COM 的那个口。")
    rc = 1
    for i, (baud, no_stub) in enumerate(plan, 1):
        cur = _wait_port(port, WAIT_PORT_S if i > 1 else 0) or port
        if not cur:
            break
        port = cur
        _say("第 %d/%d 次烧录：端口 %s，速度 %d%s" % (i, len(plan), port, baud, "，ROM 直写(不用 stub)" if no_stub else ""))
        args = _build_args(source, target, port, baud, no_stub)
        rc = subprocess.call(args)
        if rc == 0:
            _say("烧录成功！（板子已自动重启运行；如需看日志，打开串口监视器 115200）")
            return 0
        _say("本次烧录失败（返回码 %s）。" % rc)
        if i < len(plan):
            _say("2 秒后自动重试。想更稳：现在按住板子 BOOT 键不放，点一下 RST，再松开 BOOT。")
            time.sleep(2)
    _say("4 次都失败了。这是硬件/USB 层问题，不是代码问题，请依次做：\n"
         "  1) 换一根带数据的短 USB 线，直插电脑主板后面板的 USB-A 口（不要接 HUB、不要用 Type-C 转接口）\n"
         "  2) 改用板子上标 UART/COM 的口烧录（板子上有两个 Type-C 口）\n"
         "  3) 关闭串口监视器/串口助手/Arduino IDE/其它占用 COM 口的软件\n"
         "  4) 设备管理器 → 通用串行总线控制器 → USB 根集线器 → 电源管理，取消“允许计算机关闭此设备以节约电源”\n"
         "  5) 按住 BOOT → 点 RST → 松开 BOOT，再点 Upload；或在 VS Code 底部选择环境 n16r8_slow\n"
         "  6) 只插一块板子；换一台电脑/换一个 USB 口再试")
    return rc or 1


try:
    _proto = env.subst("$UPLOAD_PROTOCOL")  # noqa: F821
    _targets = COMMAND_LINE_TARGETS  # noqa: F821
    if _proto == "esptool" and "uploadfs" not in _targets and "uploadfsota" not in _targets:
        env.Replace(UPLOADCMD=upload_with_retry)  # noqa: F821
except Exception as _e:  # 出任何问题都退回 PlatformIO 默认烧录
    sys.stdout.write("[upload_retry] 脚本未启用（%s），使用默认烧录。\n" % _e)
