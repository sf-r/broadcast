# RPlay 방송화면 생성기 — Cloudflare Worker

두 개의 이미지 생성 라우트를 제공합니다.

- `GET /gg/accounts` — 계정 리스트형 이미지 (초기 버전)
- `GET /gg/broadcast` — 실제 "라이브 방송화면" 1컷 이미지 (LIVE 뱃지·제목·방송인·시청자수·팔로우 상태·채팅창·후원 배너)

렌더링 방식은 동일합니다: `satori`(HTML→SVG) + `@resvg/resvg-wasm`(SVG→PNG). Vercel의 OG 이미지 생성기와 같은 원리라 Cloudflare Workers에서 바로 동작합니다.

---

## `/gg/broadcast` 사용법

```
GET /gg/broadcast
    ?char=캐릭터코드
    &situation=상황코드
    &title=방송+제목
    &streamer=방송인+이름
    &viewers=1234
    &following=1
    &chat=닉네임:메시지|닉네임:메시지|...
    &donation=닉네임:금액:내용
    &w=720&h=1280
```

| 파라미터 | 설명 |
|---|---|
| `char`, `situation` | 배경 이미지 결정. `{SAFFRAN_BASE_URL}/bro/{char}-{situation}.png` 를 fetch해서 배경으로 씁니다 (webp 원본과 같은 경로에 올려둔 png 사본) |
| `title` | 방송 제목 (상단, 방송인 이름 아래) |
| `streamer` | 방송인 이름 (상단, LIVE 뱃지 옆) |
| `viewers` | 시청자 수. 1,000 이상 K, 10,000 이상 "만" 단위로 자동 표기 |
| `following` | `1`이면 "팔로잉" 상태, `0`(또는 생략)이면 빨간 "+ 팔로우" 버튼 |
| `chat` | `닉네임:메시지`를 `\|`로 이어붙임. **뒤에 올수록 최근 메시지**(채팅창 맨 아래에 표시). 최대 8줄까지만 렌더링(초과분은 앞에서부터 잘림) |
| `donation` | `닉네임:금액:내용` 형식(금액은 숫자만, 콤마 없이), 선택 항목. 넣으면 **채팅창 맨 아래 강조줄 + 우측 상단 배너** 둘 다에 "OOO님이 5,000원 후원하셨습니다. "메시지"" 형식으로 표시됩니다 |
| `w`, `h` | 캔버스 크기, 기본 720×1280 (세로형 라이브 화면 비율) |

모든 텍스트 파라미터(제목, 닉네임, 메시지 등)에 한글/특수문자가 들어가면 `encodeURIComponent`로 인코딩해서 넘겨주세요.

### 배경 이미지 관련 주의사항

`satori`가 webp 이미지를 제대로 못 읽어서(`TypeError: ... is not iterable` 계열 에러) 배경 원본(`.webp`)을 그대로 쓰지 않고, **같은 경로에 올려둔 png 사본**을 fetch합니다:

```
{SAFFRAN_BASE_URL}/bro/{char}-{situation}.png
```

**즉, `{char}-{situation}.webp` 원본을 새로 추가/교체할 때마다 파일명은 그대로 두고 확장자만 `.png`인 사본도 같은 `/bro/` 경로에 같이 올려주셔야 합니다** (예: `RP27-01.webp` 옆에 `RP27-01.png`). png 사본이 없으면 `fetchImageAsDataUri`에서 "배경 이미지를 가져오지 못했습니다 (404)" 에러가 납니다.

---

## 한 응답 안에서 "연속된 씬" 만들기

`/gg/broadcast`는 완전히 **stateless**입니다 — 이전 씬을 기억하지 않고, 시청자 수·채팅·후원 등 필요한 상태를 매 요청마다 파라미터로 전부 받습니다. 그래서 "채팅과 시청자 수가 변화하는 연속된 장면"을 만드는 방법은 Worker 쪽에 특별한 기능을 추가하는 게 아니라, **AI 응답을 만드는 쪽에서 이 엔드포인트를 파라미터만 바꿔가며 여러 번 호출**하고, 그 결과 이미지 URL들을 한 응답 메시지 안에 순서대로 이어 붙이는 방식입니다.

예를 들어 한 응답에서 3개의 씬을 보여주고 싶다면:

```
씬 1 (방송 시작 직후, 시청자 적음)
/gg/broadcast?char=RP27&situation=01&title=...&streamer=...&viewers=320&following=0
  &chat=user_a:안녕하세요|user_b:방금+들어왔어요

씬 2 (시청자 증가, 채팅 늘어남)
/gg/broadcast?char=RP27&situation=02&title=...&streamer=...&viewers=1850&following=0
  &chat=user_a:안녕하세요|user_c:오늘도+예쁘시네요|user_d:ㅋㅋㅋㅋ

씬 3 (후원 발생)
/gg/broadcast?char=RP27&situation=02&title=...&streamer=...&viewers=2400&following=1
  &chat=user_c:오늘도+예쁘시네요|user_d:ㅋㅋㅋㅋ|user_e:축하드려요
  &donation=user_f:5000:응원합니다!
```
→ 위 씬 3에서는 채팅창 맨 아래와 우측 상단 배너에 각각
`🎁 user_f님이 5,000원 후원하셨습니다.` / `"응원합니다!"` 가 표시됩니다.

