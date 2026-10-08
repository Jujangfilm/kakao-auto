// 클로드 5시간 사용량이 초기화되면, 가장 저렴한 모델(Haiku)에 짧은 메시지를 보내 새 5시간 창을 바로 시작하고
// Haiku의 답을 카카오톡 "나와의 채팅"으로 보낸다.
// 다음 초기화 시각은 CLAUDE_RESET_AT 변수에 저장하고, 공개 저장소에서는 다음 실행을 스스로 이어 붙여
// 그 시각까지 기다렸다가 정시에 보낸다 (GitHub 예약 실행은 자주 건너뛰어서 믿을 수 없다).
const { execSync, execFileSync } = require('child_process');
const os = require('os');
const path = require('path');
const { gh, getAccessToken, sendToMe } = require('./kakao');

const FALLBACK_MESSAGE = '클로드 5시간 사용이 초기화 되었습니다';
const PROMPT = `다음 문장만 그대로 답해: ${FALLBACK_MESSAGE}`;
const SYSTEM = 'You relay notifications. Reply with exactly the sentence the user gives, nothing else.';
const FIVE_HOURS = 5 * 60 * 60;
// 비공개 저장소는 기다리는 시간도 사용 시간으로 잡혀서, 이 이상은 기다리지 않는다
const WAIT_AHEAD_MS = 11 * 60 * 1000;
// 작업 하나는 최대 6시간까지만 돌 수 있어, 그보다 짧게 기다리고 다음 실행으로 넘긴다
const MAX_WAIT_MS = 340 * 60 * 1000;
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

function saveNextReset(resetAt) {
  gh(['variable', 'set', 'CLAUDE_RESET_AT', '--body', String(resetAt)]);
  console.log('다음 초기화 예정:', fmt(resetAt));
}

// 워크플로 자체 토큰(GITHUB_TOKEN)으로 gh 실행
function ghSelf(args) {
  return execFileSync('gh', args, {
    env: { ...process.env, GH_TOKEN: process.env.GITHUB_TOKEN },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function isPublicRepo() {
  try {
    return ghSelf(['api', `repos/${process.env.GITHUB_REPOSITORY}`, '--jq', '.private']) === 'false';
  } catch (e) {
    console.log('저장소 공개 여부 확인 실패, 비공개로 간주:', e.message);
    return false;
  }
}

// 다음 실행을 바로 이어 붙인다. 그 실행이 다음 초기화 시각까지 기다린다
function chainNext() {
  ghSelf(['workflow', 'run', 'claude-prime.yml', '--repo', process.env.GITHUB_REPOSITORY, '--ref', 'main']);
  console.log('다음 실행을 이어 붙였어요');
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
  if (process.env.TEST_ONLY === 'true') {
    // 시험 모드: 모델과 토큰 수만 확인하고 카톡/변수는 건드리지 않는다
    const { result } = askHaiku(installClaude());
    return console.log('시험 모드 답:', result && result.result);
  }

  const isPublic = isPublicRepo();
  const resetAt = Number(readVar('CLAUDE_RESET_AT')) || 0;

  if (process.env.SEND_NOW !== 'true' && resetAt) {
    const wait = resetAt * 1000 + AFTER_RESET_MS - Date.now();
    if (wait > 0) {
      if (!isPublic && wait > WAIT_AHEAD_MS) {
        return console.log(`비공개 저장소라 오래 기다리지 않아요. 초기화까지 ${Math.round(wait / 60000)}분 (${fmt(resetAt)})`);
      }
      if (wait > MAX_WAIT_MS) {
        console.log(`초기화가 아직 멀어요 (${fmt(resetAt)}). 기다렸다가 다음 실행으로 넘겨요.`);
        await sleep(MAX_WAIT_MS);
        return chainNext();
      }
      console.log(`${Math.round(wait / 60000)}분 기다렸다가 보내요 (${fmt(resetAt)})`);
      await sleep(wait);
    }
  }

  const { result, limits } = askHaiku(installClaude());
  const rejected = limits.find((i) => i.status === 'rejected' && i.resetsAt);

  if (!result || result.is_error) {
    if (!rejected) throw new Error('Claude 응답 실패: ' + JSON.stringify(result || {}));
    // 아직 초기화 전이었다: 알려준 시각에 다시 시도
    console.log('아직 한도 상태예요. 초기화 시각에 다시 시도해요.');
    saveNextReset(toSec(rejected.resetsAt));
  } else {
    const text = (result.result || '').trim() || FALLBACK_MESSAGE;
    const accessToken = await getAccessToken();
    await sendToMe(accessToken, text);

    // 5시간 창 정보가 없으면, 방금 보낸 메시지로 창이 시작됐다고 보고 5시간 뒤로 잡는다
    let next = fiveHourReset(limits);
    if (!next || next <= nowSec()) next = nowSec() + FIVE_HOURS;
    saveNextReset(next);
  }

  if (isPublic) chainNext();
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
