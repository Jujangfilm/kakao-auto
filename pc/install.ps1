# 클로드 초기화 알림 - PC 설치 스크립트 (Windows PowerShell)
# 하는 일:
#  1) GitHub 토큰을 입력받아 이 PC에만 저장 (화면/채팅에 남지 않음)
#  2) Claude Code 상태줄 스크립트 설치: 5시간 사용량 초기화 시각을 GitHub에 올림
#  3) %USERPROFILE%\.claude\settings.json 에 statusLine 설정 추가 (기존 파일은 백업)
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Repo = 'Jujangfilm/kakao-auto'
$ClaudeDir = Join-Path $HOME '.claude'
$Dir = Join-Path $ClaudeDir 'kakao-reset'
$Utf8 = New-Object System.Text.UTF8Encoding $false
New-Item -ItemType Directory -Force -Path $Dir | Out-Null

# ---------- 1. GitHub 토큰 ----------
Write-Host ''
$sec = Read-Host 'GitHub 토큰을 붙여넣고 Enter (입력해도 화면에 보이지 않아요)' -AsSecureString
$token = [Runtime.InteropServices.Marshal]::PtrToStringBSTR(
  [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)).Trim()
if (-not $token) { throw '토큰이 비어 있어요. 다시 실행해 주세요.' }

try {
  Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/actions/variables" -TimeoutSec 15 -Headers @{
    Authorization = "Bearer $token"; Accept = 'application/vnd.github+json'; 'X-GitHub-Api-Version' = '2022-11-28'
  } | Out-Null
} catch {
  Write-Host ''
  Write-Host '토큰 확인 실패: kakao-auto 저장소 접근 권한과 Variables(Read and write) 권한이 있는지 확인해 주세요.' -ForegroundColor Red
  Write-Host $_.Exception.Message
  exit 1
}
[IO.File]::WriteAllText((Join-Path $Dir 'gh-token.txt'), $token, $Utf8)
Write-Host '토큰 확인 및 저장 완료' -ForegroundColor Green

