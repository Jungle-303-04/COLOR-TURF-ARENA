# 외부 장비·Kubernetes 검증 체크리스트

이 문서는 코드·로컬 브라우저 자동 검증으로 대신할 수 없는 마지막 완료 증거를 수집한다. 결과를 추정해 적지 말고, 실제 사용한 장비·Room Code·commit SHA·시간과 파일명을 기록한다.

## 1. 검증 메타데이터

| 항목 | 기록 |
| --- | --- |
| 검증 일시 / 장소 |  |
| Git commit | `git rev-parse HEAD` 결과 |
| 발표 PC / OS |  |
| 네트워크 / AP isolation 여부 |  |
| 공개 Base URL | 예: `http://192.168.0.42:8080` |
| Room Code |  |
| 휴대폰 A / OS / Browser |  |
| 휴대폰 B / OS / Browser |  |

## 2. 발표 PC와 휴대폰 2대

1. PC와 두 휴대폰을 같은 Wi-Fi 또는 개인 핫스팟에 연결한다.
2. 관측 화면까지 함께 시작한다.

   ```powershell
   .\scripts\start-demo.ps1 -Observability
   docker compose ps
   ```

3. PC에서 출력된 LAN 주소의 `/healthz`, `/readyz`, `/version`, `/admin`, `/ops`가 열리는지 확인한다.
4. 관리자에서 Stable Room을 만들고 `/watch/:roomCode`를 전체화면으로 연다.
5. 두 휴대폰이 QR로 입장한다. 한 대는 닉네임을 입력하고 다른 한 대는 비워 서버 기본 `Guest-N`을 확인한다.
6. 두 기기가 서로 다른 팀으로 균형 배정되는지, 닉네임과 팀 색이 관리자·관전·플레이 화면에 같은 값으로 보이는지 확인한다.
7. Start 후 두 휴대폰에서 가상 조이스틱을 상·하·좌·우 및 대각선으로 드래그한다.
8. 다음 항목을 두 기기 각각 확인한다.

   - 정사각형 Canvas와 미니맵이 세로/가로 회전 후에도 찌그러지지 않는다.
   - 내 캐릭터 위치와 Paint가 움직임에 따라 갱신된다.
   - 관전·관리자 점유율과 참가자 좌표가 같은 경기 상태를 반영한다.
   - Pause 중 입력이 점수에 반영되지 않고 Resume 뒤 다시 움직인다.
   - Wi-Fi를 3~5초 끊었다 켜면 오류 페이지 대신 복구 Overlay가 나오고 같은 닉네임·팀으로 돌아온다.
   - End 뒤 승자·점유율·인원·경기 결과가 표시된다.

9. 최소 증거를 저장한다.

   - PC 관전 화면 사진 1장
   - 휴대폰 A/B 플레이 화면 사진 각 1장
   - 관리자 참가자 목록·최종 결과 1장
   - `/ops` 실제 지표와 데이터 원천 툴팁 1장
   - `docker compose ps`, `/version`, `/api/rooms/:roomCode` 출력

## 3. 같은 공개 URL의 Compose Primary→DR

기본 Compose는 Stable과 DR을 별도 프로세스로 실행하고 Nginx가 Stable 우선/DR 백업 경로를 제공한다. 다음 스크립트는 기본적으로 Stable 컨테이너를 `SIGKILL`로 비정상 종료하며, 종료 시 다시 시작한다.

```powershell
node .\scripts\verify-compose-failover.mjs |
  Tee-Object .\docs\evidence\compose-failover-result.json
```

PASS 조건:

- Stable 종료 뒤 같은 `http://localhost:8080`에서 Socket transport가 다시 연결된다.
- `resume_session`이 기존 match, nickname, team, `matchEndsAt`을 복구한다.
- 공개 `/version`과 Room snapshot의 cluster가 `dr`이다.
- 결과 JSON에 `recoveryTimeMs`와 전후 sequence·painted cells가 기록된다.
- 복구 sequence·painted cells가 장애 직전 Redis Snapshot보다 뒤로 가지 않는다. crash 모드의 live 상태 대비 차이는 허용된 Snapshot RPO로 별도 기록한다.
- “완전 무중단”이 아니라 기존 Socket 종료 후 자동 재접속으로 설명한다.

