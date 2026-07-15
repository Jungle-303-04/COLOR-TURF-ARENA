# Color Turf Arena 5분 시연 Runbook

## 사전 준비

```powershell
.\scripts\start-demo.ps1
```

- PC와 휴대폰을 같은 네트워크에 연결한다.
- `/admin`을 열고 `ADMIN_TOKEN`으로 로그인한다.
- `/ops`와 Prometheus를 별도 탭에 연다.
- 실물 네트워크가 불안하면 관리자 Bot 10~20개를 준비한다.

## 0:00–1:00 — 정상 Stable 경기

1. `Stable v1.1.3 · Delta` Arena를 만든다.
2. `＋5 BOTS`를 두 번 실행한다.
3. 관객이 QR로 닉네임을 입력해 참가한다.
4. `/watch/:roomId`를 Fullscreen으로 연다.
5. Start 후 `PRIMARY · STABLE · DELTA`와 낮은 Payload/Tick p95를 보여준다.

말할 내용: “휴대폰은 방향만 보내고 위치·속도·Paint·점수는 20Hz 서버가 판정합니다.”

## 1:00–1:40 — Paint Boost

1. 관리자에서 `PAINT BOOST ×2 · 10s`를 누른다.
2. 모바일과 관전 화면의 이벤트 표시를 확인한다.
3. 이동 경로의 Paint 반경이 실제로 2배가 되는 모습을 보여준다.
4. 시작·종료 이벤트가 Timeline에 남는지 확인한다.

## 1:40–2:40 — Canary 성능 저하

1. 운영 플랫폼 또는 다음 helper로 `CANARY_STARTED`를 전달한다.

   ```powershell
   .\scripts\send-ops-event.ps1 -Type CANARY_STARTED -Message "v1.2.0 Canary deployment started"
   ```

2. Canary Arena를 만들어 `v1.2.0 · FULL`을 보여준다.
3. Chaos 영역에서 `TICK LAG 350ms` 또는 `TOGGLE FULL BROADCAST`를 실행한다.
4. `/ops`에서 Tick p95, Broadcast p95, Payload 증가를 비교한다.
5. 관전 화면의 작은 `DEGRADED` 표시를 확인한다.

## 2:40–3:20 — Rollback

1. `SLO_BREACH`, `ROLLBACK_STARTED` 이벤트를 전송한다.
2. 실제 배포 워크플로우에서 Canary를 Rollback한다. 발표 비상용으로만 `scripts/rollback-canary.ps1` 또는 `.sh`를 쓴다.
3. `CLEAR CHAOS` 후 `ROLLBACK_COMPLETED`를 전달한다.
4. Delta/Payload/Tick 지표가 정상화되는지 보여준다.

게임 서버가 Kubernetes Rollback을 직접 실행한다고 설명하지 않는다. 운영 플랫폼이 Metric과 Label을 근거로 Rollback한다.

## 3:20–4:30 — Primary 장애와 DR 복구

1. 플레이어들이 계속 움직이는 상태에서 `PRIMARY FAILURE → DR`을 실행한다.
2. 확인 Modal의 연결 재설정 경고를 읽는다.
3. 모바일에서 오류 페이지 대신 다음 Overlay가 보이는지 확인한다.
   - “서버에 다시 연결하는 중입니다.”
   - “최근 게임 상태를 복구하고 있습니다.”
4. 수 초 안에 같은 닉네임·팀·위치로 돌아오는지 확인한다.
5. 하단 identity가 `PRIMARY → DR`로 바뀌는지 확인한다.
6. Timeline의 `PRIMARY_UNHEALTHY → FAILOVER_STARTED → SNAPSHOT_RESTORED → FAILOVER_COMPLETED` 순서를 보여준다.

말할 내용: “완전 무중단이 아니라 자동 재접속입니다. 복구점은 최근 1초 Snapshot이며 그만큼 데이터 손실 가능성이 있습니다.”

## 4:30–5:00 — 운영 증거 정리

- Recovery Time과 Snapshot Age
- 재접속 횟수
- Stable/Canary Version과 Broadcast mode
- 실제 Kubernetes Pod/replica/restart/CPU/memory
- `/metrics`의 게임 전용 Histogram/Counter

## 비상 복구

- 관객 네트워크 실패: PC와 휴대폰을 개인 핫스팟으로 옮기고 `start-demo.ps1` 재실행
- 참여자 부족: 관리자 Bot 추가
- Canary 과도한 렉: `CLEAR CHAOS`
- Redis/서버 재시작: `docker compose restart redis server-stable` 후 `/readyz`와 Snapshot 복구 확인
- 전체 종료: `docker compose stop`
