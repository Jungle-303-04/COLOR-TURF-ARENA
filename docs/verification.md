# Color Turf Arena 검증 기록

검증일: 2026-07-16 (Asia/Seoul)

이 문서는 현재 checkout에서 직접 실행한 결과를 기록한다. 로컬에서 입증한 항목과 물리 휴대폰, 실제 Kubernetes 클러스터, 외부 트래픽 전환이 필요한 항목을 구분한다.

## 자동·정적 검증

| 항목 | 결과 | 실행 증거 |
| --- | --- | --- |
| TypeScript | PASS | `npm run typecheck`: shared, game-api, bot, web 모두 exit 0 |
| 테스트 | PASS | `npm test`: game-api 23 passed / Redis integration 1 skipped, web 17 passed |
| 프로덕션 빌드 | PASS | `npm run build`: 네 workspace 모두 성공, Vite 99 modules build |
| Compose 정적 구성 | PASS | `docker compose config --quiet`, 기본 서비스가 Redis/Stable/Canary/DR/Web으로 해석됨 |
| Kustomize | PASS | `kubectl kustomize deploy/k8s` exit 0 |
| Helm | PASS | 기본·Primary·Canary-bad·DR values에 대해 `helm lint`와 `helm template` exit 0 |
| PowerShell 도구 | PASS | `scripts/*.ps1` 5개 PowerShell parser error 0 |

테스트는 경기 lifecycle·점수·마감 시각, 입력 sequence·stale·rate limit, Redis 호환 snapshot/lease, 실제 Socket.IO client 두 개의 join/input/delta 흐름을 포함한다.

### 2026-07-15 월드·부하 확장 검증

- 기본 월드는 `216×216` 정사각형으로 46,656 cells다. 기존 직사각형 월드와 셀 수를 동일하게 유지해 부하 비교가 가능하며 게임 단위 테스트가 이 기본값을 고정한다.
- 플레이 카메라는 `72×72` 정사각형 cells만 표시해 전체 월드의 1/9을 노출한다. 중앙·좌상단·우하단·작은 월드 경계 조건을 단위 테스트했다.
- 플레이어 좌표는 30Hz 서버 상태 사이를 약 33ms 동안 보간하며, 시작·중간·종료 좌표와 범위 제한을 단위 테스트했다. 판정 좌표는 서버 상태를 그대로 유지한다.
- Windows 로컬 서버에서 `/api/config`의 `tickRateHz=30`을 확인하고 실제 Socket.IO 관전자 Delta를 3.007초 동안 측정했다. 90회가 수신되어 `29.93 updates/s`였으며, 누적 시간 오차를 보정하는 Tick 스케줄러가 설정 주기를 실제 전송에도 유지함을 확인했다.
- 관리자 화면은 게임 관전, 게임·봇 제어, 운영 지표를 세 탭으로 분리한다. 지표 카드는 30Hz Tick 예산과 입력·이벤트 루프·CPU 임계치를 상태 색상으로 표시하며, 각 `?` 툴팁은 `/api/config`, `/api/ops`, Node.js 런타임 또는 Kubernetes API 중 실제 출처를 명시한다.
- 새 경기장 설정은 108/216/270 정사각형 맵 프리셋과 직접 크기 입력, 페인트 반경, A/B 팀 색상을 제공한다. 가로·세로는 항상 같은 값으로 서버 생성 API에 전달한다.
- 참가 닉네임을 비워도 payload에서 nickname을 생략하며, 서버가 만든 `Guest-N`을 화면·재접속 Session·localStorage에 저장한다. 명시한 닉네임은 앞뒤 공백을 제거한다.
- `/ops`는 기존 처리량·Tick·CPU·메모리뿐 아니라 실제 `OpsSnapshot`의 입력 지연 P95, Event Loop P95, reconnect/disconnect 누계, uptime을 한국어 카드와 출처 툴팁으로 표시한다.
- 참가자 `join/resume`, 관전자 구독, 관리자 실시간 구독은 DR lease 공백 동안 `Room not found` 또는 ACK timeout을 bounded exponential backoff로 재시도한다. 재시도 성공·상한·timeout·abort·지연 계산을 웹 단위 테스트로 고정했다.
- Compose 방 `A87XN`에 관리 API로 실제 WebSocket 봇 100개를 한 번에 요청했다. 6초 측정 시 98 players, 104 sockets, 340 inputs/s, input P95 246ms, tick P95 0.24ms, event-loop P95 43.97ms, CPU 100%, RSS 210.40MB가 `/api/ops`에 기록됐다. 이후 500개 회수 명령으로 봇 수 0을 확인했다.
- 최종 이미지 재기동 후 방 `2CXQU`에 봇 50개를 요청해 50개 모두 연결, 442 inputs/s, input P95 59ms, tick P95 0.14ms를 확인했고 전부 회수했다.
- 공지는 전체 Grid Snapshot 대신 `state_delta`로 즉시 전송되며, 자동 테스트와 Compose 런타임 모두에서 약 2초 표시 후 3초 시점에 `announcement=null`로 제거되는 것을 확인했다.
- 7월 15일 최초 내장 브라우저 자동 QA 시도는 도구 초기화 오류가 있었지만, 7월 16일 재검증에서는 아래 관리자·참가자 핵심 흐름을 실제 브라우저로 완료했다. 물리 휴대폰 시각·터치 검증은 아래 외부 환경 항목으로 남긴다.

