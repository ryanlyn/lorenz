```text
 ██████████████████████████████████████████████████████████████████████████████████████████████████████████████████████████████████ 
 LORENZ                                                                                                         up 45m 0s · poll n/a
 1 active · 4 pending                                                         rate 15 tps · total 20,200 tok · in 18,000 / out 2,200
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
 #   LANE  ID        TITLE                      STAGE         AGENT  HOST          AGE/TURN  TOKENS LAST ACTIVITY                   
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
 1 ▶ run   MT-638    Fixture issue              retrying      codex  local        20m 25s/7  14,200 agent message streami...        
   ↻ retry MT-450    retry attempt 4            —             —      —                in 2s       — rate limit exhausted            
   ↻ retry MT-451    retry attempt 2            —             —      —                in 4s       — retrying after API timeout wi...
   ↻ retry MT-452    retry attempt 6            —             —      —                in 9s       — worker crashed restarting cle...
   ↻ retry MT-453    retry attempt 1            —             —      —               in 11s       — fourth queued retry should al...
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
 events
   no recent events
```
