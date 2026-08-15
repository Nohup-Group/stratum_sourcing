"""No secret may be committed — enforced by gitleaks, not by a regex of ours.

A hand-rolled scanner lived here for four verification rounds and was wrong in
a new way each time: it scanned only tracked files (blind to every new file in
a change), then only one of the four project directories, then it missed
`*_PASSWORD` variable names, the `"password": "…"` form that JSON uses, and any
secret containing `%` or `$`. Each fix introduced the next hole. Secret
detection by shape is a maintained-ruleset problem.

Two things this deliberately does NOT do:

- It scans the working tree, not git history. The production password is still
  in history and will stay there: rotation was considered and declined
  (docs/FIX-PLAN.md N3). Scanning history would make this permanently red and
  therefore permanently ignored.
- It does not skip when gitleaks is missing. A security gate that quietly
  disables itself is the exact failure this file exists to end.
"""

from __future__ import annotations

import hashlib
import json
import shutil
import subprocess
import tempfile
from pathlib import Path

import pytest

SOURCING_ROOT = Path(__file__).resolve().parents[1]
CONFIG = SOURCING_ROOT / ".gitleaks.toml"

# The scan root is the git toplevel, one level ABOVE this project: the previous
# scanner covered 106 of the repository's 252 committable files because it
# assumed its own directory was the repository.
GIT_ROOT = Path(
    subprocess.run(
        ["git", "rev-parse", "--show-toplevel"],
        cwd=SOURCING_ROOT,
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()
)


def scan(target: Path) -> list[dict]:
    """Findings for a directory, as gitleaks reports them."""
    if shutil.which("gitleaks") is None:
        pytest.fail(
            "gitleaks is not installed, so nothing is checking for committed "
            "secrets. Install it with `brew install gitleaks` — this gate does "
            "not skip itself."
        )
    with tempfile.NamedTemporaryFile(suffix=".json") as report:
        subprocess.run(
            [
                "gitleaks", "dir", ".",
                "--config", str(CONFIG),
                "--report-format", "json",
                "--report-path", report.name,
                "--redact", "--no-banner", "--exit-code", "0",
            ],
            # Scanned from inside the target so reported paths stay relative.
            # The config's path allowlist is anchored (`^agrana/`); an absolute
            # target makes every one of those anchors silently miss, and the
            # gate then reports findings from a repo that is not ours.
            cwd=target,
            capture_output=True,
            text=True,
            check=True,
            timeout=300,
        )
        body = Path(report.name).read_text().strip()
    return json.loads(body) if body else []


def committable_files(root: Path) -> list[str]:
    """Exactly what a commit could contain: tracked, plus untracked and not ignored."""
    out = subprocess.run(
        ["git", "ls-files", "--cached", "--others", "--exclude-standard"],
        cwd=root,
        capture_output=True,
        text=True,
        check=True,
    )
    return [line for line in out.stdout.splitlines() if line]


def test_the_repository_contains_no_secret(tmp_path: Path) -> None:
    """Scans what git would actually take, not what happens to be on disk.

    `gitleaks dir` walks the filesystem and ignores .gitignore, so scanning the
    tree directly reports findings in files that can never be committed — a
    local `.env` holding the production DSN is the documented way to run the
    sourcing_run scripts, and it would turn this gate permanently red on a file
    git will never see. A gate that is red for a legitimate local setup gets
    deleted, not fixed.
    """
    staged = tmp_path / "committable"
    for relative in committable_files(GIT_ROOT):
        source = GIT_ROOT / relative
        if not source.is_file():
            continue  # embedded repos appear as a bare directory entry
        destination = staged / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, destination)

    findings = scan(staged)

    formatted = "\n".join(
        f"  {f['RuleID']}: {f['File']}:{f['StartLine']}" for f in findings
    )
    assert not findings, f"gitleaks found committable secrets:\n{formatted}"


@pytest.mark.parametrize(
    ("name", "body"),
    [
        # Every form the hand-rolled scanner missed, plus the one it caught.
        ("dsn.py", 'DSN = "postgresql://postgres:{pw}@switchback.proxy.rlwy.net:16120/railway"'),
        ("split.py", 'c = ("postgresql://postgres:{pw}"\n     "@switchback.proxy.rlwy.net:16120/railway")'),
        ("envvar.txt", "CONSOLE_PASSWORD={pw}"),
        ("kwargs.py", 'connect(host="switchback.proxy.rlwy.net", password="{pw}")'),
        ("payload.json", '{{"host": "switchback.proxy.rlwy.net", "password": "{pw}"}}'),
        ("percent.py", 'DSN = "postgresql://postgres:{pw}%40x@switchback.proxy.rlwy.net/railway"'),
    ],
)
def test_the_scanner_catches_a_planted_credential(tmp_path: Path, name: str, body: str) -> None:
    """The gate is only worth its runtime if it fails on a real secret.

    Assembled at runtime so this file never contains a credential itself.
    """
    # Derived, so no credential-shaped literal exists in this file at all and
    # it needs no exemption from the scanner. The version before this one
    # concatenated four literals that spelled the real production password,
    # putting the live secret back into the repository inside the single path
    # the config permanently allowlisted — the exact split-literal trick that
    # hid a credential in reclassify_entities.py for months.
    secret = hashlib.sha256(b"gitleaks-fixture").hexdigest()[:32]
    (tmp_path / name).write_text(body.format(pw=secret) + "\n")

    findings = scan(tmp_path)

    assert findings, f"a planted credential in {name} went undetected"


@pytest.mark.parametrize(
    ("name", "body"),
    [
        # Shapes that must NOT trip the gate. A scanner that cries wolf on a
        # function call or a local-dev URL is one nobody keeps green.
        ("call.js", "const password = resolveControlUiPassword();"),
        ("local.env", "DATABASE_URL=postgresql+asyncpg://postgres:postgres@localhost:5432/x"),
        ("nopw.env", "DATABASE_URL=postgresql+asyncpg://erickpg@localhost:5432/scratch"),
        ("redacted.json", '{"dsn": "postgresql://postgres:<REDACTED>@switchback.proxy.rlwy.net/r"}'),
        ("template.py", 'DSN = f"postgresql://postgres:{PW}@switchback.proxy.rlwy.net/r"'),
    ],
)
def test_the_scanner_leaves_benign_shapes_alone(tmp_path: Path, name: str, body: str) -> None:
    (tmp_path / name).write_text(body + "\n")

    findings = scan(tmp_path)

    assert not findings, f"false positive on {name}: {findings}"