## 실제 Compose 런타임 검증

- 방 `M5KTY`를 만들고 실제 Socket.IO client로 입장·이동했다. 입력 ACK는 `accepted=true`, 최초 delta는 변경 cell 18개였고 전체 grid를 포함하지 않았다.
- 이동 뒤 서버 snapshot은 player 1명, painted cell 40개, sequence 6을 기록했다. 즉 클라이언트가 좌표나 점수를 직접 쓰지 않고 서버 tick 결과가 전파됐다.
- `server-stable` 컨테이너를 재시작한 뒤 Redis에서 같은 방과 player/team, painted cell, sequence가 복구됐다.
- 관리 API로 실제 Socket.IO Bot 2개를 추가하고 `isBot=true` player 2명이 접속하는 것을 확인했다.
- Paint Boost를 켜고 활성 이벤트가 snapshot과 화면에 노출되는 것을 확인했다.
- `/healthz`, `/readyz`, `/version`, `/metrics`를 확인했다. 준비 상태는 `store=redis`였고 요구된 game tick, broadcast, payload, queue delay, connection, player, room, reconnect, snapshot, recovery, changed-cell, ops-event metric이 모두 노출됐다.
- Stable과 별도 DR 컨테이너를 동시에 실행했다. Stable을 정상 종료하자 DR이 방 `FMLNX`를 2.57초 만에 인계받았고, Stable을 강제 종료해 lease를 남겼을 때는 방 `VY6KL`을 8.2초 만에 인계받았다. 두 경우 모두 같은 room code와 snapshot 상태를 유지했다.
- lease는 2초마다 갱신된다. 소유권을 잃은 authority는 방을 즉시 내리고 client를 재접속시키며, 대기 authority는 7초 TTL 만료 뒤 Redis snapshot을 재획득한다.

### 2026-07-16 공개 URL DR 경로 보강

- Web Nginx에 `server-stable` 우선, `server-dr` backup upstream을 적용해 HTTP와 새 WebSocket handshake가 같은 `:8080` 공개 URL에서 DR로 넘어가도록 구성했다.
- 기본 Compose에 DR을 포함하고 Web readiness가 Stable과 DR 모두를 기다리도록 했으며, Prometheus도 DR `/metrics`를 수집한다.
- 최근 운영 이벤트는 Snapshot storage의 Redis 공유 로그에 최대 200개를 저장하고, `/api/ops`와 `/api/ops/events`가 최신 로그를 merge/dedupe한다. Platform event POST는 저장 완료 뒤 202를 반환하며, Stable 종료 뒤 DR에서도 이전 장애 이벤트가 남는 Redis 통합 테스트를 추가했다.
- `scripts/verify-compose-failover.mjs`는 실제 방·Socket Session·채색 상태와 Redis Snapshot을 만든 뒤 기본적으로 Stable 컨테이너를 `SIGKILL`하고, DR에서 match/team/nickname/score/`matchEndsAt` 및 Snapshot 이상의 sequence·paint와 `/version`이 복구되는지 검사한 후 Stable을 복원한다. graceful 모드도 선택할 수 있으며 `node --check`는 통과했다.
- 2026-07-16 재검증에서 Stable을 실제 `SIGKILL`한 방 `KLPHV`가 같은 공개 URL에서 8.859초 만에 DR로 복구됐다. match/team/nickname/`matchEndsAt`과 Snapshot 이상의 sequence·paint를 모두 유지했으며 결과는 `docs/evidence/compose-failover-2026-07-16.json`에 저장했다.

