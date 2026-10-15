# airealty 법령 MCP — 사용자 설치·이용 안내

Claude(또는 MCP 를 지원하는 다른 AI 도구)에서 대한민국 법령·조문·판례·해석례를 바로 찾아 주는 서버입니다.
연결 방법은 두 가지입니다. **A. 호스팅 서버(토큰)** 가 간단하고, **B. 로컬 설치(자기 키)** 는 호출 한도를 혼자 씁니다.

---

## A. 호스팅 서버에 토큰으로 연결 (설치 없음, 1분)

### 준비물
- 운영자에게 받은 **토큰** (`lm_` 로 시작하는 긴 문자열). 토큰은 비밀번호와 같습니다. 남에게 보여 주거나 공개 저장소·채팅방에 올리지 마세요.
- 서버 주소: `https://law.airealty.co.kr/mcp`

### A-1. Claude Code (터미널)

터미널(PowerShell·macOS 터미널·Linux 셸)에서 아래 한 줄을 실행합니다. `<토큰>` 자리에 받은 값을 넣습니다.

```bash
claude mcp add --transport http airealty-law https://law.airealty.co.kr/mcp --header "Authorization: Bearer <토큰>"
```

확인:

```bash
claude mcp list
```

`airealty-law: https://law.airealty.co.kr/mcp (HTTP) - ✔ Connected` 가 보이면 끝입니다.
이미 열려 있던 Claude Code 세션에는 나타나지 않으니 **새 세션**을 여세요.

사용 예(대화창에 그대로 입력):
- "주택임대차보호법 제6조의3 조문 보여줘"
- "임대차 계약 갱신 거절 사유에 관한 최신 판례 찾아줘"
- "이 계약서 위험 조항 점검해줘" (계약서 본문을 붙여 넣기)
- "민법 제750조 인용이 맞는지 확인해줘"

연결 해제:

```bash
claude mcp remove airealty-law
```

### A-2. Claude 앱 (claude.ai 웹·데스크톱·모바일)

1. **설정 → 커넥터(Connectors)** → **커스텀 커넥터 추가**
2. 이름: `airealty 법령` · 원격 MCP 서버 URL: `https://law.airealty.co.kr/mcp`
3. **고급 설정 → 요청 헤더**에 이름 `Authorization`, 값 `Bearer <토큰>` 입력 → 추가
4. 대화창의 도구 메뉴(🔧)에서 커넥터를 켭니다.

주의: 요청 헤더 입력란은 **조직(Team·Enterprise) Owner** 계정에만 보이는 베타 기능입니다. 개인 플랜에서 헤더 입력란이 없으면 A-1(Claude Code) 또는 B(로컬 설치)를 쓰세요.

### A-3. Cursor · Windsurf · VS Code 등 (mcp.json 방식)

각 도구의 MCP 설정 파일(예: Cursor `~/.cursor/mcp.json`)에 추가합니다.

```json
{
  "mcpServers": {
    "airealty-law": {
      "url": "https://law.airealty.co.kr/mcp",
      "headers": { "Authorization": "Bearer <토큰>" }
    }
  }
}
```

도구마다 키 이름이 조금 다를 수 있습니다(`type: "http"` 또는 `transport: "streamable-http"` 가 필요한 경우가 있음). 해당 도구의 "원격 MCP(Streamable HTTP)" 설명을 따르세요.

### A-4. 호출 한도와 오류

| 상황 | 응답 | 뜻 |
|---|---|---|
| 토큰이 없거나 틀림 | `401` | 명령의 `<토큰>` 을 다시 확인. 폐기된 토큰이면 운영자에게 재발급 요청 |
| 너무 빠른 호출 | `429` + `Retry-After` | 토큰마다 초당 2회·순간 최대 10회. 몇 초 뒤 자동으로 다시 시도됩니다 |
| 하루 2,000회 초과 | `429` | 다음 날(UTC 자정, 한국 시간 오전 9시) 초기화 |
| `UPSTREAM_AUTH`·`UPSTREAM_DOWN` 오류 봉투 | 법제처 쪽 문제 | 잠시 뒤 다시. 계속되면 운영자에게 |

