/**
 * RPlay AI 캐릭터 챗 방송화면 생성기
 * ------------------------------------------------------------
 * 라우트 2개:
 *   GET /gg/accounts   -> 계정 리스트형 이미지 (이전 버전)
 *   GET /gg/broadcast  -> 실제 "라이브 방송화면" 1컷 이미지 (신규)
 *
 * 여러 "씬"을 한 AI 응답 안에 연달아 보여주고 싶다면, 이 Worker가 여러 장을
 * 한번에 만들어주는 게 아니라 -> AI 응답 쪽에서 /gg/broadcast를 파라미터만
 * 바꿔서(시청자 수 증가, 채팅 추가, 후원 발생 등) 여러 번 호출한 이미지 URL을
 * 순서대로 이어 붙이면 됩니다. 이 Worker는 완전히 stateless이기 때문에
 * "이전 씬"을 기억하지 않고, 매 요청마다 필요한 상태를 파라미터로 전부 받습니다.
 * (자세한 예시는 README.md의 "연속 씬 만들기" 섹션 참고)
 *
 * 렌더링 방식: satori(HTML→SVG) + resvg-wasm(SVG→PNG)
 *
 * ------------------------------------------------------------
 * [중요] satori-html의 `html` 태그 템플릿 사용법에 대한 주의사항
 * ------------------------------------------------------------
 * satori-html의 `html` 함수는 내부적으로 ultrahtml의 html() 헬퍼를 그대로
 * 씁니다. 이 헬퍼는 "태그 템플릿"으로 호출될 때 `${...}`로 끼워 넣는 값들을
 * 전부 신뢰할 수 없는 텍스트로 간주해서 자동으로 HTML 이스케이프합니다.
 * 즉 `` html`<div>${someHtmlString}</div>` `` 처럼 이미 만들어진 HTML 문자열을
 * 다시 끼워 넣으면, 그 안의 태그까지 통째로 이스케이프되어 화면에 `&lt;div&gt;`
 * 같은 글자 그대로 나와버립니다 (실제로 이 버그가 있었습니다 - 채팅창 참고).
 *
 * 그래서 이 파일에서는:
 *   1) render*Markup() 함수들이 satori-html의 `html` 태그를 쓰지 않고,
 *      완성된 HTML을 "그냥 문자열"로 반환합니다 (일반 템플릿 리터럴).
 *   2) satori()에 넘기기 직전, 딱 한 번만 `html(완성된문자열)`을 "함수 호출"
 *      형태로 사용합니다 (태그 템플릿이 아니라 함수 호출이면 끼워 넣을
 *      expressions가 없으므로 자동 이스케이프 자체가 일어나지 않습니다).
 *   3) 대신 title/streamer/닉네임/메시지처럼 사용자 입력이 들어가는 값은
 *      반드시 escapeHtml()로 직접 이스케이프해야 합니다 (마크업 인젝션 방지).
 *      아래 코드에서 사용자 입력 문자열은 전부 escapeHtml()을 거칩니다.
 */

import satori from 'satori';
import { html } from 'satori-html';
import { Resvg, initWasm } from '@resvg/resvg-wasm';
import resvgWasm from '@resvg/resvg-wasm/index_bg.wasm';

// ------------------------------------------------------------------
// 공통 유틸
// ------------------------------------------------------------------

// 주의: orioncactus/pretendard 저장소에는 dist/public 경로가 없어서(최상위엔
// dist/web만 존재) 예전에 쓰던 dist/public/static/... 경로는 404가 납니다.
// 아래는 웨이트별 otf 파일만 따로 미러링해두는 fonts-archive/Pretendard 저장소 경로입니다.
const FONT_URL = 'https://cdn.jsdelivr.net/gh/fonts-archive/Pretendard/Pretendard-Regular.otf';
const FONT_BOLD_URL = 'https://cdn.jsdelivr.net/gh/fonts-archive/Pretendard/Pretendard-Bold.otf';

// fontsPromise에는 "결과"가 아니라 "진행 중인 Promise"를 담아둡니다. 콜드
// 스타트 직후 여러 요청이 동시에 들어오면(=여러 요청이 동시에 캐시가
// 비어있는 걸 보게 됨) 이렇게 안 하면 각자 fetch를 따로 시작해버립니다 —
// Promise 자체를 캐싱하면 늦게 들어온 요청들은 먼저 시작된 fetch를 그냥
// 같이 기다리기만 합니다.
let fontsPromise = null;

async function fetchFontAsArrayBuffer(url) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`폰트를 가져오지 못했습니다 (${res.status}): ${url}`);
  }
  return res.arrayBuffer();
}

async function loadFonts() {
  if (!fontsPromise) {
    fontsPromise = (async () => {
      const [regular, bold] = await Promise.all([
        fetchFontAsArrayBuffer(FONT_URL),
        fetchFontAsArrayBuffer(FONT_BOLD_URL),
      ]);
      return [
        { name: 'Pretendard', data: regular, weight: 400, style: 'normal' },
        { name: 'Pretendard', data: bold, weight: 700, style: 'normal' },
      ];
    })().catch((err) => {
      // 실패한 Promise를 그대로 캐싱해두면 이 isolate가 살아있는 동안
      // 이후 모든 요청이 재시도조차 안 해보고 영원히 실패합니다 — 실패
      // 시엔 캐시를 비워서 다음 요청이 다시 시도하게 합니다.
      fontsPromise = null;
      throw err;
    });
  }
  return fontsPromise;
}

// resvgInitPromise도 같은 이유로 boolean 대신 Promise를 캐싱합니다 — 동시
// 요청이 initWasm()을 중복 호출하는 걸(일부 wasm 바인딩은 두 번째 호출에서
// 에러를 던질 수 있음) 막고, 실패 시엔 마찬가지로 캐시를 비워 재시도를
// 허용합니다.
let resvgInitPromise = null;