## 2026-07-14 브라우저 검증 기록(레이아웃 확장 전)

- `/admin`: `demo-admin` 토큰 로그인, 복구된 방 자동 선택, 미니맵, metric 카드, Bot/Paint Boost/공지/Chaos controls와 timeline을 확인했다.
- `/play/M5KTY`: 닉네임 입장, 팀 배정, 전체 Canvas, 가상 조이스틱, RTT, 서버 버전·클러스터·release 표시를 확인했다.
- 모바일 플레이 Canvas와 미니맵은 `aspect-ratio: 1`을 사용하며, 렌더러도 가로·세로에 동일한 셀 배율을 적용한다.
- `/watch/M5KTY`: 경기 결과, RED/BLUE 점수와 점유율, human/bot 수, server identity, sequence 표시를 확인했다.
- 관리자·모바일 플레이·관전자 화면의 browser console error는 0건이었다.

## 2026-07-16 관리자 탭·참가자 브라우저 재검증

- 실제 Socket.IO 클라이언트 2개가 방에 입장해 서로 다른 팀을 배정받고, Start → 양쪽 이동 입력·채색 Delta → Pause 중 입력 거부 → Resume → End → 양 팀 최종 점수와 운영 이벤트까지 확인하는 전체 경기 smoke test를 추가했다.
- `/admin`에서 `게임 진행 상황`, `게임·봇 제어`, `운영 지표` 세 탭이 각각 필요한 패널만 노출하는지 DOM과 화면으로 확인했다.
- 운영 지표의 게임 Tick P95 `?`를 열어 지표 의미, 정상 기준, `/api/config`·`/api/ops`·Node.js 런타임·Kubernetes API 중 실제 수집 출처가 키보드 포커스와 화면에 노출되는 것을 확인했다.
- 제어 탭에서 실제 WebSocket 봇을 `1개 → 10개 → 15개`로 추가했다. 경기 시작 뒤 관리자 스트림이 초당 `29~30회`를 표시했고 점유율·참가자 수가 실시간으로 변했다. 빠른 `＋ 봇 5개`와 `모두 회수`도 UI에서 실행해 최종 봇 `0개`를 확인했다.
- 반응형 규칙이 이벤트·공지 카드에 불필요한 35rem 높이와 빈 열을 만들던 문제를 발견했다. 제어 탭 전용 3열 배치를 적용해 Paint Boost, 빠른 봇 제어, 공지 전송을 한 행에서 읽고 조작할 수 있게 수정했다.
- `/play/MMWDN`에 닉네임 `모바일-QA`로 입장해 팀 배정, 정사각형 카메라 Canvas, 전체 미니맵, 참가자·봇 닉네임, World `216×216`, RTT와 서버 identity가 배경만 남지 않고 렌더링되는 것을 확인했다.
- 관리자 개요 탭에서 `모바일-QA`와 봇의 서버 좌표가 실시간 참가자 목록에 노출되는지 확인했고, `캔버스 크게 보기` 모달에서 정사각형 전체 월드와 팀 점유율·인원·소켓 수를 확인했다.
- 증빙 이미지는 `docs/evidence/screenshots/admin-overview-tabs.png`, `admin-controls-tabs.png`, `admin-metrics-tabs.png`, `admin-canvas-modal.png`, `player-live-square.png`에 저장했다.

## 2026-07-16 자동 E2E·Canary·부하 비교

