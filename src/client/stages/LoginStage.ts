/**
 * CLoginStage — faithful port. Layout extracted from CA.exe:
 *   background  LoginStage/CAStage            (0,0)
 *   1P form     LoginStage/LO_LogTable00      (194,415)   [sub_5689DC, TW default]
 *   ID edit                                 (408,448)
 *   PW edit                                 (408,473)
 *   buttons     LO_BtLogNewId/LogOk/LogExit  (242/351/460, 558)  [sub_5694A3]
 *   music       Mp3/StageLogin
 */
import { Stage, type GameContext } from "./stage.ts";
import { Button, Edit } from "../ui/controls.ts";
import type { Sprite } from "../engine/assets.ts";
import { rect } from "../engine/types.ts";
import { textSprite } from "../ui/text.ts";

export class LoginStage extends Stage {
  private bg!: Sprite;
  private form!: Sprite;
  private btnNewId!: Button;
  private btnOk!: Button;
  private btnExit!: Button;
  private idEdit!: Edit;
  private pwEdit!: Edit;
  private status = "";
  private loggingIn = false;
  private offs: Array<() => void> = [];

  override async enter(): Promise<void> {
    const a = this.ctx.assets;
    await a.preload([
      "LoginStage/CAStage",
      "LoginStage/LO_LogTable00",
      "LoginStage/LO_BtLogNewId",
      "LoginStage/LO_BtLogOk",
      "LoginStage/LO_BtLogExit",
    ]);
    this.bg = a.getCached("LoginStage/CAStage")!;
    this.form = a.getCached("LoginStage/LO_LogTable00")!;
    this.btnNewId = new Button(a.getCached("LoginStage/LO_BtLogNewId")!, 242, 558, {
      stateCount: 5,
      onClick: () => (this.status = "新建帳號功能（後續階段還原）"),
    });
    this.btnOk = new Button(a.getCached("LoginStage/LO_BtLogOk")!, 351, 558, {
      stateCount: 5,
      onClick: () => this.doLogin(),
    });
    this.btnExit = new Button(a.getCached("LoginStage/LO_BtLogExit")!, 460, 558, {
      stateCount: 5,
      onClick: () => (this.status = "離開"),
    });
    this.idEdit = new Edit(408, 448, 156, 20, false, { size: 13 });
    this.pwEdit = new Edit(408, 473, 156, 20, true, { size: 13 });
    this.idEdit.onSubmit = () => { this.idEdit.focused = false; this.pwEdit.focused = true; };
    this.pwEdit.onSubmit = () => this.doLogin();
    this.idEdit.focused = true;

    this.offs.push(this.ctx.net.on("loginResult", (m) => {
      if (m.t !== "loginResult") return;
      this.loggingIn = false;
      if (m.ok) {
        this.ctx.changeStage("selectServer", { user: m.user });
      } else {
        this.status = m.reason ?? "登入失敗";
      }
    }));
    this.offs.push(this.ctx.net.on("error", (m) => {
      if (m.t === "error") { this.loggingIn = false; this.status = m.message; }
    }));
  }

  override exit(): void { for (const off of this.offs) off(); this.offs = []; }

  private doLogin() {
    if (this.loggingIn) return;
    const id = this.idEdit.value.trim();
    const pw = this.pwEdit.value;
    if (!id) {
      this.status = "請輸入遊戲暱稱";
      return;
    }
    this.loggingIn = true;
    this.status = "登入中…";
    this.ctx.net.send({ t: "login", id, pw });
  }

  override update(dtMs: number): void {
    const p = this.ctx.input.beginFrame();
    this.idEdit.update(p, this.ctx.input, dtMs);
    this.pwEdit.update(p, this.ctx.input, dtMs);
    this.btnNewId.update(p);
    this.btnOk.update(p);
    this.btnExit.update(p);
    this.ctx.input.endFrame();
  }

  override draw(): void {
    const r = this.ctx.renderer;
    r.begin([0, 0, 0, 1]);
    r.draw(this.bg, rect(0, 0, 800, 600));
    r.draw(this.form, rect(194, 415, this.form.w, this.form.h));
    this.idEdit.draw(r);
    this.pwEdit.draw(r);
    this.btnNewId.draw(r);
    this.btnOk.draw(r);
    this.btnExit.draw(r);
    if (this.status) {
      const t = textSprite(this.status, { size: 12, color: "#ffe08a" });
      r.draw(t, rect(194, 396, t.w, t.h));
    }
    r.end();
  }
}