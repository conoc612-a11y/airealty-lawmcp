// case_search — 로컬 사건 폴더(과거 준비서면·신청서·판결문 등) 키워드 검색.
// 대상 폴더는 환경변수 LAWMCP_CASES_DIR(절대경로). 서버가 접근할 수 있는 로컬 폴더만 검색하며,
// 업로드·외부 전송은 하지 않는다(개인정보 — 경로는 응답에 남기지만 본문은 스니펫만).
// 인덱스 없이 스캔+가산점(용어 등장 수)으로 찾는다: 폴더 총 크기 상한 50MB, 파일당 2MB, 깊이 6.
import { defineTool, ok, z, S } from "../tool.js";
import { invalid } from "../errors.js";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, extname, basename } from "node:path";

const MAX_TOTAL = 50 * 1024 * 1024;
const MAX_FILE = 2 * 1024 * 1024;
const MAX_DEPTH = 6;
const EXTS = new Set([".txt", ".md", ".csv", ".json", ".xml", ".hwpx"]);
const SKIP_DIRS = new Set(["node_modules", ".git", "$RECYCLE.BIN", "System Volume Information"]);

function listFiles(root, depth, out) {
  let entries;
  try { entries = readdirSync(root, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (out.files.length >= 2000 || out.bytes >= MAX_TOTAL) return;
    const p = join(root, e.name);
    if (e.isDirectory()) { if (depth < MAX_DEPTH && !SKIP_DIRS.has(e.name)) listFiles(p, depth + 1, out); continue; }
    if (!e.isFile() || !EXTS.has(extname(e.name).toLowerCase())) continue;
    try {
      const st = statSync(p);
      if (st.size > MAX_FILE || out.bytes + st.size > MAX_TOTAL) continue;
      out.files.push({ path: p, size: st.size, mtime: st.mtime.toISOString().slice(0, 10), name: basename(e.name) });
      out.bytes += st.size;
    } catch {}
  }
}

/** 쿼리를 한글 2글자 이상 어절로 쪼갠다(최대 8개). */
function terms(q) {
  const words = [...new Set(String(q).split(/[\s,.;:()\[\]{}"'`~!@#$%^&*+=|\\/<>?·…—–-]+/))]
    .map((w) => w.trim()).filter((w) => w.length >= 2).slice(0, 8);
  return words;
}

function snippet(text, at, span = 160) {
  const s = Math.max(0, at - 40);
  return (s > 0 ? "…" : "") + text.slice(s, s + span).replace(/\s+/g, " ") + "…";
}

export default defineTool({
  name: "case_search",
  description:
    "사무소 과거 사건 문서(준비서면·신청서·판결문 등)를 키워드로 검색한다. 대상 폴더는 환경변수 LAWMCP_CASES_DIR 로 지정하며 " +
    "UTF-8 텍스트(.txt·.md·.csv·.json·.xml, 평문으로 저장한 .hwpx)를 읽어 등장 수로 순위를 매긴다. 압축 HWPX는 제외한다.",
  catalog: { summary: "과거 사건 문서 로컬 키워드 검색(LAWMCP_CASES_DIR)", tags: ["사건", "검색", "로컬"], example: { query: "대항력 보증금" } },
  schema: {
    query: z.string().min(2).max(120),
    size: S.size(10),
    maxFileBytes: z.number().int().min(1000).max(2 * 1024 * 1024).optional().describe("파일당 읽기 상한(기본 2MB)"),
  },
  async handler(a) {
    const root = process.env.LAWMCP_CASES_DIR;
    if (!root) throw invalid("LAWMCP_CASES_DIR 환경변수에 사건 폴더 절대경로를 지정하세요(예: ~/사건)");
    const list = { files: [], bytes: 0 };
    listFiles(root, 0, list);
    if (!list.files.length) return ok({ items: [], total: 0, notes: [`'${root}' 에 검색 가능한 문서가 없습니다(.txt .md .csv .json .xml .hwpx)`] });
    const termsList = terms(a.query);
    if (!termsList.length) throw invalid("검색어는 2글자 이상 어절로 주세요");
    const maxFile = a.maxFileBytes ?? MAX_FILE;
    const foldedTerms = termsList.map((term) => term.toLowerCase());
    const scored = [];
    for (const f of list.files) {
      if (f.size > maxFile) continue;
      let text;
      try { text = readFileSync(f.path, "utf8"); } catch { continue; }
      if (extname(f.name).toLowerCase() === ".hwpx" && text.startsWith("PK")) continue;
      const lower = text.toLowerCase(), filename = f.name.toLowerCase();
      let first = Infinity;
      let score = 0; const hits = [];
      for (const [idx, term] of foldedTerms.entries()) {
        let i = lower.indexOf(term);
        if (i < 0) continue;
        first = Math.min(first, i);
        hits.push(termsList[idx]);
        if (filename.includes(term)) score += 10;
        do { score++; i = lower.indexOf(term, i + 1); } while (i >= 0);
      }
      if (score > 0) scored.push({ file: f, score, hits, excerpt: snippet(text, first) });
    }
    scored.sort((x, y) => y.score - x.score || (y.file.mtime || "").localeCompare(x.file.mtime || ""));
    const items = scored.slice(0, a.size).map(({ file, score, hits, excerpt }) => ({
      path: file.path,
      name: file.name,
      modified: file.mtime,
      score,
      matchedTerms: hits,
      missingTerms: termsList.filter((t) => !hits.includes(t)),
      snippet: excerpt,
    }));
    return ok({
      items,
      total: scored.length,
      notes: [
        `스캔 폴더: ${root} · 파일 ${list.files.length}개 · ${Math.round(list.bytes / 1024)}KB (상한 50MB)`,
        "본문은 스니펫(160자)만 응답에 실고, 원문은 로컬 파일에서 직접 확인하세요",
        "임베딩 유사 검색은 아니며 키워드 등장 수 기반입니다",
      ],
    });
  },
});
