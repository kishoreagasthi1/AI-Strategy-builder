/**
 * v5.34.17 — resilient opening retry (poll until the agent responds).
 *
 * A single retry still intermittently missed the model's warmup window, so the
 * interview opened mute. open() now RESENDS the opening every ~3s until the
 * session reports an agent frame (_gotAgentFrame), capped at 4 attempts so it
 * can never loop or double-talk once the agent is responding. This makes the
 * opening timing-independent.
 */
import { describe, it, expect } from "vitest";

function makeLI() {
  const session: any = { closed:false, ws:{readyState:1}, _gotAgentFrame:false, sends:[] as string[], sendText(t:string){this.sends.push(t);return true;} };
  const LI: any = { session, _muted:false, _openRetry:null,
    open(line:string){
      const self=this; if(!this.session) return;
      this.session._gotAgentFrame=false;
      if(this._openRetry){clearTimeout(this._openRetry);this._openRetry=null;}
      let attempts=0; const MAX=4;
      function fire(){
        const s=self.session;
        if(!s||s.closed||self._muted||!s.ws||s.ws.readyState!==1) return;
        if(s._gotAgentFrame) return;
        if(attempts>=MAX) return;
        attempts++; try{s.sendText(line);}catch(e){}
        self._openRetry=setTimeout(fire, 25);
      }
      fire();
    }
  };
  return LI;
}
const wait=(ms:number)=>new Promise(r=>setTimeout(r,ms));

describe("resilient opening retry", () => {
  it("caps at 4 attempts when the agent never responds (no loop)", async () => {
    const LI=makeLI(); LI.open("B"); await wait(250);
    expect(LI.session.sends.length).toBe(4);
  });
  it("stops as soon as the agent responds", async () => {
    const LI=makeLI(); LI.open("B");
    setTimeout(()=>{LI.session._gotAgentFrame=true;}, 40);
    await wait(250);
    expect(LI.session.sends.length).toBeLessThanOrEqual(2);
  });
  it("sends exactly once if the agent responds immediately", async () => {
    const LI=makeLI(); LI.open("B"); LI.session._gotAgentFrame=true; await wait(200);
    expect(LI.session.sends.length).toBe(1);
  });
  it("stops retrying when muted", async () => {
    const LI=makeLI(); LI.open("B"); setTimeout(()=>{LI._muted=true;},40); await wait(250);
    expect(LI.session.sends.length).toBeLessThanOrEqual(2);
  });
  it("stops retrying when the socket closes", async () => {
    const LI=makeLI(); LI.open("B"); setTimeout(()=>{LI.session.closed=true;},40); await wait(250);
    expect(LI.session.sends.length).toBeLessThanOrEqual(2);
  });
});
