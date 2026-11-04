# MGU Custom Apps 한국어판

원본: https://github.com/cauliflowermossgrape/idrive7-apps

기준 커밋: `10b0433`. 이 작업은 원본 프로젝트의 비공식 한국어 수정본입니다.

## 포함된 작업

- Redline, Service, M Vitals, eDrive, Live Data, G-Force, Warm-Up, Virtual Dyno,
  Brake Test, Drag Timer, Fault Scanner, Engine Config, Transmission Config,
  AA Cluster Companion, Doom, 12V Battery의 공통 설정 및 앱 표시 문구 번역.
- AA Cluster Companion (`aa_cluster_companion`)의 지도 배율, 회전 안내 카드,
  사용자 지정, 변경 적용·재시작 상태와 안내 문구도 한국어로 표시합니다.
- 사용자가 제공한 12V Battery 1.5.3을 `apps/battery12v/`에 추가했습니다.
  앱 ID `battery12v`와 진단 설정은 유지하며, Live Data와 겹치던 로그 식별자만
  미사용 값 `OAA3`으로 구분했습니다. 아이콘은 `iconGlyph: battery`로 기본 생성합니다.
- `kit/runtime/locales/ko.tsv`와 `ko.json`: 한국어 사전 1,773개 항목.
- Noto Sans CJK KR 기반 한글 글꼴. 번역에 쓰인 모든 글자, KS X 1001의 완성형
  한글 2,350자, 호환 자모, 숫자·단위·기호를 하나의 공용 아틀라스에 포함.
- 한국어가 들어 있는 문장을 한글 글꼴로 그리도록 공통 런타임 수정.
- Service의 한국어 정비 명칭·힌트 표시와 `2027년 9월`, `2027년 9월 15일`
  날짜 해석. 상세 화면에 `10개월 후`, `1개월 초과`, `이번 달` 표시.
- 차량 신호 이름, 제어 명령, 설정 키와 기본값은 원본과 동일.

이 소스 ZIP 자체는 차량에 설치하는 `.mgu` 파일이 아닙니다. SDK 없이 만든
`--preview-only` 출력도 PC 미리보기 전용이며 차량 설치 파일을 만들지 않습니다.

## 설치 파일 만들기

한국어 언어 태그는 `ko`, `ko-kr`, `ko-KR`, `ko_KR`를 지원합니다. 모두 같은 한국어
사전을 사용하고, 출력 패키지 이름과 미리보기 시작 로그에는 `ko`로 표시됩니다.
`--language`는 **빌드 명령**에 지정하세요. `preview.js`는 빌드된 언어를 그대로 읽습니다.

Python 3와 Node.js 14 이상이 필요합니다. 기존 프로젝트에 이미 필요한 도구입니다.
생성된 글꼴이 들어 있으므로 일반 빌드에 Pillow나 별도 글꼴 다운로드는 필요 없습니다.

1. 이 폴더에 소유 차량에서 추출한 SDK를 넣습니다.

   ```text
   idrive7-apps/
     oap-sdk/
       index.js
       package.json
     apps/
     kit/
   ```

2. 이 폴더에서 아래 명령을 실행합니다. macOS/Linux에서 `python`이 없으면
   `python3`를 사용하세요.

   ```sh
   python kit/tools/build.py --language ko redline service
   ```

   생성 파일:

   ```text
   dist/redline@1.11.2-ko.1.mgu
   dist/service@1.4.21-ko.1.mgu
   ```

3. 설치 도구·렌더러까지 들어 있는 Redline + Service 키트는 아래 명령으로 만듭니다.

   ```sh
   python kit/tools/make_kit.py --language ko redline service
   ```

   결과: `dist/mgu-custom-apps-ko.tar.gz`, `dist/mgu-custom-apps-ko/`.

다른 앱도 원본 ID를 뒤에 적으면 됩니다. 예:

```sh
python kit/tools/make_kit.py --language ko redline service car_vitals edrive warmup gforce
```

앱 이름을 생략하면 전체 16개 앱을 한국어로 빌드합니다.
AA Cluster Companion의 파일명은 `aa_cluster_companion@0.3.5-ko.1.mgu`입니다.
12V Battery만 빌드하려면 `python kit/tools/build.py --language ko battery12v`를 실행하세요.
파일명은 `battery12v@1.5.3-ko.1.mgu`입니다.
Doom은 첫 빌드에 Freedoom 게임
데이터를 다운로드하므로 인터넷 연결이 필요합니다. 차량 설치·제거 방법과 요구되는
MGU 접근 환경은 원본 [README](README.md)와 [배포 안내](deploy/car/README.txt)를 따릅니다.
이 수정본은 실차에서 검증되지 않았습니다.

