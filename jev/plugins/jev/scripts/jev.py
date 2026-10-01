"""Плагин /jev: проверка, переключатели, прогон задачи по данным и сверка с разметкой.

  python3 jev.py setup                          # ключ, связь, что включено, траты, кто отвечал в сессии
  python3 jev.py on [router|skills]              # включить в проекте (без аргумента — оба)
  python3 jev.py off [router|skills]
  python3 jev.py run <задача> <файл или папка>   # CSV, JSONL, JSON-массив или папка (файл = запись)
  python3 jev.py check <задача> <размеченный файл> [--compare sonnet]

Задачи лежат в разделе tasks файла .claude/jev/questions.json проекта. Результат прогона —
<имя>.jev.csv: ответы, уверенность и колонка «перечитать» там, где Jev не уверен.
"""
import argparse
import csv
import json
import os
import re
import subprocess
import sys
import time
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import jev_client as jc  # noqa: E402

YES, NO, UNSURE = "да", "нет", "не уверен"
NO_KEY = ("Ключ Jev не найден. Запусти /jev:setup — он создаст файл ~/.claude/jev.env и откроет его: "
          "вставь ключ после JEV_API_KEY= и сохрани. В чат ключ не присылай.")
KEY_TEMPLATE = """# Ключ Jev для плагина /jev. Вставь ключ сразу после = без пробелов и сохрани файл.
# Подходит ключ OpenRouter (openrouter.ai/settings/keys) или TypeSafe (console.typesafe.ai/keys).
JEV_API_KEY=
"""


# ---------- setup, on, off ----------

