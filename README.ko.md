# SmartThings 가상 기기 콘솔

[English](README.md) | **한국어**

![screenshot](docs/screenshot.png)

SmartThings CLI(`smartthings`)를 감싼 로컬 GUI입니다. 브라우저에서 가상 기기를 만들고, capability 속성 값을 골라 이벤트(상태)를 주입하고, 여러 이벤트를 순서대로 재생하는 시나리오를 돌릴 수 있습니다.

- 외부 npm 의존성이 없습니다. Node만 있으면 됩니다.
- 서버는 `127.0.0.1` 에만 열리고, 다른 사이트에서 오는 요청(Origin)은 막습니다.
- 쓰기 작업(이벤트 주입, 이름 변경, 삭제)은 가상 기기에만 허용됩니다.
- 시작하면 기본 브라우저가 자동으로 열립니다 (`--no-open` 또는 `ST_NO_OPEN` 으로 끔).
- UI가 실행한 CLI 명령이 하단 **CLI 명령 로그**에 그대로 남아서, 스크립트로 옮길 때 복사해 쓸 수 있습니다.

## 준비

1. **Node.js** 설치 (최신 CLI 3.x는 Node 24 이상을 요구합니다)
2. **SmartThings CLI** 설치

   ```bash
   npm install -g @smartthings/cli
   # 또는 Homebrew
   brew install smartthingscommunity/smartthings/smartthings
   smartthings --version
   ```

3. **인증** (둘 중 하나)
   - 브라우저 로그인: 아무 명령이나 처음 실행하면 CLI가 로그인 창을 엽니다. 미리 해두려면 `smartthings locations` 를 한 번 실행하세요.
   - PAT(개인 액세스 토큰): https://account.smartthings.com/tokens 에서 발급 후 아래처럼 환경변수로 넘깁니다. 권한은 최소 `Devices`(읽기/쓰기/실행), `Locations`(읽기) 가 필요합니다.

     ```bash
     export SMARTTHINGS_TOKEN=xxxxxxxx-xxxx-...
     ```

## 실행

```bash
# 설치 없이 바로 실행
npx --yes github:Twohyunpa/SmartThings_Virtual

# 또는 저장소를 받아서 실행 (Windows/macOS/Linux 공통)
git clone https://github.com/Twohyunpa/SmartThings_Virtual.git
cd SmartThings_Virtual
npm start            # 또는 node server.js
# → http://127.0.0.1:3700 을 브라우저로 엽니다
```

Windows PowerShell 에서 환경변수는 `$env:SMARTTHINGS_TOKEN="..."; npm start` 형식으로 지정합니다.

SmartThings 계정 없이 UI만 먼저 보고 싶으면 모의 CLI로 실행하세요.

```bash
npm run mock
```

자동 테스트 실행 (가짜 CLI 사용, 계정 필요 없음):

```bash
npm test
```

### 환경변수

| 변수 | 기본값 | 설명 |
| --- | --- | --- |
| `PORT` | `3700` | 웹 서버 포트 |
| `ST_CLI` | `smartthings` | CLI 실행 파일 경로. `.js` 로 끝나면 `node` 로 실행 |
| `ST_PROFILE` | `default` | CLI 설정 프로필 (`~/.config/@smartthings/cli/config.yaml`). UI 상단에서도 바꿀 수 있음 |
| `SMARTTHINGS_TOKEN` | – | PAT. 지정하면 브라우저 로그인 없이 사용 |
| `ST_NO_OPEN` | – | 값이 있으면 시작할 때 브라우저를 자동으로 열지 않음 (`--no-open` 인자도 동일) |
| `ST_CLI_TIMEOUT_MS` | `120000` | CLI 명령 하나의 최대 실행 시간 |
| `ST_CLI_CONCURRENCY` | `5` | 동시에 실행하는 CLI 명령 최대 개수 |

## 기능

**가상 기기 만들기**
**New virtual device** 패널의 탭 5개에는 각각 무엇을 하는 탭이고 언제 쓰는지 짧은 설명이 붙어 있습니다.

