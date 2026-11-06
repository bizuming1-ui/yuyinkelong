#!/usr/bin/env python3
# 把 kaggle/bzm_daemon.py 的内容内嵌进 kaggle/kaggle_cell.py（在 DAEMON_BEGIN / DAEMON_END 标记之间）。
#   python tools/make_kaggle_cell.py          重新生成
#   python tools/make_kaggle_cell.py --check  只检查是否同步（不同步则 exit 1）；同时检查两个文件都能被 Python 编译
import os, sys, re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DAEMON = os.path.join(ROOT, "kaggle", "bzm_daemon.py")
CELL = os.path.join(ROOT, "kaggle", "kaggle_cell.py")
PAT = re.compile(r"(# <<<DAEMON_BEGIN>>>\nDAEMON_SRC = r''')(.*?)(\n''')(\n# <<<DAEMON_END>>>)", re.S)


def main():
    daemon = open(DAEMON, "r", encoding="utf-8").read()
    if "'''" in daemon:
        print("bzm_daemon.py 里不能出现三个连续单引号（会破坏内嵌字符串），请改用三个双引号。")
        return 2
    if daemon.endswith("\\"):
        print("bzm_daemon.py 不能以反斜杠结尾。")
        return 2
    cell = open(CELL, "r", encoding="utf-8").read()
    m = PAT.search(cell)
    if not m:
        print("kaggle_cell.py 里找不到 DAEMON_BEGIN/END 标记。")
        return 2
    new = cell[: m.start(2)] + "\n" + daemon.rstrip("\n") + cell[m.start(3):]
    if "--check" in sys.argv:
        ok = new == cell
        for p in (DAEMON, CELL):
            compile(open(p, "r", encoding="utf-8").read(), p, "exec")
        print("kaggle_cell.py 内嵌副本与 bzm_daemon.py", "一致 ✓" if ok else "不一致 ✗（请运行 python tools/make_kaggle_cell.py）")
        return 0 if ok else 1
    with open(CELL, "w", encoding="utf-8") as f:
        f.write(new)
    compile(new, CELL, "exec")
    print("已生成 kaggle/kaggle_cell.py（内嵌 bzm_daemon.py，%d 字节）" % len(daemon.encode("utf-8")))
    return 0


if __name__ == "__main__":
    sys.exit(main())
