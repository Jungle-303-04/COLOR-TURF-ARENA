# 오픈소스 후보 평가

조사 기준일: 2026-07-14. GitHub 저장소 메타데이터, 기본 브랜치의 최신 커밋, 패키지 매니페스트를 직접 확인했다.

| 후보 | 라이선스 / 최근 커밋 | 의존성 상태 | 판단 |
| --- | --- | --- | --- |
| [christabella/freewee](https://github.com/christabella/freewee) | 루트 LICENSE 없음, `freewee/package.json`이 `UNLICENSE`로 명시. 최신 커밋 `651c0bb` (2019-09-28) | Node `>=0.8.8`, Socket.IO `1.4.5`, Phaser `2.4.6`, Bower와 저장소 내 vendored 의존성 사용 | 대형 화면과 휴대폰 컨트롤러 분리, room 동기화 구조만 참고. 라이선스가 재사용을 허용하지 않으므로 코드/에셋은 사용하지 않음 |
| [over-engineer/Socket.io-whiteboard](https://github.com/over-engineer/Socket.io-whiteboard) | MIT, 최신 커밋 `65a7ffd` (2020-08-11) | Node `11.4.0`, Socket.IO `2.3.0`, Express `4.17.1`. 그대로 실행하기에는 노후화 | **선정.** `lib/whiteboard.js`의 Canvas backing-store resize와 수신 상태를 그리는 작은 adapter 패턴만 TypeScript로 재구성. 구형 런타임 의존성은 가져오지 않음 |
| [devansvd/whiteboard-socketio](https://github.com/devansvd/whiteboard-socketio) | MIT, 최신 커밋 `17d3afb` (2023-01-28) | Express `4.9.x`, Socket.IO `latest` 비고정, jQuery/Bootstrap 파일을 저장소에 vendoring. README가 mobile touch 미지원 명시 | 모바일 데모와 재현 가능한 의존성이라는 요구에 맞지 않아 제외 |

## 선택 이유

`Socket.io-whiteboard`는 세 후보 중 라이선스가 명확하고, 재사용하려는 범위가 `Canvas 크기 동기화 → 서버에서 받은 상태 렌더링`이라는 작은 단위로 분리되어 있다. 원본처럼 클라이언트가 그리기 좌표를 권위 상태로 전파하지 않고, Color Turf Arena에서는 서버가 플레이어 위치와 grid 소유권을 계산한 뒤 최초 Snapshot과 변경 Cell Delta를 전송한다. 따라서 재사용한 것은 Canvas adapter 패턴뿐이며, 이동·점수·판정·room·팀·운영 상태는 새 서버 코드에서 파생된다.

## 현재 프로젝트의 의존성 전략

- 현재 세대의 React/Vite와 Socket.IO 4.x를 사용하고 lockfile로 버전을 고정한다.
- 선정 저장소의 Node 11/Socket.IO 2 런타임은 설치하지 않는다.
- `packages/shared`의 Zod 검증 계약과 Snapshot/Delta 타입을 플레이, 관전, 관리자, 관제 UI가 함께 사용한다.
- 실제 재사용 범위와 MIT 전문은 [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md)에 기록한다.