## SDK가 없을 때 미리보기

`preview.js`는 `dist/<앱>/source/javascript/kit/locale.json`에 기록된 빌드 언어로
화면을 그립니다. 한국어 사전이 소스에 있는 것만으로 영문 빌드가 한국어로 바뀌지는
않습니다. 아래 두 단계를 같은 소스 폴더에서 순서대로 실행하세요.

```sh
python kit/tools/build.py --language ko --preview-only redline service
node kit/tools/preview.js dist/redline preview/ko/redline render --set renderer=software
node kit/tools/preview.js dist/service preview/ko/service render --set renderer=software
```

`preview/ko/` 아래에 PNG가 생성됩니다. 차량 연결 오류를 알리는 `preview` 로그는
이 모드의 정상 동작입니다. 표시된 수치와 정비 항목은 데모 데이터입니다.

미리보기 시작 시 `[preview] UI language: ko`가 표시되는지 확인하세요. `en`이면
미리보기 대상 폴더가 영문 빌드입니다. `--language ko` 빌드를 다시 실행하고 같은
앱 경로로 미리보기를 실행하세요. 예를 들어 Redline을 빌드했다면 `dist/redline`을
지정해야 합니다. 인수 없이 실행한 `preview.js`의 기본 대상은 `dist/car_vitals`입니다.
기본 빌드(`python kit/tools/build.py` 등)를 나중에 실행하면 같은 `dist` 폴더가
영문으로 다시 만들어집니다. 로그의 `preview`, `subscribing signals` 같은 개발용
문구는 번역 대상이 아니며 실제 한글 여부는 생성된 PNG에서 확인하세요.

## 검증

```sh
python kit/tools/test_ko.py
python kit/tools/test_zh.py
node kit/tools/test_service.js
```

한국어 검사에서는 16개 앱의 메뉴, 번역 글자 누락, Service 한국어 날짜·명칭·깨진
입력의 대체 처리, 단위 유지, 소프트웨어 그리기와 GPU 명령 생성의 글자 폭을 확인합니다.
AA Cluster Companion의 지도 배율·카드 선택·적용·재시작은 메모리 데모로 검사하며,
실제 제어기에 보내는 숫자와 `shown`/`hidden` 값이 번역되지 않는지도 확인합니다.
기존 영어·중국어·러시아어 레이아웃과 Service 테스트도 통과했습니다.
실제 MGU의 HMI 문자열 전달, GPU 동작, 차량 신호 수신은 실차 검증이 필요합니다.

## 남는 원문과 표시 한계

- 차량별 고장 코드 설명 전체 데이터베이스와 외부 SGBD 설명은 별도 자료이며,
  한국어 사전에 없는 설명은 원문으로 표시합니다. 고장 코드 자체는 유지합니다.
- Doom 게임 본문의 이미지·게임 데이터는 변경하지 않았습니다.
- 한글은 번역에 필요한 글자와 일반 한글 집합을 포함합니다. 모든 유니코드 한글
  11,172자나 옛한글을 포함하는 것은 아닙니다. 차량의 정비 명칭에 글꼴로 그릴 수
  없는 글자 또는 이미 깨진 `?`가 들어오면 원본 앱의 항목 ID 기반 대체 이름을
  한국어로 표시합니다. 표시할 수 없는 상세 힌트는 생략됩니다.
- 통화 선택지는 원본 그대로입니다. KRW 등 기능 추가는 이 번역에 포함하지 않았습니다.
- 실행 중 언어 변경 메뉴는 없습니다. 한국어 `.mgu`로 교체 설치하는 방식입니다.

## 번역·글꼴 수정

문구를 바꾸려면 `kit/runtime/locales/ko.tsv`를 편집한 뒤:

```sh
python kit/tools/sync_locales.py ko
python kit/tools/bake_korean.py /path/to/NotoSansCJK-Regular.ttc
python kit/tools/test_ko.py
```

글꼴 재생성에는 Pillow가 필요합니다. 기본 글꼴 경로는 Debian/Ubuntu의
`fonts-noto-cjk` 패키지 위치이며 TTC의 한국어 면은 인덱스 1입니다.
한글 아틀라스 상한은 1024 × 3072이며, 숫자 전용 글꼴은 기존 것을 유지합니다.
글꼴 출처·SHA-256은 생성 JSON에, OFL 라이선스는
`kit/localization/fonts/OFL-NotoSansKR.txt`에 포함되어 있습니다.
