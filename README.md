# Color Turf Arena

관객이 휴대폰으로 QR에 접속해 빨강/파랑 팀으로 영역을 점령하고, 같은 경기에서 Canary 성능 저하와 Redis Snapshot 기반 DR 복구를 시연하는 실시간 Kubernetes 데모다.

React/Vite 화면과 Node/Express/Socket.IO 서버로 구성된다. 기존 저장소의 npm workspace와 Express 구조를 유지했으며, 클라이언트는 이동 방향만 전송한다. 위치, 속도, Paint, 점수, 타이머와 승패는 서버가 30Hz로 판정한다.

## 화면과 계정

| URL | 용도 |
| --- | --- |
| `/admin` | 토큰 로그인, `전체 게임 진행`·`봇·부하 제어`·`운영 지표` 탭, 실시간 관전과 최대 120초 운영 그래프 |
| `/play/:roomCode` | 닉네임 입장, 내 캐릭터 추적 제한 시야, 미니맵, 가상 조이스틱, 실제 화면 FPS, 자동 재접속 |
| `/watch/:roomCode` | 대형 관전 Canvas, 참가자 닉네임, 점유율/타이머/인원/Bot, 배포·장애 이벤트 |
| `/ops` | 실제 서버·게임·Kubernetes 관측값과 명시적인 Demo/Chaos 상태 |

호환 경로 `/join/:roomCode`, `/screen/:roomCode`도 유지한다. 기본 관리자 토큰은 `demo-admin`, Ops Event 토큰은 `demo-ops`다. 발표 전 `.env`에서 반드시 바꾼다. Demo/Chaos API는 `DEMO_ADMIN_AUTH_DISABLED=true`인 격리 데모에서도 항상 `ADMIN_TOKEN` Bearer 인증을 요구한다.

## 가장 빠른 실행

Docker Desktop이 실행 중이어야 한다.

```powershell
Copy-Item .env.example .env
docker compose up --build -d
docker compose ps
```

