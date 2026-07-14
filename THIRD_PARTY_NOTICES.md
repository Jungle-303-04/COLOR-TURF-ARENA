# Third-party notices

## Socket.io-whiteboard

- Original project: https://github.com/over-engineer/Socket.io-whiteboard
- Reviewed revision: `65a7ffd3c5c7c5c7edc2813efe51177c147be39c`
- License: MIT
- Reuse scope: `lib/whiteboard.js`의 Canvas CSS 크기를 backing-store 크기에 맞추는 방식과 수신 상태를 Canvas 2D context에 그리는 adapter 책임 분리를 `apps/web/src/game/arenaCanvas.ts`에 TypeScript로 재구성했다. 원본의 Socket event 이름, 클라이언트 권위 drawing 데이터 모델, demo server, HTML/CSS, 에셋, 런타임 의존성은 복사하지 않았다.
- Modifications: pointer drawing을 제거하고 서버가 보낸 grid-cell 소유권과 각 플레이어 위치를 Snapshot/Delta로 합성한 뒤 resize-safe하게 렌더링하도록 변경했다.

The MIT License (MIT)

Copyright (c) 2016-2020 over-engineer

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Runtime libraries

The application also uses the npm packages React, Vite, Express, Socket.IO,
redis, Zod, prom-client, and qrcode under their respective open-source licenses. Exact
resolved versions and transitive packages are recorded in `package-lock.json`.
