"""Общий код плагина /jev для хука и скрипта jev.py: настройки, ключ, запрос к Jev, чтение ответов.

Только стандартная библиотека Python 3.8+. Ключ — JEV_API_KEY (сервис определяется по ключу:
sk-or-… — OpenRouter, иначе TypeSafe), либо TYPESAFE_API_KEY / OPENROUTER_API_KEY: из переменных
окружения, из <проект>/.env или из ~/.claude/jev.env. Сам ключ никогда не печатается.

Настройки по умолчанию — questions.json плагина: при обновлении плагина он заменяется, туда
ничего не пишем. Всё своё — в папке проекта .claude/jev/:
  questions.json — свои пороги и задачи (раздел tasks), один файл;
  state.json     — что включено: роутер, подсказка скилла;
  log.jsonl      — журнал вызовов: траты и подсказки для /jev:setup;
  sessions.json  — какую модель роутер уже предлагал включить в каждой сессии (чтобы не повторять).
"""
import base64
import http.client
import json
import os
import re
import ssl
import threading
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

PLUGIN_DIR = Path(__file__).resolve().parent.parent
TYPESAFE_URL = "https://api.typesafe.ai"
OPENROUTER_URL = "https://openrouter.ai/api"
QUESTION_KEYS = ("type", "instructions", "criteria")


class JevError(Exception):
    """Jev не ответил: нет связи, ошибка запроса."""


# ---------- настройки и состояние проекта ----------

def jev_dir(project):
    return Path(project) / ".claude" / "jev"


def _read_json(path):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def _merge(base, extra):
    for key, value in extra.items():
        if isinstance(value, dict) and isinstance(base.get(key), dict):
            _merge(base[key], value)
        else:
            base[key] = value
    return base


def load_config(project=None):
    """Настройки плагина, поверх них — .claude/jev/questions.json проекта (пороги и задачи)."""
    cfg = json.loads((PLUGIN_DIR / "questions.json").read_text(encoding="utf-8"))
    cfg["tasks"] = {}
    if project:
        _merge(cfg, _read_json(jev_dir(project) / "questions.json"))
    return cfg


def load_state(project):
    """Что включено в проекте: {"router": bool, "skills": bool}. По умолчанию всё выключено."""
    state = _read_json(jev_dir(project) / "state.json")
    return {"router": bool(state.get("router")), "skills": bool(state.get("skills"))}


def save_state(project, state):
    folder = jev_dir(project)
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "state.json").write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")


def log(project, record):
    """Одна строка в .claude/jev/log.jsonl. Ошибки записи не мешают работе."""
    try:
        folder = jev_dir(project)
        folder.mkdir(parents=True, exist_ok=True)
        record = dict(record, ts=datetime.now(timezone.utc).isoformat(timespec="seconds"))
        with open(folder / "log.jsonl", "a", encoding="utf-8") as fh:
            fh.write(json.dumps(record, ensure_ascii=False) + "\n")
    except OSError:
        pass


def read_log(project):
    records = []
    try:
        lines = (jev_dir(project) / "log.jsonl").read_text(encoding="utf-8").splitlines()
    except OSError:
        return records
    for line in lines:
        try:
            records.append(json.loads(line))
        except ValueError:
            continue
    return records


# ---------- ключ и адрес ----------

def _read_env_file(path):
    values = {}
    try:
        lines = Path(path).read_text(encoding="utf-8").splitlines()
    except OSError:
        return values
    for line in lines:
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        name, value = line.split("=", 1)
        name = name.strip()
        if name.startswith("export "):
            name = name[len("export "):].strip()
        values[name] = value.strip().strip('"').strip("'")
    return values


def key_file():
    """Файл с ключом для всех проектов: вне папки плагина, чтобы ключ пережил обновление."""
    return Path.home() / ".claude" / "jev.env"


def find_credentials(project=None):
    """(ключ, базовый адрес, где нашёлся). Если ключа нет — (None, None, None)."""
    sources = [("переменные окружения", dict(os.environ))]
    if project:
        sources.append((str(Path(project) / ".env"), _read_env_file(Path(project) / ".env")))
    sources.append((str(key_file()), _read_env_file(key_file())))
    for where, env in sources:
        key = env.get("JEV_API_KEY") or env.get("TYPESAFE_API_KEY") or env.get("OPENROUTER_API_KEY")
        if not key:
            continue
        base = env.get("TYPESAFE_BASE_URL")
        if not base:
            via_openrouter = key.startswith("sk-or-") or key == env.get("OPENROUTER_API_KEY")
            base = OPENROUTER_URL if via_openrouter else TYPESAFE_URL
        return key, base.rstrip("/"), where
    return None, None, None


def provider_name(base):
    if "openrouter" in base:
        return "OpenRouter"
    if "typesafe" in base:
        return "TypeSafe"
    return base