이 3개의 이미지 URL을 AI 응답 메시지 안에 순서대로 넣기만 하면, 사용자 입장에서는 하나의 응답 안에서 방송 장면이 시간순으로 이어지는 것처럼 보입니다. `situation` 코드를 씬마다 바꾸면 배경(캐릭터 표정/포즈)도 함께 바뀌게 할 수 있습니다.

### 참고: 진짜 "필름스트립" 한 장으로 합치고 싶다면

지금 구조는 "각 씬 = 별도 이미지 N장"입니다. 만약 여러 씬을 **한 장의 이미지**(예: 세로로 스택된 3분할 이미지)로 합쳐서 받고 싶다면, `renderBroadcastMarkup`을 여러 번 호출해 세로로 이어붙이는 `/gg/broadcast-strip?scenes=...` 같은 별도 라우트를 추가하는 것도 가능합니다. 다만 이 경우 각 씬이 작아지고 텍스트 가독성이 떨어질 수 있어서, 특별한 이유가 없다면 위의 "이미지 여러 장을 순서대로 배치" 방식을 추천합니다.

---

## `/gg/accounts` 사용법 (기존)

```
GET /gg/accounts
    ?dir=RP27
    &title=고고링그램
    &accounts=이름:소개:팔로워수:인증여부:핸들|이름:소개:팔로워수:인증여부:핸들
```

- 계정은 `|`로 구분, 각 계정 필드는 `:`로 구분
- `인증여부`: `1`이면 파란 체크(✔), `0`이면 미표시
- 아바타는 `{AVATAR_BASE_URL}/{dir}/{핸들}.jpg` 경로를 사용 (없으면 그라데이션 placeholder)

---

## 로컬 실행

```bash
npm install
npm run dev
```

```
http://localhost:8787/gg/broadcast?char=RP27&situation=01&title=%EC%98%A4%EB%8A%98%EB%8F%84+%EA%B0%99%EC%9D%B4+%EC%B2%B4%ED%81%AC&streamer=%EC%84%9C%ED%95%98%EC%A7%84&viewers=1850&following=0&chat=user_a:%EC%95%88%EB%85%95%ED%95%98%EC%84%B8%EC%9A%94
```

## 배포

```bash
npx wrangler login
npm run deploy
```

배포 후 `https://broadcast.<your-subdomain>.workers.dev/gg/broadcast?...` 형태로 바로 접근 가능합니다. 커스텀 도메인은 Cloudflare 대시보드 → Workers → Triggers에서 라우트 추가.

---

## R2 암호화 저장 (`/gg/img/{id}`)

`/gg/accounts`, `/gg/broadcast`가 생성한 PNG는 응답으로 즉시 반환되는 것과 별개로,
**AES-256-GCM으로 암호화**되어 R2(`IMAGES` 바인딩)에도 저장됩니다. 이때:

- 오브젝트 키는 내용과 무관한 난수(UUID) — 파일명만으로는 뭔지 알 수 없음
- 저장되는 content-type은 `application/octet-stream` — R2에는 "이미지"라는 사실조차 안 남음
- custom metadata(제목/캐릭터/방송인 등)는 저장하지 않음
- 복호화 키는 `ENCRYPTION_KEY` 시크릿에만 존재 (레포/코드/R2 어디에도 평문 없음)

즉 R2 버킷을 대시보드나 S3 호환 API로 직접 열어봐도 암호문 바이너리만 보이고,
사이트(`/gg/img/{id}`)를 통해 요청할 때만 Worker가 복호화해서 정상 PNG로 서빙합니다.
응답 헤더 `X-Image-Id`로 저장된 오브젝트의 id를 확인할 수 있습니다.

**설정 방법**

```bash
npx wrangler r2 bucket create rplay-broadcast-images
openssl rand -base64 32          # 32바이트 랜덤 키 생성
npx wrangler secret put ENCRYPTION_KEY   # 위 값 붙여넣기
npm run deploy
```

**주의**
- 이 계정(Worker를 배포한 본인)은 시크릿에 접근 가능하므로, 원리적으로 복호화가
  영구히 불가능해지는 구조는 아닙니다. 이 구조가 막는 건 "R2 버킷을 직접 봤을 때
  내용을 알 수 없다"는 것이지, 계정 소유자의 복호화 능력 자체를 없애는 게 아닙니다.
- 어떤 요청(파라미터)이 어떤 `imageId`로 저장됐는지를 로그나 분석 도구에 남기면,
  그 로그가 R2 오브젝트를 다시 식별 가능하게 만듭니다. 완전한 오브퍼스케이션이
  목적이라면 이 매핑을 기록하지 않아야 합니다.

---

## 커스터마이징 포인트

- **폰트**: 매 콜드스타트마다 Pretendard를 jsDelivr에서 fetch합니다. 트래픽이 늘면 R2/KV에 올려두고 거기서 읽는 걸 추천합니다.
- **채팅 줄 수 / 캔버스 크기**: `CHAT_MAX_LINES` 상수, `w`/`h` 쿼리 파라미터로 조절.
- **캐싱**: 배경 이미지(png 사본 fetch)는 캐릭터+상황 조합이 반복되므로 Cache API로 data URI 자체를 캐싱하면 매 요청마다 다시 fetch하지 않아도 되어 응답이 빨라집니다.
