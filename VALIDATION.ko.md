# 한국어 수정본 검증 기록

검증일: 2026-11-04. 원본 기준: `10b0433`.

## 통과

- `python3 kit/tools/test_ko.py`: 15개 앱의 한국어 메뉴·리소스 한도,
  번역 1,704개와 글꼴, Service 한국어 날짜·정비 명칭·힌트·깨진 값 대체,
  단위 유지, 단복수, 소프트웨어 및 GPU 명령 생성 경로의 텍스트 처리.
- `python3 kit/tools/test_zh.py`: 기존 45개 언어별 레이아웃,
  HMI 문자열 표 1,485개 및 동적 문자열 ID 검사.
- `node kit/tools/test_service.js`: 기존 Service 동작 회귀 검사.
- 수정한 Python/JavaScript의 문법 검사 및 `git diff --check`.
- 15개 앱 모두 `--language ko --preview-only` 스테이징 성공.
- Redline, Service, M Vitals, eDrive, Live Data, Transmission Config의
  데모 PNG 생성. Redline·Service·M Vitals의 주요 화면 육안 확인.
- Redline과 Service의 실제 생성된 GPU 명령 스트림에서 글꼴 업로드를 읽어
  1024 × 4096 두 열의 메모리 배치를 검사: 최종 높이 2,464 / 2,977,
  공유 아틀라스 ID 12개. 한글 글꼴은 두 앱이 같은 ID로 공유함.
- SDK가 없을 때 일반 설치 파일 빌드가 설명과 함께 중단되는 것 확인.
  미리보기용 출력이 `.mgu`로 포장되지 않음.
- 사용자가 제공한 BMW `oap-sdk` 24.10.2 적용. ZIP 내부 파일과 별도 첨부된
  `index.js`, `package.json`이 일치하는지 확인하고 SDK 문법 검사 통과.
- 15개 앱 모두 한국어 설치용 `.mgu` 빌드 완료. 원본 소스 지문과 일치하는
  사전 빌드 렌더러를 포함한 `mgu-custom-apps-ko.tar.gz` 생성.
- 사용자 요청에 따라 AA Cluster Companion은 한국어 빌드에서 제외하도록 변경.
  현재 전체 키트 구성은 한국어 14개 + AA Cluster Companion 영문 1개입니다.
  `ko`, `ko-kr`, `ko-KR` 빌드에서 영문 제목·메뉴·설정·런타임 사전과 원래 버전을
  유지하고 한글 글꼴을 포함하지 않는지 검사합니다.

## 아직 검증하지 않은 항목

- 실차의 HMI·MGU GPU·진단 신호 수신과 한국어 원문 전달은 미검증.
- 이 실행 환경에서는 사전 빌드된 MGU용 렌더러 실행에 필요한 런타임이 없어
  해당 바이너리로 GPU 재생은 실행하지 못함. PNG는 소프트웨어 경로로 생성함.
- 차량별 고장 설명 데이터베이스와 Doom 게임 본문은 번역 대상에서 제외.

최종 설치 패키지의 검증 결과는 배포 파일 옆 `build-verification-ko.json`에
기록합니다. 재빌드 방법은 [한국어 안내](README.ko.md)를 참고하세요.
