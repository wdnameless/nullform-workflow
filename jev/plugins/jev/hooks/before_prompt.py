"""Хук UserPromptSubmit плагина /jev: роутер моделей и выбор скилла через Jev.

Перед каждым запросом одним вызовом спрашивает Jev, насколько сложна задача, опирается ли она на
этот разговор и какой скилл под неё подходит, и добавляет уверенные ответы в контекст Claude.

Модель сессии хук сменить не может, а поле `model` скилла, вызванного самим Claude, Claude Code
не применяет (anthropics/claude-code#79664, #85658). Поэтому роутер работает так:
  задача по силам модели сессии в самый раз  → подсказки нет, Claude делает сам;
  простая или средняя под другую модель      → Claude отдаёт её субагенту на этой модели
                                              (Agent с параметром model — модель меняется на деле);
  сложная или предельная (Opus, Fable)       → субагенту сам не отдаёт: если задача опирается на
                                              разговор — советует переключить модель в этом диалоге,
                                              иначе даёт выбор: переключить или отдать субагенту;
                                              модель сессии сильнее нужной — делает сам.
Любая ошибка — молча выходим: сессия идёт как без хука.
"""
import json
import os
import re
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import jev_client as jc  # noqa: E402

# Запросы, похожие на секреты, в Jev не отправляются.
SECRET = re.compile(
    r"(sk-[A-Za-z0-9_-]{16,}|-----BEGIN [A-Z ]*PRIVATE KEY"
    r"|(?:api[_-]?key|token|secret|password|пароль)\s*[:=]\s*\S{8,})",
    re.IGNORECASE,
)
NONE = "none"


def recheck_skill(prompt, first, skills, cfg, key, base, model):
    """Второй проход: три верхних скилла целиком, выбор ещё раз (кукбук TypeSafe, skill_suggestion)."""
    ranked = sorted(first["probabilities"].items(), key=lambda kv: kv[1], reverse=True)
    top = [name for name, _ in ranked if name != NONE][: cfg["recheck_top"]]
    criteria = {}
    for name in top:
        _, body = jc.parse_frontmatter(skills[name]["path"])
        criteria[name] = (skills[name]["description"] + "\n\n" + body)[: cfg["recheck_chars"]]
    criteria[NONE] = cfg["none_description"]
    question = {"skill": {"type": "choice", "instructions": cfg["instructions"], "criteria": criteria}}
    response = jc.ask({"task": prompt}, question, key, base, model=model, timeout=2.5)
    return response["answers"]["skill"], response


def title(model):
    return model[:1].upper() + model[1:]


def route(level, conf, context_p, cfg, event, mode, project):
    """Что делать с задачей: (строка подсказки или None, действие, модель задачи, модель сессии)."""
    target = cfg["models"][level]
    current = jc.session_model(event)
    head = "Jev (роутер): задача {}, уверенность {}".format(cfg["level_names"][level], jc.fmt(conf))
    if current == target:
        return None, "same", target, current
    agent = "вызови Agent с subagent_type «{}» и model «{}»".format(cfg["subagent_type"], target)
    brief = ("Субагент не видит этот разговор — передай в prompt запрос пользователя дословно и всё из диалога, "
             "без чего его не сделать: пути, решения, примеры.")

    if level < cfg["ask_from_level"]:
        known = ("сейчас отвечает {}".format(current) if current
                 else "если ты уже {} — просто делай сам, без субагента".format(title(target)))
        line = (
            "{head} → модель {m}; {known}. Отдай задачу субагенту на {m}: первым действием {agent}. {brief} "
            "Если результат — текст для пользователя, попроси вернуть его целиком и выведи как есть; если работа в "
            "файлах — коротко перескажи, что сделано. Ответ в одну строку без файлов и поиска дай сам: субагент там дороже."
        ).format(head=head, m=target, known=known, agent=agent, brief=brief)
        return line, "delegate", target, current

    # Сложная или предельная задача: субагенту сам не отдаёт, модель сессии меняет только пользователь.
    if mode == "auto":  # в автоматическом режиме разрешений модель сессии не может быть Haiku
        target = cfg["auto_mode_replace"].get(target, target)
    session_id = event.get("session_id") or ""
    sessions = jc.load_sessions(project)
    seen = sessions.get(session_id, {})
    if target in seen.get("switch", []):
        return None, "switch_repeat", target, current  # уже предлагали — пользователь решил остаться
    sessions[session_id] = {"switch": seen.get("switch", []) + [target],
                            "ts": time.strftime("%Y-%m-%dT%H:%M:%S")}
    jc.save_sessions(project, sessions)

    M = title(target)
    switch = "переключить модель на {} в списке моделей внизу окна (в терминале — /model {}) и написать «продолжай»: " \
             "задача пойдёт в этом диалоге со всей историей".format(M, target)
    if context_p >= cfg["context_threshold"]:
        offer = ("одной-двумя строками посоветуй пользователю {switch}. Субагенту задачу не предлагай: она опирается на "
                 "разговор, а субагент его не видит.").format(switch=switch)
    else:
        offer = ("одной-тремя строками дай пользователю выбор: 1) {switch}; 2) отдать задачу субагенту на {M} — он не "
                 "видит разговор и получит только постановку. Выберет субагента — {agent}. {brief}").format(
                     switch=switch, M=M, agent=agent, brief=brief)
    ending = "Если пользователь скажет делать на текущей модели — делай."

    if current and jc.stronger(target, current):
        line = "{head} → нужна модель {M}, а сейчас отвечает {cur}. Не начинай работу и не зови субагента сам: {offer} {end}".format(
            head=head, M=M, cur=current, offer=offer, end=ending)
        return line, ("switch_up" if context_p >= cfg["context_threshold"] else "ask"), target, current
    if current:
        line = (
            "{head}; ей хватит модели {M}, а сейчас отвечает {cur}. Делай сам, без субагента. В конце ответа одной строкой "
            "предложи пользователю переключить модель на {M} в списке моделей внизу окна (в терминале — /model {m}), если "
            "дальше будут похожие задачи: так дешевле."
        ).format(head=head, M=M, cur=current, m=target)
        return line, "switch_down", target, current
    line = (
        "{head} → по силам модели {M}. Если ты уже {M} — просто делай. Если ты сильнее {M} — делай сам, а в конце одной "
        "строкой предложи переключиться на {M}, если дальше будут похожие задачи. Если слабее — не начинай работу и не "
        "зови субагента сам: {offer} {end} Порядок по силе: haiku < sonnet < opus < fable."
    ).format(head=head, M=M, offer=offer, end=ending)
    return line, "switch", target, current


