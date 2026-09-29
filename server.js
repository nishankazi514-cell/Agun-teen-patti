const express=require('express');
const http=require('http');
const path=require('path');
const crypto=require('crypto');
const {WebSocketServer}=require('ws');

const app=express();
const server=http.createServer(app);
const wss=new WebSocketServer({server});
app.use(express.static(__dirname));
app.get('/health',(req,res)=>res.json({ok:true,players:players.length,phase:game.phase,deck:game.deck.length}));

const PORT=Number(process.env.PORT)||10000;
const MAX_PLAYERS=4, START_BALANCE=13460, ANTE=100, TURN_MS=20000;
let players=[];
const game={phase:'waiting',round:0,pot:0,turn:null,turnEndsAt:0,deck:[],dealerIndex:0,showdown:false,winnerIds:[],message:'Waiting for players'};
let timer=null;

const suits=['♠','♥','♦','♣'];
const ranks=['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
function deck(){const d=[];for(const s of suits)for(let i=0;i<ranks.length;i++)d.push({suit:s,rank:ranks[i],id:ranks[i]+s});return d;}
function shuffle(a){for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];}return a;}
function safeName(n){n=String(n||'Player').trim().replace(/[^\p{L}\p{N} _.-]/gu,'').slice(0,18);return n||'Player';}
function id(){return crypto.randomBytes(8).toString('hex');}
function cardValue(c){return ranks.indexOf(c.rank)+2;}
function score(cards){
  if(!cards||cards.length<3)return [0];
  const vals=cards.map(cardValue).sort((a,b)=>a-b), counts={}; cards.forEach(c=>counts[c.rank]=(counts[c.rank]||0)+1);
  const flush=cards.every(c=>c.suit===cards[0].suit);
  const uniq=[...new Set(vals)]; let straight=false, high=uniq[uniq.length-1];
  if(uniq.length===3){straight=(uniq[2]-uniq[1]===1&&uniq[1]-uniq[0]===1);if(uniq.join(',')==='2,3,14'){straight=true;high=3;}}
  const groups=Object.entries(counts).map(([r,n])=>[n,ranks.indexOf(r)+2]).sort((a,b)=>b[0]-a[0]||b[1]-a[1]);
  if(straight&&flush)return [6,high];
  if(groups[0][0]===3)return [5,groups[0][1]];
  if(flush)return [4,...vals.reverse()];
  if(straight)return [3,high];
  if(groups[0][0]===2)return [2,groups[0][1],groups[1][1]];
  return [1,...vals.reverse()];
}
function active(){return players.filter(p=>!p.folded);}
function publicPlayer(p,viewer){return {id:p.id,name:p.name,seat:p.seat,balance:p.balance,bet:p.bet,folded:p.folded,connected:p.connected,avatar:p.avatar,cards:game.showdown||p.id===viewer?p.cards:[],cardCount:p.cards.length};}
function state(viewer){return {phase:game.phase,round:game.round,pot:game.pot,turn:game.turn,turnEndsAt:game.turnEndsAt,dealerIndex:game.dealerIndex,showdown:game.showdown,winnerIds:game.winnerIds,message:game.message,deckCount:game.deck.length,players:players.map(p=>publicPlayer(p,viewer))};}
function send(ws,obj){if(ws.readyState===1)ws.send(JSON.stringify(obj));}
function broadcast(){for(const p of players)send(p.ws,{type:'state',state:state(p.id)});}
function setWaiting(msg='Waiting for players'){clearTimeout(timer);game.phase='waiting';game.turn=null;game.turnEndsAt=0;game.pot=0;game.showdown=false;game.winnerIds=[];game.message=msg;broadcast();}
function nextTurn(){const a=active();if(a.length<=1){finish(a[0]);return;} let i=a.findIndex(p=>p.id===game.turn); for(let k=1;k<=players.length;k++){const p=players[(i+k+players.length)%players.length];if(p&&!p.folded){game.turn=p.id;game.turnEndsAt=Date.now()+TURN_MS;game.message=`${p.name}'s turn`;clearTimeout(timer);timer=setTimeout(()=>autoPack(),TURN_MS);broadcast();return;}}}
function autoPack(){const p=players.find(x=>x.id===game.turn);if(p){p.folded=true;game.message=`${p.name} packed (timeout)`;nextTurn();}}
function startRound(){if(players.length<2){setWaiting();return;} clearTimeout(timer);game.round++;game.phase='playing';game.showdown=false;game.winnerIds=[];game.message='Cards dealt';game.deck=shuffle(deck());game.pot=0;game.turn=null;players.forEach(p=>{p.folded=false;p.bet=0;p.cards=[];if(p.balance<ANTE)p.balance=START_BALANCE; p.balance-=ANTE;p.bet=ANTE;game.pot+=ANTE;});
  for(let r=0;r<3;r++)for(const p of players) p.cards.push(game.deck.pop());
  const a=active(); game.turn=a[game.dealerIndex%a.length]?.id||a[0].id;game.turnEndsAt=Date.now()+TURN_MS;game.message=`${players.find(p=>p.id===game.turn)?.name||'Player'}'s turn`;timer=setTimeout(autoPack,TURN_MS);broadcast();}
