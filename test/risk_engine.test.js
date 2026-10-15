// contract_risk_scan — §5 수용 기준(합성 픽스처), 200자 미만 거부, 금액 단위, 기간 충돌, 규칙 데이터 형식.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { analyze, parseKoreanAmount, extractFigures, splitClauses, RULE_DATA } from "../src/risk/engine.js";
import contract_risk_scan from "../src/tools/contract_risk_scan.js";

const fx = (n) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), "utf8");

test("합성 주택임대차 계약서: 갱신요구권 배제 R1 high(제6조의3), 증액 초과 R2, 전입 금지 R3", async () => {
  const r = await contract_risk_scan.invoke({ text: fx("lease_risky.txt") });
  assert.equal(r.ok, true); const x = r.items[0];
  assert.equal(x.docType.value, "housing_lease");
  const f1 = x.findings.find((f) => f.rule === "R1-H-RENEWAL-WAIVER"); assert.ok(f1 && f1.severity === "high"); assert.ok(f1.basis.some((b) => b.law === "주택임대차보호법" && b.label === "제6조의3"));
  assert.ok(x.findings.some((f) => f.category === "R2" && f.severity === "high"));
  assert.ok(x.findings.some((f) => f.rule === "R3-H-REGISTRATION-BAN"));
  assert.ok(x.findings.every((f) => f.basis.length && f.basis.every((b) => b.law && b.label && b.effectiveDate && b.link.startsWith("https://www.law.go.kr/"))));
  assert.ok(x.findings.every((f) => !/무효다|무효이다|위법이다/.test(f.why.split(".")[0])), "첫 문장에 단정어 없음");
  assert.ok(["D", "E"].includes(x.grade.value));
});

test("표준 계약서 픽스처: high 0", async () => {
  const r = await contract_risk_scan.invoke({ text: fx("lease_standard.txt") });
  assert.equal(r.items[0].findings.filter((f) => f.severity === "high").length, 0);
});

test("200자 미만 → INVALID_INPUT", async () => {
  const r = await contract_risk_scan.invoke({ text: "짧은 계약서" });
  assert.equal(r.ok, false); assert.equal(r.error.code, "INVALID_INPUT");
});

test("금액 단위 정규화(만원·억원 혼합)·기간·날짜", () => {
  assert.equal(parseKoreanAmount("1억 2천만원"), 120000000);
  assert.equal(parseKoreanAmount("5,000만원"), 50000000);
  assert.equal(parseKoreanAmount("삼천만원"), 30000000);
  assert.equal(parseKoreanAmount("1억 800만원"), 108000000);
  assert.equal(parseKoreanAmount("500,000원"), 500000);
  assert.equal(parseKoreanAmount("2억원"), 200000000);
  const f = extractFigures("보증금 1억 2천만원, 계약금 1,200만원, 잔금 1억 800만원. 임대차기간은 2026년 11월 1일부터 2년으로 한다. 해지는 3개월 전 통지.");
  assert.deepEqual(f.amounts.map((a) => [a.label, a.value]), [["보증금", 120000000], ["계약금", 12000000], ["잔금", 108000000]]);
  assert.ok(f.periods.some((p) => p.value === 2 && p.unit === "년") && f.periods.some((p) => p.value === 3 && p.unit === "개월"));
  assert.ok(!f.periods.some((p) => p.value === 26));
  assert.equal(f.dates[0].value, "2026-11-01");
});

test("기간 충돌: 해지 통지기간 ≥ 계약기간, 같은 라벨 다른 금액", () => {
  const t = "제1조(계약기간) 계약기간은 6개월로 한다.\n제2조(해지) 해지 통지는 12개월 전에 한다.\n제3조(보증금) 보증금은 5천만원이다.\n제4조(반환) 보증금 4천만원을 반환한다.";
  const r = analyze(t, { docType: "housing_lease" });
  assert.ok(r.conflicts.some((c) => c.kind === "notice_exceeds_term"));
  assert.ok(r.conflicts.some((c) => c.kind === "amount_mismatch" && c.label === "보증금"));
  assert.equal(splitClauses(t).length, 4);
});

test("규칙 데이터 형식: id·category·basis·basisEffectiveDate·elements·severityRationale, 외부 식별자 없음", () => {
  assert.ok(RULE_DATA.rules.length >= 30);
  for (const r of RULE_DATA.rules) {
    for (const k of ["id", "category", "severity", "basis", "basisEffectiveDate", "elements", "severityRationale", "docTypes"]) assert.ok(r[k] != null, `${r.id} ${k}`);
    assert.ok(r.signals || r.check, r.id);
    assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(r.basisEffectiveDate));
    assert.ok(r.basis.every((b) => /^제\d+조(의\d+)?$/.test(b.label)));
  }
});
