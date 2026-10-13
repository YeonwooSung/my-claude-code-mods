import type { On, TurnStepResult, JsonValue } from 'claude-code'
import { test, expect, type Engine } from 'claude-code/testing'

const START = {cwd:'/repo',surface:'terminal' as const,isInteractive:true}
const BAND = {hasSurvey:false,isWorking:false,maxRows:8,bodyColumns:64,scroll:{offset:0,bodyRows:8},view:{}}
const PANE = {title:'Token Run',isFocused:true,bodyColumns:64,placement:'inline' as const,scroll:{offset:0,bodyRows:8},view:{}}
const STEP = {turnId:'t1',index:0,model:'opus',messageCount:1}
const usage = {input_tokens:1,output_tokens:2,cache_read_input_tokens:0,cache_creation_input_tokens:0,model:'opus'}
const RESULT: TurnStepResult = {...STEP,answer:'ok',toolUses:[],stopReason:'end_turn',usage}
function setup(on: On, options: {failRead?:boolean;failWrite?:boolean;failInvalidate?:boolean;failComplete?:()=>void} = {}) {
  const saved = new Map<string,unknown>()
  const opened: unknown[] = []
  const names: string[] = []
  const closed: string[] = []
  on('session.start',(_$,e)=>({cwd:e.cwd}))
  on('session.end',()=>({sessionId:'s'}))
  on('command.register',(_$,e)=>{names.push(e.name);return {value:{command:e.name}}})
  on('store.get',(_$,e)=>{if(options.failRead) throw new Error('unreadable');return {value:saved.get(e.key)}})
  on('store.set',(_$,e)=>{if(options.failWrite) throw new Error('disk full');saved.set(e.key,e.value);return {value:undefined}})
  on('ui.invalidate',()=>{if(options.failInvalidate) throw new Error('no UI');return {value:undefined}})
  on('ui.open',(_$,e)=>{opened.push(e);return {value:{isPlaced:true}}})
  on('ui.close',(_$,e)=>{closed.push(e.id);return {value:undefined}})
  on('ui.render',async($,e)=>$.ui.resolve(e).Box({key:'other-mod',children:$.ui.resolve(e).Text({children:'other mod'})}))
  on('turn.start',(_$,e)=>({turnId:e.turnId}))
  on('turn.complete',()=>{options.failComplete?.();return {text:'original answer'}})
  return {saved,opened,closed,names}
}
async function command($:Engine,args='') { return $.command.run({command:'token-run',args,origin:{kind:'composer'},presentation:{isFullscreen:false,columns:80}}) }
async function complete($:Engine, reason:'error'|'answer'|'aborted'|'refusal'='error',agentId?:string,turnId='t1') {
  const base={reason,agentId,turnId,answer:'unchanged',durationMs:10,isAborted:reason==='aborted'}
  return $.turn.complete(reason==='refusal'?{...base,reason,refusal:{category:null,explanation:null}}:{...base,reason})
}
async function mount($:Engine,surface:'terminal'|'desktop'='terminal') {
  return $.ui.mount({plugin:'token-run',surface,component:'Pane',requestId:'token-run',props:PANE,viewport:{columns:64,rows:8}})
}

test('registers local command, help does not open, and close targets only its Pane',async($,on)=>{
  const env=setup(on)
  await $.session.start(START)
  expect(env.names).toContain('token-run')
  expect((await command($,'help')).text).toContain('Space')
  expect(env.opened).toHaveLength(0)
  expect((await command($)).text).toContain('Token Run')
  expect(env.opened).toHaveLength(1)
  expect(env.opened[0]).toMatchObject({id:'token-run',focus:true,closeOnEscape:true})
  await command($,'close');expect(env.closed).toContain('token-run')
  expect((await command($,'nonsense')).text).toContain('help')
})

test('main request error invites without opening; click opens while preserving other mods',async($,on)=>{
  const env=setup(on);await $.session.start(START)
  expect(await complete($)).toEqual({text:'original answer'})
  expect(env.opened).toHaveLength(0)
  const ui=await $.ui.mount({plugin:'token-run',surface:'terminal',component:'AbovePrompt',props:BAND})
  expect((await ui.find({key:'run-invite'}))?.text).toContain('요청 실패')
  expect((await ui.find({key:'other-mod'}))?.text).toBe('other mod')
  await ui.press({key:'run-invite'})
  expect(env.opened).toHaveLength(1)
  await ui.redraw({...BAND,hasSurvey:true})
  expect(await ui.find({key:'run-invite'})).toBeUndefined()
})