function finish(last){clearTimeout(timer);game.phase='finished';game.showdown=true;game.turn=null;game.turnEndsAt=0;let winner=last;
  if(!winner){const a=active();if(a.length){winner=a.sort((x,y)=>{const sx=score(x.cards),sy=score(y.cards);for(let i=0;i<Math.max(sx.length,sy.length);i++){if((sx[i]||0)!==(sy[i]||0))return (sy[i]||0)-(sx[i]||0);}return 0;})[0];}}
  if(!winner){setWaiting('Waiting for players');return;} game.winnerIds=[winner.id];winner.balance+=game.pot;game.message=`${winner.name} wins ${game.pot}`;broadcast();setTimeout(()=>{if(players.length>=2)startRound();else setWaiting();},5000);}
function validTurn(p){return game.phase==='playing'&&game.turn===p.id&&!p.folded;}
function action(p,type){if(!validTurn(p))return send(p.ws,{type:'error',message:'Not your turn'});
  if(type==='pack'){p.folded=true;game.message=`${p.name} packed`;if(active().length===1)finish(active()[0]);else nextTurn();return;}
  if(type==='show'){finish(null);return;}
  if(type==='sideshow'){game.message=`${p.name} requested Side Show`;nextTurn();return;}
  let amount=type==='chaal'?ANTE:type==='double'?ANTE*2:0;
  if(!amount)return;
  amount=Math.min(amount,p.balance);p.balance-=amount;p.bet+=amount;game.pot+=amount;game.message=`${p.name} played ${amount}`;nextTurn();
}
function remove(p){const i=players.indexOf(p);if(i>=0)players.splice(i,1);if(players.length<2&&game.phase==='playing')setWaiting('Waiting for players');else broadcast();}

wss.on('connection',(ws,req)=>{const url=new URL(req.url,'http://localhost');const name=safeName(url.searchParams.get('name'));if(players.length>=MAX_PLAYERS){send(ws,{type:'error',message:'Table full (4/4)'});ws.close();return;}const p={id:id(),ws,name,seat:players.length,balance:START_BALANCE,bet:0,folded:false,cards:[],connected:true,avatar:['avatar1','avatar2','avatar3','avatar4'][players.length]};players.push(p);send(ws,{type:'welcome',id:p.id});broadcast();if(players.length>=2&&game.phase==='waiting')setTimeout(()=>{if(game.phase==='waiting'&&players.length>=2)startRound();},500);ws.on('message',raw=>{try{const m=JSON.parse(raw.toString());if(m.type==='action')action(p,m.action);if(m.type==='profile'){p.name=safeName(m.name)||p.name;broadcast();}if(m.type==='ping')send(ws,{type:'pong'});}catch{}});ws.on('close',()=>{p.connected=false;remove(p);});ws.on('error',()=>{p.connected=false;remove(p);});});

server.listen(PORT,'0.0.0.0',()=>console.log(`Teen Patti server running on ${PORT}`));
