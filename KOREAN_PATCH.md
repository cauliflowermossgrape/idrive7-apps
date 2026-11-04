# MGU 앱 한글화 패치 다운로드·공유

전체 저장소 대신 아래 ZIP 링크를 공유하면 한글화 변경 파일만 전달할 수 있습니다.

**[한글화 패치 ZIP 다운로드](https://github.com/jaimeen77-cmyk/idrive7-apps/raw/refs/heads/main/github-upload-ko.zip)**

공유할 안내 페이지: https://github.com/jaimeen77-cmyk/idrive7-apps/blob/main/KOREAN_PATCH.md

## 포함 내용

- 한국어 번역 사전과 한글 글꼴, 글꼴 라이선스
- 공통 번역·빌드·미리보기 도구의 변경 파일
- Service 한국어 날짜 처리와 AA Cluster Companion 표시 문구 수정
- 사용자가 제공한 12V Battery 앱 소스 (`apps/Battery12v/`)와 한국어 화면·설정 문구
- 검사 도구와 한국어 안내서

**원본 프로젝트 전체, BMW `oap-sdk`, 설치용 `.mgu`는 포함하지 않습니다.**
AA Cluster Companion과 12V Battery를 포함한 16개 앱의 한국어 빌드에 사용합니다.
차량별 고장 설명 전체 데이터베이스와 Doom 게임 본문은 원문이 남아 있습니다.

## 적용할 원본 버전

원본 저장소: https://github.com/cauliflowermossgrape/idrive7-apps

기준 커밋: `10b0433220428cbe4bb247892ee94315a5695b4b` (`10b0433`).

다른 버전의 원본 소스에는 변경 내용을 비교해 병합해야 합니다. 패치 파일을 그대로
덮어쓰면 원본의 새로운 수정 내용이 이전 코드로 바뀔 수 있습니다.

## 적용과 빌드

1. 위 기준 버전의 원본 소스를 준비합니다.
2. 패치 ZIP의 압축을 풀고, 안의 `apps`, `kit`, README 등의 파일을 원본 프로젝트
   최상위 폴더에 합쳐서 덮어씁니다.
3. 설치 파일을 만들려면 소유 차량에서 추출한 `oap-sdk/index.js`와
   `oap-sdk/package.json`을 원본 프로젝트의 `oap-sdk` 폴더에 준비합니다.
4. 프로젝트 최상위 폴더에서 실행합니다.

```sh
python kit/tools/build.py --language ko
```

`dist`에 앱별 `-ko.1.mgu` 파일이 만들어집니다. `ko-kr`과 `ko-KR`도 지원합니다.
macOS/Linux에서 `python`이 없으면 `python3`를 사용하세요.

이전 패치의 `apps/battery12v/`가 남아 있다면 `apps/Battery12v/`로 교체하세요.
두 폴더를 동시에 두면 같은 앱이 중복 빌드됩니다.

## SDK 없이 한국어 화면 확인

```sh
python kit/tools/build.py --language ko --preview-only redline service aa_cluster_companion
node kit/tools/preview.js dist/redline preview/ko/redline render --set renderer=software
node kit/tools/preview.js dist/service preview/ko/service render --set renderer=software
node kit/tools/preview.js dist/aa_cluster_companion preview/ko/aa render --set renderer=software
```

이 모드는 설치용 `.mgu`를 만들지 않습니다. 시작 로그의 `UI language: ko`와 생성된
PNG를 확인하세요. 숫자와 차량 상태는 데모 데이터이며 실차 설치·통신 검증과는 별개입니다.

검사 명령과 자세한 설명은 [한국어 안내](README.ko.md)를 참고하세요.
