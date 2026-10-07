const { execFileSync } = require('child_process');

const REST_KEY = process.env.KAKAO_REST_API_KEY;
const REFRESH = process.env.KAKAO_REFRESH_TOKEN;
const GH_PAT = process.env.GH_PAT;
const REPO = process.env.GITHUB_REPOSITORY;

const now = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
const MESSAGE = `자동 발송 테스트예요 🎉\n${now}`;

async function main() {
  // 1. access_token 갱신 (refresh_token 사용)
  const tokenRes = await fetch('https://kauth.kakao.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: REST_KEY,
      refresh_token: REFRESH,
    }),
  });
  const tokenData = await tokenRes.json();
  if (!tokenRes.ok) {
    throw new Error('토큰 갱신 실패: ' + JSON.stringify(tokenData));
  }

  // 2. 새 refresh_token이 왔으면 GitHub Secret 교체
  if (tokenData.refresh_token) {
    execFileSync('gh', ['secret', 'set', 'KAKAO_REFRESH_TOKEN', '--repo', REPO], {
      input: tokenData.refresh_token,
      env: { ...process.env, GH_TOKEN: GH_PAT },
    });
    console.log('새 refresh_token 저장 완료');
  } else {
    console.log('refresh_token 갱신 불필요 (그대로 유지)');
  }

  // 3. 나에게 메시지 보내기
  const template = {
    object_type: 'text',
    text: MESSAGE,
    link: {
      web_url: 'https://developers.kakao.com',
      mobile_web_url: 'https://developers.kakao.com',
    },
  };
  const sendRes = await fetch('https://kapi.kakao.com/v2/api/talk/memo/default/send', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + tokenData.access_token,
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

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
