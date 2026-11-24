import assert from "node:assert/strict";
import test from "node:test";
import { _setDictionary, exactDictionaryEntry, expandAbbreviation, matchingDictionaryEntries } from "../src/dictionary.js";

test("동일 정규화 이름의 순서·현행 약칭 우선순위와 사전 교체를 보존한다", () => {
  const first = { n: "주택 법", i: "1" }, second = { n: "주택법", i: "2" };
  _setDictionary({ entries: [first, second], abbreviations: [
    { abbr: "주법", name: "과거" }, { abbr: "주 법", name: "현행", current: true },
    { abbr: "주법", name: "다음", current: true },
  ] });
  assert.equal(exactDictionaryEntry("주택법"), first);
  assert.deepEqual([...matchingDictionaryEntries("주택")], [first, second]);
  assert.equal(expandAbbreviation("주 법"), "현행");
  _setDictionary({ entries: [second] });
  assert.equal(exactDictionaryEntry("주택법"), second);
  assert.equal(expandAbbreviation("주법"), null);
});