async function ensureResvg() {
  if (!resvgInitPromise) {
    resvgInitPromise = initWasm(resvgWasm).catch((err) => {
      resvgInitPromise = null;
      throw err;
    });
  }
  await resvgInitPromise;
}

async function svgToPng(svg, width) {
  await ensureResvg();
  console.log(`[broadcast]     resvg wasm 준비 완료, svg 길이=${svg.length}`);
  // satori가 이미 모든 텍스트를 HarfBuzz로 셰이핑해서 <path>로 구워 넣은
  // SVG를 넘기므로, resvg 쪽에서 폰트를 다시 찾을 일이 없습니다.
  // loadSystemFonts: false로 그 탐색(꽤 IO 비용이 큼) 자체를 건너뜁니다.
  const rendered = new Resvg(svg, {
    fitTo: { mode: 'width', value: width },
    font: { loadSystemFonts: false },
  }).render();
  console.log('[broadcast]     resvg render() 완료, asPng 시작');
  const png = rendered.asPng();
  console.log('[broadcast]     resvg asPng 완료');
  return png;
}

function escapeHtml(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

// url.searchParams.get()이 쿼리스트링 전체를 이미 한 번 디코딩해주기 때문에,
// chat/donation/accounts처럼 ':'나 '|'로 다시 split한 뒤 조각마다
// decodeURIComponent()를 또 거는 코드는 사실상 "이중 디코딩"을 기대하는
// 구조입니다. 호출부(AI 응답)가 원문 그대로 넣든, 한 번만 encodeURIComponent
// 하든, 필드별로 개별 encodeURIComponent 해서 이어붙이든 — 어떤 방식으로
// 오든 깨지지 않게 하기 위한 안전한 디코더입니다.
//   - 정상적으로 디코딩되면 그 결과를 반환
//   - 디코딩할 % 시퀀스가 없으면(=원문 그대로 왔거나 이미 다 풀린 경우)
//     decodeURIComponent가 입력을 그대로 반환하므로 별문제 없음
//   - '%' 뒤에 잘못된 시퀀스가 와서(예: 메시지에 우연히 포함된 "50%" 같은
//     literal '%') decodeURIComponent가 URIError를 던지면, 그 예외를 삼키고
//     "디코딩 시도 전 원본 문자열"을 그대로 돌려줍니다 — 요청을 500으로
//     죽이는 대신 최대한 원문에 가까운 값으로 계속 렌더링을 이어갑니다.
function safeDecodeURIComponent(s) {
  if (!s) return '';
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

// 배경 이미지 자리표시자 — renderBroadcastMarkup()이 만드는 HTML 문자열에는
// 이 짧은 문자열만 들어가고, 실제 base64 데이터 URI는 html() 파싱이 끝난
// 뒤 replaceImgSrc()로 VDOM 트리에 직접 주입합니다.
const BG_IMG_PLACEHOLDER = 'about:blank#bg-image-placeholder';

// satori-html이 만든 VDOM({ type, props: { style?, children?, ... } })을
// 재귀적으로 훑어서, src가 placeholder와 일치하는 <img> 노드의 src를
// 실제 값으로 바꿔치기합니다. children은 문자열 / 단일 노드 / 배열 중
// 하나일 수 있어서 셋 다 처리합니다.
function replaceImgSrc(node, targetSrc, replacement) {
  if (!node || typeof node !== 'object') return;
  if (node.type === 'img' && node.props && node.props.src === targetSrc) {
    node.props.src = replacement;
  }
  const children = node.props && node.props.children;
  if (Array.isArray(children)) {
    for (const child of children) replaceImgSrc(child, targetSrc, replacement);
  } else if (children && typeof children === 'object') {
    replaceImgSrc(children, targetSrc, replacement);
  }
}

function formatCount(n, unit = '') {
  if (!Number.isFinite(n)) return '0' + unit;
  if (n >= 10000) {
    const v = n / 10000;
    return `${Number.isInteger(v) ? v : v.toFixed(1)}만${unit}`;
  }
  if (n >= 1000) {
    const v = n / 1000;
    return `${Number.isInteger(v) ? v : v.toFixed(1)}K${unit}`;
  }
  return `${n}${unit}`;
}

// Buffer(nodejs_compat)의 base64 인코딩은 네이티브 경로를 타서, 수동으로
// String.fromCharCode(...chunk) + btoa()를 청크 단위로 돌리던 예전 방식보다
// 빠릅니다. 특히 배경 이미지처럼 수백 KB~수 MB급 버퍼에서 체감됩니다.
function arrayBufferToBase64(buffer) {
  return Buffer.from(buffer).toString('base64');
}

// ------------------------------------------------------------------
// 이모지 대체 아이콘 (👁 / 🎁)
// ------------------------------------------------------------------
//
// Pretendard에는 이모지 글리프가 없어서, 마크업에 👁 · 🎁 를 텍스트로 넣으면
// satori가 해당 코드포인트를 그릴 폰트를 못 찾아 폴백 처리를 시도하게 됩니다.
// 이 폴백 자체가 큰 비용은 아니지만, 어차피 대체가 쉬운 데다(이 2개는 항상
// 우리 템플릿이 직접 넣는 고정 아이콘이라) 아예 <img>로 그리는 작은 SVG로
// 바꿔서 이 경로 자체를 없앴습니다. (title/streamer/chat/donation처럼
// 사용자가 직접 넣는 텍스트에 이모지가 들어가는 경우까지 막지는 못합니다.)
const EYE_ICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/></svg>';

const GIFT_ICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#ffd479" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="8" width="18" height="13" rx="1"/><path d="M3 12h18"/><path d="M12 8v13"/><path d="M7.5 8C5 8 5 4.5 7.5 4.5S12 6.5 12 8"/><path d="M16.5 8C19 8 19 4.5 16.5 4.5S12 6.5 12 8"/></svg>';

function iconTag(svg, size, extraStyle = '') {
  return `<img src="data:image/svg+xml,${encodeURIComponent(
    svg
  )}" width="${size}" height="${size}" style="display:flex;flex-shrink:0;${extraStyle}" />`;
}

// ------------------------------------------------------------------
// (폰트 서브셋팅은 제거됨 — 2026-09 업데이트)
// ------------------------------------------------------------------
//
// 예전에는 satori에 넘기기 전에 subset-font(harfbuzzjs 기반)로 "이 요청에
// 실제로 쓰이는 글자"만 남긴 임시 폰트를 만들어 CPU 타임아웃을 줄이려
// 했습니다. 하지만 이 최적화는 두 가지 문제가 있었습니다:
//   1) subset-font가 내부적으로 WOFF/WOFF2 변환용 fontverter -> wawoff2를
//      물고 오는데, 이 체인이 모듈 require 시점에 Node의 __dirname을
//      참조합니다. Cloudflare Workers 런타임(workerd)은 __dirname을
//      지원하지 않아서, wrangler를 4.x로 올리자 배포 자체가
//      "Uncaught ReferenceError: __dirname is not defined"로 실패했습니다.
//      (우리는 targetFormat: 'sfnt'만 쓰므로 WOFF 변환 기능은 애초에 필요
//      없었는데도, subset-font가 무조건 그 의존성을 불러오면서 생긴 문제.)
//   2) 그 이전에도(wrangler 3.x 환경) harfbuzzjs wasm 로딩이 이 환경에서
//      100% 안정적이지 않아, 실제로는 거의 매 요청 "서브셋 실패 -> 풀 폰트
//      폴백"으로 빠지고 있었습니다 — 즉 최적화가 이미 제 역할을 못 하고
//      있었습니다.
//
// 그래서 서브셋팅 자체를 걷어내고 항상 풀 Pretendard 폰트로 렌더링합니다.
// CPU 타임아웃은 여전히 RENDER_TIMEOUT_MS(아래)와 wrangler.toml의
// [limits] cpu_ms가 안전망 역할을 하고, 반복되는 동일 파라미터 요청은
// wrangler.toml의 [cache] 설정(Workers Cache)이 렌더링 자체를 건너뛰게
// 해주므로 실질적인 CPU 부담은 이전보다 오히려 줄었습니다.

// ------------------------------------------------------------------
// CPU 타임아웃 안전장치
// ------------------------------------------------------------------
//
// Cloudflare Workers는 플랜에 따라 CPU 시간 한도(예: 30초)를 넘기면 요청을
// 강제 종료합니다 — 이때 뜨는 에러("Worker exceeded CPU time limit")는 우리
// try/catch로 못 잡고, 응답도 우리가 원하는 형태로 못 냅니다(플랫폼이 바로 끊음).
//
// 그래서 실제 CPU 한도보다 살짝 짧은 타임아웃을 애플리케이션 레벨에서 걸어
// 두면, 한도에 걸려 죽기 "직전"에 우리가 먼저 정상적인 에러 응답(504)을
// 반환할 수 있습니다. 폰트/배경이미지 fetch처럼 await로 이벤트 루프에
// 양보하는 구간에는 잘 걸리지만, 완전히 동기적인 무한루프 같은 건 JS 타이머로
// 선점할 수 없다는 한계는 있습니다 — 그런 경우엔 결국 플랫폼의 하드 한도가
// 마지막 방어선이 됩니다 (wrangler.toml의 [limits] cpu_ms 참고).
class TimeoutError extends Error {}

function withTimeout(promise, ms, label = '작업') {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new TimeoutError(`${label} 처리 시간이 ${ms}ms를 초과했습니다`)),
      ms
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * 배경(캐릭터 상황 이미지)을 fetch해서 data URI로 변환.
 *
 * handleBroadcast에서 bgUrl이 .png 사본을 가리키도록 만들기 때문에 여기서는 png가
 * 내려온다고 가정합니다. webp 원본을 satori가 제대로 못 읽어서(TypeError: ... is not
 * iterable 계열) 생긴 조치이며, {char}-{situation}.webp 원본과 같은 경로에 파일명은
 * 그대로 두고 확장자만 .png인 사본이 올라와 있어야 정상 동작합니다.
 */
/**
 * ctx가 있으면 Cloudflare의 엣지 Cache API(caches.default)를 함께 씁니다.
 * char+situation 조합은 반복 요청되는 경우가 많아서(README의 "연속 씬" 예시
 * 참고), 여기서는 원본 이미지 바이트가 아니라 "이미 base64 인코딩까지 끝난
 * data URI 문자열 자체"를 캐싱합니다 — 그래야 캐시 적중 시 fetch 왕복뿐
 * 아니라 base64 인코딩(이것도 수백 KB~수 MB 버퍼면 공짜가 아닙니다) 비용까지
 * 통째로 생략됩니다. cache.put()은 ctx.waitUntil로 넘겨서 응답을 기다리게
 * 하지 않습니다.
 */
async function fetchImageAsDataUri(url, ctx, width, height) {
  const cache = caches.default;
  // 원본 바이트가 아니라 "완성된 data URI"를 캐싱한다는 걸 키에서도 구분되게.
  // 캔버스 크기(w/h)별로 리사이즈 결과가 다르므로 크기도 캐시 키에 포함.
  const cacheKey = new Request(`${url}#datauri:${width}x${height}`, { method: 'GET' });

  console.time('[broadcast]   bg fetch+encode');
  if (ctx) {
    const cached = await cache.match(cacheKey);
    if (cached) {
      const dataUri = await cached.text();
      console.timeEnd('[broadcast]   bg fetch+encode');
      console.log(`[broadcast] bg image cache HIT (data URI): ${url}`);
      return dataUri;
    }
  }

  // Cloudflare Image Transformations(구 Image Resizing)로 원본을 캔버스 크기에
  // 맞춰 미리 축소·크롭해서 받아옵니다. 이 리사이즈는 Cloudflare 엣지에서
  // 처리되어 이 Worker의 CPU 시간을 전혀 쓰지 않고, 월 5,000회까지 무료입니다
  // (Free 플랜 포함). 원본을 그대로 받아 satori/resvg가 고해상도를 직접
  // 디코딩·리샘플링하면서 CPU 한도를 초과하던 문제를 근본적으로 우회합니다.
  // 만약 해당 zone에서 아직 Transformations가 꺼져 있다면 원본이 그대로
  // 내려올 수 있으니, 대시보드에서 Speed → Optimization(또는 Images →
  // Transformations)에서 켜져 있는지 확인하세요.
  const res = await fetch(url, {
    cf: {
      image: {
        width,
        height,
        fit: 'cover', // 기존 CSS의 object-fit:cover와 동일한 크롭 방식으로 통일
        format: 'png', // satori가 webp를 못 읽는 문제 회피 (원본이 webp/jpeg 등이어도 png로 통일)
      },
    },
  });
  if (!res.ok) {
    throw new Error(`배경 이미지를 가져오지 못했습니다 (${res.status}): ${url}`);
  }
  const contentType = res.headers.get('content-type') || 'image/png';
  const buf = await res.arrayBuffer();
  const dataUri = `data:${contentType};base64,${arrayBufferToBase64(buf)}`;
  console.timeEnd('[broadcast]   bg fetch+encode');
  console.log(`[broadcast] bg image cache MISS: ${url}`);

  if (ctx && typeof ctx.waitUntil === 'function') {
    const cacheable = new Response(dataUri, {
      headers: {
        'content-type': 'text/plain;charset=UTF-8',
        // 배경 이미지(캐릭터+상황 조합)는 자주 바뀌지 않으므로 넉넉히 하루.
        'cache-control': 'public, max-age=86400',
      },
    });
    ctx.waitUntil(cache.put(cacheKey, cacheable));
  }

  return dataUri;
}

// ------------------------------------------------------------------
// 1) /gg/accounts — 계정 리스트형 이미지
// ------------------------------------------------------------------

const ACCOUNTS_WIDTH = 820;

function parseAccounts(raw) {
  if (!raw) return [];
  return raw
    .split('|')
    .filter(Boolean)
    .map((entry) => {
      const [name, bio, followers, verified, handle] = entry.split(':');
      return {
        name: safeDecodeURIComponent(name || ''),
        bio: safeDecodeURIComponent(bio || ''),
        followers: Number(followers) || 0,
        verified: verified === '1',
        handle: safeDecodeURIComponent(handle || ''),
      };
    });
}

// 주의: 아래는 satori-html의 `html` 태그가 아니라 "일반 문자열"을 반환합니다.
// (이유는 파일 상단 주석 참고 — html 태그로 감싸면 rows 안의 태그가 통째로
// 이스케이프되어 글자 그대로 노출되는 버그가 있었습니다.)
function renderAccountsMarkup({ title, dir, accounts, avatarBase }) {
  const rows = accounts
    .map((a) => {
      const avatarUrl =
        avatarBase && dir && a.handle
          ? `${avatarBase.replace(/\/$/, '')}/${dir}/${encodeURIComponent(a.handle)}.jpg`
          : null;

      const avatar = avatarUrl
        ? `<img src="${avatarUrl}" width="56" height="56" style="border-radius:9999px;object-fit:cover;margin-right:16px;" />`
        : `<div style="display:flex;width:56px;height:56px;border-radius:9999px;background:linear-gradient(135deg,#3a3a3c,#1c1c1e);margin-right:16px;"></div>`;

      return `
        <div style="display:flex;align-items:center;width:100%;padding:14px 20px;border-bottom:1px solid #1f1f1f;">
          ${avatar}
          <div style="display:flex;flex-direction:column;flex:1;">
            <div style="display:flex;align-items:center;">
              <span style="font-size:18px;font-weight:700;color:#fafafa;">${escapeHtml(a.name)}</span>
              ${
                a.verified
                  ? '<span style="display:flex;margin-left:5px;font-size:15px;color:#3897f0;">✔</span>'
                  : ''
              }
            </div>
            <div style="font-size:14px;color:#9a9a9a;margin-top:3px;">${escapeHtml(a.bio)}</div>
          </div>
          <div style="font-size:15px;color:#d4d4d4;">${formatCount(a.followers)}</div>
        </div>
      `;
    })
    .join('');

  return `
    <div style="display:flex;flex-direction:column;width:${ACCOUNTS_WIDTH}px;background:#000;font-family:'Pretendard';">
      <div style="display:flex;padding:22px 20px 14px;font-size:24px;font-weight:700;color:#fafafa;">
        ${escapeHtml(title)}
      </div>
      <div style="display:flex;flex-direction:column;width:100%;">${rows}</div>
    </div>
  `;
}

async function handleAccounts(url, env) {
  const title = url.searchParams.get('title') || '';
  const dir = url.searchParams.get('dir') || '';
  const accounts = parseAccounts(url.searchParams.get('accounts'));
  const avatarBase = env.AVATAR_BASE_URL || `${url.origin}/avatars`;

  const fonts = await loadFonts();
  const markupStr = renderAccountsMarkup({ title, dir, accounts, avatarBase });
  // html()을 "함수 호출"로 사용 — 완성된 문자열을 그대로 파싱, 자동 이스케이프 없음
  const markup = html(markupStr);
  const svg = await satori(markup, { width: ACCOUNTS_WIDTH, fonts });
  return svgToPng(svg, ACCOUNTS_WIDTH);
}

// ------------------------------------------------------------------
// 2) /gg/broadcast — 라이브 방송화면 1컷
// ------------------------------------------------------------------
//
// GET /gg/broadcast
//   ?char=캐릭터코드
//   &situation=상황코드          -> 배경: {SAFFRAN_BASE}/bro/{char}-{situation}.png (webp 원본 옆의 png 사본)
//   &title=방송+제목
//   &streamer=방송인+이름
//   &viewers=1234
//   &following=1|0
//   &chat=닉네임:메시지|닉네임:메시지|...     (최근 메시지가 맨 뒤 = 채팅창 맨 아래)
//   &donation=닉네임:내용                     (선택, 있으면 채팅창 강조줄 + 우상단 배너 둘 다 표시)
//   &w=1280&h=720                             (선택, 기본 1280x720 — 가로형 라이브 화면)
//
// 가로(w >= h)일 때는 채팅창을 하단 전체 폭이 아니라 우측 세로 패널로
// 배치합니다(데스크톱 스트리밍 사이트 채팅창과 비슷한 배치). 세로로 호출하면
// 기존처럼 하단 전체 폭 오버레이 방식을 씁니다.

const CHAT_MAX_LINES = 8;

function parseChat(raw) {
  if (!raw) return [];
  return raw
    .split('|')
    .filter(Boolean)
    .map((entry) => {
      const [nick, msg] = entry.split(':');
      return { nick: safeDecodeURIComponent(nick || ''), msg: safeDecodeURIComponent(msg || '') };
    })
    .slice(-CHAT_MAX_LINES);
}

function parseDonation(raw) {
  if (!raw) return null;
  const [nick, amount, content] = raw.split(':');
  if (!nick) return null;
  return {
    nick: safeDecodeURIComponent(nick),
    amount: Number(amount) || 0,
    content: safeDecodeURIComponent(content || ''),
  };
}

function formatWon(n) {
  if (!Number.isFinite(n)) return '0';
  return n.toLocaleString('ko-KR');
}

// 주의: 아래도 satori-html의 `html` 태그가 아니라 "일반 문자열"을 반환합니다.
// (이유는 파일 상단 주석 참고)
function renderBroadcastMarkup({ width, height, bgDataUri, title, streamer, viewers, following, chat, donation }) {
  const isLandscape = width >= height;

  const chatRows = chat
    .map(
      (c) => `
        <div style="display:flex;margin-top:7px;">
          <span style="font-size:15px;font-weight:700;color:#7ad0ff;margin-right:6px;">${escapeHtml(c.nick)}</span>
          <span style="font-size:15px;color:#f2f2f2;">${escapeHtml(c.msg)}</span>
        </div>
      `
    )
    .join('');

  const donationChatRow = donation
    ? `
      <div style="display:flex;flex-direction:column;margin-top:8px;background:rgba(255,145,0,0.28);padding:7px 10px;border-radius:8px;">
        <div style="display:flex;align-items:center;font-size:15px;font-weight:700;color:#ffd479;">
          ${iconTag(GIFT_ICON_SVG, 15)}
          <span style="margin-left:5px;">${escapeHtml(donation.nick)}님이 ${formatWon(donation.amount)}원 후원하셨습니다.</span>
        </div>
        ${
          donation.content
            ? `<div style="display:flex;font-size:14px;color:#fff;margin-top:2px;">"${escapeHtml(
                donation.content
              )}"</div>`
            : ''
        }
      </div>
    `
    : '';

  const donationBanner = donation
    ? `
      <div style="position:absolute;top:118px;right:20px;display:flex;flex-direction:column;max-width:${Math.round(
        width * (isLandscape ? 0.34 : 0.48)
      )}px;background:linear-gradient(135deg,#ffb300,#ff5f00);padding:10px 14px;border-radius:12px;">
        <div style="display:flex;align-items:center;font-size:13px;font-weight:700;color:#fff;">
          ${iconTag(GIFT_ICON_SVG, 14)}
          <span style="margin-left:4px;">${escapeHtml(donation.nick)}님이 ${formatWon(donation.amount)}원 후원하셨습니다.</span>
        </div>
        ${
          donation.content
            ? `<div style="display:flex;font-size:13px;color:#fff;margin-top:3px;">"${escapeHtml(
                donation.content
              )}"</div>`
            : ''
        }
      </div>
    `
    : '';

  // 가로: 우측 세로 채팅 패널 / 세로: 하단 전체 폭 오버레이
  const chatBoxStyle = isLandscape
    ? `position:absolute;top:200px;right:20px;width:${Math.min(
        360,
        Math.round(width * 0.3)
      )}px;height:${height - 220}px;display:flex;flex-direction:column;justify-content:flex-end;background:rgba(0,0,0,0.32);border-radius:14px;padding:14px;overflow:hidden;`
    : `position:absolute;bottom:22px;left:18px;width:${Math.round(
        width * 0.72
      )}px;display:flex;flex-direction:column;`;

  // 세로일 때만 쓰던 하단 어둡게 깔리는 그라데이션(채팅 가독성용) — 가로에서는
  // 채팅이 우측 패널 자체 배경으로 가독성을 확보하므로 생략합니다.
  const bottomGradient = isLandscape
    ? ''
    : `<div style="position:absolute;bottom:0;left:0;width:${width}px;height:460px;display:flex;background:linear-gradient(0deg, rgba(0,0,0,0.78), rgba(0,0,0,0));"></div>`;

  return `
    <div style="position:relative;display:flex;width:${width}px;height:${height}px;background:#000;font-family:'Pretendard';overflow:hidden;">
      <img src="${bgDataUri}" width="${width}" height="${height}" style="position:absolute;top:0;left:0;width:${width}px;height:${height}px;object-fit:cover;" />

      <div style="position:absolute;top:0;left:0;width:${width}px;height:230px;display:flex;background:linear-gradient(180deg, rgba(0,0,0,0.6), rgba(0,0,0,0));"></div>
      ${bottomGradient}

      <div style="position:absolute;top:24px;left:20px;display:flex;align-items:center;max-width:${Math.round(
        width * 0.6
      )}px;">
        <div style="display:flex;width:50px;height:50px;border-radius:9999px;background:linear-gradient(135deg,#555,#222);margin-right:10px;flex-shrink:0;"></div>
        <div style="display:flex;flex-direction:column;">
          <div style="display:flex;align-items:center;">
            <div style="display:flex;background:#ff2d55;color:#fff;font-size:12px;font-weight:700;padding:3px 7px;border-radius:4px;margin-right:6px;">LIVE</div>
            <span style="font-size:17px;font-weight:700;color:#fff;">${escapeHtml(streamer)}</span>
          </div>
          <div style="display:flex;font-size:14px;color:#e6e6e6;margin-top:3px;">${escapeHtml(title)}</div>
        </div>
      </div>

      <div style="position:absolute;top:28px;right:20px;display:flex;align-items:center;background:rgba(0,0,0,0.45);padding:5px 10px;border-radius:9999px;">
        ${iconTag(EYE_ICON_SVG, 13)}
        <span style="font-size:13px;color:#fff;margin-left:4px;">${formatCount(viewers, '명')}</span>
      </div>

      <div style="position:absolute;top:70px;right:20px;display:flex;">
        <div style="display:flex;padding:6px 16px;border-radius:9999px;font-size:13px;font-weight:700;color:#fff;background:${
          following ? 'rgba(255,255,255,0.16)' : '#ff2d55'
        };">${following ? '팔로잉' : '+ 팔로우'}</div>
      </div>

      ${donationBanner}

      <div style="${chatBoxStyle}">
        ${chatRows}
        ${donationChatRow}
      </div>
    </div>
  `;
}

async function handleBroadcast(url, env, ctx) {
  const char = url.searchParams.get('char') || '';
  const situation = url.searchParams.get('situation') || '';
  const title = url.searchParams.get('title') || '';
  const streamer = url.searchParams.get('streamer') || '';
  const viewers = Number(url.searchParams.get('viewers')) || 0;
  const following = url.searchParams.get('following') === '1';
  const chat = parseChat(url.searchParams.get('chat'));
  const donation = parseDonation(url.searchParams.get('donation'));
  // 기본값을 가로형(16:9)로 변경. 세로가 필요하면 ?w=720&h=1280 으로 호출.
  const width = Number(url.searchParams.get('w')) || 1280;
  const height = Number(url.searchParams.get('h')) || 720;

  const bgBase = env.SAFFRAN_BASE_URL || 'https://saffran.kr';
  // webp를 satori가 제대로 못 읽어서(Unsupported/is not iterable 계열 에러) png 사본을 씁니다.
  // {char}-{situation}.webp 원본과 같은 /bro/ 경로에, 파일명은 그대로 두고 확장자만 .png인
  // 사본을 같이 올려두면 됩니다 (예: RP27-01.webp 옆에 RP27-01.png).
  const bgUrl = `${bgBase.replace(/\/$/, '')}/bro/${encodeURIComponent(char)}-${encodeURIComponent(situation)}.png`;

  // --- 타이밍 계측 시작 -----------------------------------------------
  // 어느 단계(폰트+배경이미지 로딩 / satori 레이아웃 / resvg 래스터라이즈)가
  // CPU 시간을 잡아먹는지 확정하기 위한 체크포인트 로그.
  //
  // 주의: console.time()은 "호출 시점"엔 아무 로그도 안 남기고, 반드시
  // console.timeEnd()까지 끝나야만 한 줄이 찍힙니다. 그래서 CPU 한도로
  // 죽어버리는 요청은 마지막으로 진입한 단계의 timeEnd가 영원히 안 찍히고,
  // 심지어 그 전 단계까지도 로그가 하나도 안 남을 수 있어 "어디서 죽었는지"를
  // 알 수가 없었습니다. 아래는 각 단계 "시작 시점"에 즉시 찍히는 console.log
  // 체크포인트라서, 죽기 직전 로그에 찍힌 마지막 단계가 곧 범인입니다.
  console.log('[broadcast] step: fonts+bg 시작');
  const [fonts, bgDataUri] = await Promise.all([
    loadFonts(),
    fetchImageAsDataUri(bgUrl, ctx, width, height),
  ]);
  console.log('[broadcast] step: fonts+bg 완료');

  const markupStr = renderBroadcastMarkup({
    width,
    height,
    // 실제 base64 데이터 URI(수백KB~수MB짜리 긴 문자열) 대신 짧은 자리표시자를
    // 넣습니다. satori-html의 html()은 내부적으로 ultrahtml 파서로 이 문자열
    // 전체를 파싱하는데, <img src="..."> 속성값이 이렇게 거대하면 파서가
    // 비정상적으로 느려지는 사례가 알려져 있습니다(예: sanitize-html #619류
    // 이슈). 실제 이미지 데이터는 파싱이 끝난 뒤 트리에 직접 주입해서
    // 파서가 그 긴 문자열을 아예 보지 않게 합니다.
    bgDataUri: BG_IMG_PLACEHOLDER,
    title,
    streamer,
    viewers,
    following,
    chat,
    donation,
  });
  // html()을 "함수 호출"로 사용 — 완성된 문자열을 그대로 파싱, 자동 이스케이프 없음
  // (그래서 채팅 줄 안의 <div>/<span> 태그가 실제 엘리먼트로 정상 렌더링됩니다)
  console.log(`[broadcast] step: html() 파싱 시작, markupStr 길이=${markupStr.length}`);
  const markup = html(markupStr);
  console.log('[broadcast] step: html() 파싱 완료');
  // 파서를 거치지 않고, 파싱된 VDOM 트리에서 자리표시자를 실제 데이터 URI로 교체
  replaceImgSrc(markup, BG_IMG_PLACEHOLDER, bgDataUri);

  console.log('[broadcast] step: satori 시작');
  const svg = await satori(markup, { width, height, fonts });
  console.log('[broadcast] step: satori 완료');

  console.log('[broadcast] step: resvg 시작');
  const png = await svgToPng(svg, width);
  console.log('[broadcast] step: resvg 완료');
  // --- 타이밍 계측 끝 ---------------------------------------------------

  return png;
}

// ------------------------------------------------------------------
// 3) R2 암호화 저장 / 서빙
// ------------------------------------------------------------------
//
// 생성된 PNG를 그대로 R2에 올리면, 버킷을 들여다보는 누구든(대시보드,
// S3 호환 API, 백업 도구 등) 파일명·메타데이터·내용만으로 뭘 저장한 건지
// 알 수 있습니다. 아래 방식은 그걸 막습니다:
//
//   1) 오브젝트 키   : 내용과 무관한 난수(UUID). char/situation/title 등
//                      어떤 단서도 파일명에 남지 않음.
//   2) 오브젝트 내용 : AES-256-GCM으로 암호화한 바이트. R2에는 순수
//                      암호문만 존재 (뷰어로 열어도 그냥 랜덤 바이너리).
//   3) 메타데이터    : content-type도 image/png 대신
//                      application/octet-stream으로 저장 — "이미지"라는
//                      사실 자체도 숨김. custom metadata는 아예 저장 안 함.
//   4) 복호화 키     : wrangler secret으로만 존재. 레포/코드/R2 어디에도
//                      평문으로 남지 않음.
//
// 주의: Worker를 배포한 계정(=본인)은 원리적으로 시크릿에 접근 가능하므로
// "복호화가 영구적으로 불가능"해지는 건 아닙니다. 이 구조로 얻는 건
// "R2 버킷을 직접 열어봐서는(본인 포함) 무슨 파일인지 알 수 없다"는 것이지,
// 계정 소유자의 복호화 능력 자체를 없애는 게 아닙니다 — 그러려면 키를
// 정말 아무 데도 남기지 않아야 하는데, 그러면 이미지도 다시는 못 엽니다.
//
// 부가 주의: 어느 요청(파라미터)이 어느 imageId로 저장됐는지를 로그/분석
// 도구에 같이 남기면, 그 로그 자체가 R2 오브젝트를 다시 식별 가능하게
// 만듭니다. "완전히 알아볼 수 없게"가 목적이라면 이 매핑을 어디에도
// 기록하지 않아야 합니다.

async function getCryptoKey(env) {
  if (!env.ENCRYPTION_KEY) {
    throw new Error('ENCRYPTION_KEY 시크릿이 설정되지 않았습니다. (wrangler secret put ENCRYPTION_KEY)');
  }
  const raw = Uint8Array.from(atob(env.ENCRYPTION_KEY), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

async function encryptBytes(buf, key) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, buf);
  const out = new Uint8Array(iv.length + ciphertext.byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(ciphertext), iv.length);
  return out;
}

async function decryptBytes(buf, key) {
  const iv = buf.slice(0, 12);
  const data = buf.slice(12);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data);
  return new Uint8Array(plain);
}

// ------------------------------------------------------------------
// 3-1) 요청 파라미터 기반 "결정론적" R2 키 (중복 누적 방지)
// ------------------------------------------------------------------
//
// 기존에는 매 요청마다 crypto.randomUUID()로 완전히 새 키를 만들어 저장했기
// 때문에, 같은 장면(같은 파라미터)이 다시 요청될 때마다 — 예를 들어
// 클라이언트가 이미 생성된 이미지를 확대해서 다시 불러오거나, 캐릭터 AI 챗
// 히스토리를 다시 렌더링하면서 마크다운 이미지 URL(=같은 쿼리 파라미터)을
// 재요청하는 경우 — 내용은 완전히 동일한데 키만 다른 사본이 R2에 계속
// 추가로 쌓였습니다.
//
// 아래 함수는 URL의 쿼리 파라미터를 key 기준으로 정렬해 정규화한 뒤
// SHA-256 해시를 구해, 그 값 자체를 R2 오브젝트 키(= /gg/img/{id}의 id)로
// 씁니다. 같은 파라미터 조합은 항상 같은 id로 귀결되므로:
//   - 처음 보는 조합  -> 새로 렌더링해서 그 id로 저장
//   - 이미 본 조합    -> 렌더링 자체를 생략하고 기존 오브젝트를 복호화해서
//                        그대로 서빙 (CPU 절약 + R2에 중복 저장 안 됨)
// 해시는 일방향이라, id만 봐서는(기존 랜덤 UUID와 마찬가지로) 어떤
// char/situation/title/chat 조합이었는지 역산할 수 없습니다 — R2 버킷을
// 들여다봐도 내용을 알 수 없다는 기존 목적은 그대로 유지됩니다.
async function canonicalRequestId(url) {
  const sortedParams = [...url.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b));
  const canonical = sortedParams.map(([k, v]) => `${k}=${v}`).join('&');
  const data = new TextEncoder().encode(`${url.pathname}?${canonical}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * 주어진 id로 PNG를 암호화해서 R2에 저장합니다. id는 호출자(라우터)가
 * crypto.randomUUID()로 미리 만들어 응답 헤더(x-image-id)에 즉시 실어
 * 보내고, 이 함수 자체는 ctx.waitUntil로 백그라운드에서 돌립니다 — 그래야
 * AES-GCM 암호화 + R2 업로드가 클라이언트 응답 시간에 더해지지 않습니다.
 * IMAGES 바인딩이 없으면(로컬 dev 등) 조용히 건너뜁니다.
 */