test('aborted refused subagent and stale completions do not invite',async($,on)=>{
  setup(on);await $.session.start(START)
  await $.turn.start({turnId:'t1',text:'keep prompt'})
  await complete($,'aborted');await complete($,'refusal');await complete($,'error','worker','a1')
  await $.turn.start({turnId:'t2',text:'new'})
  await complete($,'error',undefined,'t1')
  const ui=await $.ui.mount({plugin:'token-run',surface:'terminal',component:'AbovePrompt',props:BAND})
  expect(await ui.find({key:'run-invite'})).toBeUndefined()
})

test('stream chunks and generator result pass exactly once; response updates an open game',async($,on)=>{
  setup(on);let calls=0
  on('turn.step',async function*(){calls++;yield {kind:'text',index:0,text:'hello'};yield {kind:'stop',stopReason:'end_turn',usage};return RESULT})
  await $.session.start(START);await complete($);await command($)
  const ui=await mount($)
  const stream=$.turn.step(STEP)
  expect(await stream.next()).toEqual({done:false,value:{kind:'text',index:0,text:'hello'}})
  expect(await stream.next()).toEqual({done:false,value:{kind:'stop',stopReason:'end_turn',usage}})
  expect(await stream.next()).toEqual({done:true,value:RESULT})
  expect(calls).toBe(1)
  await ui.redraw()
  expect((await ui.find({key:'run-status',in:'runner'}))?.text).toContain('응답이 돌아왔어요')
})

test('subagent stream cannot announce recovery and invalidate errors never retry downstream',async($,on)=>{
  setup(on,{failInvalidate:true});let calls=0
  on('turn.step',async function*(_$,e){calls++;yield {kind:'text',index:0,text:'one'};return {...RESULT,turnId:e.turnId}})
  await $.session.start(START);await complete($);await command($)
  for await(const _ of $.turn.step({...STEP,agentId:'worker',turnId:'a1'})) {}
  const ui=await mount($)
  expect((await ui.find({key:'run-status',in:'runner'}))?.text).not.toContain('응답이 돌아왔어요')
  for await(const _ of $.turn.step(STEP)) {}
  expect(calls).toBe(2)
})

for(const surface of ['terminal','desktop'] as const) {
  test(`focused ${surface} Client starts jumps pauses restarts and posts records`,async($,on)=>{
    const env=setup(on);await $.session.start({...START,surface});await command($)
    const ui=await mount($,surface)
    await ui.advance(1000)
    expect((await ui.find({key:'run-score',in:'runner'}))?.text).toContain('SCORE 0')
    await ui.key({key:' '});await ui.advance(1000)
    expect((await ui.find({key:'run-score',in:'runner'}))?.text).toContain('SCORE 1')
    expect(env.saved.get('token-run.best.v1')).toEqual({version:1,best:1})
    await ui.key({key:'p'});await ui.advance(500)
    expect((await ui.find({key:'run-phase',in:'runner'}))?.text).toContain('PAUSED')
    expect((await ui.find({key:'run-score',in:'runner'}))?.text).toContain('SCORE 1')
    await ui.press({key:'run-pause'});await ui.advance(1000)
    expect((await ui.find({key:'run-score',in:'runner'}))?.text).toContain('SCORE 2')
    await ui.key({key:'r'})
    expect((await ui.find({key:'run-score',in:'runner'}))?.text).toContain('SCORE 0')
    expect((await ui.find({key:'run-score',in:'runner'}))?.text).toContain('BEST 2')
    await ui.press({key:'run-jump'});await ui.advance(50)
    expect((await ui.find({key:'track-4',in:'runner'}))?.text).toContain('@')
    await ui.key({key:'q'})
    expect(env.closed).toContain('token-run')
    await ui.unmount()
  })
}

test('modified keys are ignored and repeated redraws do not multiply timers',async($,on)=>{
  setup(on);await $.session.start(START);await command($);const ui=await mount($)
  for(const event of [{key:' ',ctrl:true as const},{key:'up',meta:true as const},{key:' ',shift:true as const}]) await ui.key(event)
  await ui.advance(1000)
  expect((await ui.find({key:'run-score',in:'runner'}))?.text).toContain('SCORE 0')
  await ui.key({key:'up'})
  for(let i=0;i<6;i++) await ui.redraw()
  await ui.advance(1000)
  expect((await ui.find({key:'run-score',in:'runner'}))?.text).toContain('SCORE 1')
})