# ---------- 2. 상태줄 스크립트 ----------
$statusline = @'
# Claude Code status line: shows 5h usage and uploads the reset time to GitHub
# (CLAUDE_RESET_AT variable) so a GitHub Actions workflow can send a KakaoTalk alert.
$ErrorActionPreference = 'Stop'
$Repo = '__REPO__'
$Dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$parts = @()
try {
  [Console]::InputEncoding = [Text.Encoding]::UTF8
  [Console]::OutputEncoding = [Text.Encoding]::UTF8
  $j = [Console]::In.ReadToEnd() | ConvertFrom-Json
  if ($j.model.display_name) { $parts += "[$($j.model.display_name)]" }
  $fh = $j.rate_limits.five_hour
  if ($fh -and $null -ne $fh.used_percentage) { $parts += ('5h {0}%' -f [math]::Round([double]$fh.used_percentage)) }

  # resets_at may be epoch seconds, epoch milliseconds, or an ISO 8601 string
  $epoch = $null
  $v = $fh.resets_at
  if ($v -is [DateTime]) { $epoch = ([DateTimeOffset]$v.ToUniversalTime()).ToUnixTimeSeconds() }
  elseif ("$v" -match '^\d+(\.\d+)?$') {
    $epoch = [int64][math]::Floor([double]"$v")
    if ($epoch -gt 100000000000) { $epoch = [int64][math]::Floor($epoch / 1000) }
  }
  elseif ("$v") { $epoch = [DateTimeOffset]::Parse("$v").ToUnixTimeSeconds() }

  if ($epoch) {
    $parts += ('reset ' + [DateTimeOffset]::FromUnixTimeSeconds($epoch).ToLocalTime().ToString('HH:mm'))
    $sentFile = Join-Path $Dir 'last-uploaded.txt'
    $tryFile = Join-Path $Dir 'last-attempt.txt'
    $prev = if (Test-Path $sentFile) { (Get-Content $sentFile -Raw).Trim() } else { '' }
    # upload only when the reset time changes; after a failure, retry at most once a minute
    $recentTry = (Test-Path $tryFile) -and ((Get-Item $tryFile).LastWriteTime -gt (Get-Date).AddMinutes(-1))
    if ("$epoch" -ne $prev -and -not $recentTry) {
      Set-Content -Path $tryFile -Value "$epoch"
      try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        $token = (Get-Content (Join-Path $Dir 'gh-token.txt') -Raw).Trim()
        $h = @{ Authorization = "Bearer $token"; Accept = 'application/vnd.github+json'; 'X-GitHub-Api-Version' = '2022-11-28' }
        $api = "https://api.github.com/repos/$Repo/actions/variables"
        $body = @{ name = 'CLAUDE_RESET_AT'; value = "$epoch" } | ConvertTo-Json
        try {
          Invoke-RestMethod -Method Patch -Uri "$api/CLAUDE_RESET_AT" -Headers $h -Body $body -ContentType 'application/json' -TimeoutSec 5 | Out-Null
        } catch {
          if ($_.Exception.Response -and [int]$_.Exception.Response.StatusCode -eq 404) {
            Invoke-RestMethod -Method Post -Uri $api -Headers $h -Body $body -ContentType 'application/json' -TimeoutSec 5 | Out-Null
          } else { throw }
        }
        Set-Content -Path $sentFile -Value "$epoch"
      } catch {
        $parts += '(alert upload failed)'
        Add-Content -Path (Join-Path $Dir 'error.log') -Value ("{0} {1}" -f (Get-Date -Format s), $_.Exception.Message)
      }
    }
  }
} catch {
  Add-Content -Path (Join-Path $Dir 'error.log') -Value ("{0} {1}" -f (Get-Date -Format s), $_.Exception.Message)
}
Write-Output ($parts -join ' | ')
'@
$statusline = $statusline.Replace('__REPO__', $Repo)
$scriptPath = Join-Path $Dir 'statusline.ps1'
[IO.File]::WriteAllText($scriptPath, $statusline, $Utf8)
Write-Host '상태줄 스크립트 설치 완료' -ForegroundColor Green

# ---------- 3. settings.json ----------
$settingsPath = Join-Path $ClaudeDir 'settings.json'
$command = 'powershell -NoProfile -ExecutionPolicy Bypass -File "' + ($scriptPath -replace '\\', '/') + '"'
$settings = New-Object PSObject
if (Test-Path $settingsPath) {
  $text = [IO.File]::ReadAllText($settingsPath)
  if ($text.Trim()) {
    try { $settings = $text | ConvertFrom-Json }
    catch { throw "settings.json 을 읽지 못했어요. 파일 내용을 확인해 주세요: $settingsPath" }
  }
  $old = $settings.statusLine
  if ($old -and "$($old.command)" -notlike '*kakao-reset*') {
    Write-Host ''
    Write-Host "이미 다른 상태줄 설정이 있어요: $($old.command)" -ForegroundColor Yellow
    $ans = Read-Host '이 설정으로 바꿀까요? (Y/N)'
    if ($ans -notmatch '^[Yy]') { Write-Host '설치를 멈췄어요. settings.json 은 바꾸지 않았어요.'; exit 1 }
  }
  $backup = "$settingsPath.bak-$(Get-Date -Format yyyyMMdd-HHmmss)"
  Copy-Item $settingsPath $backup
  Write-Host "기존 settings.json 백업: $backup"
}
$settings | Add-Member -NotePropertyName statusLine -Force -NotePropertyValue ([pscustomobject]@{
  type = 'command'
  command = $command
})
[IO.File]::WriteAllText($settingsPath, ($settings | ConvertTo-Json -Depth 32), $Utf8)
Write-Host 'Claude Code 설정 완료' -ForegroundColor Green

Write-Host ''
Write-Host '설치가 끝났어요! Claude Code를 새로 열고 메시지를 하나 보내면' -ForegroundColor Cyan
Write-Host '아래쪽 상태줄에 "5h 00% | reset 00:00" 처럼 표시돼요.' -ForegroundColor Cyan