def mask(key):
    return key[:6] + "…" + key[-4:] if key and len(key) > 12 else "…"


# ---------- запрос ----------

def ssl_context():
    """Python с python.org на macOS без «Install Certificates.command» не видит корневых сертификатов
    (CERTIFICATE_VERIFY_FAILED). Тогда берём certifi, если он стоит, или системный набор macOS / Linux."""
    paths = ssl.get_default_verify_paths()
    if os.name == "nt" or paths.cafile or paths.capath:
        return ssl.create_default_context()
    try:
        import certifi
        return ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        pass
    for bundle in ("/etc/ssl/cert.pem", "/etc/ssl/certs/ca-certificates.crt"):
        if os.path.exists(bundle):
            return ssl.create_default_context(cafile=bundle)
    return ssl.create_default_context()


SSL_CONTEXT = ssl_context()
_local = threading.local()


def _connect(target, timeout):
    """Соединение с сервисом Jev; для https учитывается прокси из окружения (HTTPS_PROXY)."""
    port = target.port or (443 if target.scheme == "https" else 80)
    if target.scheme != "https":
        return http.client.HTTPConnection(target.hostname, port, timeout=timeout)
    proxy = None if urllib.request.proxy_bypass(target.hostname) else urllib.request.getproxies().get("https")
    if not proxy:
        return http.client.HTTPSConnection(target.hostname, port, timeout=timeout, context=SSL_CONTEXT)
    p = urllib.parse.urlsplit(proxy if "://" in proxy else "http://" + proxy)
    conn = http.client.HTTPSConnection(p.hostname, p.port or 80, timeout=timeout, context=SSL_CONTEXT)
    headers = {}
    if p.username:
        creds = "{}:{}".format(urllib.parse.unquote(p.username), urllib.parse.unquote(p.password or ""))
        headers["Proxy-Authorization"] = "Basic " + base64.b64encode(creds.encode("utf-8")).decode("ascii")
    conn.set_tunnel(target.hostname, port, headers=headers)
    return conn


def _drop_connection():
    conn = getattr(_local, "conn", None)
    if conn is not None:
        conn.close()
    _local.conn = None


def ask(state, questions, key, base, model="jev-latest", timeout=10.0, retries=0):
    """Один запрос к Jev: все вопросы по одному state. Возвращает ответ API как есть.

    Соединение одно на поток: TLS и туннель через прокси открываются один раз на весь прогон,
    а не на каждую запись. Через прокси это в разы быстрее: новый туннель стоит дороже ответа Jev."""
    clean = {qid: {k: q[k] for k in QUESTION_KEYS if k in q} for qid, q in questions.items()}
    body = json.dumps({"model": model, "state": state, "questions": clean}, ensure_ascii=False).encode("utf-8")
    headers = {"Authorization": "Bearer " + key, "Content-Type": "application/json", "User-Agent": "jev-plugin/1.0"}
    target = urllib.parse.urlsplit(base)
    for attempt in range(retries + 1):
        try:
            conn = getattr(_local, "conn", None)
            if conn is None or getattr(_local, "base", None) != base:
                _drop_connection()
                conn = _local.conn = _connect(target, timeout)
                _local.base = base
            if conn.sock is not None:
                conn.sock.settimeout(timeout)
            conn.request("POST", target.path + "/v1/systemone", body, headers)
            response = conn.getresponse()
            data = response.read()
        except (http.client.HTTPException, OSError) as err:
            _drop_connection()
            if attempt < retries:
                time.sleep(min(2 ** attempt, 8))
                continue
            raise JevError("нет связи с {}: {}".format(base, err)) from None
        if 200 <= response.status < 300:
            try:
                return json.loads(data.decode("utf-8"))
            except ValueError:
                raise JevError("непонятный ответ: {}".format(data[:200])) from None
        if response.status in (429, 500, 502, 503, 529) and attempt < retries:
            time.sleep(min(2 ** attempt, 8))
            continue
        raise JevError("HTTP {}: {}".format(response.status, data.decode("utf-8", "replace")[:400]))
    raise JevError("Jev не ответил")


def cost_usd(response, price_per_million=0.042):
    """Стоимость запроса: OpenRouter присылает её сам, для TypeSafe считаем по входным токенам."""
    usage = response.get("usage") or {}
    if isinstance(usage.get("cost"), (int, float)):
        return float(usage["cost"])
    return usage.get("input_tokens", 0) * price_per_million / 1_000_000


# ---------- чтение ответов ----------

def confidence(answer):
    """Уверенность ответа 0..1. У да/нет своей уверенности нет — берём, насколько далеко от 0,5."""
    if answer.get("type") == "noul":
        return abs(answer.get("noul", 0.5) - 0.5) * 2
    return float(answer.get("confidence", 0.0))


