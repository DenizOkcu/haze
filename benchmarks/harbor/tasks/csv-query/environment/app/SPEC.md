# csv-query — CSV filtering CLI

Implement `csv-query.js` in `/app` so it behaves exactly as specified below.
Node.js (>= 18) is preinstalled. **Do not install any npm dependencies** — the
solution must be a single self-contained file using only the Node standard
library. Do not modify `data.csv`, `SPEC.md`, or any other file; write your
implementation into `csv-query.js`.

## Command line

```
node csv-query.js [--where COLUMN=VALUE]... [--select COL1[,COL2...]]... [--sort COLUMN] FILE
```

## CSV parsing rules

1. Fields are separated by `,`; rows are separated by `\n` (a trailing newline
   at end of file is allowed and must not produce an empty final row).
2. A field may be wrapped in double quotes. Quoted fields may contain commas
   and newlines.
3. Inside a quoted field, `""` is an escaped literal double quote.
4. Values used for `--where`, `--select`, `--sort` and for output are the
   *unquoted* field values (quotes are not part of the value).
5. Unclosed quotes are malformed input: print an error message to `stderr`
   and exit with status `2`.
6. The first row of the file is the header.

## Filtering (`--where`)

- `--where COLUMN=VALUE` keeps rows whose field value in `COLUMN` equals
  `VALUE` exactly (plain string comparison, no quoting on either side).
- Multiple `--where` flags combine with AND.
- `VALUE` may contain `=` (split on the first `=` only: column name is before
  the first `=`).

## Column selection (`--select`)

- `--select a,b` outputs only columns `a` and `b`, in the order given.
- The flag may be given multiple times; the effective selection is the
  concatenation of all lists, in order.
- The same column may appear more than once.
- Default (no `--select`): all columns in file order.

## Sorting (`--sort COLUMN`)

- Sorts rows lexicographically (ascending, byte-wise, as raw UTF-8 strings —
  no numeric or locale-aware comparison) by the field value in `COLUMN`.
- The sort must be stable: rows with equal keys keep their file order.
- The header is never sorted; it is always the first output line.

## Output

- Print the selected column names as the first line, then one line per
  (filtered, sorted) row.
- Fields are joined by a single TAB character (`\t`). Values are printed raw
  (never re-quoted).
- If no rows match, print only the header line and exit `0`.
- End the output with a trailing newline after the last line.

## Errors

- Unknown column in `--where`, `--select`, or `--sort`, a missing `FILE`
  argument, an unreadable file, or malformed CSV: print a message to `stderr`
  and exit with status `2`.
- Exit status is `0` on success.

## Example

Given `data.csv` in `/app`:

```
$ node csv-query.js --where department=Engineering --select name,salary --sort name data.csv
name	salary
Alice "Ace" Miller	120000
Chen, Wei	140000
```

(The first name contains a literal quoted `Ace` and the second contains a
literal comma — both come out raw, joined by tabs.)
