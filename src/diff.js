// 두 조문의 문장 단위 비교 — 최장 공통 부분열(LCS). 입력은 문자열 배열, 출력은 {op:"equal"|"del"|"add", text} 순서열.
export function diff(a, b) {
  const n = a.length, m = b.length;
  const table = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
  const ops = []; let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { ops.push({ op: "equal", text: a[i] }); i++; j++; }
    else if (table[i + 1][j] >= table[i][j + 1]) { ops.push({ op: "del", text: a[i] }); i++; }
    else { ops.push({ op: "add", text: b[j] }); j++; }
  }
  while (i < n) ops.push({ op: "del", text: a[i++] });
  while (j < m) ops.push({ op: "add", text: b[j++] });
  return ops;
}

/** 문장 분할: 마침표·물음표·느낌표 뒤 공백, 줄바꿈. 항 기호(①)·호 기호(1.)는 그 줄의 앞 조각으로 남는다. */
export function splitSentences(s) {
  return String(s || "").split(/(?<=[.。!?])\s+|\n+/u).map((x) => x.trim()).filter(Boolean);
}
export function diffSentences(a, b) { return diff(splitSentences(a), splitSentences(b)); }