def main():
    try:
        event = json.load(sys.stdin)
    except ValueError:
        return
    prompt = (event.get("prompt") or "").strip()
    project = os.environ.get("CLAUDE_PROJECT_DIR") or event.get("cwd") or os.getcwd()

    state = jc.load_state(project)
    if not (state["router"] or state["skills"]):
        return
    cfg = jc.load_config(project)
    router_cfg, picker_cfg = cfg["router"], cfg["skill_picker"]
    if prompt.startswith("/") or len(prompt) < router_cfg["min_prompt_chars"] or SECRET.search(prompt):
        return
    key, base, _ = jc.find_credentials(project)
    if not key:
        return

    model = cfg["settings"]["model"]
    task = prompt[:6000]
    questions, skills = {}, {}
    if state["router"]:
        questions["complexity"] = {"type": "score", "instructions": router_cfg["instructions"],
                                   "criteria": router_cfg["levels"]}
        questions["context"] = {"type": "noul", "instructions": router_cfg["context_instructions"],
                                "criteria": router_cfg["context_criteria"]}
    if state["skills"]:
        skills = jc.list_skills(project)
        if skills:
            criteria = {name: skills[name]["description"] for name in list(skills)[:254]}
            criteria[NONE] = picker_cfg["none_description"]
            questions["skill"] = {"type": "choice", "instructions": picker_cfg["instructions"], "criteria": criteria}
    if not questions:
        return

    started = time.time()
    try:
        response = jc.ask({"task": task}, questions, key, base, model=model,
                          timeout=cfg["settings"]["hook_timeout_sec"])
    except jc.JevError as err:
        jc.log(project, {"event": "hook_error", "error": str(err)[:300]})
        return
    price = cfg["settings"]["price_per_million_input_usd"]
    spent = jc.cost_usd(response, price)
    answers = response.get("answers", {})
    mode = event.get("permission_mode") or ""
    lines, record = [], {"event": "hook", "mode": mode, "transcript": event.get("transcript_path")}

    action = None
    if "complexity" in answers:
        answer = answers["complexity"]
        level = min(jc.score_level(answer), len(router_cfg["models"]) - 1)
        conf = jc.confidence(answer)
        context_p = float((answers.get("context") or {}).get("noul", 0.0))
        record.update(level=level, level_conf=round(conf, 3), context=round(context_p, 3))
        if conf >= router_cfg["min_confidence"]:
            line, action, target, current = route(level, conf, context_p, router_cfg, event, mode, project)
            record.update(action=action, model_hint=target, current=current)
            if line:
                lines.append(line)

    if "skill" in answers:
        answer = answers["skill"]
        conf = jc.confidence(answer)
        if answer.get("choice") != NONE and conf < picker_cfg["recheck_below"]:
            try:
                answer, second = recheck_skill(task, answer, skills, picker_cfg, key, base, model)
                spent += jc.cost_usd(second, price)
                conf = jc.confidence(answer)
            except (jc.JevError, KeyError):
                pass
        record.update(skill=answer.get("choice"), skill_conf=round(conf, 3))
        if answer.get("choice") not in (None, NONE) and conf >= picker_cfg["min_confidence"]:
            record["skill_hinted"] = True
            how = ("впиши субагенту первым шагом открыть его" if action == "delegate"
                   else "открой его перед работой")
            lines.append(
                "Jev (скиллы): под задачу подходит скилл «{s}», уверенность {c} — {how}, "
                "если он действительно про это.".format(s=answer["choice"], c=jc.fmt(conf), how=how))

    record.update(cost_usd=round(spent, 7), ms=int((time.time() - started) * 1000), hinted=bool(lines))
    jc.log(project, record)
    if lines:
        print(json.dumps(
            {"hookSpecificOutput": {"hookEventName": "UserPromptSubmit", "additionalContext": "\n".join(lines)}},
            ensure_ascii=False,
        ))


if __name__ == "__main__":
    try:
        main()
    except Exception:  # хук не имеет права ломать сессию
        pass
    sys.exit(0)
