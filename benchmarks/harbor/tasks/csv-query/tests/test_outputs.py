"""Verify csv-query.js behavior against the SPEC.md contract.

Runs `node /app/csv-query.js ...` as a subprocess for each case and asserts
exact stdout, stderr routing, and exit codes.
"""

import subprocess
import tempfile
from pathlib import Path

APP = Path("/app")
CLI = APP / "csv-query.js"
DATA = APP / "data.csv"


def run(*args: str, cwd: str = "/tests") -> subprocess.CompletedProcess:
    return subprocess.run(
        ["node", str(CLI), *args],
        capture_output=True,
        text=True,
        cwd=cwd,
        timeout=60,
    )


def test_help_example_from_spec() -> None:
    """The exact example printed in SPEC.md must reproduce."""
    result = run(
        "--where", "department=Engineering",
        "--select", "name,salary",
        "--sort", "name",
        str(DATA),
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout == (
        'name\tsalary\n'
        'Alice "Ace" Miller\t120000\n'
        'Chen, Wei\t140000\n'
    )


def test_default_all_columns_and_row_order() -> None:
    result = run(str(DATA))
    assert result.returncode == 0, result.stderr
    assert result.stdout == (
        "name\tdepartment\tsalary\tcity\n"
        'Alice "Ace" Miller\tEngineering\t120000\tBerlin\n'
        "Bob Jones\tSales\t85,500\tLondon\n"
        "Chen, Wei\tEngineering\t140000\tShanghai\n"
        "Dana White\tMarketing\t95000\tNew York\n"
        'Eve Adams"Jr.\tSales\t78000\tParis\n'
    )


def test_where_on_quoted_field_with_spaces() -> None:
    result = run("--where", "city=New York", str(DATA))
    assert result.returncode == 0, result.stderr
    assert result.stdout == (
        "name\tdepartment\tsalary\tcity\nDana White\tMarketing\t95000\tNew York\n"
    )


def test_where_value_containing_equals_sign() -> None:
    with tempfile.NamedTemporaryFile("w", suffix=".csv", delete=False) as f:
        f.write("a,b\nx,y=1\n")
        path = f.name
    result = run("--where", "b=y=1", path)
    assert result.returncode == 0, result.stderr
    assert result.stdout == "a\tb\nx\ty=1\n"


def test_multiple_where_flags_are_anded() -> None:
    result = run(
        "--where", "department=Sales",
        "--where", "city=London",
        str(DATA),
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout == (
        "name\tdepartment\tsalary\tcity\nBob Jones\tSales\t85,500\tLondon\n"
    )


def test_no_matches_prints_only_header() -> None:
    result = run("--where", "department=Legal", "--select", "name", str(DATA))
    assert result.returncode == 0, result.stderr
    assert result.stdout == "name\n"


def test_select_reorder_and_duplicate_columns() -> None:
    result = run("--select", "city,name,name", "--where", "salary=78000", str(DATA))
    assert result.returncode == 0, result.stderr
    assert result.stdout == "city\tname\tname\nParis\tEve Adams\"Jr.\tEve Adams\"Jr.\n"


def test_select_multiple_flags_concatenate() -> None:
    result = run(
        "--select", "salary",
        "--select", "name",
        "--where", "salary=95000",
        str(DATA),
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout == "salary\tname\n95000\tDana White\n"


def test_sort_is_lexicographic_and_stable() -> None:
    result = run("--sort", "salary", "--select", "name,salary", str(DATA))
    assert result.returncode == 0, result.stderr
    # Byte-wise ascending on the raw string: "120000" < "140000" < "78000" < "85,500" < "95000"
    assert result.stdout == (
        "name\tsalary\n"
        'Alice "Ace" Miller\t120000\n'
        "Chen, Wei\t140000\n"
        'Eve Adams"Jr.\t78000\n'
        "Bob Jones\t85,500\n"
        "Dana White\t95000\n"
    )


def test_quoted_field_with_embedded_newline() -> None:
    with tempfile.NamedTemporaryFile("w", suffix=".csv", delete=False) as f:
        f.write('a,b\n"line1\nline2",end\nplain,done\n')
        path = f.name
    result = run("--where", "b=end", str(path))
    assert result.returncode == 0, result.stderr
    assert result.stdout == "a\tb\nline1\nline2\tend\n"


def test_trailing_newline_does_not_add_empty_row() -> None:
    result = run(str(DATA))  # data.csv ends with a trailing newline
    lines = result.stdout.splitlines()
    assert result.returncode == 0, result.stderr
    assert len(lines) == 6  # header + 5 rows


def test_unknown_column_exits_2() -> None:
    result = run("--where", "nope=1", str(DATA))
    assert result.returncode == 2
    assert result.stderr.strip() != ""
    assert result.stdout == ""


def test_unknown_select_column_exits_2() -> None:
    result = run("--select", "name,nope", str(DATA))
    assert result.returncode == 2
    assert result.stderr.strip() != ""


def test_unknown_sort_column_exits_2() -> None:
    result = run("--sort", "nope", str(DATA))
    assert result.returncode == 2
    assert result.stderr.strip() != ""


def test_missing_file_argument_exits_2() -> None:
    result = run()
    assert result.returncode == 2
    assert result.stderr.strip() != ""


def test_unreadable_file_exits_2() -> None:
    result = run("/tests/does-not-exist.csv")
    assert result.returncode == 2
    assert result.stderr.strip() != ""


def test_malformed_csv_unclosed_quote_exits_2() -> None:
    with tempfile.NamedTemporaryFile("w", suffix=".csv", delete=False) as f:
        f.write('a,b\n"unclosed,1\n')
        path = f.name
    result = run(path)
    assert result.returncode == 2
    assert result.stderr.strip() != ""
