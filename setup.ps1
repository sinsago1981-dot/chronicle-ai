# =============================================================================
# Chronicle AI TRPG — Windows 로컬 개발 환경 설정 스크립트
# =============================================================================
# 실행 방법:
#   PowerShell을 관리자 권한으로 실행 후:
#   Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
#   .\setup.ps1
# =============================================================================

$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "============================================" -ForegroundColor Cyan
Write-Host "  Chronicle AI TRPG — 개발 환경 설정" -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""

# ── 1. 사전 확인 ────────────────────────────────────────────────────────────
Write-Host "[1/5] Node.js / pnpm 버전 확인..." -ForegroundColor Yellow

try {
    $nodeVer = node --version 2>&1
    Write-Host "  Node.js: $nodeVer" -ForegroundColor Green
} catch {
    Write-Host "  [오류] Node.js가 설치되어 있지 않습니다." -ForegroundColor Red
    Write-Host "  https://nodejs.org 에서 Node.js 22 이상을 설치하세요." -ForegroundColor Red
    exit 1
}

try {
    $pnpmVer = pnpm --version 2>&1
    Write-Host "  pnpm: $pnpmVer" -ForegroundColor Green
} catch {
    Write-Host "  pnpm이 없습니다. 설치 중..." -ForegroundColor Yellow
    npm install -g pnpm
    Write-Host "  pnpm 설치 완료." -ForegroundColor Green
}

# ── 2. .env 파일 확인 ────────────────────────────────────────────────────────
Write-Host ""
Write-Host "[2/5] 환경변수 파일 확인..." -ForegroundColor Yellow

if (-not (Test-Path ".env")) {
    if (Test-Path ".env.example") {
        Copy-Item ".env.example" ".env"
        Write-Host "  .env.example → .env 복사 완료" -ForegroundColor Green
        Write-Host ""
        Write-Host "  !! 중요: .env 파일을 열고 다음 값을 채워주세요:" -ForegroundColor Red
        Write-Host "     DATABASE_URL=postgresql://user:pass@localhost:5432/chronicle" -ForegroundColor White
        Write-Host "     OPENAI_API_KEY=sk-..." -ForegroundColor White
        Write-Host ""
        Read-Host "  .env 편집 후 Enter 키를 누르세요"
    } else {
        Write-Host "  [경고] .env 파일이 없습니다. API 서버가 시작되지 않을 수 있습니다." -ForegroundColor Red
    }
} else {
    Write-Host "  .env 파일 확인됨." -ForegroundColor Green
}

# ── 3. node_modules 초기화 ──────────────────────────────────────────────────
Write-Host ""
Write-Host "[3/5] 기존 node_modules 삭제..." -ForegroundColor Yellow
Write-Host "  (ERR_PNPM_EPERM 오류 방지를 위해 관리자 권한으로 실행하세요)" -ForegroundColor Gray

$nmPaths = @(
    "node_modules",
    "artifacts\ai-trpg\node_modules",
    "artifacts\api-server\node_modules",
    "artifacts\mockup-sandbox\node_modules",
    "lib\db\node_modules",
    "lib\api-spec\node_modules",
    "lib\api-client-react\node_modules",
    "lib\api-zod\node_modules",
    "scripts\node_modules"
)

foreach ($p in $nmPaths) {
    if (Test-Path $p) {
        Write-Host "  삭제: $p" -ForegroundColor Gray
        Remove-Item -Recurse -Force $p -ErrorAction SilentlyContinue
    }
}
Write-Host "  완료." -ForegroundColor Green

# ── 4. 의존성 설치 ──────────────────────────────────────────────────────────
Write-Host ""
Write-Host "[4/5] pnpm install 실행..." -ForegroundColor Yellow
Write-Host "  (첫 설치는 수 분이 걸릴 수 있습니다)" -ForegroundColor Gray
Write-Host ""

pnpm install

if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "  [오류] pnpm install 실패." -ForegroundColor Red
    Write-Host "  ERR_PNPM_EPERM 오류인 경우:" -ForegroundColor Yellow
    Write-Host "    1. PowerShell을 '관리자 권한으로 실행' 후 다시 시도" -ForegroundColor White
    Write-Host "    2. Windows Defender 실시간 보호를 잠시 끄고 재시도" -ForegroundColor White
    Write-Host "    3. 프로젝트 폴더를 Defender 제외 목록에 추가" -ForegroundColor White
    exit 1
}

Write-Host "  설치 완료." -ForegroundColor Green

# ── 5. 완료 안내 ────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "============================================" -ForegroundColor Cyan
Write-Host "  설정 완료!" -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "  개발 서버 실행 방법:" -ForegroundColor White
Write-Host ""
Write-Host "  [방법 A] 두 서버 동시 실행:" -ForegroundColor Yellow
Write-Host "    pnpm dev" -ForegroundColor White
Write-Host ""
Write-Host "  [방법 B] 개별 실행 (터미널 2개):" -ForegroundColor Yellow
Write-Host "    터미널 1: pnpm dev:api     (API 서버 - localhost:10000)" -ForegroundColor White
Write-Host "    터미널 2: pnpm dev:web     (웹 서버  - localhost:3000)" -ForegroundColor White
Write-Host ""
Write-Host "  브라우저에서 http://localhost:3000 접속" -ForegroundColor Green
Write-Host ""
Write-Host "  핸드폰으로 접속하려면:" -ForegroundColor Yellow
$localIP = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.InterfaceAlias -notmatch "Loopback|vEthernet|WSL" -and $_.IPAddress -notmatch "^169" } | Select-Object -First 1).IPAddress
if ($localIP) {
    Write-Host "    http://${localIP}:3000 (같은 Wi-Fi 연결 필요)" -ForegroundColor Green
} else {
    Write-Host "    ipconfig 명령으로 IPv4 주소 확인 후 :3000 으로 접속" -ForegroundColor Green
}
Write-Host ""
