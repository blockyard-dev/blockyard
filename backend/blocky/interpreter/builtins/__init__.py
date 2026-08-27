"""匯入即註冊。新增內建命名空間時要記得加進這裡。"""

from blocky.interpreter.builtins import (  # noqa: F401
    control,
    data,
    debug,
    object_ns,
    operator,
    procedure,
    time_ns,
    type_ns,
)

__all__ = ["control", "data", "debug", "object_ns", "operator", "procedure", "time_ns", "type_ns"]