- Playwright Chromium이 빈 임시 포트에 메모리 API와 Vite를 직접 띄워 관리자 로그인·방 생성, 모바일 `390×844` 참가, 닉네임·팀 배정, 경기 시작, 실제 Pointer 조이스틱, 관전 점수 증가, Paint Boost 양 화면 표시, offline → online Overlay와 동일 Session·닉네임·팀·sequence 복구를 검증했다. 기본 실행과 `--repeat-each=3` 모두 통과했고 teardown 뒤 임시 listener는 남지 않았다.
- Stable API가 Canary 방 생성을 `server-canary`로 위임하고 Join API가 `/socket/canary`를 반환하는 경로를 Compose에서 검증했다. 방 `WQ2X9`은 `compose-canary-primary`, `v1.2.0`, `releaseChannel=canary`, `broadcastMode=full`로 실제 연결·이동·채색됐고 Canary Bot 2개도 별도 Socket 경로로 접속했다. 결과는 `docs/evidence/canary-routing-2026-07-16.json`에 저장했다.
- 관리자 운영 지표는 선택 방의 release channel을 `/api/ops?releaseChannel=...`로 조회한다. 별도 Canary가 있으면 Canary 프로세스의 실제 CPU·Event Loop·Payload·Socket을 사용하고, 단일 프로세스 개발 환경에서는 Stable 프로세스라는 사실을 그대로 표시한다. `docs/evidence/screenshots/admin-canary-metrics.png`에서 `CANARY · v1.2.0`, 실제 지표 카드·그래프와 출처 툴팁을 확인했다.
- WebSocket RTT는 클라이언트와 서버의 서로 다른 시계에서 도착 시간을 빼지 않는다. 브라우저가 `client_ping` ACK까지 직접 잰 값을 `client_rtt`로 보고하며, 42.5ms 표본이 운영 P95에 그대로 반영되는 통합 테스트를 추가했다.
- `game_snapshot_age_seconds`는 저장 순간마다 0으로 고정하지 않고 마지막 성공 Snapshot 시각부터의 실제 경과시간을 scrape 시 계산한다. Compose 실측에서 Canary 방은 `0.112초`, DR 방들은 `0.137~0.308초` 범위로 노출됐다.
- `npm run load:compare`는 독립된 Delta/Full 서버와 10개 client worker를 사용해 50 Bot × 10Hz를 각각 5초 측정한다. 양쪽 모두 `2,500/2,500` 입력·거부 0이었고 Full/Delta는 대표 Payload `5.493배`, 서버 Payload P95 `5.301배`, Broadcast P95 `1.598배`, Event Loop P95 `1.573배`, CPU `4.355배`였다. 원본은 `docs/evidence/load-comparison-2026-07-16.json`에 저장했다.
- Helm/Kustomize에는 Nginx 시작을 막던 누락 `server-dr` DNS와 항상 해석 가능한 `server-canary` Service를 추가했다. 공개 Primary values는 관리자 인증을 유지하고 OOM 주입을 끄며, 인증 우회·실제 OOM은 외부 공개 경로가 없는 `values-isolated-chaos-demo.yaml`에만 분리했다.
- GitHub Actions CI는 Node 24에서 typecheck/test/build, Playwright, 부하 비교, Compose config, Helm lint와 Kustomize render를 모든 push와 PR에서 실행한다.

## 아직 외부 환경 증거가 필요한 항목

- 발표 PC와 물리 휴대폰 2대 이상을 같은 Wi-Fi에 연결한 QR 접속, touch drag, 화면 회전, 재접속 확인
- Windows Firewall과 행사장 AP isolation 여부 확인
- 실제 Kubernetes에서 stable/canary Pod 분리, HPA/PDB/ServiceMonitor, image pull, rollout/rollback 확인
- 두 개의 실제 클러스터와 외부 LB/DNS를 사용한 Primary→DR 트래픽 전환 및 RTO 측정
- 실제 운영 플랫폼이 `/api/ops/events`를 호출하고 SLO webhook을 받아 rollback하는 end-to-end 확인

코드는 로컬 데모와 배포 manifest 수준까지 완료했지만, 마지막 다섯 항목은 해당 외부 환경 없이는 완료로 간주하지 않는다.

## 현재 실행 상태

2026-07-16 최종 검증 뒤 `docker compose stop`으로 Redis, Stable, Canary, DR, Web을 모두 종료했다. `3001`, `3002`, `3003`, `5173`, `8080`, `9090` 여섯 포트가 Listen 상태가 아님을 확인했다. Docker Desktop의 기존 kind control-plane 컨테이너는 이 저장소의 Compose 서버가 아니므로 변경하지 않았다.
