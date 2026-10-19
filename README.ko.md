# omp-slack-bridge

[English](README.md) · **한국어**

![omp-slack-bridge: Slack DM 하나, 여러 OMP / Paseo 에이전트, 에이전트마다 스레드 하나](media/banner.png)

[Pi 에이전트 하니스(harness)](https://github.com/earendil-works/pi-coding-agent)의 터미널 세션을 Socket Mode로 Slack에 연결하는 **pi 확장 프로그램**입니다. Socket Mode는 브리지가 Slack으로 연결을 직접 여는 방식입니다.

이 프로젝트는 [tintinweb/pi-messenger-bridge](https://github.com/tintinweb/pi-messenger-bridge)의 포크(fork)이며, 오직 Slack 연동에만 집중합니다. 정해진 사용 방식을 따르는(opinionated) 편의(Quality-of-Life) 기능을 제공합니다. 예를 들면 [Slack Block Kit API](https://docs.slack.dev/reference/block-kit/blocks/markdown-block/)를 이용한 Markdown 서식, tmux 기반 세션 관리(새 Pi 세션 만들기 또는 이전 Pi 세션으로 전환) 등이 있습니다.

주요 기능 요약:
- Slack에서 pi로 메시지를 보내고 응답을 받습니다.
- 결정적(deterministic) 원격 명령을 실행합니다(pi 터미널에서는 `/slk-bridge ...`, Slack DM에서는 `.bridge ...`). 결정적 명령은 LLM 호출 없이 실행되는 명령입니다.
- Slack과 pi 사이에서 파일을 업로드하고 다운로드합니다.
- **Slack DM 하나에서 여러 세션을 동시에 사용합니다.** 참여(join)한 세션마다 고유한 스레드가 있습니다. 답장은 그 스레드를 소유한 세션으로 전달됩니다. 이 라우팅(routing, 메시지를 알맞은 세션으로 보내는 일)에는 LLM이 관여하지 않습니다. ([멀티 세션 아키텍처](#멀티-세션-아키텍처) 참고)
- 세션을 전환하고, 새 세션을 만들고, 활성 터미널 세션을 Slack으로 넘깁니다(핸드오버, handover).
- 세션 메시지 리플레이(replay): 세션을 재개하면 이전 대화 기록을 Slack 스레드에 다시 게시합니다.
- 세션이 Slack 연결을 자동으로 차지하지 않도록 제외할 수 있습니다(opt-out).

## 이 포크에 대하여

이 저장소는 [comsysto/pi-slack-bridge](https://github.com/comsysto/pi-slack-bridge)(버전 0.3.0)의 **OMP / Paseo 멀티 세션 포크**입니다. comsysto/pi-slack-bridge는 그 자체가 [tintinweb/pi-messenger-bridge](https://github.com/tintinweb/pi-messenger-bridge)의 Slack 전용 포크입니다. 이 저장소는 수정하지 않은 업스트림(upstream, 원본 프로젝트) 설치본이 아닙니다. 원본 브리지, Slack Block Kit 서식, 챌린지 인증, tmux 세션 관리에 대한 모든 공로는 [감사의 말](#감사의-말)에 나열한 업스트림 작성자들에게 있습니다. 코드는 원래의 **MIT** 라이선스를 그대로 따릅니다. 코드를 복사하거나 재배포할 때는 [LICENSE](LICENSE)의 저작권 고지를 유지하세요.

이 포크에서 바뀐 점:

- **멀티 세션 사용.** 여러 OMP 세션이 같은 Slack DM을 동시에 사용할 수 있습니다. 세션마다 스레드 하나를 씁니다. 예를 들어 여러 [Paseo](#omp--paseo-참고-사항) 에이전트가 각자 자기 `omp` 프로세스에서 실행되는 경우입니다. 업스트림은 한 번에 세션 하나만 Slack에 연결하고, 가장 마지막에 사용한 세션에 그 연결을 넘깁니다.
- **OMP 연동.** 빌드된 확장 프로그램은 `~/.omp/agent/extensions/pi-slack-bridge.ts`를 통해 로드됩니다. 상태(state)는 `~/.omp/agent/` 아래에 저장됩니다. OMP `ask` 질문은 세션의 Slack 스레드에도 똑같이 표시됩니다(미러링).
- **더 안전한 공유 상태.** 이제 여러 프로세스가 `slk-bridge.json`을 공유합니다. 그래서 이 파일에 쓰는 모든 작업은 프로세스 간에 잠기고 원자적(atomic)입니다. 원자적이란 쓰기가 중간 상태 없이 한 번에 반영된다는 뜻입니다.

## 멀티 세션 아키텍처

Slack Socket Mode는 앱 토큰 하나당 열려 있는 연결 중 **정확히 하나**에만 각 이벤트를 전달합니다. 그래서 한 컴퓨터에서 이 연결을 가질 수 있는 프로세스는 하나뿐입니다. 이 프로세스를 **라우터**(router)라고 부릅니다. 라우터는 Slack 연결을 가지고, 받은 메시지를 알맞은 세션에 전달합니다. 그 밖의 모든 것은 로컬 디스크의 일반 파일 입출력(file I/O)으로 처리합니다.

```mermaid
flowchart LR
    Slack[("Slack DM<br/>세션마다 스레드 하나")]
    subgraph Host["한 대의 컴퓨터 - ~/.omp/agent/"]
        R["라우터 세션<br/>slk-bridge.lock 소유<br/>Socket Mode 연결 유지"]
        A["세션 A<br/>참여 중"]
        B["세션 B<br/>참여 중"]
        REG[("slk-bridge-sessions/<br/>참여한 세션마다 파일 하나")]
        IN[("slk-bridge-inbox/SHA1/<br/>대기 중인 메시지마다 파일 하나")]
        CFG[("slk-bridge.json<br/>토큰, 스레드와 세션의 매핑, 참여 목록")]
    end
    Slack -- "이벤트 (Socket Mode)" --> R
    R -- "B의 스레드에 온 답장 (B가 실행 중)" --> IN
    IN -- "B가 500 ms마다 확인(폴링)" --> B
    R -. "소유자가 실행 중인가?" .-> REG
    R -. "이 스레드의 소유자는 누구인가?" .-> CFG
    A -- "메시지, 리액션, 파일 (봇 토큰만 사용)" --> Slack
    B -- "메시지, 리액션, 파일 (봇 토큰만 사용)" --> Slack
    R -- "라우터 자신의 세션도 동일" --> Slack
```

- **참여 / 나가기.** `/slk-bridge connect`는 현재 세션을 *참여*시킵니다. 이 명령은 세션을 등록합니다. 같은 세션의 프로세스를 다시 시작하면 시작할 때 다시 참여하도록, 참여 사실을 `slk-bridge.json`에 기억해 둡니다. 또 페어링된 DM(인증을 마친 Slack 사용자와의 DM)에 세션의 루트 메시지(스레드의 첫 메시지)를 게시하거나, 이미 있으면 재사용합니다. 그리고 **살아 있는 라우터가 없을 때만** 라우터가 됩니다. `/slk-bridge disconnect`는 *나가기*입니다. 세션 등록을 해제하고, 참여 기록을 지우고, 대기 중인 메시지를 삭제합니다. 이 세션이 라우터 역할이나 소켓을 가지고 있으면 함께 놓습니다.
- **라우터 선출(election).** 잠금 파일 `slk-bridge.lock`이 여전히 유일한 보호 장치입니다. 참여한 세션은 모두 약 2초마다 확인합니다. 잠금을 가진 살아 있는 프로세스가 없으면, 그 세션이 잠금을 획득하고 소켓을 엽니다. (죽은 소유자의 잠금은 PID(프로세스 ID) 확인으로 정리됩니다.) 잠금 획득은 배타적 생성(exclusive create)입니다. 파일이 이미 있으면 생성이 실패합니다. 그래서 동시에 시도한 세션이 둘 다 성공할 수 없습니다. 참여하는 것만으로는 살아 있는 라우터의 역할을 가져오지 않습니다. 그 역할은 `/slk-bridge router`로 명시적으로 가져옵니다. 잠금을 잃은 라우터는 약 250 ms 안에 소켓을 닫습니다. 잠금을 잃는 경우는 다른 세션이 가져갔을 때, 또는 로컬 플래그가 해제되었을 때입니다.
- **레지스트리(registry).** 참여한 세션마다 `slk-bridge-sessions/<sha1(sessionPath)>.json` 파일이 하나씩 있습니다. 이 파일에는 다음 항목이 들어 있습니다: `{sessionPath, pid, instanceId, updatedAt}`. 해당 PID가 살아 있는 동안 그 세션은 실행 중으로 봅니다. 참여한 세션은 자기 기록이 사라지면 다시 만듭니다. (생존 여부는 PID 확인으로만 판단합니다. 그래서 비정상 종료한 세션의 PID를 운영 체제가 다른 프로그램에 다시 배정하면, 그 세션은 다시 시작하거나 나갈 때까지 살아 있는 것처럼 보입니다.)
- **라우팅(routing).** 라우터가 받은 모든 메시지는 평소처럼 신뢰 사용자 필터링을 거칩니다. 그 뒤에 다음 표대로 처리합니다.

  | 메시지 | 처리하는 쪽 |
  | --- | --- |
  | 라우터 자신의 세션이 소유한 스레드에 단 답장 | 라우터 세션 |
  | **살아 있는 다른** 세션이 소유한 스레드에 단 답장 | 그 세션이 받은편지함(inbox)을 통해 처리합니다. 받은편지함 파일은 `slk-bridge-inbox/<sha1>/<ms>-<id>.json`입니다. 원자적으로 기록하고, 약 500 ms마다 폴링하고, 읽으면 삭제하고, `chat:ts`로 중복을 제거합니다. |
  | **실행 중이 아닌** 세션이 소유한 스레드에 단 답장 | 아무도 처리하지 않습니다. 대신 라우터가 그 스레드에 이렇게 답합니다. *"이 스레드의 세션이 꺼져 있습니다. Paseo에서 해당 에이전트를 열면 다시 연결됩니다."* |
  | 최상위 DM 메시지(스레드 밖에 쓴 메시지), 또는 아무도 소유하지 않은 스레드에 단 답장 | 라우터 세션. 그 스레드는 이후 라우터 세션이 소유합니다. |
  | `.bridge resume ...` | 라우터. 어디에 쓰든 마찬가지입니다. |

- **게시에는 소켓이 필요 없습니다.** 답장, ⏳ 리액션, 파일 업로드, 미러링된 답변, 질문/승인 알림은 봇 토큰(`@slack/web-api`)만 사용합니다. 그래서 참여한 세션은 라우터이든 아니든 게시할 수 있습니다. 참여하지 않은 세션은 아무것도 게시하지 않습니다.
- **오래된 메시지.** 대기 중인 메시지가 10분을 넘기면 읽을 때 버립니다. 그래서 늦게 다시 시작한 세션이 오래된 지시를 실행하는 일은 없습니다.

### `autoConnect`

`autoConnect`(기본값 **켜짐**)는 **참여한** 세션이 비어 있는 라우터 역할을 스스로 맡을지만 결정합니다. 이 판단은 세션을 시작할 때와 2초마다 하는 확인 때 이루어집니다. 이 설정은 아무것도 참여시키지 않습니다. 그리고 `connect` / `disconnect`는 더 이상 이 설정을 바꾸지 않습니다. 명시적으로 `/slk-bridge connect`를 실행하면, 살아 있는 라우터가 없을 때 라우터 역할을 맡습니다. `/slk-bridge router`는 살아 있는 라우터에게서도 그 역할을 가져옵니다. `autoConnect`를 끄면, 또는 `/slk-bridge optout`을 실행한 세션에서는, 사라진 라우터를 자동으로 대체하지 않습니다. 이 경우 누군가 `/slk-bridge connect` 또는 `/slk-bridge router`를 실행할 때까지 아무도 Slack에서 메시지를 받지 못합니다. `/slk-bridge autoconnect`로 이 설정을 켜고 끌 수 있습니다.

### 참여 관련 명령

| 명령 | 효과 |
| --- | --- |
| `/slk-bridge connect` | 이 세션을 참여시킵니다. 세션 파일이 필요하므로, 완전히 새로운 세션에서는 먼저 메시지를 보내야 합니다. 살아 있는 라우터가 없으면 이 세션이 라우터가 됩니다. |
| `/slk-bridge disconnect` | 나갑니다. 라우터 역할과 소켓을 가지고 있으면 놓습니다. |
| `/slk-bridge router` | 현재 라우터에게서 라우터 역할을 가져옵니다. 필요하면 먼저 참여합니다. 기존 라우터가 소켓을 닫은 뒤에 이 세션이 연결합니다. |
| `/slk-bridge status` | 참여 여부, 라우터가 누구인지, 이 프로세스가 소켓을 열고 있는지, `autoConnect` 값을 보여 줍니다. |
| `/slk-bridge autoconnect` | 참여한 세션이 라우터 역할을 자동으로 맡는 기능을 켜거나 끕니다. |
| `/slk-bridge optout` / `optin` | 이 세션이 라우터 역할을 자동으로 맡지 않게 합니다(`optout`). 다시 자동으로 맡게 합니다(`optin`). |
| `.bridge status` / `connect` / `disconnect` (Slack) | 위 명령과 같은 동작을 합니다. 메시지를 쓴 스레드를 소유한 세션에 적용됩니다. `.bridge disconnect`는 먼저 확인 메시지를 보낸 다음 나갑니다. |

`/slk-bridge handover`도 세션을 참여시킵니다. 이때는 별도의 루트 메시지를 게시하지 않습니다. 핸드오버가 스레드를 열기 때문입니다.

### OMP / Paseo 참고 사항

- OMP는 빌드된 확장 프로그램을 `~/.omp/agent/extensions/pi-slack-bridge.ts`로 로드합니다. 이 파일은 `dist/bridge/index.js`를 다시 내보냅니다(re-export). 소스를 바꾼 뒤에는 `npm run build`로 다시 빌드하세요. **새** OMP 세션은 새 빌드를 사용합니다. 이미 실행 중인 세션은 로드한 코드를 그대로 유지합니다.
- Paseo 에이전트는 각각 독립된 `omp` 프로세스입니다. Slack에서 쓰려는 에이전트마다 `/slk-bridge connect`를 한 번 실행하세요. 참여 기록은 세션 파일 단위로 저장됩니다. 그래서 Paseo에서 에이전트를 다시 열면 자동으로 다시 참여합니다. 프로세스 안의 서브에이전트(subagent)는 참여하지 않습니다.
- OMP `ask` 질문은 일반 앱 UI와 세션의 Slack 스레드에 모두 나타납니다. 그 스레드에서 선택지 번호, 선택지의 정확한 이름(label), 또는 자유 텍스트로 답하세요. 질문이 여러 개이면 질문마다 `question-id: answer` 형식으로 한 줄씩 쓰세요. 먼저 도착한 명시적 답변이 채택되고, 다른 쪽 대화 상자는 취소됩니다. 이미 끝난 질문에 늦게 보낸 답장은 새 턴(turn, 에이전트가 한 번 응답하는 단위)을 시작하지 않습니다. 취소하거나 답변이 없는 것은 승인이 아닙니다.
- OMP/Paseo 자체(native) 도구 권한 요청은 Slack에 알림을 보낼 수 있습니다. 하지만 승인은 Paseo/OMP 안에서만 이루어집니다. Slack 답장으로는 도구 권한을 우회할 수 없습니다.
- 새 질문 알림은 설정된 신뢰 사용자만 멘션합니다. 휴대폰 푸시 알림이 오는지는 Slack과 OS의 알림 설정에 달려 있습니다. 로컬 알림과 최종 답변에는 프롬프트 미리보기 푸터(footer)가 붙지 않습니다.
- 업스트림의 tmux/Pi 세션 생성 명령은 지원하는 Windows/Paseo 워크플로가 아닙니다. 세션을 만들고 전환할 때는 Paseo를 사용하세요.
- 이미 설정된 채널/사용자 인가(authorization)를 그대로 재사용합니다. 이 설정이 파일 전송 스코프(scope, Slack 앱에 부여하는 권한 범위)를 활성화하지는 않습니다. 선택 사항인 Slack 사용자/채널 메타데이터 스코프는 텍스트로 질문에 답하는 데 필요하지 않습니다.

## 설치 및 설정

### 1. 설치

```bash
pi install npm:pi-slack-bridge
```

또는 로컬 경로에서 설치합니다:

```bash
pi install /path/to/pi-slack-bridge
```

OMP에서는 다음 순서로 설치합니다. 먼저 이 포크를 `~/.omp/agent/pi-slack-bridge`에 클론합니다(`git clone https://github.com/ChanwooKim01/omp-slack-bridge.git ~/.omp/agent/pi-slack-bridge`). 그다음 빌드합니다(`npm install && npm run build`). 마지막으로 `~/.omp/agent/extensions/pi-slack-bridge.ts` 파일을 만듭니다. 이 파일의 내용은 다음과 같습니다: `export { default } from "../pi-slack-bridge/dist/bridge/index.js";`

### 2. Slack 앱 만들기

**Socket Mode**를 켠 Slack 앱과 토큰 두 개가 필요합니다. 하나는 **Bot Token**(`xoxb-...`)이고, 다른 하나는 **App-Level Token**(`xapp-...`)입니다. Socket Mode에서는 브리지가 Slack으로 나가는 연결을 직접 엽니다. 그래서 공개 URL, 서버, 포트 포워딩(port forwarding)이 필요 없습니다.

#### 빠른 방법: 매니페스트로 앱 만들기

1. <https://api.slack.com/apps>를 열고 **Create New App**을 클릭합니다.
2. **From a manifest**를 선택하고 워크스페이스를 고릅니다.
3. **YAML** 탭을 선택합니다. 내용을 아래 매니페스트(앱 설정을 적은 YAML 문서)로 바꾸고 **Next** → **Create** 순서로 클릭합니다.

   ```yaml
   display_information:
     name: oh-my-pi
     description: Talk to your OMP / Paseo agents from Slack, one thread per session
     background_color: "#1e1b4b"
   features:
     app_home:
       home_tab_enabled: false
       messages_tab_enabled: true
       messages_tab_read_only_enabled: false
     bot_user:
       display_name: oh-my-pi
       always_online: true
   oauth_config:
     scopes:
       bot:
         - chat:write
         - reactions:write
         - im:history
         - im:write
         - files:read
         - files:write
   settings:
     event_subscriptions:
       bot_events:
         - message.im
     interactivity:
       is_enabled: false
     org_deploy_enabled: false
     socket_mode_enabled: true
     token_rotation_enabled: false
   ```

   `oh-my-pi`는 이름을 바꿔도 됩니다. Slack과 에이전트 사이에서 파일을 전혀 주고받지 않는다면 `files:read` / `files:write`를 빼세요.
4. **App-Level Token.** **Settings → Basic Information → App-Level Tokens**에서 **Generate Token and Scopes**를 클릭합니다. 이름은 아무거나 정해도 됩니다. 스코프 `connections:write`를 추가하고 **Generate**를 클릭한 뒤, `xapp-...` 토큰을 복사합니다.
5. **Bot Token.** **Settings → Install App**에서 **Install to Workspace** → **Allow** 순서로 클릭합니다. **Bot User OAuth Token**(`xoxb-...`)을 복사합니다.
6. **아이콘(선택 사항).** **Settings → Basic Information → Display Information**에서 [`media/icon-512.png`](media/icon-512.png)를 앱 아이콘으로 업로드합니다.

#### 수동 방법

설정 화면을 직접 하나씩 클릭하며 설정하고 싶거나, 이미 있는 앱을 고치는 경우에는 다음 순서를 따릅니다:

1. **Settings → Socket Mode:** **Enable Socket Mode**를 켭니다. Slack이 `connections:write` 스코프가 있는 App-Level Token을 요구합니다. 토큰을 만들고 `xapp-...` 토큰을 복사합니다.
2. **Features → App Home:** **Messages Tab**을 켜고 **Allow users to send Slash commands and messages from the messages tab**을 체크합니다. 이렇게 하지 않으면 봇에게 DM을 보낼 수 없습니다.
3. **Features → Event Subscriptions:** **Enable Events**를 켜고 **Subscribe to bot events**를 펼친 뒤, 다음을 추가합니다:
   - `message.im` — 다이렉트 메시지(지원하는 설정)
   - `message.channels` — 공개 채널(`/enable`로 채널을 활성화하는 경우에만)
   - `message.groups` — 비공개 채널(조건은 위와 같음)
4. **Features → OAuth & Permissions → Bot Token Scopes:** 아래 표의 스코프를 추가합니다.
5. **Settings → Install App:** 앱을 설치합니다. 스코프나 이벤트를 바꾼 뒤에는 **다시 설치**합니다. 그리고 `xoxb-...` 토큰을 복사합니다.

> 스코프나 이벤트를 바꾸면 Slack이 노란색 "reinstall your app" 배너를 보여 줍니다. 변경 사항은 다시 설치한 뒤에야 적용됩니다.

#### Bot Token 스코프

(위치: `Features > OAuth & Permissions`)

| 스코프 | 필요한 기능 |
| --- | --- |
| `chat:write` | 모든 답장, 알림, 스레드 루트 메시지 게시 |
| `reactions:write` | 프롬프트를 처리하는 동안 표시하는 ⏳ 리액션 |
| `im:history` | DM 수신(`message.im`) |
| `im:write` | 봇의 DM 채널 접근(`chat:write`와 함께 사용하기를 권장) |
| `channels:history`, `groups:history` | 채널 메시지 수신(`message.channels` / `message.groups`). DM만 쓰는 설정에서는 생략합니다 |
| `files:write` | Slack으로 파일 업로드(`send_slack_file`, `/slk-bridge sendfile`). 업로드를 쓸 때만 필요합니다 |
| `files:read` | 사용자가 pi로 보낸 파일 다운로드. 다운로드를 쓸 때만 필요합니다 |
| `im:read` | 선택 사항: 세션 관리를 위한 DM 메타데이터(`D`로 시작하는 채널 ID는 이 스코프 없이도 인식합니다) |
| `users:read` | 선택 사항: 사용자 ID 대신 표시 이름 표시 |

### 3. 브리지에 토큰 전달하기

대화형 메뉴로 Slack Bridge를 설정합니다:

```bash
/slk-bridge
# Select "Configure"
# Enter bot token
# Enter app token
```

또는 CLI로 설정합니다:

```bash
/slk-bridge configure <bot-token> <app-token>
```

또는 환경 변수를 설정합니다(환경 변수는 `slk-bridge.json`에 절대 기록되지 않습니다):

```bash
export PI_SLACK_BOT_TOKEN="xoxb-your-slack-bot-token"
export PI_SLACK_APP_TOKEN="xapp-your-slack-app-token"
```

### 4. 연결

```bash
/slk-bridge connect
```

이 명령은 현재 세션을 참여시킵니다([멀티 세션 아키텍처](#멀티-세션-아키텍처) 참고). 참여한 세션은 프로세스가 시작될 때 자동으로 다시 참여합니다. 세션이 Slack 연결까지 스스로 차지할지는 `~/.omp/agent/slk-bridge.json`의 `autoConnect`로 제어합니다.

### 5. Slack 사용자 인증

1. Slack에서 앱의 DM을 엽니다. 사이드바의 **Apps**(앱)를 클릭하거나 앱 이름을 검색한 뒤, **Messages**(메시지) 탭을 엽니다.
2. 아무 메시지나 보냅니다. 예를 들면 `hi`입니다. 처음에는 브리지가 6자리 챌린지 코드(challenge code, 본인 확인용 코드)를 요구하는 답을 보냅니다. 이 코드는 라우터 세션(Slack 연결을 가진 세션)의 터미널에 표시됩니다.
3. 그 코드를 DM에 입력합니다. 이제 이 브리지의 신뢰 Slack 사용자로 등록(claim)되고, 그 DM이 페어링된 대화(paired chat)가 됩니다.
4. 이제부터 참여한 세션은 각자 이 DM에 자신의 루트 메시지를 게시합니다. 특정 세션과 대화하려면 그 세션의 루트 메시지 **스레드 안에서** 답장하세요.

> 한 번에 한 명의 Slack 사용자만 신뢰합니다. 첫 등록(claim)이 성공한 뒤에는 다른 사용자를 무시합니다. Pi 터미널 세션에서 `/slk-bridge releaseclaim`으로 등록을 수동으로 다시 열 때까지 그렇습니다.

## pi-messenger-bridge와의 주요 차이점

### Slack을 일급(first-class) 전송 수단으로

- **용어(semantics) 변경** - `msg-bridge` -> `slk-bridge`
- **파일 업로드와 수신** - Slack을 통해 Pi Agent 세션과 파일을 주고받습니다.
- **Markdown 서식** - Slack 메시지에 이제 Markdown 블록(Markdown Blocks)으로 서식이 올바르게 적용됩니다.
- **stop** - Slack에서 `stop`을 보내면 에이전트의 현재 턴을 중단합니다. [badlogic/pi-telegram](https://github.com/badlogic/pi-telegram)에서 영감을 받았습니다.
- **Slack 메시지 푸터에 pi 상태 표시** - 가장 최근 메시지마다 Pi 에이전트의 상태(현재 경로, 모델, 컨텍스트 윈도우 등)를 보여 주는 Slack 푸터 주석이 붙습니다.

![Markdown 서식 스크린샷](media/markdown-formatting-screenshot.png)

### tmux 기반 세션 관리

목표는 원할 때 언제든 Slack이나 터미널에서 Pi 세션을 이어서 사용하는 것입니다.
이를 위해 터미널 멀티플렉서(multiplexer)인 `tmux`를 기반으로 사용합니다.
`tmux`로 새 Pi 세션을 만들고, 이전 세션으로 전환하고, 이전 세션 목록을 봅니다.
`tmux` 세션은 한 번에 하나만 존재할 수 있습니다. 이 세션이 새로 만들었거나 전환한 Pi 세션을 담는 컨테이너 역할을 합니다.

도입된 주요 명령은 다음과 같습니다:

- `/slk-bridge new [path]` - 현재 Pi 세션을 종료하고 tmux 세션 안에서 새 세션을 시작합니다. 선택 인수(argument)로 `path`를 넣으면 OS의 해당 경로에서 세션을 시작합니다.
- `/slk-bridge resume` - Pi 에이전트의 최근 세션 10개를 보여 줍니다.
- `/slk-bridge resume list [number]` - 최근 세션 `number`개를 보여 줍니다(기본값 10). `number`는 선택 인수입니다.
- `/slk-bridge resume <number>` - `resume` 또는 `resume list` 출력에서 해당 번호가 가리키는 세션을 재개합니다. 기존 tmux 세션이 있으면 그 세션을 Pi 터미널 세션 전환에 사용합니다.
- `/slk-bridge handover` - 현재 터미널 세션을 Slack으로 넘겨서 그곳에서 대화를 이어 갈 수 있게 합니다.

각 명령은 Pi Agent 하니스 안에서 결정적(deterministic) 방식으로 구현되어 있어 LLM 호출이 일어나지 않습니다.
로컬 터미널 세션이 Slack 연결을 스스로 차지하지 못하게 하려면 `/slk-bridge optout`을 사용합니다. 다시 허용하려면 `/slk-bridge optin`을 사용합니다.

참여한 세션은 모두 Pi 에이전트와 연결된(bridged) Slack 앱과의 DM 안에 자기만의 스레드를 가집니다. 세션의 스레드에 답장하면, 그 세션이 실행 중일 때 답장이 해당 세션에 전달됩니다([라우팅](#멀티-세션-아키텍처) 참고). 실행 중이 아니면 그렇다는 안내가 돌아옵니다. `/slk-bridge handover`로 터미널 세션을 명시적으로 Slack에 넘길 때도 같은 스레드 기반 흐름을 씁니다. 세션을 Slack으로 넘기면(핸드오버) 전체 대화 기록과 최종 응답이 새 스레드에 다시 게시됩니다(replay). 그래서 Slack 사용자는 터미널에서 멈춘 지점부터 이어서 진행할 수 있습니다.

### 결정적 도트 명령(Dot Commands)

사용자는 `.bridge`를 일종의 대체 수단으로 사용해 Pi의 일부 `/` 명령을 실행할 수 있습니다. 현재는 pi-slack-bridge 자체 명령 외에 `skills`와 `prompt templates`만 지원합니다.
사용 가능한 명령을 모두 보려면 Slack에서 `.`을 보냅니다.

![dot 명령 스크린샷](media/dot-commands-screenshot.png)

## 보안

- 설정 파일: `~/.omp/agent/slk-bridge.json` (chmod 600 — 소유자만 읽고 쓸 수 있음. Windows에서는 디렉터리/파일 ACL(접근 제어 목록)에 의존합니다. 아래 참고)
- 설정 디렉터리: `~/.omp/agent/` (chmod 700 — 소유자 전용)
- 라우터 잠금: `~/.omp/agent/slk-bridge.lock`. 설정 쓰기 잠금: `~/.omp/agent/slk-bridge.json.lock`
- 참여한 세션의 레지스트리: `~/.omp/agent/slk-bridge-sessions/`
- 세션별 받은편지함(Slack 메시지의 텍스트가 들어 있음): `~/.omp/agent/slk-bridge-inbox/`
- 다운로드: `~/.pi/slk-bridge-downloads/slack/`
- 환경 변수는 파일 설정보다 우선하며, 파일에 다시 기록되지 않습니다.
- 설정 갱신은 프로세스 간에 잠기고, 잠금 안에서 다시 읽은 뒤 원자적으로 교체합니다(임시 파일 + 이름 변경(rename)). 파싱할 수 없는 설정 파일은 절대 덮어쓰지 않습니다.
- 챌린지 기반 인증(6자리 코드, 3회 시도, 2분 후 만료)
- 전송 수단(transport)별 네임스페이스가 붙은 사용자 ID로 사칭을 막습니다.
- 한 번에 한 명의 신뢰 Slack 사용자만 지원합니다. 첫 등록(claim)이 성공한 뒤에는 `/slk-bridge releaseclaim`으로 등록을 수동으로 다시 열 때까지 다른 사용자를 무시합니다.

> **Windows:** 이름 변경(rename)으로 설정 파일을 교체하면, 새 파일은 `~/.omp/agent/`에서 상속된 ACL을 갖습니다. 이전 파일에만 설정해 둔 ACL은 이어지지 않습니다. 기본 프로필 ACL은 현재 사용자, SYSTEM, Administrators에게 권한을 줍니다. 이 범위가 원하는 것보다 넓다면 **디렉터리**의 ACL을 더 엄격하게 설정하세요.

## 문제 해결

자세한 로그를 보려면 디버그 모드를 켭니다:

```bash
export SLK_BRIDGE_DEBUG=true
```

또는 설정 파일에 지정합니다:

```json
{ "debug": true }
```

### 자주 겪는 문제

- **먼저 `/slk-bridge status`를 실행하세요.** 이 세션이 참여했는지, 라우터가 누구인지, 이 프로세스가 소켓을 잡고 있는지 보여 줍니다.
- **"Only one socket per app token."** Slack은 앱 토큰 하나에 열려 있는 연결 중 Slack이 고른 *하나*에만 각 이벤트를 전달합니다. 두 번째 프로세스가 소켓을 잡고 있으면 이벤트가 무작위로 그쪽에 도착해서 사라진 것처럼 보입니다. 두 번째 프로세스의 예는 다음과 같습니다. 잠금 디렉터리를 다르게 하여 시작한 세션, 다른 컴퓨터, 오래된 봇 프로세스, 같은 App-Level Token을 쓰는 다른 도구입니다. 한 컴퓨터 안에서는 라우터 잠금이 이 문제를 막습니다. 컴퓨터나 도구가 다르면 막을 수 없습니다. 컴퓨터/도구마다 앱 토큰을 하나씩 사용하세요. 다른 수신 프로세스(consumer)를 중지한 다음, 메시지를 받아야 할 세션에서 `/slk-bridge router`를 실행하세요.
- **Slack 메시지가 수신되지 않을 때** — Socket Mode가 켜져 있는지, 두 토큰이 모두 올바른지, `message.im`을 구독했는지, `/slk-bridge status`에 라우터가 표시되는지 확인하세요. `autoConnect`가 꺼져 있으면 아무도 스스로 라우터 역할을 맡지 않습니다. 이때는 `/slk-bridge router`를 실행하세요.
- **"이 스레드의 세션이 꺼져 있습니다…"** — 그 스레드를 소유한 세션에 실행 중인 프로세스가 없다는 뜻입니다. Paseo에서 해당 에이전트를 열거나 세션을 재개하세요. 참여했던 세션은 시작할 때 다시 참여합니다. 실행 중인 세션의 스레드에 쓰거나, 라우터 세션에 보내려면 스레드 밖(최상위)에 쓰세요.
- **답장이 엉뚱한 세션으로 갈 때** — 답장은 *스레드*를 따라갑니다. 보내려는 세션의 스레드 안에 쓰세요. 스레드 밖(최상위)의 DM 메시지는 라우터 세션으로 갑니다.
- **"Another session is the router"라고 나오는데 아무것도 수신되지 않을 때** — 그 프로세스가 멈췄을 수 있습니다. `/slk-bridge router`를 실행해 라우터 역할을 넘겨받으세요. 기존 라우터는 약 0.25초 안에 소켓을 닫습니다.
- **`Refusing to overwrite ...: it is not valid JSON`** — `slk-bridge.json`이 손상되었거나 손으로 편집되었습니다. 브리지는 파싱할 수 없는 파일을 절대 덮어쓰지 않습니다. JSON을 고치거나 복원하세요.
- **`Timed out waiting for the slk-bridge config lock`** — 다른 프로세스가 `slk-bridge.json.lock`을 잡고 있습니다. 5초보다 오래된 잠금은 비정상 종료로 남은 것으로 보고 자동으로 해제합니다. 실행 중인 `omp`가 없는데도 계속되면 잠금 파일을 삭제하세요.
- **핸드오버(handover)가 동작하지 않을 때** — 신뢰 Slack 사용자가 이미 브리지를 등록(claim)했는지 확인하세요. `/slk-bridge handover`에는 기억된 Slack DM 대상이 필요합니다.
- **핸드오프(handoff)가 동작하지 않을 때** — tmux가 설치되어 있고 `pi`가 PATH에 있는지 확인하세요. 핸드오프는 tmux 안에서 `pi --session <target>`을 실행합니다.

## 개발

```bash
git clone https://github.com/ChanwooKim01/omp-slack-bridge.git
cd omp-slack-bridge
npm install
npm run build        # compile TypeScript
npm run typecheck    # type-check without emitting
npm run test         # run vitest suite
npm run lint         # biome lint
npm run lint:fix     # biome lint with auto-fix
```

### 소스에서 직접 로드하기 (개발할 때 더 빠름)

```bash
pi -e src/bridge/index.ts
/slk-bridge connect
```

### 테스트 스위트

```bash
npm run test
```

테스트 스위트가 다루는 범위는 다음과 같습니다: 설정 로딩과 프로세스 간 안전한 갱신, 라우터 잠금(별도 프로세스에서 동시에 획득을 시도하는 경우 포함), 세션 레지스트리와 받은편지함, 수신 메시지 라우팅, 소켓 없는 발신 게시, 두 세션이 하나의 DM을 공유하는 종단 간(end-to-end) 동작, Slack 블록 분할, 대화 기록 추출, 서식. 일부 테스트는 파일 잠금을 검증하려고 실제 Node 프로세스를 시작합니다. 이 테스트는 몇 초 걸립니다.

## 감사의 말

무엇보다 Earendil의 매우 유용한 Pi 프로젝트에 감사드립니다.

이 프로젝트가 기반으로 삼은 `pi-messenger-bridge` 확장 프로그램을 제공한 [@tintinweb](https://github.com/tintinweb)에게 감사드립니다. 또 이 멀티 세션 포크가 바탕으로 삼은 Slack 전용 포크 [comsysto/pi-slack-bridge](https://github.com/comsysto/pi-slack-bridge)의 작성자들에게도 감사드립니다.
또한 `pi-telegram-bridge` 구현으로 Markdown 서식 같은 이 확장 프로그램의 일부 기능에 영감을 준 [@badlogic](https://github.com/badlogic)과 [@llblab](https://github.com/llblab)에게 감사드립니다.

마지막으로, 로컬 `deepseek-v4-flash`로 상당한 개발을 할 수 있게 해 준 `ds4` 추론 엔진(inference engine)을 제공한 [@antirez](https://github.com/antirez)에게 감사드립니다.

## 코딩 에이전트 사용에 관한 투명성

이 프로젝트는 처음에 Slack 전용이라는 방향을 정립하려고 Pi Agent Harness와 `gpt-5.4` 모델을 사용했습니다. 이후 새 기능, 개선, 리팩터링에서는 Macbook Pro M3 Max에서 [antirez/ds4](https://github.com/antirez/ds4)로 로컬 호스팅한 `deepseek-v4-flash`를 많이 활용했습니다. 이 포크의 OMP / Paseo 멀티 세션 변경도 코딩 에이전트의 도움을 받아 개발했습니다.

## 라이선스

MIT
