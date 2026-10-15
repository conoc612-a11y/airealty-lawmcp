# airealty-lawmcp — 법제처 국가법령정보 OPEN API 위의 법령 MCP 서버

대한민국 법령·조문·별표·연혁·판례·해석례를 Claude 등 MCP 클라이언트에서 바로 찾아보는 서버입니다.
업스트림은 법제처 국가법령정보 공동활용 OPEN API(`open.law.go.kr`)이며, 응답은 모두 읽기 전용입니다.

## 연결하기 — 두 가지 방법

### 1. 호스팅 서버(토큰 필요) — 설치 없이 한 줄

```bash
claude mcp add --transport http airealty-law https://law.airealty.co.kr/mcp --header "Authorization: Bearer <발급받은 토큰>"
```

토큰은 운영자(`conoc612@gmail.com`)에게 요청하면 사용자별로 발급됩니다. 토큰마다 초당 2회·버스트 10회·하루 2,000회(`tools/call` 기준)로 제한되며, 넘으면 `429` 와 `Retry-After` 를 돌려줍니다.
Claude 앱(claude.ai·Desktop)에서는 **설정 → 커넥터 → 커스텀 커넥터 추가** 에 같은 URL 을 넣고 요청 헤더 `Authorization: Bearer <토큰>` 을 지정합니다(요청 헤더 입력은 조직 Owner 에게만 보이는 베타 기능입니다).

### 2. 로컬 설치(자기 법제처 키) — 한도를 혼자 씁니다

