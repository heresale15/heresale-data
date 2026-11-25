# app/ — 여긴할인 앱 코드 (자동 배포)
- 이 폴더(app/)가 바뀌면 Cloudflare가 자동으로 https://heresale.hsy015.workers.dev 에 올립니다.
- 설정: Cloudflare → Workers & Pages → heresale → Settings → Builds
  - 저장소 heresale15/heresale-data, 브랜치 main, 루트 디렉터리 `app`, 배포 명령 `npx wrangler deploy`, 빌드 감시 경로 `app/*`
- 지역화폐 가맹점 파일(kc)은 저장소에 없음 → 사용자 PC에서 `upload_kc.bat`로 heresale-kc 사이트에 올림
- 키·비밀번호는 절대 이 저장소에 넣지 않음 (Cloudflare 비밀 변수에만)
