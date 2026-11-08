export {};
/** WS smoke test: login -> room -> game; verifies map, movement, bombs, fire. */
const ws = new WebSocket("ws://localhost:3000/ws");
const send = (m: unknown) => ws.send(JSON.stringify(m));
let frameCount = 0, maxBombs = 0, maxFire = 0, maxItems = 0, destroyed = 0, ended = false;
let init: any = null;
let roomCreated = false;
let myId = "";
const t0 = Date.now();
ws.onopen = () => send({ t: "login", id: "smoke", pw: "x" });
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data as string);
  switch (m.t) {
    case "loginResult": myId = m.user?.id ?? "smoke"; send({ t: "selectServer", server: 0 }); break;
    case "serverList": send({ t: "selectChannel", channel: 0 }); break;
    case "channelList": send({ t: "enterLobby" }); break;
    case "lobbyState": if (!roomCreated) { roomCreated = true; send({ t: "createRoom", title: "smoke", map: 291, mode: 0 }); } break;
    case "roomState": if (!init && roomCreated) send({ t: "startGame" }); break;
    case "gameStart":
      init = m.state;
      console.log("gameStart", init.map, init.width + "x" + init.height, "players", init.players.length, "fuse", init.fuseMs);
      break;
    case "gameFrame": {
      frameCount++;
      const s = m.state;
      maxBombs = Math.max(maxBombs, s.bombs.length);
      maxFire = Math.max(maxFire, s.explosions.length);
      maxItems = Math.max(maxItems, s.items.length);
      destroyed += s.destroyed.length;
      if (frameCount % 40 === 0) {
        const me = s.bombers.find((b: any) => b.id === myId);
        console.log("frame", s.frame, "me", me && [me.x, me.y, me.alive], "bombs", s.bombs.length, "fire", s.explosions.length);
      }
      // drive the human: wander + bomb
      const dir = Math.floor(frameCount / 20) % 4;
      send({ t: "gameInput", seq: frameCount, dx: dir === 2 ? -1 : dir === 3 ? 1 : 0, dy: dir === 0 ? 1 : dir === 1 ? -1 : 0, bomb: frameCount % 60 < 2 });
      break;
    }
    case "gameEnd": ended = true; console.log("gameEnd", m.result); ws.close(); break;
    case "error": console.error("server error", m); break;
  }
};
setTimeout(() => {
  console.log(JSON.stringify({ frames: frameCount, maxBombs, maxFire, maxItems, destroyed, ended, seconds: (Date.now() - t0) / 1000 }));
  const ok = init && frameCount > 50 && maxBombs > 0 && maxFire > 0 && destroyed > 0;
  console.log(ok ? "SMOKE_OK" : "SMOKE_FAIL");
  process.exit(ok ? 0 : 1);
}, 15000);
