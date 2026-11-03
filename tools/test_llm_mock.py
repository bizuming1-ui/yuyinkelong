#!/usr/bin/env python3
# 用假的 tokenizer/模型验证 Kaggle 脚本里「LLM 场景解说」线程与 ai_status 的调用路径（无需 GPU/下载权重）
# 用法：python tools/test_llm_mock.py      （需要先 node scripts/build-kaggle.mjs 生成 kaggle/wifi_radar_kaggle.py，且已安装 torch）
import sys, os, time, threading, importlib.util
os.environ.update(RADAR_NO_TUNNEL="1", RADAR_LLM="off", RADAR_PORT="8013")
spec = importlib.util.spec_from_file_location("kg", os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "kaggle", "wifi_radar_kaggle.py"))
kg = importlib.util.module_from_spec(spec)
spec.loader.exec_module(kg)
import torch


class Enc(dict):
    def to(self, d):
        return self


class Tok:
    def apply_chat_template(self, msgs, tokenize=False, add_generation_prompt=True):
        self.last = msgs[1]["content"]
        return "PROMPT"

    def __call__(self, texts, return_tensors="pt"):
        return Enc(input_ids=torch.zeros(1, 5, dtype=torch.long))

    def decode(self, ids, skip_special_tokens=True):
        return "有人静止，呼吸约 16 次/分｜可信度80%"


class Mdl(torch.nn.Module):
    def __init__(self):
        super().__init__()
        self.p = torch.nn.Parameter(torch.zeros(1))

    def generate(self, **kw):
        return torch.zeros(1, 9, dtype=torch.long)


kg._LLM_OBJ.update(tok=Tok(), model=Mdl())
kg.LLM["state"] = "就绪"
kg.LLM["model"] = "Qwen/Qwen2.5-14B-Instruct"
threading.Thread(target=kg.scene_loop, daemon=True).start()
# 1) 有人 → 必须走 LLM
kg.SENSE["v"] = {"present": True, "act": "still", "level": 1.4, "breath": 16.2, "dom": 0.3, "snr": 8, "rate": 20, "age": 0.1}
time.sleep(4.5)
ok1 = kg.SCENE["engine"] == "llm" and "呼吸" in kg.SCENE["text"]
# 2) 空场 → 不调用 LLM，规则文案“房间无人”
kg.SCENE["t"] = 0
kg.SENSE["v"] = {"present": False, "act": "empty", "level": 0.9, "breath": 0, "dom": 0, "snr": 0, "rate": 20, "age": 0.1}
time.sleep(4.5)
ok2 = kg.SCENE["engine"] == "rules" and "无人" in kg.SCENE["text"]
kg._AI_CACHE["t"] = 0
ai = kg.ai_status()
ok3 = ai["state"] == "就绪" and ai["model"] == "Qwen2.5-14B-Instruct" and ai["scene"] == kg.SCENE["text"]
print("有人→LLM解说:", "PASS" if ok1 else "FAIL", kg.SCENE if not ok1 else "")
print("空场→规则(不编造人物):", "PASS" if ok2 else "FAIL", kg.SCENE["text"])
print("ai_status:", "PASS" if ok3 else "FAIL", ai)
kg.NGPU = 2
kg.LLM_NAME = "auto"
print("14B 候选链(2卡):", kg._llm_pick())
sys.stdout.flush()
os._exit(0 if ok1 and ok2 and ok3 else 1)
