/* MORGAN AUTONOMOUS TRADING BRAIN v3.0
 * Drop-in overlay for the existing Morgan/GT Sequence Rotator page.
 * Keeps the fast local execution path; AI/network review never blocks orders.
 * No martingale escalation. Uses fixed fractional stake and a loss circuit breaker.
 */
(() => {
  'use strict';
  const CFG = {
    minTicks: 35,
    fast: 8,
    slow: 21,
    momentum: 7,
    maxHistory: 240,
    minEdge: 0.12,
    strongEdge: 0.22,
    cooldownAfterLoss: 1,
    maxRiskFraction: 0.015,
    maxStakeFraction: 0.03,
    aiReviewMs: 500,
    stateKey: 'morgan_autonomous_v3'
  };
  let state = load();
  let lastDecision = null;
  let lastTradeAt = 0;
  let lossCooldown = 0;
  let evaluating = false;

  function load(){ try{return JSON.parse(localStorage.getItem(CFG.stateKey)||'{}')}catch(e){return {}} }
  function save(){try{localStorage.setItem(CFG.stateKey,JSON.stringify(state))}catch(e){}}
  function arr(){ return Array.isArray(window.tickHistory) ? window.tickHistory : []; }
  function nums(){ return arr().map(Number).filter(Number.isFinite); }
  function mean(a){return a.length?a.reduce((x,y)=>x+y,0)/a.length:0}
  function sd(a){if(a.length<2)return 0;const m=mean(a);return Math.sqrt(mean(a.map(x=>(x-m)**2)))}
  function slope(a){if(a.length<2)return 0;const n=a.length,m=mean(a),ym=a.reduce((s,v,i)=>s+(i-(n-1)/2)*v,0),xx=a.reduce((s,_,i)=>s+(i-(n-1)/2)**2,0);return xx?ym/xx:0}
  function rsi(a,n=14){if(a.length<n+1)return 50;let g=0,l=0;for(let i=a.length-n;i<a.length;i++){const d=a[i]-a[i-1];if(d>0)g+=d;else l-=d}if(l===0)return 100;return 100-(100/(1+g/l))}
  function z(v,a){const s=sd(a);return s?((v-mean(a))/s):0}
  function decision(){
    const p=nums();
    if(p.length<CFG.minTicks)return {action:'WAIT',score:0,reason:'Collecting live market data'};
    const fast=p.slice(-CFG.fast), slow=p.slice(-CFG.slow), mom=p.slice(-CFG.momentum);
    const sf=slope(fast), ss=slope(slow), sm=slope(mom);
    const vol=sd(p.slice(-30));
    const norm=vol||Math.max(Math.abs(mean(p))*1e-7,1e-8);
    const trend=Math.tanh((sf+0.6*ss)/norm);
    const accel=Math.tanh((sm-slope(p.slice(-CFG.momentum*2,-CFG.momentum)))/norm);
    const rv=rsi(p,14), rsiBias=Math.max(-1,Math.min(1,(rv-50)/25));
    const last=p[p.length-1], pos=z(last,p.slice(-30));
    // Avoid chasing extreme one-sided extensions; prefer continuation with healthy momentum.
    const exhaustion = Math.abs(pos)>2.2 && Math.sign(trend)===Math.sign(pos);
    let score=0.55*trend+0.30*accel+0.15*rsiBias;
    if(exhaustion) score*=0.35;
    const abs=Math.abs(score);
    let action='WAIT';
    if(abs>=CFG.strongEdge) action=score>0?'UP':'DOWN';
    else if(abs>=CFG.minEdge) action=score>0?'UP':'DOWN';
    const regime=Math.abs(trend)>0.55?'TREND':Math.abs(trend)<0.18?'RANGE':'TRANSITION';
    return {action,score,trend,accel,rsi:rv,vol,pos,regime,reason:`${regime} | score ${(score*100).toFixed(0)} | RSI ${rv.toFixed(0)} | momentum ${(sm/norm).toFixed(2)}`};
  }
  function stake(){
    const bal=Number(window.accountBalance||0);
    const base=Number(window.baseStake||0.35);
    if(!bal)return Math.round(base*100)/100;
    const max=Math.max(0.35,bal*CFG.maxStakeFraction);
    // Never increase stake because of a loss.
    return Math.round(Math.min(base,max)*100)/100;
  }
  function safe(){
    if(!window.isActive)return false;
    if(window.pendingLegs>0 || (window.activeContractIds&&window.activeContractIds.length))return false;
    if(!window.ws || window.ws.readyState!==1)return false;
    if(typeof window.isSafeToTrade==='function' && !window.isSafeToTrade())return false;
    if(lossCooldown>0){lossCooldown--;return false}
    return true;
  }
  function params(){
    const d=decision(); lastDecision=d;
    if(d.action==='WAIT')return null;
    const s=stake();
    return {contract_type:d.action==='UP'?'CALL':'PUT',label:d.action==='UP'?'RISE':'FALL',stake:s,indicatorReason:'MORGAN: '+d.reason};
  }
  // Override the old indicator-gated trade selector.
  window.currentTradeParams=function(){return params()};

  // Fast local decision. It never waits for the LLM/network.
  window.executeTrade=function(){
    if(!safe())return;
    const p=params();
    if(!p){ if(typeof window.updateScanUI==='function')window.updateScanUI('⏳ MORGAN WATCHING',lastDecision?.reason||'No edge','WAIT',0); return; }
    if(typeof window.updateScanUI==='function')window.updateScanUI('🧠 MORGAN '+p.label,p.indicatorReason,'GO',Math.round(Math.abs(lastDecision.score)*100));
    window.currentStake=p.stake;
    window.lastTradeKey=p.contract_type;
    window.currentBatchParams=p;
    window.batchExpected=Number(window.positionsPerEntry)||1;
    window.batchSettled=0;window.batchPnl=0;window.legsToOpen=window.batchExpected;
    if(Number(window.accountBalance||0)<p.stake){if(typeof window.stopEngine==='function')window.stopEngine();return}
    if(typeof window.log==='function')window.log(`🧠 MORGAN DECISION: ${p.label} | ${lastDecision.regime} | score ${(lastDecision.score*100).toFixed(0)} | $${p.stake.toFixed(2)}`,'var(--purple)');
    // Send immediately. No AI/network gate.
    if(typeof window.sendNextLegProposal==='function')window.sendNextLegProposal();
  };

  // Replace loss escalation with capital-preserving behavior.
  const oldSettle=window.settleBatch;
  window.settleBatch=function(pnl){
    const won=Number(pnl)>0;
    if(!state.trades)state.trades=0;if(!state.wins)state.wins=0;if(!state.losses)state.losses=0;if(!state.pnl)state.pnl=0;
    state.trades++;state.pnl+=Number(pnl)||0;won?state.wins++:state.losses++;save();
    if(won){window.consecutiveLosses=0;window.currentStake=window.baseStake||0.35;}
    else {window.consecutiveLosses=(Number(window.consecutiveLosses)||0)+1;window.currentStake=window.baseStake||0.35;lossCooldown=CFG.cooldownAfterLoss;}
    if(typeof window.updateBalanceDisplay==='function')window.updateBalanceDisplay();
    if(typeof window.log==='function')window.log(`${won?'🧠 WIN':'🧠 LOSS'} | Morgan keeps stake at base level | session P/L $${Number(window.sessionProfit||0).toFixed(2)}`,won?'var(--green)':'var(--red)');
    // Preserve the existing hard circuit breaker.
    if(!won && Number(window.consecutiveLosses)>=Number(window.maxLossStreak||4)){
      if(typeof window.log==='function')window.log('🛑 Morgan capital-protection circuit breaker: loss limit reached.','var(--red)');
      if(typeof window.stopEngine==='function')window.stopEngine();
    }
  };

  // Expose an auditable snapshot for the UI/console.
  window.MorganBrain={
    version:'3.0', decision, snapshot:()=>({decision:lastDecision,state,stake:stake(),ticks:nums().length}),
    resetMemory:()=>{state={};save();},
    config:CFG
  };
  if(typeof window.log==='function')window.log('🧠 MORGAN AUTONOMOUS BRAIN v3.0 loaded — fast local decision path ACTIVE','var(--purple)');
})();