def score_level(answer):
    """Номер ступени шкалы (0, 1, 2…) по взвешенному баллу."""
    levels = len(answer.get("legend") or {}) or 1
    return max(0, min(levels - 1, int(round(float(answer.get("score", 0))))))


def is_unsure(answer, review_below, noul_unsure):
    if answer.get("type") == "noul":
        low, high = noul_unsure
        return low < answer.get("noul", 0.5) < high
    return confidence(answer) < review_below


def fmt(number, digits=2):
    return ("{:." + str(digits) + "f}").format(number).replace(".", ",")


# ---------- скиллы проекта ----------

def parse_frontmatter(path):
    """name, description и прочие поля из шапки SKILL.md (включая многострочные > и |)."""
    try:
        text = Path(path).read_text(encoding="utf-8")
    except OSError:
        return {}, ""
    if not text.startswith("---"):
        return {}, text
    end = text.find("\n---", 3)
    if end < 0:
        return {}, text
    meta, key, buf, block = {}, None, [], False
    for line in text[3:end].splitlines():
        if block and (not line.strip() or line[:1] in (" ", "\t")):
            buf.append(line.strip())
            continue
        if block:
            meta[key] = " ".join(x for x in buf if x)
            block, buf = False, []
        match = re.match(r"^([A-Za-z0-9_-]+):\s*(.*)$", line)
        if not match:
            continue
        key, value = match.group(1), match.group(2).strip()
        if value in (">", "|", ">-", "|-", ">+", "|+"):
            block, buf = True, []
            continue
        meta[key] = value.strip('"').strip("'")
    if block:
        meta[key] = " ".join(x for x in buf if x)
    body = text[end + 4:].lstrip("-\n")
    return meta, body


def list_skills(project):
    """Скиллы проекта и пользователя, которые Claude может вызвать сам. Проектные — первыми."""
    roots = [Path(project) / ".claude" / "skills", Path.home() / ".claude" / "skills"]
    found = {}
    for root in roots:
        if not root.is_dir():
            continue
        for skill_md in sorted(root.glob("*/SKILL.md")):
            meta, _ = parse_frontmatter(skill_md)
            name = meta.get("name") or skill_md.parent.name
            if name in found or str(meta.get("disable-model-invocation", "")).lower() == "true":
                continue
            description = (meta.get("description") or "").strip()
            if description:
                found[name] = {"description": description[:400], "path": str(skill_md)}
    return found


# ---------- модели ----------

MODELS = ("haiku", "sonnet", "opus", "fable")  # по силе, от слабой к сильной


def model_family(model_id):
    """claude-opus-5-5 → opus. Незнакомое имя → None."""
    text = str(model_id or "").lower()
    for name in MODELS:
        if name in text:
            return name
    return None


def stronger(a, b):
    return MODELS.index(a) > MODELS.index(b)


def _tail_lines(path, max_bytes=400_000):
    """Последние строки журнала: файл сессии бывает в мегабайты, а нужен только конец."""
    try:
        with open(path, "rb") as fh:
            fh.seek(0, os.SEEK_END)
            size = fh.tell()
            fh.seek(max(0, size - max_bytes))
            data = fh.read().decode("utf-8", "replace")
    except OSError:
        return []
    lines = data.splitlines()
    return lines[1:] if size > max_bytes else lines


def session_model(event):
    """Модель, на которой идёт сессия: из входа хука, иначе по концу журнала сессии.

    В журнале берётся последнее из двух: ответ основного диалога (поле model — какая модель
    ответила на самом деле) и запись Claude Code о модели хода. Не нашлось — None.
    """
    given = event.get("model")
    if isinstance(given, dict):
        given = given.get("id") or given.get("display_name")
    if model_family(given):
        return model_family(given)
    transcript = event.get("transcript_path")
    if not transcript:
        return None
    for line in reversed(_tail_lines(transcript)):
        try:
            item = json.loads(line)
        except ValueError:
            continue
        if item.get("type") == "assistant" and not item.get("isSidechain"):
            name = model_family((item.get("message") or {}).get("model"))
        elif item.get("type") == "attachment" and (item.get("attachment") or {}).get("type") == "model":
            name = model_family(((item.get("attachment") or {}).get("identity") or {}).get("modelId"))
        else:
            continue
        if name:
            return name
    return None


def load_sessions(project):
    return _read_json(jev_dir(project) / "sessions.json")


def save_sessions(project, sessions, keep=50):
    """Что роутер уже предлагал в каждой сессии; хранятся последние `keep` сессий."""
    try:
        items = sorted(sessions.items(), key=lambda kv: kv[1].get("ts", ""))[-keep:]
        folder = jev_dir(project)
        folder.mkdir(parents=True, exist_ok=True)
        (folder / "sessions.json").write_text(json.dumps(dict(items), ensure_ascii=False, indent=1), encoding="utf-8")
    except OSError:
        pass
