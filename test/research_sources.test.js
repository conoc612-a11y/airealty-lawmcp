import test from "node:test";
import assert from "node:assert/strict";
import { getTool } from "../src/registry.js";
import { semantic_article_search } from "../src/tools/catalog.js";
import { _setDictionary } from "../src/dictionary.js";

const law = "주택임대차보호법";
const housing = "주택공급에 관한 규칙";
const empty = () => ({ ok: true, items: [], total: 0 });

test("청약 조사는 본문에서 찾고 공급 법령 또는 질문과 일치하는 제목을 보여준다", async t => {
  _setDictionary({ entries: [{ n: housing }], loadedAt: Date.now() });
  for (const tool of [semantic_article_search, getTool("annex_get")]) t.mock.method(tool, "invoke", empty);
  const search = t.mock.method(getTool("source_search"), "invoke", async () => ({
    ok: true, source: "interpretation", total: 30,
    items: [
      { id: "1", title: "부담금 환급 여부(「학교용지 확보 등에 관한 특례법」 관련)" },
      { id: "2", title: "모집 자격(「주택공급에관한규칙」 관련)" },
      { id: "3", title: "조합원 자격(「주택법 시행령」 관련)" },
      { id: "4", title: "주택 청약 자격에 관한 질의" },
    ],
  }));
  const body = await getTool("research_run").invoke({ scenario: "housing_subscription", query: "주택 청약 자격" });
  assert.equal(body.ok, true);
  assert.equal(search.mock.callCount(), 1);
  assert.equal(search.mock.calls[0].arguments[0].field, "body");
  const step = body.items[0].steps.find(s => s.name === "선례·해석");
  assert.deepEqual(step.items.map(item => item.id), ["2", "3", "4"]);
  assert.equal(step.total, 30);
  assert.equal(step.source, "interpretation");
  assert.equal(step.candidatesExamined, 4);
  assert.equal(step.candidatesKept, 3);
});

test("계약 조사는 찾아낸 조문으로 검색하고 같은 판결만 중복 제거한다", async t => {
  _setDictionary({ entries: [{ n: law }], loadedAt: Date.now() });
  t.mock.method(getTool("contract_risk_scan"), "invoke", async () => ({
    ok: true, items: [{ findings: [{ basis: [{ law, label: "제6조의3" }] }] }],
  }));
  t.mock.method(getTool("article_get"), "invoke", empty);
  const common = { caseNo: "2023다1", court: "대법원", date: "2024-01-01", kind: "판결" };
  const search = t.mock.method(getTool("source_search"), "invoke", async () => ({
    ok: true, source: "precedent", total: 4, items: [
      { ...common, id: "1", court: "서울고등법원" },
      { ...common, id: "2" }, { ...common, id: "3", caseNo: "2023 다1" },
      { ...common, id: "4", date: "2024-02-01" },
    ],
  }));
  const body = await getTool("research_run").invoke({ scenario: "contract_check", query: "계약서 검토", text: "갱신요구권을 포기한다." });
  assert.equal(body.ok, true);
  assert.equal(search.mock.callCount(), 1);
  const [args] = search.mock.calls[0].arguments;
  assert.equal(args.query, '"주택임대차보호법 제6조의3"');
  assert.equal(args.field, "body");
  const step = body.items[0].steps.find(s => s.name === "관련 판례");
  assert.deepEqual(step.items.map(item => item.id), ["2", "4", "1"]);
  assert.equal(step.candidatesKept, 3);
});
