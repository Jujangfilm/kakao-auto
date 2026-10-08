// 클로드 5시간 사용량이 초기화되면, 가장 저렴한 모델(Haiku)에 짧은 메시지를 보내 새 5시간 창을 바로 시작하고
// Haiku의 답을 카카오톡 "나와의 채팅"으로 보낸다.
// 다음 초기화 시각은 CLAUDE_RESET_AT 변수에, 그 시각에 맞춰 실행될 예약(cron) 줄은 CLAUDE_NEXT_CRONS에 저장한다.
const { execSync, execFileSync } = require('child_process');
const os = require('os');
const path = require('path');
const { gh, getAccessToken, sendToMe } = require('./kakao');

const FALLBACK_MESSAGE = '클로드 5시간 사용이 초기화 되었습니다';
const PROMPT = `다음 문장만 그대로 답해: ${FALLBACK_MESSAGE}`;
const SYSTEM = 'You relay notifications. Reply with exactly the sentence the user gives, nothing else.';
const FIVE_HOURS = 5 * 60 * 60;
// 예약 실행은 10분 간격이라, 이 안에 초기화 시각이 있으면 기다렸다가 정시에 보낸다
const WAIT_AHEAD_MS = 11 * 60 * 1000;
// 초기화 직후 바로 보내면 아직 이전 창으로 잡힐 수 있어 조금 여유를 둔다
const AFTER_RESET_MS = 60 * 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowSec = () => Math.floor(Date.now() / 1000);
const toSec = (t) => (t > 1e12 ? Math.floor(t / 1000) : Math.floor(t));
const fmt = (sec) => new Date(sec * 1000).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });

function readVar(name) {
  try {
    return gh(['variable', 'get', name]);
  } catch (e) {
    if (/was not found/.test(e.message)) return '';
    throw new Error(`${name} 변수 읽기 실패 (GH_PAT에 Variables 권한이 있는지 확인): ${e.message}`);
  }
}

// 다음 초기화 시각을 저장하고, 그 시간대(UTC 시)와 다음 시간대의 예약 줄만 실행되게 한다.
// (워크플로의 cron 줄과 글자가 똑같아야 한다)
function saveNextReset(resetAt) {
  const h = new Date(resetAt * 1000).getUTCHours();
  const crons = [h, (h + 1) % 24].map((x) => `*/10 ${x} * * *`);
  gh(['variable', 'set', 'CLAUDE_RESET_AT', '--body', String(resetAt)]);
  gh(['variable', 'set', 'CLAUDE_NEXT_CRONS', '--body', `|${crons.join('|')}|`]);
  console.log('다음 초기화 예정:', fmt(resetAt));
}

function installClaude() {
  const bin = path.join(os.homedir(), '.local', 'bin', 'claude');
  try {
    execFileSync(bin, ['--version'], { stdio: 'ignore' });
  } catch {
    execSync('curl -fsSL https://claude.ai/install.sh | bash', { stdio: 'inherit' });
  }
  return bin;
}

// Haiku에 한 번 물어보고, 답과 사용량 정보(rate_limit_event)를 돌려준다
function askHaiku(bin) {
  const args = [
    '-p', PROMPT,
    '--model', 'haiku',
    '--system-prompt', SYSTEM,
    '--tools', '',
    '--max-turns', '1',
    '--no-session-persistence',
    '--output-format', 'stream-json',
    '--verbose',
  ];
  let out;
  try {
    out = execFileSync(bin, args, {
      encoding: 'utf8',
      env: {
        ...process.env,
        CLAUDE_CODE_OAUTH_TOKEN: (process.env.CLAUDE_CODE_OAUTH_TOKEN || '').replace(/\s/g, ''),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 3 * 60 * 1000,
    });
  } catch (e) {
    out = (e.stdout || '').toString();
    if (!out) throw new Error('Claude 실행 실패: ' + (e.stderr || e.message));
  }
  const events = out.split('\n').filter(Boolean).flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
  const result = events.find((e) => e.type === 'result');
  const limits = events.filter((e) => e.type === 'rate_limit_event').map((e) => e.rate_limit_info || {});
  console.log('사용량 정보:', JSON.stringify(limits));
  if (result) {
    // 실제로 쓴 모델과 토큰 수 (모델별)
    console.log('사용 모델/토큰:', JSON.stringify(result.modelUsage || result.usage || {}));
  }
  return { result, limits };
}

// 사용량 정보에서 5시간 창의 초기화 시각을 찾는다
function fiveHourReset(limits) {
  for (const info of limits.slice().reverse()) {
    const w = info.unifiedWindows && info.unifiedWindows.five_hour;
    if (w && w.resetsAt) return toSec(w.resetsAt);
    if (info.rateLimitType === 'five_hour' && info.resetsAt) return toSec(info.resetsAt);
  }
  return null;
}

async function main() {
  const manual = process.env.GITHUB_EVENT_NAME === 'workflow_dispatch';
  const resetAt = Number(readVar('CLAUDE_RESET_AT')) || 0;

  if (!manual && resetAt && process.env.TEST_ONLY !== 'true') {
    const wait = resetAt * 1000 + AFTER_RESET_MS - Date.now();
    if (wait > WAIT_AHEAD_MS) {
      return console.log(`초기화까지 ${Math.round(wait / 60000)}분 남음 (${fmt(resetAt)})`);
    }
    if (wait > 0) {
      console.log(`${Math.round(wait / 1000)}초 기다렸다가 보냄 (${fmt(resetAt)})`);
      await sleep(wait);
    }
    // 기다리는 동안 다른 실행이 이미 처리했으면 그만둔다
    if (Number(readVar('CLAUDE_RESET_AT')) !== resetAt) return console.log('이미 처리됨');
  }

  const bin = installClaude();
  const { result, limits } = askHaiku(bin);
  if (process.env.TEST_ONLY === 'true') {
    // 시험 모드: 모델과 토큰 수만 확인하고 카톡/예약은 건드리지 않는다
    return console.log('시험 모드 답:', result && result.result);
  }
  const rejected = limits.find((i) => i.status === 'rejected' && i.resetsAt);

  if (!result || result.is_error) {
    if (rejected) {
      // 아직 초기화 전이었다: 알려준 시각에 다시 시도
      console.log('아직 한도 상태예요. 초기화 시각에 다시 시도해요.');
      return saveNextReset(toSec(rejected.resetsAt));
    }
    throw new Error('Claude 응답 실패: ' + JSON.stringify(result || {}));
  }

  const text = (result.result || '').trim() || FALLBACK_MESSAGE;
  const accessToken = await getAccessToken();
  await sendToMe(accessToken, text);

  // 5시간 창 정보가 없으면, 방금 보낸 메시지로 창이 시작됐다고 보고 5시간 뒤로 잡는다
  let next = fiveHourReset(limits);
  if (!next || next <= nowSec()) next = nowSec() + FIVE_HOURS;
  saveNextReset(next);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