1. [http://localhost:8080/admin](http://localhost:8080/admin)을 연다.
2. `demo-admin`으로 잠금을 해제한다.
3. Stable 또는 Canary Arena를 만든다.
4. 관전 화면을 열고 휴대폰으로 QR을 스캔한다.

```powershell
curl.exe http://localhost:3001/healthz
curl.exe http://localhost:3001/readyz
curl.exe http://localhost:3001/version
curl.exe http://localhost:3001/metrics
```

Prometheus를 함께 실행하려면 다음 profile을 쓴다.

```powershell
docker compose --profile observability up --build -d
# 또는 LAN 주소 자동 설정과 함께
.\scripts\start-demo.ps1 -Observability
```

종료 시 Redis volume을 보존하려면 `stop`, 모두 삭제하려면 `down`을 사용한다.

```powershell
docker compose stop
# 또는
docker compose down
```

## 휴대폰 연결

`localhost`는 휴대폰 자신을 뜻한다. 발표 PC와 휴대폰을 같은 Wi-Fi에 연결한 후 helper를 실행하면 기본 경로의 LAN IPv4를 자동 감지한다.

```powershell
.\scripts\start-demo.ps1
```

직접 지정할 수도 있다.

```powershell
.\scripts\start-demo.ps1 -PublicBaseUrl "http://192.168.0.42:8080"
```

PC에서도 동일한 LAN 주소의 `/admin`을 열어 QR URL을 확인한다. 학교·회사 Wi-Fi가 AP isolation으로 기기 간 통신을 막으면 개인 핫스팟을 사용한다.

## 게임과 상태 전송

- 논리 맵은 기본 `216×216` 정사각형(46,656 cells), 경기는 90초, 서버 Tick은 30Hz다.
- 플레이 화면은 전체 맵을 노출하지 않고 `72×72` 정사각형 셀 카메라가 내 캐릭터를 따라간다. 미니맵의 흰 점선은 현재 카메라 범위다.
- 서버 판정과 상태 전송은 30Hz로 실행하고, 플레이 캔버스는 연속 좌표를 `requestAnimationFrame`으로 약 33ms 동안 보간해 기기 주사율에 맞춰 부드럽게 표시한다.
- 플레이·관전 브라우저는 1초마다 `requestAnimationFrame` 간격을 집계해 실제 FPS, 프레임 시간 P95, 60fps 기준 추정 누락률을 서버에 보고한다. 서버 Tick과 브라우저 화면 FPS는 별도 지표다.
- 플레이어는 인원이 적은 팀에 먼저 배정되며, 동률이면 무작위 배정된다.
- 사람 클라이언트는 `{x,y}` 방향 의도를 20Hz로 보내며, 부하 봇은 10Hz를 유지한다. 서버가 입력 범위, 세션, 상태, sequence, timestamp와 초당 입력 수를 검증한다.
- 이동 속도는 서버에서 `18 cell/s`로 제한한다. 기본 Paint 반경은 2 cell이며 Paint Boost 동안 2배가 된다.
- 초기 입장·재접속·운영 명령에는 전체 Snapshot을 보내고, 정상 Tick에는 변경 Cell과 플레이어 위치만 `state_delta`로 전송한다.
- Canary/Chaos의 Full Broadcast 모드는 매 Tick 전체 Grid를 직렬화해 Payload·Broadcast·Tick 지표 차이를 의도적으로 만든다.
- 운영 공지는 플레이·관전 화면에 약 2초간 유지된 뒤 페이드되고, 서버 snapshot에서도 2.5초 후 자동 제거된다.
- `localStorage`에 `sessionId`, 닉네임, 팀, 마지막 sequence를 저장한다. 연결 해제 시 500ms → 1s → 2s → 최대 3s 간격으로 자동 복구한다.

## Bot과 부하 비교

관리자 `봇·부하 제어` 탭에서 50·100·250·500개 프리셋 또는 직접 입력한 수만큼 봇을 한 번에 추가·회수할 수 있다. 각 봇은 서버 내부 숫자가 아니라 별도 Socket.IO client로 실제 `join_room`과 `player_input` 프로토콜에 접속한다. 봇은 공유 Snapshot/Delta에서 24방향을 탐색해 이미 자기 팀이 칠한 영역보다 중립·상대 팀 영역을 우선하며, 관리자가 팀을 재배정하면 최신 월드 Snapshot의 팀을 즉시 따라간다.

`운영 지표` 탭에서는 선택한 방의 `roomCode`와 Stable/Canary release channel을 함께 전달한다. Redis Room command bus가 현재 lease owner로 요청을 라우팅하므로, 여러 Replica 환경에서도 임의의 gateway Pod가 아니라 실제 방 권위를 가진 프로세스의 입력 처리량, 입력/Tick/Event Loop 지연, Socket, CPU, RSS Memory, 상태 Payload와 플레이·관전 브라우저 FPS·프레임 누락률을 최근 최대 120초 시계열로 표시한다. 각 지표 이름 옆 `?`는 값의 정의, 단위, 수집 출처, 갱신 주기와 `실제 관측값`·`설정값`·`식별 정보`·`데모 시뮬레이션` 구분을 표시한다.

Demo/Chaos 명령도 선택한 방의 lease owner로 전달한다. Tick 지연과 Full Broadcast는 그 owner의 실제 game-api 프로세스 런타임에 적용되므로 같은 프로세스가 담당하는 다른 Room에도 영향을 줄 수 있다. Primary 장애와 Failover 버튼은 타임라인 전용 시뮬레이션이며 실제 Kubernetes 상태나 라우팅을 바꾸지 않는다.

CLI에서 최대 50개를 실행할 수도 있다.

```powershell
npm run bot -- --room ABC12 --count 50 --server http://localhost:3001
```

같은 조건의 Delta/Full을 각각 임시 서버에서 50 Bot × 10Hz로 재현하고 JSON으로 비교하려면 다음을 실행한다. 서버와 Bot worker는 측정 뒤 자동 종료된다.

```powershell
npm run load:compare
```

2026-07-16 현재 revision 재측정에서는 두 모드 모두 입력 `2,500/2,500`, 거부 `0`이었고 Full은 Delta보다 대표 Payload `5.51배`, 서버 Payload P95 `5.32배`, Broadcast P95 `1.60배`, Event Loop P95 `1.44배`, CPU `1.80배`를 사용했다. 실행법과 필드 정의는 [Delta / Full Broadcast 부하 비교](docs/load-comparison.md)에 있다.

서버 부하 지표만으로 화면 프레임 저하를 추정하지 않는다. 실제 게임을 열어 둔 플레이·관전 브라우저가 있으면 관리자 그래프의 `게임 화면 FPS P10` 하락과 `프레임 누락률 P95` 상승으로 화면 렌더링 저하를 직접 확인한다.

Compose profile:

```powershell
$env:BOT_ROOM="ABC12"
$env:BOT_COUNT="20"
docker compose --profile load up --build bot
```

## Snapshot과 DR 복구

- Redis가 있으면 `color-turf:room:{roomId}:snapshot`에 기본 1초마다 저장한다.
- 플레이어 Session은 30분 TTL로 저장한다.
- Room lease는 `SET NX PX`와 owner 일치 Lua 갱신/해제로 단일 writer를 보호한다.
- 소유권을 잃은 authority는 즉시 해당 Room을 내리고 연결을 끊는다. 대기 authority는 2초마다 재시도해 7초 lease 만료 뒤 최신 Snapshot을 재획득한다.
- 서버 시작 시 최신 Snapshot을 복원하며, 기존 `matchEndsAt`, Grid, 점수, 팀과 위치를 유지한다.
- 기본 Compose는 Stable과 별도 DR 대기 프로세스를 함께 실행한다. Web Nginx는 Stable을 우선 사용하고, Stable 연결 실패 시 같은 공개 URL의 새 HTTP/WebSocket handshake를 DR로 전달한다.
- `docker compose stop server-stable`로 실제 Primary 프로세스를 종료하면 기존 Socket이 끊기고, 클라이언트가 같은 Session으로 자동 재접속하는 동안 DR이 Redis Snapshot과 Room lease를 인계받는다. 기존 연결을 무중단으로 넘기는 방식은 아니다.
- 참가·관전·관리자 구독은 DR이 lease를 얻기 전 `Room not found`가 먼저 와도 최대 8회 bounded backoff로 다시 시도한다. 화면을 떠나거나 Socket이 끊기면 진행 중인 재시도는 취소한다.
- 최근 운영 이벤트는 Redis 공유 로그에 최대 200개를 보관하므로 Stable에서 기록한 `PRIMARY_UNHEALTHY`, `FAILOVER_STARTED`도 DR의 관리자·관제 타임라인에서 이어진다.
- 데이터 손실 가능 범위는 Snapshot 주기만큼이므로 `RPO 0` 또는 완전 무중단이라고 표현하지 않는다.

같은 8080 URL의 실제 Compose failover를 자동 확인하려면 실행 중인 데모에서 다음 명령을 사용한다. 기본값은 Stable을 `SIGKILL`로 비정상 종료한다. 스크립트는 장애 직전 Redis Snapshot을 함께 캡처하고, DR에서 같은 match/team/nickname/`matchEndsAt`과 Snapshot 이상의 sequence·paint가 복구되는지 확인한 뒤 Stable을 다시 시작한다.

```powershell
node .\scripts\verify-compose-failover.mjs | Tee-Object .\compose-failover-result.json
```

정상 종료 경로도 별도로 확인하려면 `$env:FAILOVER_FAILURE_MODE='graceful'`을 설정한다.

실제 두 cluster 사이의 Service/DNS/LB 전환과 양쪽에서 접근 가능한 외부/복제 Redis는 운영 플랫폼 책임이다.

## Stable과 Canary

방 생성 시 Release Channel을 고른다.

| 모드 | Version | Broadcast | 기본 Tick 지연 |
| --- | --- | --- | --- |
| Stable | `v1.1.3` | Delta | 0ms |
| Canary | `v1.2.0` | Full Grid | 시연 시 250~350ms |

기본 Compose는 Redis, Stable authority, 별도 Canary authority, DR standby, Web을 함께 실행한다. Stable API는 Canary 방 생성을 내부 `server-canary`로 위임하고, 참가·관전 브라우저는 Join API가 돌려준 `/socket/canary` 경로로 접속한다. DR은 Stable이 lease를 놓거나 만료되면 Room Snapshot을 재획득한다.

```powershell
docker compose up --build -d
curl.exe http://localhost:3002/version  # canary
curl.exe http://localhost:3003/version  # dr
```

로컬 공개 URL은 Stable 우선/DR 백업 gateway를 사용하며 Canary Socket은 별도 upstream으로 전달한다. Canary authority는 실제 Full Grid 직렬화와 별도 250ms Tick 지연을 적용하므로 Stable과 Payload·Broadcast·Event Loop·CPU 차이를 실측할 수 있다. 로컬 단일 서버 개발에서 Canary 서비스가 설정되지 않은 경우에는 호환성을 위해 기존 `/socket.io` 논리 Canary 모드로 폴백한다.

## 운영 플랫폼 이벤트 API

```powershell
.\scripts\send-ops-event.ps1 `
  -Type CANARY_STARTED `
  -Message "game-server v1.2.0 Canary deployment started" `
  -Token demo-ops
```

직접 호출할 때는 `Authorization: Bearer {OPS_EVENT_TOKEN}`을 사용한다. 지원 이벤트는 `DEPLOYMENT_STARTED`, `CANARY_STARTED`, `SLO_BREACH`, `ROLLBACK_STARTED`, `ROLLBACK_COMPLETED`, `PRIMARY_UNHEALTHY`, `FAILOVER_STARTED`, `SNAPSHOT_RESTORED`, `FAILOVER_COMPLETED`, `SERVICE_RECOVERED` 등이다. `SLO_BREACH` 수신 시 `OPS_PLATFORM_WEBHOOK_URL`이 설정되어 있으면 현재 지표를 Webhook으로 전달한다. 게임 서버가 Kubernetes Rollback을 직접 수행하지 않는다.

## Prometheus Metrics

`/metrics`는 Node.js process metrics와 다음 게임 지표를 노출한다.

- `game_tick_duration_seconds`
- `game_state_broadcast_duration_seconds`
- `game_state_payload_bytes`
- `game_input_queue_delay_seconds`
- `game_websocket_connections`
- `game_active_players`, `game_active_rooms`
- `game_client_reconnect_total`
- `game_client_render_fps_p10`
- `game_client_render_frame_time_p95_seconds`
- `game_client_render_frame_drop_ratio_p95`
- `game_client_render_telemetry_clients`
- `game_snapshot_save_duration_seconds`, `game_snapshot_age_seconds`
- `game_room_recovery_duration_seconds`
- `game_changed_cells_total`, `game_ops_events_total`

`playerId`와 `sessionId`는 Metric label에 넣지 않는다.

## 개발과 테스트

Node.js 22.12 이상이 필요하며 검증 환경은 Node 24다. Redis URL이 없으면 테스트·개발 서버는 메모리 Snapshot 저장소로 동작한다.

```powershell
npm install
npm run dev

npm run typecheck
npm test
npm run build
npm run test:e2e:install
npm run test:e2e
docker compose config
helm lint .\deploy\helm\color-turf
kubectl kustomize .\deploy\k8s
```

테스트는 Paint/Delta/속도 제한/팀 배정/종료, Snapshot 직렬화·복원, Lease, 관리자·Ops 토큰, Paint Boost, metrics를 검증한다. 두 실제 Socket.IO client smoke test는 방 생성 → 팀 배정 → Start → 이동·채색 → Pause/Resume → End → 최종 점수와 운영 이벤트까지 한 흐름으로 확인한다.

Playwright E2E는 빈 임시 포트에 메모리 기반 API와 Vite를 직접 시작하고 테스트 종료 시 모두 닫는다. Chromium에서 관리자 방 생성, `390×844` 모바일 정사각형 Canvas, 참가자 닉네임 입장, 관전 화면 닉네임, 경기 시작, 실제 Pointer 조이스틱 입력, 관전 점수 반영, Paint Boost, offline → online 자동 재접속과 동일 Session·닉네임·팀 복구, 브라우저 FPS 표본의 관리자 그래프 반영을 한 흐름으로 검증한다.

## Kubernetes Helm 배포

이미지를 build/load한 뒤 Primary를 설치한다.

```powershell
kubectl create namespace color-turf --dry-run=client -o yaml | kubectl apply -f -
kubectl -n color-turf create secret generic color-turf-auth `
  --from-literal=ADMIN_TOKEN='change-me' `
  --from-literal=OPS_EVENT_TOKEN='change-me-too'

helm upgrade --install color-turf .\deploy\helm\color-turf `
  --namespace color-turf --create-namespace `
  -f .\deploy\helm\color-turf\values-primary.yaml
```

`values-primary.yaml`은 공개 환경 기준으로 관리자 인증을 유지하고 실제 OOM 주입과 game-api 프로세스 종료를 비활성화한다. `ALLOW_DEMO_SERVER_SHUTDOWN`은 모든 기본 Kustomize/Helm 배포에서 `false`다. 인증 우회, OOM 주입과 서버 종료를 명시적으로 허용하는 `values-isolated-chaos-demo.yaml`은 외부 Ingress/Tunnel이 없는 폐쇄형 일회성 namespace에서만 추가한다. 이 values를 사용해도 Demo/Chaos endpoint의 `ADMIN_TOKEN` 인증은 해제되지 않는다.

```powershell
kubectl create namespace color-turf-chaos --dry-run=client -o yaml | kubectl apply -f -
kubectl -n color-turf-chaos create secret generic color-turf-auth `
  --from-literal=ADMIN_TOKEN='isolated-demo-only' `
  --from-literal=OPS_EVENT_TOKEN='isolated-demo-only'
helm upgrade --install color-turf .\deploy\helm\color-turf `
  --namespace color-turf-chaos `
  -f .\deploy\helm\color-turf\values-primary.yaml `
  -f .\deploy\helm\color-turf\values-isolated-chaos-demo.yaml
```

문제 Canary:

```powershell
helm upgrade color-turf .\deploy\helm\color-turf `
  --namespace color-turf `
  -f .\deploy\helm\color-turf\values-primary.yaml `
  -f .\deploy\helm\color-turf\values-canary-bad.yaml
```

Canary를 내릴 때는 Deployment의 첫 revision에도 동작하고 Helm 상태와 일치하도록 `scripts/rollback-canary.ps1` 또는 `.sh`가 `helm upgrade --reuse-values --set canary.enabled=false`를 수행한다.

DR 값 확인 또는 별도 namespace 설치:

```powershell
helm template color-turf-dr .\deploy\helm\color-turf -f .\deploy\helm\color-turf\values-dr.yaml
```

Chart에는 Stable/Canary Deployment와 Service, Web, Redis, 선택적 Bot, Ingress, PDB, HPA, RBAC, Downward API `POD_NAME`, probes, resources, preStop, 선택적 ServiceMonitor가 포함된다. `serviceMonitor.enabled=false`가 기본이라 CRD가 없는 cluster에서도 설치되며, 활성화 시 Stable과 Canary Service를 별도 ServiceMonitor로 수집한다.

Web의 `server-dr` backup hostname은 기본적으로 같은 Stable Pod를 가리키는 단일 클러스터 fallback Service다. 실제 DR endpoint가 이 클러스터에서 `:3001`로 접근 가능하면 `gateway.dr.externalName`에 해당 DNS 이름을 지정한다. `server-canary`도 항상 존재하며 Canary가 꺼져 있을 때는 Stable Pod로 fallback하고, `canary.enabled=true`일 때만 Canary Pod를 선택한다. 두 클러스터 전체 장애 전환은 여전히 외부 LB/DNS/Gateway와 공유 Redis가 담당한다.

## 문서

- [아키텍처와 상태 경계](docs/architecture.md)
- [5분 시연 Runbook](docs/demo-runbook.md)
- [검증 기록](docs/verification.md)
- [Delta / Full Broadcast 부하 비교](docs/load-comparison.md)
- [외부 장비·Kubernetes 검증 체크리스트](docs/external-verification-runbook.md)
- [오픈소스 후보 평가](docs/open-source-evaluation.md)
- [제3자 고지](THIRD_PARTY_NOTICES.md)

## 현재 제한사항

- 실제 휴대폰·발표장 Wi-Fi, 실제 Primary/DR cluster의 외부 LB/DNS 전환은 해당 환경에서 별도 검증해야 한다.
- Socket.IO gateway와 Room 명령 전달은 Redis adapter/command bus를 사용하지만, 각 Room의 게임 Tick은 lease를 가진 단일 authority만 수행한다.
- 실제 Primary/DR 두 cluster는 양쪽에서 접근 가능한 외부 또는 복제 Redis와 동일한 인증 Secret이 필요하다. 기본 Chart의 cluster-local Redis를 두 cluster에 각각 설치하면 DR Snapshot 공유가 되지 않는다.
- Playwright E2E는 Chromium 기준 핵심 흐름을 자동화한다. 실제 iOS Safari/Android Chrome의 터치·화면 회전과 행사장 Wi-Fi 재접속은 물리 장비에서 별도 검증해야 한다.

## 오픈소스

코드 작성 전 세 후보를 비교했다. 실제 코드 패턴을 참고한 것은 MIT 라이선스의 [over-engineer/Socket.io-whiteboard](https://github.com/over-engineer/Socket.io-whiteboard) 하나다. Canvas backing-store resize와 서버에서 받은 상태를 한 adapter로 그리는 책임 분리만 TypeScript로 재구성했다.

`christabella/freewee`는 구조적 아이디어만 살폈지만 `UNLICENSE`이므로 코드와 에셋을 전혀 사용하지 않았다. 자세한 revision, 라이선스와 재사용 범위는 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)에 있다.
