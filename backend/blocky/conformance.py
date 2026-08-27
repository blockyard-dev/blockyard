"""一致性題庫的執行與比對（§17）。

每一題有兩層檢查，缺一不可：

  expect （meta.yaml，**手寫**）  這才是規格。人讀得懂、改動時要有意識。
  expected.jsonl（**產生**）      黃金事件軌跡，抓「結果對了但過程錯了」。

只有 expect 會漏掉求值順序、事件配對、變數寫入時機；只有黃金軌跡則會把
bug 一起鎖進去——它是回歸網，不是規格。
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

from blocky.errors import BlockyError, ValidationError
from blocky.interpreter import builtins as _builtins  # noqa: F401  匯入即註冊
from blocky.interpreter.engine import Interpreter
from blocky.interpreter.events import EventSink, normalize
from blocky.interpreter.scope import InMemoryPersistStore
from blocky.ir.schema import load


@dataclass
class Case:
    """一道題目。"""

    path: str                       # "control/repeat_basic"
    title: str
    spec: str                       # 指回設計文件的章節——題庫是規格的可執行版本
    project: dict[str, Any]
    expect: dict[str, Any] = field(default_factory=dict)
    tags: list[str] = field(default_factory=list)
    clock: float | None = None      # 固定時鐘（epoch ms），讓 time.now 可重現
    timezone: str = "UTC"
    persist: dict[str, Any] = field(default_factory=dict)

    def meta(self) -> dict[str, Any]:
        m: dict[str, Any] = {"title": self.title, "spec": self.spec}
        if self.tags:
            m["tags"] = self.tags
        if self.clock is not None:
            m["clock"] = self.clock
        if self.timezone != "UTC":
            m["timezone"] = self.timezone
        if self.persist:
            m["persist"] = self.persist
        m["expect"] = self.expect
        return m


@dataclass
class Result:
    status: str
    events: list[dict[str, Any]]
    logs: list[str]
    variables: dict[str, Any]
    persist: dict[str, Any]
    error: dict[str, Any] | None
    load_error: str | None = None


async def run_case(case: Case) -> Result:
    sink = EventSink()
    store = InMemoryPersistStore(case.persist)

    try:
        project = load(case.project, strict_refs=True)
    except ValidationError as e:
        # §4.7 的 `${a+b}`、§4.6 的 return 位置——這些必須在**載入期**就爆，
        # 不是執行期。題目用 expect.load_error 斷言。
        return Result("load_error", [], [], {}, store.snapshot(), None, load_error=str(e))

    interp = Interpreter(
        project,
        sink=sink,
        persist=store,
        clock=(lambda: case.clock) if case.clock is not None else None,
        timezone=case.timezone,
    )
    run = await interp.run()

    events = normalize(run.events)
    logs = [e["text"] for e in events if e["op"] == "log"]
    error = next((e["error"] for e in events if e["op"] == "block.error"), None)

    return Result(
        status=run.status,
        events=events,
        logs=logs,
        variables=dict(interp.run_scope.vars),
        persist=store.snapshot(),
        error=error,
    )


def check(case: Case, result: Result) -> list[str]:
    """比對 meta.yaml 的 expect。回傳失敗訊息清單（空 = 通過）。"""
    failures: list[str] = []
    exp = case.expect

    def fail(what: str, want: Any, got: Any) -> None:
        failures.append(f"{what}\n    預期: {want!r}\n    實際: {got!r}")

    if "status" in exp and result.status != exp["status"]:
        fail("status 不符", exp["status"], result.status)

    if "load_error" in exp:
        want = exp["load_error"]
        if result.load_error is None:
            fail("預期載入期就該報錯，但載入成功了", want, None)
        elif want and want not in result.load_error:
            fail("載入期錯誤訊息不含預期片段", want, result.load_error)

    if "logs" in exp and result.logs != exp["logs"]:
        fail("log 輸出不符", exp["logs"], result.logs)

    for name, want in (exp.get("vars") or {}).items():
        got = result.variables.get(name, "<不存在>")
        if got != want:
            fail(f'變數 "{name}" 不符', want, got)

    for name, want in (exp.get("persist") or {}).items():
        got = result.persist.get(name, "<不存在>")
        if got != want:
            fail(f'持久值 "{name}" 不符', want, got)

    if (want_err := exp.get("error")) is not None:
        got = result.error
        if got is None:
            fail("預期有錯誤但沒有發生", want_err, None)
        else:
            for key in ("code", "type", "blockId"):
                if key in want_err and got.get(key) != want_err[key]:
                    fail(f"error.{key} 不符", want_err[key], got.get(key))
            if (frag := want_err.get("message_contains")) and frag not in got.get("message", ""):
                fail("錯誤訊息不含預期片段", frag, got.get("message"))
            if (frag := want_err.get("hint_contains")) and frag not in (got.get("hint") or ""):
                fail("錯誤提示不含預期片段", frag, got.get("hint"))

    if exp.get("no_error") and result.error is not None:
        fail("預期不該有錯誤", None, result.error)

    return failures


# --------------------------------------------------------------------------
# fixture 的讀寫
# --------------------------------------------------------------------------


def write_case(root: Path, case: Case, events: list[dict[str, Any]]) -> None:
    d = root / case.path
    d.mkdir(parents=True, exist_ok=True)
    (d / "project.json").write_text(
        json.dumps(case.project, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    (d / "meta.yaml").write_text(
        yaml.safe_dump(case.meta(), allow_unicode=True, sort_keys=False), encoding="utf-8"
    )
    (d / "expected.jsonl").write_text(
        "".join(json.dumps(e, ensure_ascii=False) + "\n" for e in events), encoding="utf-8"
    )


def read_case(d: Path) -> tuple[Case, list[dict[str, Any]]]:
    meta = yaml.safe_load((d / "meta.yaml").read_text(encoding="utf-8"))
    project = json.loads((d / "project.json").read_text(encoding="utf-8"))
    golden_file = d / "expected.jsonl"
    golden = (
        [json.loads(line) for line in golden_file.read_text(encoding="utf-8").splitlines() if line]
        if golden_file.exists()
        else []
    )
    case = Case(
        path=d.name,
        title=meta.get("title", d.name),
        spec=meta.get("spec", ""),
        project=project,
        expect=meta.get("expect", {}),
        tags=meta.get("tags", []),
        clock=meta.get("clock"),
        timezone=meta.get("timezone", "UTC"),
        persist=meta.get("persist", {}),
    )
    return case, golden


def diff_trace(golden: list[dict], actual: list[dict]) -> str | None:
    """比對黃金軌跡，回第一個差異的可讀描述。"""
    if golden == actual:
        return None
    for i, (g, a) in enumerate(zip(golden, actual)):
        if g != a:
            return f"事件 #{i} 不同\n    黃金: {json.dumps(g, ensure_ascii=False)}\n    實際: {json.dumps(a, ensure_ascii=False)}"
    if len(actual) > len(golden):
        extra = json.dumps(actual[len(golden)], ensure_ascii=False)
        return f"多了 {len(actual) - len(golden)} 個事件，第一個是 {extra}"
    missing = json.dumps(golden[len(actual)], ensure_ascii=False)
    return f"少了 {len(golden) - len(actual)} 個事件，第一個是 {missing}"
