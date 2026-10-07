// 클로드 5시간 사용량 초기화 알림.
// PC의 Claude Code 상태줄 스크립트가 초기화 시각(epoch 초)을 CLAUDE_RESET_AT 변수에 올려두면,
// 이 스크립트가 그 시각이 지났을 때 카카오톡으로 알리고 CLAUDE_RESET_SENT에 기록한다.
const { gh, getAccessToken, sendToMe } = require('./kakao');

const MESSAGE = '클로드 5시간 사용이 초기화 되었습니다';
// 워크플로가 15분마다 돌기 때문에, 이 안에 초기화 시각이 있으면 기다렸다가 정시에 보낸다
const WAIT_AHEAD_MS = 16 * 60 * 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 변수가 아직 없으면 빈 값. 권한 문제 같은 다른 오류는 그대로 실패시켜 로그에 남긴다
function readVar(name) {
  try {
    return gh(['variable', 'get', name]);
  } catch (e) {
    if (/was not found/.test(e.message)) return '';
    throw new Error(`${name} 변수 읽기 실패 (GH_PAT에 Variables 권한이 있는지 확인): ${e.message}`);
  }
}

function fmt(epochSec) {
  return new Date(epochSec * 1000).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
}

async function main() {
  const resetAt = Number(readVar('CLAUDE_RESET_AT'));
  if (!resetAt) return console.log('등록된 초기화 시각 없음');
  if (readVar('CLAUDE_RESET_SENT') === String(resetAt)) {
    return console.log('이미 알림 보냄:', fmt(resetAt));
  }

  const wait = resetAt * 1000 - Date.now();
  if (wait > WAIT_AHEAD_MS) {
    return console.log(`초기화까지 ${Math.round(wait / 60000)}분 남음 (${fmt(resetAt)})`);
  }
  if (wait > 0) {
    console.log(`${Math.round(wait / 1000)}초 기다렸다가 보냄 (${fmt(resetAt)})`);
    await sleep(wait);
  }

  // 기다리는 동안 다른 실행이 이미 보냈을 수 있으니 한 번 더 확인
  if (readVar('CLAUDE_RESET_SENT') === String(resetAt)) {
    return console.log('이미 알림 보냄:', fmt(resetAt));
  }

  const accessToken = await getAccessToken();
  await sendToMe(accessToken, MESSAGE);
  gh(['variable', 'set', 'CLAUDE_RESET_SENT', '--body', String(resetAt)]);
  console.log('알림 완료:', fmt(resetAt));
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
