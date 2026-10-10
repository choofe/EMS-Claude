"""Expected business-rule failures. `code` is a stable machine-readable string (the frontend maps it
to a Persian message); `extra` carries structured details (never secrets). Subclasses ValueError so
non-HTTP callers (the CLI) can keep catching ValueError."""


class DomainError(ValueError):
    def __init__(self, code: str, status_code: int = 409, **extra):
        super().__init__(code)
        self.code = code
        self.status_code = status_code
        self.extra = extra

    def detail(self) -> str | dict:
        return self.code if not self.extra else {"code": self.code, **self.extra}
