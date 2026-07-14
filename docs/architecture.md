# Color Turf Arena 아키텍처

## 런타임 구조

```mermaid
flowchart LR
    subgraph Clients["Browser / Bot clients"]
        Player["/play/:roomId\nCanvas + joystick"]
        Watch["/watch/:roomId\nvenue spectator"]
        Admin["/admin\ntoken-protected control"]
        Bot["Bot Runner\nreal Socket.IO protocol"]
    end

    subgraph Web["React + Vite / Nginx"]
        SPA["Role-based SPA"]
        Renderer["Canvas render adapter"]
    end

    subgraph Server["Node + Express + Socket.IO"]
        REST["Public / Admin / Ops APIs"]
        Socket["join · resume · input · delta"]
        Engine["GameRoom authority\n10Hz · speed · paint · deadline"]
        Broadcaster["Delta / Full broadcaster"]
        Metrics["prom-client + JSON logs"]
        Lease["Room lease owner"]
    end

    Redis[("Redis\n1s Snapshot · 30m Session · Lease")]
    Platform["Kubernetes operations platform\nrollout / rollback / LB switch"]
    Kube["Kubernetes API + metrics.k8s.io"]

    Player --> SPA
    Watch --> SPA
    Admin --> SPA
    SPA --> REST
    SPA <--> Socket
    Bot <--> Socket
    Renderer --> Player
    Renderer --> Watch
    Socket --> Engine
    REST --> Engine
    Engine --> Broadcaster
    Broadcaster --> Socket
    Engine --> Metrics
    Engine --> Lease
    Lease <--> Redis
    Engine <--> Redis
    Platform -->|"POST /api/ops/events"| REST
    Metrics -->|"SLO webhook"| Platform
    Server -. "read-only observation" .-> Kube
```

## Snapshot과 Delta

```mermaid
sequenceDiagram
    participant P as Mobile player
    participant S as Socket.IO server
    participant G as GameRoom authority
    participant R as Redis
    participant V as Watch/Admin

    P->>S: join_room(roomId, sessionId, nickname)
    S->>G: restore session or assign smaller team
    G-->>P: room_snapshot(grid, players, score, server)
    P->>S: player_input(sequence, direction, sentAt)
    S->>G: validate session, status, range, rate, order
    loop 10Hz authoritative tick
        G->>G: cap speed, move player, paint cells
        alt Stable delta mode
            G-->>P: state_delta(changedCells, players)
            G-->>V: state_delta(changedCells, players)
        else Canary full mode
            G-->>P: room_snapshot(full grid)
            G-->>V: room_snapshot(full grid)
        end
    end
    loop every 1 second
        G->>R: snapshot + session TTL + lease renewal
    end
```

## 장애복구 흐름

```mermaid
sequenceDiagram
    participant C as Browser clients
    participant P as Primary authority
    participant R as Redis Snapshot
    participant D as DR authority
    participant T as Admin timeline

    P->>R: latest room snapshot
    P--xC: WebSocket connection reset
    T-->>C: PRIMARY_UNHEALTHY / FAILOVER_STARTED
    loop every 2s until lease is available
        D->>R: acquire room lease
    end
    D->>R: load latest snapshot
    R-->>D: grid, scores, players, teams, deadline, sequence
    D-->>T: SNAPSHOT_RESTORED / FAILOVER_COMPLETED
    C->>D: automatic resume_session(sessionId)
    D-->>C: full snapshot from recent recovery point
    Note over C,D: 새로고침이나 재로그인은 없지만 Snapshot 주기만큼 RPO가 존재한다.
```

로컬 Chaos Control은 같은 프로세스가 Redis Snapshot을 다시 읽고 identity를 `DR`로 바꾸는 방식으로 복구 코드 경로를 검증한다. 실제 두 cluster 사이의 Service/DNS/LB 전환은 운영 플랫폼 책임이다.

## 상태 소유권

| 상태 | 실제 소유자 | 전송/소비자 |
| --- | --- | --- |
| 팀, 위치, Grid, 점수, deadline | `GameRoom` server authority | Snapshot/Delta → 모든 화면 |
| Session identity와 복구점 | Redis Snapshot storage | 재시작·Failover 복구 |
| Room single writer | Redis lease owner | server start/renew/release |
| Stable/Canary mode | Room `releaseChannel` + server config | version/broadcast metrics/UI |
| 배포·Rollback 이벤트 | 외부 운영 플랫폼 | `/api/ops/events` → Timeline |
| Tick/Broadcast/Payload/RTT | 실제 runtime collector | `/metrics`, `/ops`, `/admin` |
| Pod/replica/restart/CPU/memory | Kubernetes API/Metrics Server | `/ops` actual card |
| Chaos delay/full/failover | 명시적인 Admin Chaos API | 실제 game loop/Socket에 영향 |

## 중요한 설계 결정

- 기존 npm workspace, React/Vite, Express/Socket.IO 코드를 유지했다. 새 요구의 pnpm/Fastify/Tailwind 전환은 기능과 무관한 재작성 위험이 커서 하지 않았다.
- Redis에는 매 입력을 쓰지 않고 1초 Snapshot만 저장한다. 쓰기 부하를 줄이는 대신 최대 Snapshot 주기만큼 RPO를 인정한다.
- Socket.IO Redis adapter 없이 Room당 authority는 하나다. lease가 중복 writer를 막으며, API 수평 확장은 adapter와 sticky routing 이후에만 해야 한다.
- authority는 lease를 2초마다 갱신한다. 갱신 실패 시 Room을 내리고 client를 끊어 split-brain을 피하며, 대기 인스턴스는 7초 TTL 만료 후 Snapshot을 재획득한다.
- Canary는 같은 Room의 일부 플레이어를 분리하지 않고 Room 단위로 `stable/canary`를 고른다.
- `ALLOW_DEMO_SERVER_SHUTDOWN=true` 없이는 shutdown API가 409를 반환한다. 데모 Backdoor가 기본 활성화되지 않는다.