async function storeEncryptedImage(env, id, pngBuffer) {
  if (!env.IMAGES) return;
  const key = await getCryptoKey(env);
  const encrypted = await encryptBytes(pngBuffer, key);
  await env.IMAGES.put(id, encrypted, {
    httpMetadata: { contentType: 'application/octet-stream' },
  });
}

/** GET /gg/img/{id} — R2에서 암호문을 읽어 복호화해서 정상 PNG로 서빙 */
async function handleStoredImage(url, env) {
  const id = url.pathname.split('/').filter(Boolean).pop();
  const obj = await env.IMAGES.get(id);
  if (!obj) return new Response('Not found', { status: 404 });
  const encrypted = new Uint8Array(await obj.arrayBuffer());
  const key = await getCryptoKey(env);
  const png = await decryptBytes(encrypted, key);
  return new Response(png, {
    headers: {
      'content-type': 'image/png',
      'cache-control': 'public, max-age=120',
    },
  });
}

// ------------------------------------------------------------------
// 라우터
// ------------------------------------------------------------------

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    // 실제 CPU 한도(예: 30초)보다 여유를 두고 먼저 끊어서, 플랫폼이 강제
    // 종료하기 전에 우리가 정상적인 에러 응답을 낼 수 있게 합니다.
    const RENDER_TIMEOUT_MS = 25000;

    try {
      // 저장된(암호화된) 이미지를 다시 꺼내오는 라우트
      if (url.pathname.startsWith('/gg/img/')) {
        return await handleStoredImage(url, env);
      }

      const isAccounts = url.pathname.startsWith('/gg/accounts');
      const isBroadcast = url.pathname.startsWith('/gg/broadcast');
      if (!isAccounts && !isBroadcast) {
        return new Response('Not found', { status: 404 });
      }

      const headers = {
        'content-type': 'image/png',
        'cache-control': 'public, max-age=120',
      };

      if (env.IMAGES) {
        // 같은 파라미터의 요청인지(=이미 만든 적 있는 장면인지)를 렌더링 전에
        // 먼저 확인합니다. "이미 생성된 이미지 확대해서 다시 불러오기",
        // "챗 히스토리 재로딩"처럼 완전히 동일한 URL이 다시 호출되는 경우가
        // 여기서 걸러져서, 렌더링을 다시 하지 않고(CPU 절약) R2에도 중복
        // 오브젝트가 추가되지 않습니다 — id가 파라미터로부터 결정되므로 같은
        // 파라미터는 항상 같은 오브젝트를 가리킵니다.
        const imageId = await canonicalRequestId(url);
        headers['x-image-id'] = imageId;

        const cached = await env.IMAGES.get(imageId);
        if (cached) {
          const encrypted = new Uint8Array(await cached.arrayBuffer());
          const key = await getCryptoKey(env);
          const png = await decryptBytes(encrypted, key);
          headers['x-image-cache'] = 'hit';
          return new Response(png, { headers });
        }

        let png;
        if (isAccounts) {
          png = await withTimeout(handleAccounts(url, env), RENDER_TIMEOUT_MS, '/gg/accounts 이미지 생성');
        } else {
          png = await withTimeout(handleBroadcast(url, env, ctx), RENDER_TIMEOUT_MS, '/gg/broadcast 이미지 생성');
        }

        // 암호화 + R2 업로드는 백그라운드로(ctx.waitUntil) 돌려서 응답 시간에
        // 더해지지 않게 합니다. 키가 이제 파라미터로부터 결정되므로, 같은
        // 파라미터로 다시 저장을 시도해도 "추가"가 아니라 "같은 자리에
        // 덮어쓰기"가 되어 R2에 사본이 쌓이지 않습니다.
        //   - 배포 환경: `npx wrangler tail` 로 console.error 로그 확인
        //   - 로컬(wrangler dev): 터미널에 바로 찍힘
        // 주의: 저장이 실제로 끝나기 전(또는 실패한 경우)에도 응답은 먼저
        // 나가므로, x-image-id가 있어도 /gg/img/{id}가 아주 잠깐 404를 낼 수
        // 있고 저장 자체가 실패하면 계속 404입니다.
        ctx.waitUntil(
          storeEncryptedImage(env, imageId, png).catch((storeErr) => {
            console.error('[storeEncryptedImage 실패]', storeErr);
          })
        );

        headers['x-image-cache'] = 'miss';
        return new Response(png, { headers });
      }

      // IMAGES 바인딩이 없는 경우(로컬 dev 등) — 캐싱/저장 없이 매번 렌더링
      let png;
      if (isAccounts) {
        png = await withTimeout(handleAccounts(url, env), RENDER_TIMEOUT_MS, '/gg/accounts 이미지 생성');
      } else {
        png = await withTimeout(handleBroadcast(url, env, ctx), RENDER_TIMEOUT_MS, '/gg/broadcast 이미지 생성');
      }
      headers['x-image-store-skipped'] = 'no-images-binding';
      return new Response(png, { headers });
    } catch (err) {
      const status = err instanceof TimeoutError ? 504 : 500;
      return new Response(`이미지 생성 실패: ${err.message}`, { status });
    }
  },
};