def prepare_key_file():
    """Нет ключа: создаёт ~/.claude/jev.env по шаблону (если файла нет) и открывает его в редакторе."""
    path = jc.key_file()
    created = False
    if not path.exists():
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(KEY_TEMPLATE, encoding="utf-8")
            created = True
        except OSError as err:
            print("Ключ Jev не найден, а создать {} не вышло ({}). Создай файл сам — одна строка: "
                  "JEV_API_KEY=<ключ>. В чат ключ не присылай.".format(path, err))
            return
    if sys.platform == "darwin":
        command = ["open", "-e", str(path)]
    elif os.name == "nt":
        command = ["notepad", str(path)]
    else:
        command = ["xdg-open", str(path)]
    try:
        subprocess.Popen(command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        opened = "открыт в редакторе"
    except OSError:
        opened = "открой его в любом текстовом редакторе"
    print("Ключ Jev не найден. Файл {} {} — {}.".format(path, "создан" if created else "уже есть", opened))
    print("Вставь ключ после JEV_API_KEY= без пробелов, сохрани и снова запусти /jev:setup. "
          "Подходит ключ OpenRouter (openrouter.ai/settings/keys) или TypeSafe (console.typesafe.ai/keys). "
          "В чат ключ не присылай.")



def onoff(state):
    return "Роутер: {} · выбор скилла: {}".format("вкл" if state["router"] else "выкл",
                                                 "вкл" if state["skills"] else "выкл")


def find_transcript(project, records):
    """Журнал сессии Claude Code: из последней записи хука или самый свежий в папке проекта."""
    for record in reversed(records):
        if record.get("transcript") and Path(record["transcript"]).exists():
            return Path(record["transcript"])
    slug = re.sub(r"[^A-Za-z0-9]", "-", str(Path(project).resolve()))
    folder = Path.home() / ".claude" / "projects" / slug
    files = sorted(folder.glob("*.jsonl"), key=lambda p: p.stat().st_mtime) if folder.is_dir() else []
    return files[-1] if files else None


def session_models(path):
    """Сколько ответов дала каждая модель: в основном диалоге и у субагентов.

    Модель берётся из ответа API в журнале — это та, что ответила на самом деле. Журналы субагентов
    Claude Code пишет рядом, в <сессия>/subagents/*.jsonl; старые версии — в тот же файл с isSidechain.
    """
    main, side, seen = Counter(), Counter(), set()
    path = Path(path)
    files = [(path, False)] + [(f, True) for f in sorted((path.parent / path.stem / "subagents").glob("*.jsonl"))]
    for file, is_subagent in files:
        try:
            lines = file.read_text(encoding="utf-8").splitlines()
        except OSError:
            continue
        for line in lines:
            try:
                item = json.loads(line)
            except ValueError:
                continue
            if item.get("type") != "assistant":
                continue
            message = item.get("message") or {}
            key = item.get("requestId") or message.get("id") or item.get("uuid")
            if key in seen:  # один ответ модели занимает несколько строк журнала
                continue
            seen.add(key)
            model = message.get("model")
            if model and not model.startswith("<"):
                (side if is_subagent or item.get("isSidechain") else main)[model] += 1
    return main, side


def cmd_setup(args):
    cfg = jc.load_config(args.project)
    ok = True
    key, base, where = jc.find_credentials(args.project)
    if not key:
        ok = False
        prepare_key_file()
    else:
        print("Ключ Jev: {} из {} → {}".format(jc.mask(key), where, jc.provider_name(base)))
        question = {"ping": {"type": "noul", "instructions": "Это сообщение про оплату?"}}
        started = time.time()
        try:
            response = jc.ask("Списали деньги дважды, верните одну оплату", question, key, base,
                              model=cfg["settings"]["model"], timeout=15)
            print("Связь с Jev: ок — {} мс".format(int((time.time() - started) * 1000)))
        except (jc.JevError, KeyError) as err:
            ok = False
            print("Связь с Jev: ошибка — {}".format(err))
    print(onoff(jc.load_state(args.project)))
    if cfg["tasks"]:
        print("Задачи проекта: " + ", ".join("{} — {}".format(k, v.get("title", "")) for k, v in cfg["tasks"].items()))

    records = jc.read_log(args.project)
    hooks = [r for r in records if r.get("event") == "hook"]
    if hooks:
        print("Запросов через хук: {} · с подсказкой: {} · средняя задержка {} мс".format(
            len(hooks), sum(1 for r in hooks if r.get("hinted")), int(sum(r.get("ms", 0) for r in hooks) / len(hooks))))
        routed = [r for r in hooks if r.get("action")]
        if routed:
            delegated = Counter(r["model_hint"] for r in routed if r["action"] == "delegate")
            switched = Counter(r["model_hint"] for r in routed if r["action"] in ("switch", "switch_up", "switch_down", "ask"))
            parts = []
            if delegated:
                parts.append("отдал субагентам — " + ", ".join("{} {}".format(k, v) for k, v in delegated.most_common()))
            if switched:
                parts.append("предложил переключить модель — " + ", ".join(
                    "на {} {}".format(k, v) for k, v in switched.most_common()))
            same = sum(1 for r in routed if r["action"] in ("same", "switch_repeat"))
            if same:
                parts.append("оставил модель сессии — {}".format(same))
            print("Решения роутера: " + " · ".join(parts))
        skills = Counter(r["skill"] for r in hooks if r.get("skill_hinted"))
        if skills:
            print("Подсказанные скиллы: " + ", ".join("{} — {}".format(k, v) for k, v in skills.most_common(8)))
    errors = sum(1 for r in records if r.get("event") == "hook_error")
    if errors:
        print("Ошибок связи в хуке: {}".format(errors))
    if records:
        print("Потрачено на Jev всего: ${}".format(jc.fmt(sum(r.get("cost_usd", 0) for r in records), 4)))

    transcript = find_transcript(args.project, records)
    if transcript:
        main, side = session_models(transcript)
        print("Кто отвечал в сессии {} (журнал Claude Code):".format(transcript.stem[:8]))
        print("  основной диалог: " + (", ".join("{} — {}".format(k, v) for k, v in main.most_common()) or "—"))
        print("  субагенты: " + (", ".join("{} — {}".format(k, v) for k, v in side.most_common()) or "—"))
    return 0 if ok else 1


def cmd_toggle(args, value):
    state = jc.load_state(args.project)
    for part in [args.part] if args.part else ["router", "skills"]:
        state[part] = value
    jc.save_state(args.project, state)
    print(onoff(state))
    return 0


# ---------- run ----------

def read_records(source, pattern="*", max_chars=20000):
    """Файл (CSV с запятой или точкой с запятой, JSONL, JSON-массив) или папка → список словарей.
    В папке каждый текстовый файл — запись {"file", "text"}, двоичные пропускаются."""
    path = Path(source)
    if path.is_dir():
        rows = []
        for item in sorted(path.rglob(pattern)):
            if not item.is_file() or item.name.startswith("."):
                continue
            try:
                text = item.read_text(encoding="utf-8")
            except (UnicodeDecodeError, OSError):
                continue
            rows.append({"file": str(item.relative_to(path)), "text": text[:max_chars]})
        return rows
    suffix = path.suffix.lower()
    if suffix in (".xlsx", ".xls"):
        raise SystemExit("Excel не читается напрямую — сохрани лист как CSV (UTF-8).")
    text = path.read_text(encoding="utf-8-sig")
    if suffix == ".jsonl":
        return [json.loads(line) for line in text.splitlines() if line.strip()]
    if suffix == ".json":
        data = json.loads(text)
        if not isinstance(data, list):
            raise SystemExit("В JSON-файле нужен массив объектов.")
        return data
    try:
        dialect = csv.Sniffer().sniff(text[:4096], delimiters=",;\t")
    except csv.Error:
        dialect = csv.excel
    return list(csv.DictReader(text.splitlines(), dialect=dialect))


def get_task(cfg, name):
    if name not in cfg["tasks"]:
        raise SystemExit("Задачи «{}» нет в .claude/jev/questions.json проекта. Есть: {}.".format(
            name, ", ".join(cfg["tasks"]) or "пока ни одной"))
    return cfg["tasks"][name]


def build_state(row, fields):
    """Что уходит в Jev по одной записи: только поля из fields, пустые выкидываем."""
    if fields:
        missing = [f for f in fields if f not in row]
        if missing:
            raise ValueError("в записи нет полей {} (есть: {})".format(missing, list(row)))
        return {f: row[f] for f in fields if str(row[f]).strip()}
    return {k: v for k, v in row.items() if str(v).strip()}


def answer_columns(qid, answer, noul_unsure):
    """Колонки результата по одному вопросу."""
    kind = answer.get("type")
    if kind == "choice":
        return {qid: answer.get("choice", ""), qid + "_увер": jc.fmt(jc.confidence(answer))}
    if kind == "score":
        level = jc.score_level(answer)
        label = (answer.get("legend") or {}).get(str(level), str(level + 1))
        return {qid: label.split(":")[0], qid + "_балл": jc.fmt(float(answer.get("score", 0)) + 1),
                qid + "_увер": jc.fmt(jc.confidence(answer))}
    p = float(answer.get("noul", 0.5))
    low, high = noul_unsure
    return {qid: YES if p >= high else NO if p <= low else UNSURE, qid + "_вер": jc.fmt(p)}


def run_task(task, rows, key, base, settings):
    """Прогоняет все записи: по одному запросу на запись, все вопросы задачи сразу."""
    questions = task["questions"]
    review_below = task.get("review_below", 0.8)
    noul_unsure = task.get("noul_unsure", [0.3, 0.7])
    done, latency = [0], []

    def one(row):
        out = {}
        started = time.time()
        try:
            response = jc.ask(build_state(row, task.get("fields")), questions, key, base,
                              model=settings["model"], timeout=settings["batch_timeout_sec"], retries=3)
        except (jc.JevError, ValueError) as err:
            out["ошибка"] = str(err)[:200]
            return out, 0.0
        latency.append(time.time() - started)
        unsure = []
        for qid in questions:
            answer = response.get("answers", {}).get(qid)
            if not answer:
                unsure.append(qid)
                continue
            out.update(answer_columns(qid, answer, noul_unsure))
            if jc.is_unsure(answer, review_below, noul_unsure):
                unsure.append(qid)
        out["перечитать"] = YES if unsure else NO
        out["почему"] = ", ".join(unsure)
        done[0] += 1
        if done[0] % 25 == 0:
            print("  …{} из {}".format(done[0], len(rows)), flush=True)
        return out, jc.cost_usd(response, settings["price_per_million_input_usd"])

    started = time.time()
    with ThreadPoolExecutor(max_workers=settings["batch_workers"]) as pool:
        results = list(pool.map(one, rows))
    elapsed = time.time() - started
    if latency:
        print("  запросов параллельно: {} · один запрос в среднем {} с".format(
            settings["batch_workers"], jc.fmt(sum(latency) / len(latency), 1)))
    merged = [dict(row, **out) for row, (out, _) in zip(rows, results)]
    return merged, sum(cost for _, cost in results), elapsed


def result_columns(original, questions):
    cols = list(original)
    for qid, question in questions.items():
        cols.append(qid)
        cols += {"choice": [qid + "_увер"], "score": [qid + "_балл", qid + "_увер"]}.get(question["type"], [qid + "_вер"])
    return cols + ["перечитать", "почему", "ошибка"]


def cmd_run(args):
    cfg = jc.load_config(args.project)
    task = get_task(cfg, args.task)
    rows = read_records(args.source, args.glob)
    if args.limit:
        rows = rows[: args.limit]
    if not rows:
        raise SystemExit("Записей нет: файл пуст или в папке нет подходящих файлов.")
    key, base, _ = jc.find_credentials(args.project)
    if not key:
        raise SystemExit(NO_KEY)

    print("Задача: {} · записей: {} · через {}".format(task.get("title", args.task), len(rows), jc.provider_name(base)))
    results, cost, elapsed = run_task(task, rows, key, base, cfg["settings"])
    source = Path(args.source)
    if source.is_dir():  # в таблицу результата — начало текста, не файл целиком
        for record in results:
            record["text"] = str(record.get("text", ""))[:300]
        out = str(source.resolve()) + ".jev.csv"
    else:
        out = str(source.with_suffix("")) + ".jev.csv"
    with open(out, "w", encoding="utf-8-sig", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=result_columns(rows[0].keys(), task["questions"]), extrasaction="ignore")
        writer.writeheader()
        writer.writerows(results)

    errors = sum(1 for r in results if r.get("ошибка"))
    review = sum(1 for r in results if r.get("перечитать") == YES)
    print("\nГотово за {} с · стоимость ${} · результат: {}".format(jc.fmt(elapsed, 1), jc.fmt(cost, 4), out))
    for qid in task["questions"]:
        counts = Counter(r.get(qid) for r in results if r.get(qid))
        print("  {}: {}".format(qid, ", ".join("{} — {}".format(k, v) for k, v in counts.most_common())))
    print("  перечитать Claude Code: {} из {}".format(review, len(results)))
    if errors:
        print("  ошибок: {} (колонка «ошибка»)".format(errors))
    jc.log(args.project, {"event": "run", "task": args.task, "rows": len(results), "review": review,
                          "errors": errors, "cost_usd": round(cost, 6), "sec": round(elapsed, 1)})
    return 0


# ---------- check ----------

TRUE = {"да", "yes", "true", "1", "y", "д"}
FALSE = {"нет", "no", "false", "0", "n", "н"}


def normalize(value, question):
    """Ответ человека или другой модели → сравнимый вид."""
    text = str(value or "").strip().lower()
    if not text:
        return None
    if question["type"] == "noul":
        return True if text in TRUE else False if text in FALSE else None
    if question["type"] == "score":
        if text.replace(",", ".").replace(".", "", 1).isdigit():
            return int(round(float(text.replace(",", ".")))) - 1
        for index, level in enumerate(question["criteria"]):
            label = str(level).lower()
            if text in (label, label.split(":")[0].strip()):
                return index
        return None
    return text


def jev_value(row, qid, question):
    if question["type"] == "noul":
        prob = row.get(qid + "_вер")
        return None if prob in (None, "") else float(str(prob).replace(",", ".")) >= 0.5
    if question["type"] == "score":
        points = row.get(qid + "_балл")
        return None if points in (None, "") else int(round(float(str(points).replace(",", ".")))) - 1
    return str(row.get(qid, "")).strip().lower() or None


def pct(a, b):
    return "{}% ({}/{})".format(round(100 * a / b), a, b) if b else "—"


def cmd_check(args):
    cfg = jc.load_config(args.project)
    task = get_task(cfg, args.task)
    rows = read_records(args.file)
    gold_q = [q for q in task["questions"] if rows and ("ответ_" + q) in rows[0]]
    if not gold_q:
        raise SystemExit("В файле нет колонок «ответ_<вопрос>». Вопросы задачи: " + ", ".join(task["questions"]))
    key, base, _ = jc.find_credentials(args.project)
    if not key:
        raise SystemExit(NO_KEY)
    hidden = ("ответ_",) + ((args.compare + "_",) if args.compare else ())
    inputs = [{k: v for k, v in r.items() if not k.startswith(hidden)} for r in rows]
    results, cost, elapsed = run_task(task, inputs, key, base, cfg["settings"])

    header = "| Вопрос | Примеров | Jev прав | Jev прав без спорных |" + (" {} прав |".format(args.compare) if args.compare else "")
    lines = ["# Сверка «{}» на {} примерах".format(task.get("title", args.task), len(rows)), "",
             "Jev: {} с, ${}. Спорные ответы Jev (колонка «перечитать») посчитаны отдельно.".format(
                 jc.fmt(elapsed, 1), jc.fmt(cost, 4)), "", header, "|" + "---|" * (header.count("|") - 1)]
    misses = []
    for qid in gold_q:
        question = task["questions"][qid]
        total = hit = sure_total = sure_hit = other_total = other_hit = 0
        for row, res in zip(rows, results):
            gold = normalize(row.get("ответ_" + qid), question)
            if gold is None or res.get("ошибка"):
                continue
            mine = jev_value(res, qid, question)
            total += 1
            hit += mine == gold
            if res.get("перечитать") != YES:
                sure_total += 1
                sure_hit += mine == gold
            if mine != gold:
                misses.append((qid, row, res))
            if args.compare:
                other = normalize(row.get(args.compare + "_" + qid), question)
                if other is not None:
                    other_total += 1
                    other_hit += other == gold
        line = "| {} | {} | {} | {} |".format(qid, total, pct(hit, total), pct(sure_hit, sure_total))
        lines.append(line + (" {} |".format(pct(other_hit, other_total)) if args.compare else ""))

    lines += ["", "## Где Jev разошёлся с человеком", "",
              "Чаще всего это не ошибка модели, а размытый вопрос — Jev читает его буквально. "
              "Допиши критерий в задаче и прогони сверку ещё раз.", ""]
    fields = task.get("fields") or []
    for qid, row, res in misses[:15]:
        snippet = " · ".join(str(row.get(f, ""))[:160] for f in fields) or str(row)[:160]
        lines.append("- **{}** — человек: `{}`, Jev: `{}` (перечитать: {}) — {}".format(
            qid, row.get("ответ_" + qid), res.get(qid), res.get("перечитать"), snippet))
    if not misses:
        lines.append("Расхождений нет.")
    report = "\n".join(lines) + "\n"
    out = str(Path(args.file).with_suffix("")) + ".check.md"
    Path(out).write_text(report, encoding="utf-8")
    print(report + "\nОтчёт: " + out)
    jc.log(args.project, {"event": "check", "task": args.task, "rows": len(rows), "misses": len(misses),
                          "cost_usd": round(cost, 6)})
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(description="Плагин /jev")
    parser.add_argument("--project", default=os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd())
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("setup")
    for name in ("on", "off"):
        sub.add_parser(name).add_argument("part", nargs="?", choices=["router", "skills"])
    run = sub.add_parser("run")
    run.add_argument("task")
    run.add_argument("source", help="файл или папка")
    run.add_argument("--glob", default="*", help="какие файлы брать из папки")
    run.add_argument("--limit", type=int, help="только первые N записей")
    check = sub.add_parser("check")
    check.add_argument("task")
    check.add_argument("file", help="размеченный CSV/JSONL с колонками ответ_<вопрос>")
    check.add_argument("--compare", help="префикс колонок другой модели, например sonnet")
    args = parser.parse_args(argv)
    if args.cmd == "setup":
        return cmd_setup(args)
    if args.cmd in ("on", "off"):
        return cmd_toggle(args, args.cmd == "on")
    if args.cmd == "run":
        return cmd_run(args)
    return cmd_check(args)


if __name__ == "__main__":
    sys.exit(main())
