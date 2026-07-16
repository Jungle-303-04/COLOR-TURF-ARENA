# Color Turf Arena 검증 기록

검증일: 2026-07-16 (Asia/Seoul)

이 문서는 현재 checkout에서 직접 실행한 결과를 기록한다. 로컬에서 입증한 항목과 물리 휴대폰, 실제 Kubernetes 클러스터, 외부 트래픽 전환이 필요한 항목을 구분한다.

## 자동·정적 검증

| 항목 | 결과 | 실행 증거 |
| --- | --- | --- |
| TypeScript | PASS | `npm run typecheck`: shared, game-api, bot, web 모두 exit 0 |
| 테스트 | PASS | `npm test`: game-api 16 passed / Redis integration 1 skipped, web 8 passed |
| 프로덕션 빌드 | PASS | `npm run build`: 네 workspace 모두 성공, Vite 97 modules build |
| Compose | PASS | `docker compose config --quiet`, 이미지 빌드, Redis/server-stable/frontend 모두 healthy |
| Kustomize | PASS | `kubectl kustomize deploy/k8s` exit 0 |
| Helm | PASS | 기본·Primary·Canary values에 대해 `helm lint`와 `helm template` exit 0 |
| PowerShell 도구 | PASS | `scripts/*.ps1` PowerShell parser error 0 |

테스트는 경기 lifecycle·점수·마감 시각, 입력 sequence·stale·rate limit, Redis 호환 snapshot/lease, 실제 Socket.IO client 두 개의 join/input/delta 흐름을 포함한다.

### 2026-07-15 월드·부하 확장 검증

- 기본 월드는 `216×216` 정사각형으로 46,656 cells다. 기존 직사각형 월드와 셀 수를 동일하게 유지해 부하 비교가 가능하며 게임 단위 테스트가 이 기본값을 고정한다.
- 플레이 카메라는 `72×72` 정사각형 cells만 표시해 전체 월드의 1/9을 노출한다. 중앙·좌상단·우하단·작은 월드 경계 조건을 단위 테스트했다.
- 플레이어 좌표는 30Hz 서버 상태 사이를 약 33ms 동안 보간하며, 시작·중간·종료 좌표와 범위 제한을 단위 테스트했다. 판정 좌표는 서버 상태를 그대로 유지한다.
- Windows 로컬 서버에서 `/api/config`의 `tickRateHz=30`을 확인하고 실제 Socket.IO 관전자 Delta를 3.007초 동안 측정했다. 90회가 수신되어 `29.93 updates/s`였으며, 누적 시간 오차를 보정하는 Tick 스케줄러가 설정 주기를 실제 전송에도 유지함을 확인했다.
- 관리자 화면은 게임 관전, 게임·봇 제어, 운영 지표를 세 탭으로 분리한다. 지표 카드는 30Hz Tick 예산과 입력·이벤트 루프·CPU 임계치를 상태 색상으로 표시하며, 각 `?` 툴팁은 `/api/config`, `/api/ops`, Node.js 런타임 또는 Kubernetes API 중 실제 출처를 명시한다.
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
- Primary failure 시뮬레이션은 Redis에 저장한 snapshot을 다시 읽었고 `PRIMARY_UNHEALTHY → FAILOVER_STARTED → SNAPSHOT_RESTORED → FAILOVER_COMPLETED` 순서를 기록했다.
- `/healthz`, `/readyz`, `/version`, `/metrics`를 확인했다. 준비 상태는 `store=redis`였고 요구된 game tick, broadcast, payload, queue delay, connection, player, room, reconnect, snapshot, recovery, changed-cell, ops-event metric이 모두 노출됐다.
- Stable과 별도 DR 컨테이너를 동시에 실행했다. Stable을 정상 종료하자 DR이 방 `FMLNX`를 2.57초 만에 인계받았고, Stable을 강제 종료해 lease를 남겼을 때는 방 `VY6KL`을 8.2초 만에 인계받았다. 두 경우 모두 같은 room code와 snapshot 상태를 유지했다.
- lease는 2초마다 갱신된다. 소유권을 잃은 authority는 방을 즉시 내리고 client를 재접속시키며, 대기 authority는 7초 TTL 만료 뒤 Redis snapshot을 재획득한다.

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

## 아직 외부 환경 증거가 필요한 항목

- 발표 PC와 물리 휴대폰 2대 이상을 같은 Wi-Fi에 연결한 QR 접속, touch drag, 화면 회전, 재접속 확인
- Windows Firewall과 행사장 AP isolation 여부 확인
- 실제 Kubernetes에서 stable/canary Pod 분리, HPA/PDB/ServiceMonitor, image pull, rollout/rollback 확인
- 두 개의 실제 클러스터와 외부 LB/DNS를 사용한 Primary→DR 트래픽 전환 및 RTO 측정
- 실제 운영 플랫폼이 `/api/ops/events`를 호출하고 SLO webhook을 받아 rollback하는 end-to-end 확인

코드는 로컬 데모와 배포 manifest 수준까지 완료했지만, 마지막 다섯 항목은 해당 외부 환경 없이는 완료로 간주하지 않는다.

## 현재 실행 상태

검증을 위해 임시 실행한 로컬 API(3001)와 Web(5173)은 모두 종료했고 두 포트가 Listen 상태가 아님을 확인했다. Docker Desktop도 현재 실행 중이 아니며 Compose·Kubernetes 증거는 위에 기록한 7월 15일 검증 결과다.
