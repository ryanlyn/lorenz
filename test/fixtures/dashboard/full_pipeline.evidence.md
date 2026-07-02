```text
 LORENZ  ▶ 1/10 running  ◌ 1 reserving  ↻ 1 retrying  ■ 1 blocked                                                 48 tps · up 45m 0s
 issues ████████████░░░░░░░░░░ · 1✓ · 1✗ · 1 active · 3 waiting · 5 backlog            tok 129,400 · gpt-5 61% ↺1m 35s · poll in 23s
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
 #   LANE  ID        TITLE                      STAGE         AGENT  HOST          AGE/TURN  TOKENS LAST ACTIVITY                   
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
 1 ▶ run   MT-700    Dedupe webhook retries ... In Progress   codex  mac-mini-01   14m 2s/6  89,350 editing src/webhooks/retry.ts   
   ◌ rsv   MT-458    reserving slot 1           —             —      (acquiring)         4s       — acquiring worker (prefers ssh...
   ↻ retry MT-450    retry attempt 2            —             —      —               in 34s       — Linear 429: rate limited        
   ■ block MT-461    —                          Todo          —      —                    —       — global concurrency cap          
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
 events
   00:44:41 run_started        MT-700 session e71a23 spawned on mac-mini-01 (slot 0)
```
