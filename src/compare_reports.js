// Compares generated reports (generated.json) with Toast's own export (toast_reports.json). Numbers must match to 0.01.
//   node src/compare_reports.js <toast_reports.json> <generated.json>
const fs = require("fs");
const T = JSON.parse(fs.readFileSync(process.argv[2], "utf8")), G = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
const num = (v) => (v === null || v === "" || v === undefined || v === "None" ? null : isNaN(Number(v)) ? v : Number(v));
const nameCols = { "Payments summary": 2, "Service mode summary": 1, "Menu groups": 2, "Modifiers": 3, "Special requests": 3, "Items": 2, "Menus": 1 };
let totalOk = 0, totalBad = 0; const report = [];
for (const [k, mine] of Object.entries(G)) {
  for (const [name, header, rows] of mine) {
    const toast = T[k][name];
    if (!toast) { report.push([name, "no Toast sheet"]); continue; }
    let tt = toast;
    if (name === "Summary") { const hi = toast.findIndex((r) => r[0] === "Qty sold"); tt = toast.slice(hi); }
    const th = tt[0] || [], trows = tt.slice(1).filter((r) => r.some((v) => v !== null && v !== ""));
    const nk = nameCols[name] || 1;
    const key = (r) => r.slice(0, nk).map((v) => (v === null || v === undefined ? "" : String(v).trim())).join("|");
    const mm = new Map(rows.map((r) => [key(r), r]));
    let ok = 0; const bad = [];
    for (const tr of trows) {
      const r = mm.get(key(tr));
      if (!r) { bad.push(`missing row "${key(tr)}"`); continue; }
      let rowOk = true;
      for (let c = nk; c < th.length; c++) {
        const a = num(tr[c]), b = num(r[c]);
        if (a === null && (b === null || b === 0)) continue;
        if (b === null && (a === null || a === 0)) continue;
        if (typeof a === "number" && typeof b === "number" ? Math.abs(a - b) > 0.011 : String(a) !== String(b)) { rowOk = false; bad.push(`"${key(tr)}" ${th[c]}: toast ${a} vs ours ${b}`); }
      }
      if (rowOk) ok++;
    }
    const extra = rows.filter((r) => !trows.some((t) => key(t) === key(r))).map((r) => key(r));
    totalOk += ok; totalBad += bad.length;
    report.push([name, `${ok}/${trows.length} rows match`, bad.length ? bad.slice(0, 6).join("; ") + (bad.length > 6 ? ` (+${bad.length - 6} more)` : "") : "", extra.length ? `extra rows in ours: ${extra.slice(0, 4).join(", ")}` : ""]);
  }
}
for (const r of report) console.log(r.filter(Boolean).join("  |  "));
console.log(`\nrows matched: ${totalOk}; differences: ${totalBad}`);
