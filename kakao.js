const { execFileSync } = require('child_process');

const REST_KEY = process.env.KAKAO_REST_API_KEY;
const CLIENT_SECRET = (process.env.KAKAO_CLIENT_SECRET || '').trim();
const REFRESH = process.env.KAKAO_REFRESH_TOKEN;
const GH_PAT = process.env.GH_PAT;
const REPO = process.env.GITHUB_REPOSITORY;

// gh CLI 실행 (GH_PAT 권한으로 이 저장소의 Secret/Variable을 읽고 쓴다)
function gh(args, input) {
  return execFileSync('gh', [...args, '--repo', REPO], {
    input,
    env: { ...process.env, GH_TOKEN: GH_PAT },
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'], // 실패하면 오류 내용은 예외 메시지에 담긴다
  }).trim();
}

// refresh_token으로 access_token 갱신. 새 refresh_token이 오면 GitHub Secret 교체
async function getAccessToken() {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: REST_KEY,
    refresh_token: REFRESH,
  });
  // 클라이언트 시크릿이 ON인 앱은 client_secret이 없으면 KOE010 오류
  if (CLIENT_SECRET) body.append('client_secret', CLIENT_SECRET);

  const tokenRes = await fetch('https://kauth.kakao.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const tokenData = await tokenRes.json();
  if (!tokenRes.ok) {
    throw new Error('토큰 갱신 실패: ' + JSON.stringify(tokenData));
  }

  if (tokenData.refresh_token) {
    gh(['secret', 'set', 'KAKAO_REFRESH_TOKEN'], tokenData.refresh_token);
    console.log('새 refresh_token 저장 완료');
  } else {
    console.log('refresh_token 갱신 불필요 (그대로 유지)');
  }
  return tokenData.access_token;
}

// 카카오톡 "나와의 채팅"으로 메시지 보내기
async function sendToMe(accessToken, text) {
  const template = {
    object_type: 'text',
    text,
    link: {
      web_url: 'https://claude.ai',
      mobile_web_url: 'https://claude.ai',
    },
  };
  const sendRes = await fetch('https://kapi.kakao.com/v2/api/talk/memo/default/send', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + accessToken,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ template_object: JSON.stringify(template) }),
  });
  const sendData = await sendRes.json();
  if (!sendRes.ok) {
    throw new Error('발송 실패: ' + JSON.stringify(sendData));
  }
  console.log('발송 성공:', sendData);
}

module.exports = { gh, getAccessToken, sendToMe };