graceful 종료 경로는 `$env:FAILOVER_FAILURE_MODE='graceful'`로 한 번 더 실행하며, 이때는 장애 직전 live sequence도 후퇴하지 않아야 한다.

## 4. 실제 Kubernetes

먼저 인증 Secret을 만들고 Chart를 배포한다.

```powershell
kubectl create namespace color-turf --dry-run=client -o yaml | kubectl apply -f -
kubectl -n color-turf create secret generic color-turf-auth `
  --from-literal=ADMIN_TOKEN='change-me' `
  --from-literal=OPS_EVENT_TOKEN='change-me-too'
helm upgrade --install color-turf .\deploy\helm\color-turf `
  -n color-turf -f .\deploy\helm\color-turf\values-primary.yaml
```

다음을 실제 출력으로 보관한다.

```powershell
kubectl -n color-turf get deployment,pod,service,hpa,pdb -o wide
kubectl -n color-turf get pod -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.status.containerStatuses[0].restartCount}{"\t"}{.status.containerStatuses[0].lastState.terminated.reason}{"\n"}{end}'
kubectl -n color-turf top pod
kubectl -n color-turf rollout history deployment/color-turf-server-stable
kubectl -n color-turf get events --sort-by=.lastTimestamp
```

PASS 조건:

- liveness/readiness probe가 성공하고 원하는 replica가 Ready다.
- `/ops`가 `LOCAL`이 아니라 Kubernetes API에서 읽은 Pod, replica, restart, image를 표시한다.
- HPA/PDB/resources와 실제 image tag 또는 digest를 확인할 수 있다.
- Canary 배포 전후 Stable/Canary `/metrics`의 version, release channel, payload, Tick 값이 구분된다.

### 실제 OOMKilled 선택 검증

외부 Ingress/Tunnel이 없는 격리된 일회성 namespace에서만 `values-isolated-chaos-demo.yaml`을 추가해 배포한다. 이 values는 관리자 인증 우회와 `chaos.allowPodOom=true`를 의도적으로 함께 켜므로 공개 환경에는 절대 적용하지 않는다. 관리자 버튼을 누른 뒤 다음 세 조건이 모두 확인되어야 PASS다.

1. `lastState.terminated.reason=OOMKilled`
2. restart count 증가
3. 새 컨테이너 Ready 복귀

API가 요청을 받았다는 사실만으로 성공 처리하지 않는다.

## 5. 실제 Primary/DR 두 cluster

두 cluster가 동일 Snapshot을 보려면 양쪽에서 접근 가능한 외부 또는 복제 Redis가 필요하다. 각 cluster에 기본 `redis.install=true`로 서로 다른 Redis를 설치한 상태는 DR 검증이 아니다.

기록할 항목:

- Primary/DR kube context와 public endpoint
- 공용 Redis endpoint 또는 복제 구조(Secret 값 자체는 기록하지 않음)
- 장애 시작 시각, DR Ready/접속 복구 시각, 계산한 RTO
- 장애 직전 Snapshot age와 `SNAPSHOT_INTERVAL_MS`에 따른 최대 RPO
- 복구 전후 Room Code, match ID, team, nickname, score, `matchEndsAt`, sequence
- 외부 LB/DNS/Gateway가 Primary에서 DR로 전환한 증거

PASS 조건은 새로고침·재로그인 없이 같은 Session으로 수 초 내 재접속하고, 최근 Snapshot 기준으로 게임이 이어지는 것이다. RPO 0이나 무중단으로 표현하지 않는다.

## 6. 결과 기록

검증이 끝나면 [verification.md](verification.md)의 “아직 외부 환경 증거가 필요한 항목”을 실제 결과와 증거 파일 경로로 교체한다. 실패 항목은 숨기지 말고 기기·브라우저·네트워크·재현 단계와 함께 남긴다.
