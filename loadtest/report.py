"""Markdown summary of a k6 run plus container CPU/RAM samples (loadtest/out)."""
import json
from pathlib import Path

out = Path(__file__).parent / "out"
s = json.loads((out / "summary.json").read_text())
m = s["metrics"]
dur = m["http_req_duration"]
reqs = m["http_reqs"]
failed = m["http_req_failed"]

cpu, mem = [], []
for line in (out / "stats.csv").read_text().splitlines():
    try:
        c, u = line.split(";")
        cpu.append(float(c.rstrip("%")))
        used = u.split("/")[0].strip()
        mem.append(float(used[:-3]) * (1024 if used.endswith("GiB") else 1))
    except ValueError:
        continue
busy = [c for c in cpu if c > 5]

print("| Метрика | Значение |")
print("|---|---|")
print(f"| Запросов всего | {int(reqs['count'])} |")
print(f"| Пропускная способность | {reqs['rate']:.0f} RPS |")
print(f"| Задержка p50 / p95 / p99 | {dur['med']:.1f} / {dur['p(95)']:.1f} / {dur['p(99)']:.1f} мс |")
print(f"| Ошибки | {failed['value'] * 100:.2f} % |")
if busy:
    print(f"| CPU контейнера (2 vCPU = 200 %) | среднее {sum(busy) / len(busy):.0f} %, максимум {max(busy):.0f} % |")
if mem:
    print(f"| Память контейнера | от {min(mem):.0f} до {max(mem):.0f} МиБ |")