1. [open.law.go.kr](https://open.law.go.kr) 가입 → OPEN API 신청(승인 1~2일) → **API인증키관리** 에서 인증값(OC) 복사.
2. ```bash
   git clone https://github.com/conoc612-a11y/airealty-lawmcp && cd airealty-lawmcp && npm install
   claude mcp add airealty-law -e openlaw_API_KEY=<내 인증값> -- node /절대경로/airealty-lawmcp/src/index.js
   ```
   인증값은 환경변수 `openlaw_API_KEY` 또는 저장소 상위 폴더의 `keys.env`(`openlaw_API_KEY=…`)에서 읽고, 어디에도 출력하지 않습니다.

## 도구

코어 12(항상 노출): `statute_find` `article_get` `statute_outline` `annex_get` `statute_history` `source_search` `source_get` `citation_audit` `precedent_trace` `contract_risk_scan` `research_run` `toolbox`
카탈로그 12(`toolbox` 로 호출): `term_lookup` `abbreviation_list` `change_feed` `jo_code` `article_refs` `link_build` `precedent_similar` `ordinance_link` `admin_rule_diff` `semantic_article_search` `english_statute` `article_with_cases`

`research_run` 시나리오: `rent_dispute` `housing_subscription` `redevelopment_procedure` `brokerage_duty` `zoning_check` `tax_on_transfer` `contract_check` `version_at` `statute_map` `amendment_watch`.
`source_search` 원천 20종 중 특별행정심판 2종은 `acr_adjudication`·`civil_service_appeal`. `term_lookup` 모드: `define` `from_everyday` `to_everyday` `articles`.
`article_get` 은 `format`(기본 `structured`: 항·호 트리 + `head`, `text`: 평문만)으로 같은 본문을 두 번 싣지 않습니다.

모든 도구는 같은 봉투 `{ok,total,returned,page?,items,warnings,notes,next,meta}` / 오류 `{ok:false,error:{code,message,retryable,hint?,candidates?}}` 를 돌려주고, `annotations.readOnlyHint=true` 입니다.

## 직접 띄우기

```bash
npm install
npm test                            # 빌드 검사(tools/list ≤13KB · 코어 12 · 카탈로그 12) + 단위 테스트(모의 업스트림, 네트워크 없음)
node src/index.js                   # stdio MCP
node src/http-server.js             # Streamable HTTP 127.0.0.1:3457/mcp (POST 전용, GET/DELETE 405, /healthz)
LAWMCP_LIVE_URL=http://127.0.0.1:3457/mcp npm run test:live   # 실업스트림 B1~B11(서버 떠 있어야 함)
node tools/bench.js --out bench.json                           # cold start 5회 + B1~B11 5회
```

### 공개 호스팅(HTTP) 설정

- 토큰은 `node tools/token.js add <이름>` 으로 발급(값은 그때 한 번만 출력) · `revoke <이름>` · `list`. 파일 `~/.config/airealty-lawmcp/tokens.txt` 에는 `이름 sha256(토큰)` 만 남고, 서버가 5초마다 파일 변경을 따라가므로 재시작이 필요 없습니다.
- **인증 강제**: `LAWMCP_HOST` 가 루프백이 아니거나 `LAWMCP_REQUIRE_AUTH=1` 이거나 토큰 설정이 있는데 유효 토큰이 0개면 종료 코드 2. 토큰이 없는 서버라도 `cf-connecting-ip`·`x-forwarded-for` 가 붙은(프록시를 거친) 요청은 401 입니다. JSON-RPC 배치(배열)는 400 으로 거부합니다(한도 우회 방지).
- 토큰 출처: `LAWMCP_TOKENS_FILE`(파일, 해시 또는 평문 줄) 또는 `LAWMCP_TOKENS`(`이름:토큰,…` 평문). 비교는 sha256 + timingSafeEqual, 로그에는 이름만 남깁니다.
- 토큰별 한도(`tools/call` 만 셈): `LAWMCP_TOKEN_RATE_PER_SEC`(2) · `LAWMCP_TOKEN_BURST`(10) · `LAWMCP_TOKEN_DAILY`(2000, UTC 자정 초기화 — 일일 상한의 `Retry-After` 는 최대 86400초).
- `/healthz` 는 토큰 없이 `ok`·`version` 만, 토큰이 있으면 캐시·업스트림·한도·예열 상태까지.
- 브라우저 Origin 은 로컬(localhost·127.0.0.1)만 허용하며 `LAWMCP_ALLOWED_ORIGINS`(쉼표)로 더할 수 있습니다. 그 밖의 Origin 은 403.
- HTTPS 는 앞단(Cloudflare Tunnel 등)에서 끝냅니다. 서버 자체는 평문 HTTP 입니다.
- 컨테이너: `docker build -t airealty-lawmcp . && docker run -e openlaw_API_KEY=… -e LAWMCP_TOKENS=me:… -p 3457:3457 airealty-lawmcp`

### 환경변수

`LAWMCP_PORT`(3457) · `LAWMCP_HOST`(127.0.0.1) · `LAWMCP_CONCURRENCY`(4, 1~8) · `LAWMCP_RATE_PER_SEC`(5) · `LAWMCP_BURST`(8) — 업스트림 전체 한도 ·
`LAWMCP_BUCKET_FILE`(파일 공유 버킷) · `LAWMCP_CACHE_DIR`(디스크 캐시: 사전·조문 번호 색인 24h·체계도 요약 7d·판 목록 6h — 키 없음) · `LAWMCP_HIERARCHY_BUDGET_MS`(1200) ·
`LAWMCP_PREWARM`(기본 1: 서버가 뜬 뒤 `src/prewarm.js` 목록 38개 법령의 색인·체계도를 백그라운드로 채움, `0` 이면 끔) · `LAWMCP_DEBUG`(stderr 오류 로그).

예열·만료 갱신은 `drf.call(..., {background:true})` 레인으로만 나갑니다: 전경 요청이 진행 중이거나 버킷 여유가 2토큰 미만이면 기다리고, 전경 요청이 같은 키에 합류하면 바로 나갑니다. `/healthz` 의 `prewarm`·`auth` 에 상태가 보입니다.

## 구조

`src/drf.js`(호출·버킷·재시도·차단기·백그라운드 레인) · `cache.js` · `diskcache.js` · `article_index.js`(조문 번호 색인) · `hierarchy_cache.js`(체계도 요약) · `prewarm.js` · `dictionary.js`(법령명 사전) · `resolver.js`(이름 해석) · `versions.js`(판 선택) · `articles.js`(조문 구조화) ·
`citations.js`+`casenos.js`(인용 추출) · `sources.js`(원천 20종) · `risk/`(문서 위험 규칙·엔진) · `tools/*`(도구) · `registry.js` · `stdio.js` · `http-server.js` · `auth.js`(토큰·토큰별 한도).

## 개인정보·출처

서버는 요청 본문(검색어·문서 텍스트)을 법제처 API 호출에만 쓰고 저장하지 않습니다. 디스크 캐시에는 법령 파생물(사전·조문 번호 색인·체계도 요약·판 목록)만 남고 사용자 입력·인증값은 들어가지 않습니다. 로그에는 토큰 **이름**과 횟수만 남습니다.
법령정보의 저작권은 법제처에 있으며 출처는 응답의 `link`(www.law.go.kr 공개 주소)로 표기합니다. 상업적 이용 가능 여부는 법제처 이용안내를 따릅니다.

## 라이선스

MIT — `LICENSE`.