- Appliance templates: 세탁기, 건조기, 식기세척기, 에어컨, 공기청정기, 냉장고, 로봇청소기, 오븐, TV 등 실제 모델 35종. 프로필 정의(JSON)를 열어서 capability를 더하거나 뺄 수 있습니다.
- Matter devices: Matter 1.0~1.5의 대표 기기 36종(조명, 플러그, 버튼, 각종 센서, 도어락, 온도조절기, 블라인드, TV, 에어컨, 선풍기, 공기청정기, 화재/CO 경보기, 로봇청소기, 세탁기, 건조기, 식기세척기, 냉장고, 오븐, 쿡탑, 후드, 전자레인지, 누수 센서, 전기차 충전기, 태양광, 가정용 배터리, 히트펌프, 온수기, 카메라/도어벨, 차고문/게이트, 토양 센서). 분류와 Matter 버전으로 거를 수 있고, 각 capability가 어떤 Matter 클러스터에 해당하는지 표로 보여줍니다. 아래 [Matter 기기](#matter-기기) 참고.
- 표준 프로토타입: `VIRTUAL_SWITCH`, `VIRTUAL_MOTION_SENSOR` 등 17종 (`virtualdevices:create-standard`)
- 내 디바이스 프로필 ID로 만들기, 또는 프로필 JSON 직접 입력 (`virtualdevices:create`)
- dry-run 버튼으로 실제 생성 없이 요청 JSON을 확인할 수 있습니다.

**상태 & 주입**
- 왼쪽은 capability 목록(현재 값 표시, 필터), 오른쪽은 선택한 capability의 상세입니다. 맨 위에는 한 줄 상태 요약 바가 있고, 누르면 해당 capability로 이동합니다.
- **Custom event**(component/capability/attribute/value/unit 직접 입력)는 오른쪽 맨 위에 항상 있습니다.
- 자주 쓰는 capability는 별표(☆/★)로 고정하세요. 목록 맨 위 *Pinned* 그룹으로 올라가고, Custom event 바로 아래에 항상 펼쳐집니다. 마지막 선택과 고정 목록은 기기별로 기억됩니다.
- 기기의 component/capability 별로 속성과 현재 값이 표시됩니다.
- capability 정의를 읽어 컨트롤을 자동으로 만듭니다: enum은 칩(누르면 바로 주입), 숫자는 슬라이더/입력 + 단위, 배열/객체는 JSON 입력.
- 짝이 되는 `supported*` / `available*` 목록이 있는 값(예: `fanMode` ↔ `supportedAcFanModes` / `availableAcFanModes`)은 기기의 **현재** 목록으로 채운 드롭다운이 되고, 목록 자체는 체크박스로 고릅니다. 옵션은 기기 상태를 따라가므로 supported 목록을 새로 주입하면 드롭다운도 바뀝니다. 목록에 없는 값을 일부러 넣으려면 **Custom value…**(또는 **Edit as JSON**)을 쓰세요. `available*`에 없는 값은 ⚠ 로 표시됩니다.
- `supported*` / `available*` 목록은 체크박스 목록으로 편집합니다. 새 값은 입력 후 **Enter** 또는 **Add**, 그리고 **Inject**. 입력창에 남아 있는 값도 주입할 때 포함됩니다.
- `supported*` / `available*` 속성 옆 **ⓘ** 버튼이 차이를 설명합니다: `supported*`는 기기가 할 수 있는 전체, `available*`는 지금(현재 모드에서) 고를 수 있는 부분집합입니다.
- 5초 자동 새로고침.

**프리셋 & 시나리오**
- 템플릿 프리셋(예: 세탁 시작 → 헹굼 → 탈수 → 완료)이 기기 capability와 맞으면 자동으로 보입니다.
- 상태 탭의 ＋ 버튼으로 단계를 모아 시나리오를 만들고, 단계별 대기 시간(ms)과 반복 실행을 설정할 수 있습니다.
- 시나리오는 브라우저(localStorage)에 저장되고 JSON으로 가져오기/내보내기가 됩니다.

**계정**: 오른쪽 위 계정 메뉴에 CLI가 로그인한 SmartThings 계정(기본 조직 이름과 로케이션. SmartThings에는 이메일을 돌려주는 공개 API가 없습니다)과 로그인 방식(브라우저 로그인, `SMARTTHINGS_TOKEN`, CLI 프로필 토큰)이 표시됩니다.
- **Log out**: `smartthings logout`을 실행해 현재 프로필의 CLI 로그인 정보를 지웁니다. 기기는 그대로입니다.
- **Switch account**: 로그아웃한 뒤 새 브라우저 로그인을 시작합니다. 브라우저가 같은 계정으로 바로 다시 로그인되면, 그 페이지(또는 account.samsung.com)에서 삼성 계정을 로그아웃한 뒤 다시 시도하세요.
- `SMARTTHINGS_TOKEN`(또는 `config.yaml`의 토큰)을 쓰는 경우 토큰이 계정을 결정하므로 버튼이 비활성화됩니다. 다른 토큰으로 다시 실행하세요.
- 로그아웃 상태에서는 앱이 스스로 로그인 창을 띄우지 않고 **Sign in** 버튼을 보여줍니다.

**기타**: 이름 변경, 삭제, 원본 JSON(`devices`, `devices:status`) 보기, CLI 명령 로그(클릭하면 복사).

**오류 처리**: CLI 명령이 실패하면 UI에 알기 쉬운 메시지가 뜨고 터미널에도 `[cli failed] ...`로 출력됩니다. 예상치 못한 오류가 나도 서버는 계속 돌아가고, 3700 포트가 이미 쓰이고 있으면 알려 줍니다(`PORT=3800 npm start`로 다른 포트에서 실행).

## 템플릿 출처

삼성 가전 템플릿은 임의로 만든 것이 아니라 [Home Assistant](https://github.com/home-assistant/core)의 SmartThings 테스트 데이터(`tests/components/smartthings/fixtures`, Apache-2.0, [NOTICE](NOTICE) 참고)에서 생성합니다. 실제 삼성 가전에서 덤프한 데이터이고, `tools/build-templates.py`가 모델별 capability 목록과 샘플 속성 값을 추출합니다. **표준 capability만** 사용하고, `custom.*`/`samsungce.*` 같은 삼성 전용 capability는 의도적으로 제외했습니다. 자세한 내용은 영어 [README](README.md) 참고.

## Matter 기기

SmartThings는 Matter 1.5까지 지원합니다. 실제 Matter 기기를 추가하면 SmartThings Matter 드라이버가 **표준 capability**로 된 프로필을 붙입니다(On/Off 클러스터 → `switch`, Level Control → `switchLevel`, Door Lock → `lock` 등). **Matter devices** 탭은 같은 프로필로 가상 기기를 만들어서, 앱·자동화·API 연동에서 실제 Matter 기기와 똑같이 보이게 합니다.

- 프로필은 [SmartThings 공식 Matter Edge 드라이버](https://github.com/SmartThingsCommunity/SmartThingsEdgeDrivers)(Apache-2.0, [NOTICE](NOTICE) 참고)에서 `tools/build-matter-templates.py`로 가져옵니다.
- `firmwareUpdate`, 명령 전용 `stateless*`, 카메라 영상 관련 capability, `vision.*` 같은 전용 capability는 뺐습니다.
- 만들면 기본 상태가 들어가고(예: 조명 70%, 도어락 잠김), *Lock: forced opening attempt*, *Alarm: smoke detected*, *Cycle: running* 같은 프리셋을 쓸 수 있습니다. 기기 목록에는 **Matter** 표시가 붙습니다.

**한계:** 클라우드 가상 기기라서 페어링(QR 코드), Matter 클러스터·엔드포인트·통신은 없고 카메라 영상도 나오지 않습니다. Matter 통신 자체를 테스트하려면 SmartThings 허브와 실제 기기 또는 삼성 [Matter Virtual Device](https://developer.samsung.com/smartthings/blog/en/2023/12/14/creating-a-matter-virtual-device)를 쓰세요.

`operationalState`, `evseState` 같은 최신 capability는 계정에 따라 가상 기기에서 거부될 수 있습니다. `npm run check-capabilities`를 한 번 실행하면 안 되는 capability와 그걸 쓰는 템플릿을 알려줍니다. 그 capability를 프로필 정의에서 빼고 만들면 됩니다.

## 사용하는 CLI 명령

| 동작 | 명령 |
| --- | --- |
| 위치/방 목록 | `smartthings locations`, `smartthings locations:rooms -l <locationId>` |
| 가상 기기 목록 | `smartthings virtualdevices [-l <locationId>]` |
| 기기 정보/상태 | `smartthings devices <id>`, `smartthings devices:status <id>` |
| capability 정의 | `smartthings capabilities <id> --capability-version 1` (CLI 1.x는 `capabilities <id> 1`) |
| 생성 | `smartthings virtualdevices:create-standard -i input.json`, `smartthings virtualdevices:create -i input.json` |
| 이벤트 주입 | `smartthings virtualdevices:events <id> -i input.json` |
| 이름 변경/삭제 | `smartthings virtualdevices:update <id> -i input.json`, `smartthings virtualdevices:delete <id>` |
| 계정 | `smartthings organizations`, `smartthings logout` (로그인: 아무 명령, 예: `smartthings locations` 실행 시 브라우저 로그인이 열림) |

모든 명령에 `--json` 을 붙여 결과를 파싱합니다. CLI 1.10.x와 3.x 둘 다 동작하도록 버전을 감지해 인자를 맞춥니다.

## 알아둘 점

- 삼성 가전 템플릿은 SmartThings 표준 capability만 씁니다. 실제 삼성 가전이 쓰는 `samsungce.*` 같은 전용 capability가 필요하면 템플릿 JSON에 추가해 보세요. 계정 권한에 따라 가상 기기에서 거부될 수 있습니다.
- 가상 기기는 실제 SmartThings 계정의 선택한 위치에 만들어지고, SmartThings 앱과 자동화(루틴)에도 그대로 보입니다.
- 이벤트 주입은 클라우드 가상 기기 기준입니다. 허브에서 로컬 실행하는 가상 기기(`--local`)는 이 UI에서 만들지 않습니다.

## 라이선스

MIT. 자세한 내용은 [LICENSE](LICENSE) 참고.
