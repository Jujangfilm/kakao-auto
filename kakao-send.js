// 카카오 토큰 유지용: refresh_token은 오래 안 쓰면 만료되므로 주기적으로 갱신만 한다.
// KAKAO_MESSAGE가 있으면 그 내용도 "나와의 채팅"으로 보낸다 (수동 테스트용).
const { getAccessToken, sendToMe } = require('./kakao');

async function main() {
  const accessToken = await getAccessToken();
  const message = (process.env.KAKAO_MESSAGE || '').trim();
  if (message) await sendToMe(accessToken, message);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
