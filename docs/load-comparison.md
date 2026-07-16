# Delta / Full Broadcast 부하 비교

독립된 game-api 프로세스를 모드별로 하나씩 실행해 같은 조건을 비교한다. 기본 조건은 실제 Socket.IO Bot 50개, Bot당 10Hz 입력, `108×108` 정사각형 Grid, 1.5초 준비 후 5초 측정이다. 두 모드 사이에 runtime 표본이나 Room 상태를 공유하지 않는다. Client는 기본 10개 Worker로 나눠 Full Snapshot 수신 부하가 입력 타이머를 굶기지 않게 하고, 각 Worker는 지연된 입력 주기를 보정한다.

```powershell
npm run --silent load:compare |
  Tee-Object .\docs\evidence\load-comparison.json
```

출력 JSON에는 Delta/Full 각각의 연결 Bot 수, 예상·실제 입력 수와 전달률, 입력 스케줄 지연 P95, 상태 메시지 처리량, 대표 Payload 크기, 전체 Client 전송량 추정치, Tick/Broadcast/Event Loop P95, CPU·RSS와 Full/Delta 비율이 들어간다. `ok=true`는 두 모드 모두 요청한 Bot 수가 연결되고 예상 입력 수를 정확히 전송했으며, Delta는 `state_delta`만, Full은 전체 `room_snapshot`만 수신하고 Full Payload가 Delta보다 큰 경우다.

측정 시간을 늘리거나 현재 기본 월드인 `216×216`으로 확인하려면 환경변수를 사용한다.

```powershell
$env:LOAD_GRID_SIZE="216"
$env:LOAD_WARMUP_MS="3000"
$env:LOAD_MEASURE_MS="10000"
npm run --silent load:compare
```

선택 변수는 `LOAD_BOT_COUNT`, `LOAD_INPUT_RATE_HZ`, `LOAD_GRID_SIZE`, `LOAD_WARMUP_MS`, `LOAD_MEASURE_MS`, `LOAD_CLIENT_WORKERS`다. 러너가 사용하는 서버는 임시 포트에 뜨고 각 측정 뒤 종료된다. 기존 Compose나 로컬 데모 서버를 변경하지 않는다.
