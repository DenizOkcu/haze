#!/bin/bash
# Reference solution for local/csv-query.
# Overwrites the stub with a working implementation, then verifies it.

cat > /app/csv-query.js <<'SOLUTION_EOF'
#!/usr/bin/env node
"use strict";

function parseCsv(text) {
  const rows = [];
  let field = "";
  let row = [];
  let inQuotes = false;
  let i = 0;
  const n = text.length;

  while (i < n) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
        } else {
          inQuotes = false;
          i += 1;
        }
      } else {
        field += ch;
        i += 1;
      }
    } else if (ch === '"') {
      inQuotes = true;
      i += 1;
    } else if (ch === ",") {
      row.push(field);
      field = "";
      i += 1;
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i += 1;
    } else if (ch === "\r") {
      i += 1; // tolerate CRLF
    } else {
      field += ch;
      i += 1;
    }
  }
  if (inQuotes) {
    throw new Error("malformed CSV: unclosed quote");
  }
  // Final field/row (file without trailing newline).
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  // Drop fully-empty trailing rows produced by a trailing newline.
  while (rows.length > 0 && rows[rows.length - 1].length === 1 && rows[rows.length - 1][0] === "") {
    rows.pop();
  }
  return rows;
}

function fail(msg) {
  process.stderr.write(`csv-query: ${msg}\n`);
  process.exit(2);
}

function main() {
  const argv = process.argv.slice(2);
  const wheres = [];
  const selects = [];
  let sortCol = null;
  let file = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--where") {
      const spec = argv[++i];
      if (spec === undefined) fail("--where requires COLUMN=VALUE");
      const eq = spec.indexOf("=");
      if (eq <= 0) fail(`invalid --where spec: ${spec}`);
      wheres.push([spec.slice(0, eq), spec.slice(eq + 1)]);
    } else if (arg === "--select") {
      const spec = argv[++i];
      if (spec === undefined) fail("--select requires a column list");
      for (const col of spec.split(",")) selects.push(col);
    } else if (arg === "--sort") {
      const spec = argv[++i];
      if (spec === undefined) fail("--sort requires a column");
      sortCol = spec;
    } else if (file === null) {
      file = arg;
    } else {
      fail(`unexpected argument: ${arg}`);
    }
  }

  if (file === null) fail("missing FILE argument");

  const fs = require("fs");
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    fail(`cannot read ${file}: ${err.message}`);
  }

  let rows;
  try {
    rows = parseCsv(text);
  } catch (err) {
    fail(err.message);
  }
  if (rows.length === 0) fail("empty CSV file");
  const header = rows[0];
  const colIndex = new Map(header.map((name, idx) => [name, idx]));

  const requireCol = (name, flag) => {
    if (!colIndex.has(name)) fail(`unknown column '${name}' in ${flag}`);
    return colIndex.get(name);
  };

  for (const [name] of wheres) requireCol(name, "--where");
  const selectIdx = (selects.length > 0 ? selects : header).map((name) =>
    requireCol(name, "--select")
  );
  let sortIdx = -1;
  if (sortCol !== null) sortIdx = requireCol(sortCol, "--sort");

  let data = rows.slice(1);
  for (const [name, value] of wheres) {
    const idx = colIndex.get(name);
    data = data.filter((r) => (r[idx] !== undefined ? r[idx] : "") === value);
  }
  if (sortIdx >= 0) {
    const keyed = data.map((r, i) => [r[sortIdx] !== undefined ? r[sortIdx] : "", i, r]);
    keyed.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1]));
    data = keyed.map((k) => k[2]);
  }

  const out = [];
  out.push(selectIdx.map((idx) => header[idx]).join("\t"));
  for (const r of data) out.push(selectIdx.map((idx) => (r[idx] !== undefined ? r[idx] : "")).join("\t"));
  process.stdout.write(out.join("\n") + "\n");
}

main();
SOLUTION_EOF

node /app/csv-query.js --where department=Engineering --select name,salary --sort name /app/data.csv