test('focus loss and small region suspend physics and unfocused input is ignored',async($,on)=>{
  setup(on);await $.session.start(START);await command($);const ui=await mount($)
  await ui.key({key:' '});await ui.advance(1000)
  await ui.redraw({...PANE,isFocused:false});await ui.key({key:'r'});await ui.advance(2000)
  expect((await ui.find({key:'run-score',in:'runner'}))?.text).toContain('SCORE 1')
  await ui.redraw(PANE);await ui.resize({columns:20,rows:8});await ui.advance(2000)
  expect((await ui.find({key:'run-resize',in:'runner'}))?.text).toContain('Resize')
  await ui.resize({columns:64,rows:8});await ui.advance(1000)
  expect((await ui.find({key:'run-score',in:'runner'}))?.text).toContain('SCORE 2')
})

test('collision freezes score and restart makes the game playable again',async($,on)=>{
  setup(on);await $.session.start(START);await command($);const ui=await mount($)
  await ui.key({key:' '});await ui.advance(7000)
  expect((await ui.find({key:'run-phase',in:'runner'}))?.text).toContain('GAME OVER')
  const score=(await ui.find({key:'run-score',in:'runner'}))?.text
  await ui.advance(3000)
  expect((await ui.find({key:'run-score',in:'runner'}))?.text).toBe(score)
  await ui.press({key:'run-restart'});await ui.press({key:'run-jump'});await ui.advance(1000)
  expect((await ui.find({key:'run-score',in:'runner'}))?.text).toContain('SCORE 1')
})

test('malformed messages and expired run ids cannot save or close the current game',async($,on)=>{
  const env=setup(on);await $.session.start(START);await command($);const ui=await mount($)
  const node=await ui.find({key:'runner'})
  const props=node?.props?.props as {runId:number}
  expect(props.runId).toBeGreaterThan(0)
  for(const data of ([null,{}, {runId:props.runId,score:-1,type:'score'}, {runId:props.runId,score:1000000,type:'score'}, {runId:props.runId,score:'100',type:'score'}, {runId:props.runId,type:'unknown'}] as JsonValue[])) await ui.post(data)
  expect(env.saved.size).toBe(0)
  await command($,'close');await command($)
  const before=env.closed.length
  await ui.post({type:'exit',runId:props.runId,score:99})
  expect(env.closed.length).toBe(before)
  expect(env.saved.size).toBe(0)
})

test('session end removes the game and ignores subsequent old posts; saved best restores',async($,on)=>{
  const env=setup(on);env.saved.set('token-run.best.v1',{version:1,best:30})
  await $.session.start(START);await command($);const ui=await mount($)
  expect((await ui.find({key:'run-score',in:'runner'}))?.text).toContain('BEST 30')
  const props=(await ui.find({key:'runner'}))?.props?.props as {runId:number}
  await $.session.end({reason:'clear',sessionId:'s',resume:{id:'s'}})
  expect(env.closed).toContain('token-run')
  await ui.post({type:'score',runId:props.runId,score:900})
  expect(env.saved.get('token-run.best.v1')).toEqual({version:1,best:30})
  await ui.unmount();await $.session.start(START);await command($)
  const next=await mount($)
  expect((await next.find({key:'run-score',in:'runner'}))?.text).toContain('BEST 30')
})

test('storage failure warns without stopping frames; unsupported sessions explain the limitation',async($,on)=>{
  setup(on,{failRead:true});await $.session.start(START);await command($);const ui=await mount($)
  expect((await ui.find({key:'run-status',in:'runner'}))?.text).toContain('기록')
  await ui.key({key:' '});await ui.advance(1000)
  expect((await ui.find({key:'run-score',in:'runner'}))?.text).toContain('SCORE 1')
  await $.session.start({...START,surface:null,isInteractive:false})
  expect((await command($)).text).toContain('terminal')
})

test('downstream lifecycle errors propagate once and do not cause duplicate execution',async($,on)=>{
  let calls=0;setup(on,{failComplete:()=>{calls++;throw new Error('downstream failed')}})
  await $.session.start(START)
  await expect(complete($)).rejects.toThrow()
  expect(calls).toBe(1)
})