---

## B. 로컬 설치 — 자기 법제처 키로 쓰기

호출이 많거나(하루 2,000회 이상) 회사 정책상 외부 서버를 거치면 안 될 때. 자기 PC 에서 서버가 돌고, 법제처 API 를 자기 키로 직접 부릅니다.

### B-1. 법제처 OPEN API 키 받기 (무료, 승인 1~2일)

1. https://open.law.go.kr 회원가입 → 로그인
2. 상단 **OPEN API → OPEN API 신청** → 신청서 작성
   - 활용 서비스: 예 "법령 조회 AI 도구(개인용)"
   - 이용 형태: 개인 PC 또는 사무소 내부 업무용
3. 승인 메일을 받으면 **마이페이지 → API인증키관리** 에서 **인증값(OC)** 을 복사합니다. 보통 가입 이메일 ID 형태의 짧은 문자열입니다.

### B-2. 설치

Node.js 20 이상이 필요합니다(https://nodejs.org LTS 설치).

```bash
git clone https://github.com/conoc612-a11y/airealty-lawmcp
cd airealty-lawmcp
npm install
npm test
```

`npm test` 가 `pass 41` 로 끝나면 정상입니다(네트워크 없이 도는 단위 테스트).

### B-3. Claude Code 에 등록 (키는 환경변수로)

```bash
claude mcp add airealty-law -e openlaw_API_KEY=<내 인증값> -- node /절대경로/airealty-lawmcp/src/index.js
```

Windows 예: `-- node D:\tools\airealty-lawmcp\src\index.js`

`claude mcp list` 에서 `✔ Connected` 확인. 인증값은 어디에도 출력되지 않습니다(응답·로그·캐시 모두 키 제거).

### B-4. 다른 도구(mcp.json 방식)

```json
{
  "mcpServers": {
    "airealty-law": {
      "command": "node",
      "args": ["/절대경로/airealty-lawmcp/src/index.js"],
      "env": { "openlaw_API_KEY": "<내 인증값>" }
    }
  }
}
```

### B-5. 업데이트

```bash
cd airealty-lawmcp && git pull && npm install
```

---

## 도구 한눈에 보기

| 도구 | 하는 일 |
|---|---|
| `statute_find` | 법령 이름·키워드로 찾기(약칭·자동완성·여러 이름 일괄) |
| `article_get` | 조문 본문(항·호 구조, 특정 시행일 기준 판 선택) |
| `statute_outline` | 목차·체계도(상위법·시행령·시행규칙·행정규칙) |
| `annex_get` | 별표·서식 |
| `statute_history` | 개정 연혁·판 목록·신구 대조 |
| `source_search` / `source_get` | 판례·헌재결정·법령해석례·행정심판·조세심판·자치법규 등 20종 검색·본문 |
| `citation_audit` | 문서 속 법령 인용(법명·조문)이 실제 존재·현행인지 검증 |
| `precedent_trace` | 사건번호로 판례 추적(원심·상급심·인용 판례) |
| `contract_risk_scan` | 계약서 본문의 강행규정 저촉·불리 조항 점검(등급 A~E) |
| `research_run` | 시나리오형 종합 조사(임대차 분쟁·청약·재개발·중개·용도지역·양도세·계약 점검 등) |
| `toolbox` | 보조 12종(용어 사전·약칭·개정 피드·조문코드 변환·링크 생성·유사 판례·조례 연계·영문 법령 등) |

모든 도구는 읽기 전용이며 응답마다 `link`(law.go.kr 공개 주소)로 출처를 함께 줍니다. 법령정보 저작권은 법제처에 있습니다.

## 개인정보

- 호스팅 서버는 질문·문서 본문을 법제처 API 호출에만 쓰고 저장하지 않습니다. 로그에는 토큰 **이름**과 호출 횟수만 남습니다.
- 로컬 설치는 모든 데이터가 내 PC 와 법제처 사이에서만 오갑니다.

## 문의

운영자: conoc612@gmail.com (토큰 발급·재발급·폐기, 오류 신고)
소스·이슈: https://github.com/conoc612-a11y/airealty-lawmcp
