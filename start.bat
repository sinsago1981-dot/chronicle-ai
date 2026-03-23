@echo off
chcp 65001 >nul 2>&1
echo.
echo ============================================
echo   Chronicle AI TRPG -- 개발 서버 시작
echo ============================================
echo.

:: ── Node.js 확인 ─────────────────────────────
node --version >nul 2>&1
if errorlevel 1 (
    echo [오류] Node.js가 설치되어 있지 않습니다.
    echo   https://nodejs.org 에서 Node.js 22 LTS를 설치하세요.
    pause
    exit /b 1
)
for /f "tokens=*" %%v in ('node --version') do echo   Node.js: %%v

:: ── pnpm 확인 / 설치 ─────────────────────────
pnpm --version >nul 2>&1
if errorlevel 1 (
    echo   pnpm 없음. 설치 중...
    npm install -g pnpm
    if errorlevel 1 (
        echo [오류] pnpm 설치 실패. 관리자 권한으로 CMD를 열고 다시 실행하세요.
        pause
        exit /b 1
    )
)
for /f "tokens=*" %%v in ('pnpm --version') do echo   pnpm: %%v
echo.

:: ── .env 파일 확인 ───────────────────────────
if not exist ".env" (
    if exist ".env.example" (
        copy ".env.example" ".env" >nul
        echo .env 파일을 생성했습니다.
        echo.
        echo !! DATABASE_URL 과 OPENAI_API_KEY 를 입력해야 합니다.
        echo    무료 DB: https://neon.tech (가입 후 Connection string 복사)
        echo    OpenAI : https://platform.openai.com/api-keys
        echo.
        echo 메모장으로 .env 파일을 엽니다...
        start /wait notepad ".env"
    ) else (
        echo [경고] .env 파일이 없습니다. API 서버가 실패할 수 있습니다.
    )
)

:: ── node_modules 확인 ────────────────────────
if not exist "node_modules" (
    echo node_modules 없음. 패키지 설치 중...
    echo (처음 설치는 2~5분 걸릴 수 있습니다)
    echo.
    pnpm install
    if errorlevel 1 (
        echo.
        echo [오류] pnpm install 실패.
        echo   해결 방법:
        echo   1. 이 창을 닫고 CMD를 "관리자 권한으로 실행" 후 다시 실행
        echo   2. Windows Defender 실시간 보호 잠시 비활성화
        echo   3. 프로젝트 폴더를 Defender 예외 목록에 추가
        pause
        exit /b 1
    )
    echo.

    :: 첫 설치 시 DB 마이그레이션 실행
    echo DB 테이블 생성 중...
    pnpm --filter @workspace/db run push
    if errorlevel 1 (
        echo [경고] DB 마이그레이션 실패. .env 의 DATABASE_URL 을 확인하세요.
    ) else (
        echo DB 초기화 완료.
    )
    echo.
)

:: ── 개발 서버 시작 ────────────────────────────
echo 개발 서버를 시작합니다...
echo.
echo   웹  : http://localhost:3000
echo   API : http://localhost:10000
echo.
echo 핸드폰 접속 (같은 Wi-Fi):
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /r "IPv4.*192\."') do (
    for /f "tokens=1" %%b in ("%%a") do echo   http://%%b:3000
)
echo.
echo 종료: Ctrl+C
echo ============================================
echo.
pnpm dev
pause
